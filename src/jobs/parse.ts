// One job file on its own: its frontmatter read against the format (docs/DESIGN.md "Job files"),
// with the defaults of its kind. Every problem names its field, its line and the fix. What needs
// the other files or Pomade's projects — chains, names, project ids — is checked in `check.ts`.

import { normalizeWorkspacePath, isPomadeFolderPath } from "pomade-kit/protocol";
import { describeSchedule, parseSchedule, parseTime, type Schedule } from "pomade-kit/schedule";

import { encodeJobId, jobIdFits, MAX_ENCODED_JOB_ID } from "../keeper/ids";
import { fieldName, readJobDocument, type FieldPath, type JobDocument } from "./document";
import {
  CHAIN_RESULTS,
  GIT_OPERATIONS,
  HOOK_EVENTS,
  HOOK_FILTERS,
  JOB_KINDS,
  MISSED_POLICIES,
  NOTIFY_VALUES,
  OVERLAP_POLICIES,
  SERVICE_ACTIONS,
  SERVICE_STARTS,
  SESSION_STATUSES,
  workspacePath,
  type Chain,
  type Hook,
  type HookFilter,
  type Job,
  type JobError,
  type JobKind,
  type Readiness,
  type RunPolicies,
  type ServiceAction,
  type Trigger,
} from "./model";

/** A job's slug — its file name without `.md`: lower-case letters, digits and single dashes. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A job id as `after.job` names it: `<slug>` or `<sub-folder>/<slug>`. */
const JOB_ID_RE = /^(?:[^/\s][^/]*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ALL_KINDS = JOB_KINDS;
const RUN_KINDS: readonly JobKind[] = ["script", "agent", "git"];

/** Which kinds take each field. */
export const FIELD_KINDS: Readonly<Record<string, readonly JobKind[]>> = {
  kind: ALL_KINDS,
  name: ALL_KINDS,
  project: ALL_KINDS,
  enabled: ALL_KINDS,
  notify: ALL_KINDS,
  "low-priority": ALL_KINDS,
  after: ALL_KINDS,
  folder: ["service", "script", "agent"],
  command: ["service", "script"],
  start: ["service"],
  ready: ["service"],
  agent: ["agent"],
  mode: ["agent"],
  git: ["git"],
  schedule: RUN_KINDS,
  hook: RUN_KINDS,
  missed: RUN_KINDS,
  "worth-until": RUN_KINDS,
  overlap: RUN_KINDS,
  "time-limit": RUN_KINDS,
};

/** Defaults that depend on the kind. */
export const KIND_DEFAULTS: Record<JobKind, { notify: Job["notify"]; lowPriority: boolean; missed: RunPolicies["missed"] }> = {
  service: { notify: "on-failure", lowPriority: false, missed: null },
  script: { notify: "on-failure", lowPriority: true, missed: "run-on-wake" },
  agent: { notify: "always", lowPriority: true, missed: "run-on-wake" },
  git: { notify: "on-failure", lowPriority: false, missed: "skip" },
};

/** What a later check needs to know of a file, valid or not. */
export interface ParsedJobFile {
  id: string;
  /** Workspace-relative. */
  path: string;
  /** The sub-folder it sits in; `null` at the top level. */
  folder: string | null;
  name: { value: string; line: number } | null;
  kind: JobKind | null;
  project: { value: string; line: number } | null;
  /** A chain this job follows, as written. */
  after: { job: string; line: number } | null;
  /** A hook's project filter, as written. */
  hookProject: { value: string; line: number } | null;
  /** Errors in this file alone. */
  errors: JobError[];
  /** The job, when the file alone has no errors. */
  job: Job | null;
}

/** A file the jobs folder holds: its text, or why it could not be read. */
export type JobFileInput = { path: string; text: string } | { path: string; readError: string };

function show(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  return JSON.stringify(value);
}

/** "a script job", "an agent job". */
function aJob(kind: JobKind): string {
  return `${kind === "agent" ? "an" : "a"} ${kind} job`;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listWords(values: readonly string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} or ${values.at(-1) ?? ""}`;
}

/** The closest of `candidates` to a mistyped `word` (case, `_`, camelCase or a slip of two letters). */
export function closest(word: string, candidates: readonly string[]): string | null {
  const plain = word.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = plain === candidate ? 0 : distance(plain, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return bestDistance <= Math.min(2, Math.floor(word.length / 2)) ? best : null;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(current + 1, (row[j - 1] ?? 0) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

/** Parse a duration — `45m`, `2h`, `1h30m` — into minutes; `null` when it is not one. */
export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/.exec(text.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return minutes > 0 ? minutes : null;
}

class FileCheck {
  readonly errors: JobError[] = [];

  constructor(
    readonly path: string,
    readonly doc: JobDocument,
  ) {}

  add(field: FieldPath, problem: string, fix: string): void {
    this.errors.push({ path: this.path, line: this.doc.line(field), field: fieldName(field), problem, fix });
  }

  /** The value at a top-level field; `undefined` when absent or empty (`key:`). */
  get(key: string): unknown {
    const value = this.doc.fields[key];
    return value === null ? undefined : value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  text(field: FieldPath, value: unknown, example: string, options: { oneLine?: boolean } = {}): string | null {
    if (typeof value === "number" || typeof value === "boolean") {
      this.add(field, `${show(value)} reads as a ${typeof value}, not text`, `put it in quotes: ${fieldName(field)}: "${String(value)}"`);
      return null;
    }
    if (typeof value !== "string") {
      this.add(field, `${show(value)} is not text`, `write text, e.g. ${fieldName(field)}: ${example}`);
      return null;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      this.add(field, "is empty", `write it, e.g. ${fieldName(field)}: ${example}`);
      return null;
    }
    if (options.oneLine && /[\r\n]/.test(trimmed)) {
      this.add(field, "spans several lines", `keep it on one line, e.g. ${fieldName(field)}: ${example}`);
      return null;
    }
    return trimmed;
  }

  required(key: string, example: string, kind: JobKind): unknown {
    const value = this.get(key);
    if (value === undefined) this.add([key], `${aJob(kind)} needs ${key}`, `add ${key}: ${example}`);
    return value;
  }

  oneOf<T extends string>(field: FieldPath, value: unknown, values: readonly T[]): T | null {
    if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
    const guess = typeof value === "string" ? closest(value, values) : null;
    this.add(field, `${show(value)} is not allowed`, guess ? `write ${guess}` : `use one of ${listWords(values)}`);
    return null;
  }

  flag(key: string, fallback: boolean): boolean {
    const value = this.get(key);
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    this.add([key], `${show(value)} is not true or false`, `write ${key}: true or ${key}: false`);
    return fallback;
  }

  /** Report keys of a nested mapping that it does not take. */
  keys(field: FieldPath, value: Record<string, unknown>, allowed: readonly string[], what: string): void {
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      const guess = closest(key, allowed);
      this.add([...field, key], `${what} does not take ${key}`, guess ? `rename it to ${guess}` : `remove it — ${what} takes ${listWords(allowed)}`);
    }
  }
}

function checkFolder(c: FileCheck, kind: JobKind): string | null {
  const value = c.required("folder", "Projects/my-project", kind);
  if (value === undefined) return null;
  const text = c.text(["folder"], value, "Projects/my-project", { oneLine: true });
  if (text === null) return null;
  const fix = "write a folder inside the workspace, relative to its root, e.g. folder: Projects/my-project (. is the workspace root)";
  if (text.includes("\\")) {
    c.add(["folder"], `${show(text)} uses backslashes`, `write it with forward slashes — ${fix}`);
    return null;
  }
  const normalized = normalizeWorkspacePath(text);
  if (!normalized.ok) {
    c.add(["folder"], `${show(text)} is outside the workspace`, fix);
    return null;
  }
  if (isPomadeFolderPath(normalized.path)) {
    c.add(["folder"], `${show(text)} is inside .pomade, Pomade's own folder`, "pick another folder — jobs never run in .pomade");
    return null;
  }
  return normalized.path;
}

function checkCommand(c: FileCheck, kind: JobKind): string | null {
  const value = c.required("command", "./start.sh", kind);
  return value === undefined ? null : c.text(["command"], value, "./start.sh");
}

function checkChain(c: FileCheck, kind: JobKind): { chain: Chain; action: ServiceAction } | null {
  const value = c.get("after");
  if (value === undefined) return null;
  const example = kind === "service" ? "{ job: git-pull, result: done, action: restart }" : "{ job: backup, result: done }";
  if (!isMapping(value)) {
    c.add(["after"], `${show(value)} is not a chain`, `write after: ${example}`);
    return null;
  }
  c.keys(["after"], value, kind === "service" ? ["job", "result", "action"] : ["job", "result"], "after");
  let job: string | null = null;
  if (value.job === undefined || value.job === null) {
    c.add(["after"], "names no job", `add the job to follow: after: ${example}`);
  } else if (typeof value.job === "string" && value.job.trim().endsWith(".md")) {
    c.add(["after", "job"], `${show(value.job)} is a file name`, `write the job's id, without .md: ${value.job.trim().slice(0, -3)}`);
  } else if (typeof value.job !== "string" || !JOB_ID_RE.test(value.job.trim())) {
    c.add(["after", "job"], `${show(value.job)} is not a job id`, "write the other job's id: its file name without .md, with its sub-folder for a project job — backup, coda-helper/git-pull");
  } else {
    job = value.job.trim();
  }
  const result = value.result === undefined || value.result === null ? "done" : c.oneOf(["after", "result"], value.result, CHAIN_RESULTS);
  const action = value.action === undefined || value.action === null ? "restart" : c.oneOf(["after", "action"], value.action, SERVICE_ACTIONS);
  return job === null || result === null || action === null ? null : { chain: { job, result }, action };
}

function checkHook(c: FileCheck): Hook | null {
  const value = c.get("hook");
  if (!isMapping(value)) {
    c.add(["hook"], `${show(value)} is not a hook`, "write hook: { event: login } — the events are " + listWords(HOOK_EVENTS));
    return null;
  }
  const event = value.event === undefined || value.event === null ? null : c.oneOf(["hook", "event"], value.event, HOOK_EVENTS);
  if (value.event === undefined || value.event === null) {
    c.add(["hook"], "names no event", `add one: hook: { event: login } — the events are ${listWords(HOOK_EVENTS)}`);
  }
  if (event === null) {
    c.keys(["hook"], value, ["event", "project", "agent", "status"], "hook");
    return null;
  }
  const filters = HOOK_FILTERS[event];
  const takes: readonly HookFilter[] = [...filters.required, ...filters.optional];
  for (const key of Object.keys(value)) {
    if (key === "event" || (takes as readonly string[]).includes(key)) continue;
    if (key === "project" || key === "agent" || key === "status") {
      c.add(["hook", key], `the ${event} hook has no ${key} filter`, takes.length === 0 ? "remove it" : `remove it — this hook filters by ${listWords(takes)}`);
    } else {
      c.keys(["hook"], { [key]: value[key] }, ["event", ...takes], `the ${event} hook`);
    }
  }
  let ok = true;
  const filter = (key: "project" | "agent", example: string): string | null => {
    const v = value[key];
    if (v === undefined || v === null || !(takes as readonly string[]).includes(key)) return null;
    const text = c.text(["hook", key], v, example, { oneLine: true });
    if (text === null) ok = false;
    return text;
  };
  const project = filter("project", "<project id>");
  const agent = filter("agent", "claude");
  let status: Hook["status"] = null;
  if (filters.required.includes("status")) {
    if (value.status === undefined || value.status === null) {
      c.add(["hook"], `the ${event} hook needs a status`, `add it: hook: { event: ${event}, status: done } — ${listWords(SESSION_STATUSES)}`);
      ok = false;
    } else {
      status = c.oneOf(["hook", "status"], value.status, SESSION_STATUSES);
      if (status === null) ok = false;
    }
  }
  return ok ? { event, project, agent, status } : null;
}

function checkSchedule(c: FileCheck): { schedule: Schedule; words: string } | null {
  const value = c.get("schedule");
  if (isMapping(value) && value.always !== undefined) {
    c.add(["schedule", "always"], "always is for services", "a service runs all the time on its own (kind: service, start: login); give this job a schedule like daily: { at: 7:00 }");
    return null;
  }
  const result = parseSchedule(value, { resolution: "time" });
  if (result.ok) return { schedule: result.schedule, words: describeSchedule(result.schedule) };
  for (const error of result.errors) {
    const path: (string | number)[] = ["schedule"];
    for (const part of error.field.split(/\.|(?=\[)/)) {
      if (part === "") continue;
      const index = /^\[(\d+)\]$/.exec(part);
      path.push(index ? Number(index[1]) : part);
    }
    const dash = error.message.indexOf(" — ");
    const problem = dash < 0 ? error.message : error.message.slice(0, dash);
    const fix = dash < 0 ? "write a schedule like daily: { at: 7:00 } — see the pomade-runner-jobs skill for every shape" : error.message.slice(dash + 3);
    c.add(path, problem, fix);
  }
  return null;
}

/** The job's trigger: exactly one of schedule, hook and after. */
function checkTrigger(c: FileCheck, kind: JobKind, chain: Chain | null): Trigger | "invalid" {
  const given = (["schedule", "hook", "after"] as const).filter((key) => c.has(key));
  if (given.length === 0) {
    c.add(["kind"], `${aJob(kind)} needs a trigger`, "add one of schedule: (when), hook: (on an event) or after: (when another job finishes)");
    return "invalid";
  }
  if (given.length > 1) {
    const [, second] = given;
    c.add([second ?? "after"], `a job has one trigger, and this one has ${listWords(given).replace(" or ", " and ")}`, `keep one of them`);
    return "invalid";
  }
  if (given[0] === "schedule") {
    const scheduled = checkSchedule(c);
    return scheduled === null ? "invalid" : { kind: "schedule", ...scheduled };
  }
  if (given[0] === "hook") {
    const hook = checkHook(c);
    return hook === null ? "invalid" : { kind: "hook", hook };
  }
  return chain === null ? "invalid" : { kind: "chain", chain };
}

function checkPolicies(c: FileCheck, kind: JobKind, trigger: Trigger | null): RunPolicies {
  const scheduled = trigger?.kind === "schedule" || c.has("schedule");
  let missed: RunPolicies["missed"] = scheduled ? KIND_DEFAULTS[kind].missed : null;
  if (c.has("missed")) {
    if (!scheduled) c.add(["missed"], "only a scheduled job can miss a run", "remove it — hooks and chains have no missed runs");
    else missed = c.oneOf(["missed"], c.get("missed"), MISSED_POLICIES) ?? missed;
  }
  let worthUntil: string | null = missed === "run-on-wake" ? "next-run" : null;
  if (c.has("worth-until")) {
    const value = c.get("worth-until");
    if (missed !== "run-on-wake") {
      c.add(["worth-until"], "only applies with missed: run-on-wake", scheduled ? "remove it, or set missed: run-on-wake" : "remove it");
    } else if (value === "next-run") {
      worthUntil = "next-run";
    } else if (typeof value === "string" && parseTime(value.trim()) !== null) {
      worthUntil = value.trim();
    } else {
      c.add(["worth-until"], `${show(value)} is not a time of day`, "write a time like worth-until: 12:00 (H:MM, 24-hour), or worth-until: next-run");
    }
  }
  const overlap = c.has("overlap") ? (c.oneOf(["overlap"], c.get("overlap"), OVERLAP_POLICIES) ?? "skip") : "skip";
  let timeLimitMinutes: number | null = null;
  if (c.has("time-limit")) {
    const value = c.get("time-limit");
    const minutes = typeof value === "string" ? parseDuration(value) : null;
    if (minutes !== null) timeLimitMinutes = minutes;
    else if (typeof value === "number") c.add(["time-limit"], `${value} has no unit`, `add one: time-limit: ${value}m (minutes) or ${value}h (hours)`);
    else c.add(["time-limit"], `${show(value)} is not a duration`, "write minutes or hours, e.g. time-limit: 45m, 2h or 1h30m — or leave it empty for no limit");
  }
  return { missed, worthUntil, overlap, timeLimitMinutes };
}

function checkReadiness(c: FileCheck): Readiness {
  const value = c.get("ready");
  if (value === undefined) return { kind: "alive" };
  const fix = "write ready: { port: 5173 } or ready: { url: http://localhost:5173/ } — or remove it: up means still alive after 5 s";
  if (!isMapping(value)) {
    c.add(["ready"], `${show(value)} is not a readiness check`, fix);
    return { kind: "alive" };
  }
  c.keys(["ready"], value, ["port", "url"], "ready");
  const given = (["port", "url"] as const).filter((key) => value[key] !== undefined && value[key] !== null);
  if (given.length !== 1) {
    c.add(["ready"], given.length === 0 ? "names no check" : "has both port and url", fix);
    return { kind: "alive" };
  }
  if (given[0] === "port") {
    const port = value.port;
    if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) return { kind: "port", port };
    c.add(["ready", "port"], `${show(port)} is not a port`, "write a whole number from 1 to 65535, e.g. ready: { port: 5173 }");
    return { kind: "alive" };
  }
  const url = value.url;
  if (typeof url === "string" && /^https?:\/\/\S+$/.test(url.trim())) return { kind: "url", url: url.trim() };
  c.add(["ready", "url"], `${show(url)} is not a web address`, "write one that starts with http:// or https://, e.g. ready: { url: http://localhost:5173/ }");
  return { kind: "alive" };
}

function checkGit(c: FileCheck): { operation: (typeof GIT_OPERATIONS)[number]; repos: string[] } | null {
  const value = c.required("git", "{ operation: commit-push, repos: [Knowledge] }", "git");
  if (value === undefined) return null;
  const fix = "write git: { operation: commit-push, repos: [Knowledge] }";
  if (!isMapping(value)) {
    c.add(["git"], `${show(value)} is not a git operation`, fix);
    return null;
  }
  c.keys(["git"], value, ["operation", "repos"], "git");
  let operation: (typeof GIT_OPERATIONS)[number] | null = null;
  if (value.operation === undefined || value.operation === null) c.add(["git"], "names no operation", `add one: ${listWords(GIT_OPERATIONS)}`);
  else operation = c.oneOf(["git", "operation"], value.operation, GIT_OPERATIONS);
  const repos: string[] = [];
  const raw = value.repos;
  const reposFix = "list the repos by the name Pomade's Git panel shows: repos: [Knowledge, coda-helper]";
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    c.add(raw === undefined || raw === null ? ["git"] : ["git", "repos"], "names no repos", reposFix);
  } else if (!Array.isArray(raw)) {
    if (typeof raw === "string" && raw.trim() !== "") repos.push(raw.trim());
    else c.add(["git", "repos"], `${show(raw)} is not a list of repos`, reposFix);
  } else {
    raw.forEach((repo: unknown, i) => {
      if (typeof repo !== "string" || repo.trim() === "") c.add(["git", "repos", i], `${show(repo)} is not a repo name`, reposFix);
      else if (repos.includes(repo.trim())) c.add(["git", "repos", i], `${repo.trim()} is listed twice`, "list each repo once");
      else repos.push(repo.trim());
    });
  }
  return operation === null || repos.length === 0 ? null : { operation, repos };
}

function checkAgent(c: FileCheck): { agent: string; mode: string; prompt: string } | null {
  const agentValue = c.required("agent", "claude", "agent");
  let agent: string | null = null;
  if (agentValue !== undefined) {
    agent = c.text(["agent"], agentValue, "claude", { oneLine: true });
    if (agent !== null && /[/\\]/.test(agent)) {
      c.add(["agent"], `${show(agent)} is not an agent id`, "write the agent's id from the Agents app, e.g. agent: claude");
      agent = null;
    }
  }
  const mode = c.has("mode") ? c.text(["mode"], c.get("mode"), "normal", { oneLine: true }) : "normal";
  const prompt = c.doc.body.trim();
  if (prompt === "") {
    c.errors.push({
      path: c.path,
      line: c.doc.line(["kind"]),
      field: "",
      problem: "an agent job's prompt is its body, and the body is empty",
      fix: "write what the agent should do below the closing --- line",
    });
  }
  return agent === null || mode === null || prompt === "" ? null : { agent, mode, prompt };
}

/** Where a file sits in the jobs folder: its id and sub-folder, and why it cannot be a job file there. */
function locate(path: string): { id: string; folder: string | null; problem: { problem: string; fix: string } | null } {
  const parts = path.split("/");
  const file = parts.at(-1) ?? "";
  const slug = file.replace(/\.md$/, "");
  const folder = parts.length > 1 ? (parts[0] ?? null) : null;
  const id = path.replace(/\.md$/, "");
  if (parts.length > 2) {
    return {
      id,
      folder,
      problem: { problem: "job files sit at the top of the jobs folder or one sub-folder deep", fix: `move it to ${workspacePath(`${folder ?? ""}/${file}`)}` },
    };
  }
  if (!SLUG_RE.test(slug)) {
    const suggested = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "my-job";
    return {
      id,
      folder,
      problem: { problem: `the file name is the job's slug, and ${show(slug)} is not one`, fix: `rename the file to ${suggested}.md — lower-case letters, digits and dashes` },
    };
  }
  if (!jobIdFits(id)) {
    return {
      id,
      folder,
      problem: {
        problem: `the job's id ${show(id)} is too long to name its terminal session (${encodeJobId(id).length} characters; ${MAX_ENCODED_JOB_ID} at most, a character other than a letter, a digit or - counting 3 or more)`,
        fix: folder === null ? "rename the file to a shorter slug" : "rename the file to a shorter slug, or the project's folder to a shorter name",
      },
    };
  }
  return { id, folder, problem: null };
}

/** Check one job file on its own. `path` is inside the jobs folder (`coda-helper/coda-web.md`). */
export function parseJobFile(input: JobFileInput): ParsedJobFile {
  const path = workspacePath(input.path);
  const where = locate(input.path);
  const parsed: ParsedJobFile = {
    id: where.id,
    path,
    folder: where.folder,
    name: null,
    kind: null,
    project: null,
    after: null,
    hookProject: null,
    errors: [],
    job: null,
  };
  if (where.problem !== null) parsed.errors.push({ path, line: 1, field: "", ...where.problem });
  if ("readError" in input) {
    parsed.errors.push({ path, line: 1, field: "", problem: `the file cannot be read: ${input.readError}`, fix: "check that it is a readable text file" });
    return parsed;
  }
  const read = readJobDocument(input.text);
  if (!read.ok) {
    parsed.errors.push({ path, line: read.line, field: "", problem: read.problem, fix: read.fix });
    return parsed;
  }
  const c = new FileCheck(path, read.doc);

  // kind first: it decides which fields the file may have.
  let kind: JobKind | null = null;
  if (!c.has("kind")) c.add(["kind"], "the file says no kind", `add kind: as the first field — ${listWords(JOB_KINDS)}`);
  else kind = c.oneOf(["kind"], c.get("kind"), JOB_KINDS);
  parsed.kind = kind;

  for (const key of Object.keys(read.doc.fields)) {
    const kinds = FIELD_KINDS[key];
    if (kinds === undefined) {
      const guess = closest(key, Object.keys(FIELD_KINDS));
      c.add([key], `${key} is not a job field`, guess ? `rename it to ${guess}` : "remove it — the pomade-runner-jobs skill lists every field");
    } else if (kind !== null && !kinds.includes(kind)) {
      c.add([key], `${aJob(kind)} has no ${key}`, `remove it — ${key} is for ${listWords(kinds)} jobs`);
    }
  }

  const nameValue = c.get("name");
  const name = nameValue === undefined ? null : c.text(["name"], nameValue, "Coda web", { oneLine: true });
  if (nameValue === undefined) c.add(["name"], "the job has no name", "add name: — what Runner shows, e.g. name: Coda web");
  if (name !== null) parsed.name = { value: name, line: c.doc.line(["name"]) };

  const projectValue = c.get("project");
  const project = projectValue === undefined ? null : c.text(["project"], projectValue, "<project id>", { oneLine: true });
  if (project !== null) parsed.project = { value: project, line: c.doc.line(["project"]) };
  if (parsed.folder !== null && projectValue === undefined) {
    c.add(["project"], `the file is in the ${parsed.folder}/ sub-folder, which holds project jobs, and says no project`, "add project: <the project's id> — `pomade-runner projects` lists them — or move the file to the top of the jobs folder for a workspace job");
  }
  if (parsed.folder === null && project !== null) {
    c.add(["project"], "a project job sits in its project's sub-folder, and this file is at the top of the jobs folder", "move the file into the project's sub-folder (`pomade-runner projects` shows it), or remove project: for a workspace job");
  }

  const enabled = c.flag("enabled", true);
  const defaults = kind === null ? KIND_DEFAULTS.script : KIND_DEFAULTS[kind];
  const notify = c.has("notify") ? (c.oneOf(["notify"], c.get("notify"), NOTIFY_VALUES) ?? defaults.notify) : defaults.notify;
  const lowPriority = c.flag("low-priority", defaults.lowPriority);

  const chain = c.has("after") ? checkChain(c, kind ?? "script") : null;
  if (chain !== null) parsed.after = { job: chain.chain.job, line: c.doc.line(["after", "job"]) };
  const hookValue = c.get("hook");
  if (isMapping(hookValue) && typeof hookValue.project === "string" && hookValue.project.trim() !== "") {
    parsed.hookProject = { value: hookValue.project.trim(), line: c.doc.line(["hook", "project"]) };
  }
  if (kind === null) {
    parsed.errors.push(...c.errors);
    return parsed;
  }

  const common = { id: parsed.id, path, name: name ?? "", project, enabled, notify, lowPriority, body: read.doc.body };
  let job: Job | null = null;
  if (kind === "service") {
    const folder = checkFolder(c, kind);
    const command = checkCommand(c, kind);
    let start = c.has("start") ? c.oneOf(["start"], c.get("start"), SERVICE_STARTS) : "login";
    if (start === "project-first-open" && projectValue === undefined) {
      c.add(["start"], "starts on the first open of its project, and the job has no project", "add project: <the project's id>, or write start: login");
      start = null;
    }
    const ready = checkReadiness(c);
    if (folder !== null && command !== null && start !== null) {
      job = { ...common, kind, folder, command, start, ready, after: chain && { ...chain.chain, action: chain.action } };
    }
  } else {
    const trigger = checkTrigger(c, kind, chain?.chain ?? null);
    const policies = checkPolicies(c, kind, trigger === "invalid" ? null : trigger);
    if (kind === "script") {
      const folder = checkFolder(c, kind);
      const command = checkCommand(c, kind);
      if (folder !== null && command !== null && trigger !== "invalid") job = { ...common, ...policies, kind, folder, command, trigger };
    } else if (kind === "agent") {
      const folder = checkFolder(c, kind);
      const agent = checkAgent(c);
      if (folder !== null && agent !== null && trigger !== "invalid") job = { ...common, ...policies, kind, folder, ...agent, trigger };
    } else {
      const git = checkGit(c);
      if (git !== null && trigger !== "invalid") job = { ...common, ...policies, kind, git, trigger };
    }
  }

  parsed.errors.push(...c.errors);
  parsed.errors.sort((a, b) => a.line - b.line);
  if (parsed.errors.length === 0 && name !== null) parsed.job = job;
  return parsed;
}
