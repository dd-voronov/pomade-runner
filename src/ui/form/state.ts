// The job form's state, pure: the values the person sees, which of them they set, and the job file
// they become. The form never keeps its own copy of the format's rules: a kind turns the values into
// the file's fields (`FORM_KINDS`), the file the form would write is checked by the one validator
// (`checkJobAmong`), and each error lands on the field it names. An edit writes only the fields
// whose value changed against the file as last read, so comments, unknown fields and the body stay.

import { setBody } from "pomade-kit/frontmatter";
import { baseName } from "pomade-kit/protocol";

import { checkJobAmong, projectJobsFolder } from "../../jobs/check";
import { readJobDocument } from "../../jobs/document";
import { FIELD_ORDER, jobFileCandidates, newJobText, setJobFields, type FieldChanges, type FieldInput } from "../../jobs/edit";
import {
  CHAIN_RESULTS,
  GIT_OPERATIONS,
  HOOK_EVENTS,
  HOOK_FILTERS,
  JOB_KINDS,
  JOBS_FOLDER,
  MISSED_POLICIES,
  NOTIFY_VALUES,
  OVERLAP_POLICIES,
  SERVICE_ACTIONS,
  SERVICE_STARTS,
  type ChainResult,
  type GitOperation,
  type HookEvent,
  type HookFilter,
  type JobError,
  type JobKind,
  type JobsSnapshot,
  type MissedPolicy,
  type Notify,
  type OverlapPolicy,
  type ProjectRecord,
  type ServiceAction,
  type ServiceStart,
} from "../../jobs/model";
import { KIND_DEFAULTS } from "../../jobs/parse";
import { blankSchedule, readSchedule, scheduleInput, type ScheduleValues } from "./schedule";

/** How a service tells it is up, as the form offers it. */
export type ReadyCheck = "alive" | "port" | "url";

/** A script's trigger: a schedule, a hook (its event in `hookEvent`) or a chain (`chainJob`,
 *  `chainResult`). */
export type TriggerKind = "schedule" | "hook" | "chain";

/** Until when a caught-up run is worth starting: the job's next scheduled run, or a time of day. */
export type WorthUntil = "next-run" | "time";

/** Every value the form shows. A kind writes the ones it takes; the others are kept for a switch back. */
export interface FormValues {
  kind: JobKind;
  name: string;
  /** The stable project id; `null` for the Workspace (no project). */
  project: string | null;
  /** Workspace-relative, as typed; `.` is the root. */
  folder: string;
  enabled: boolean;
  command: string;
  start: ServiceStart;
  /** `start: project-first-open`: the project whose first open starts it, its id as written; empty
   *  is the job's own project (the file leaves `start-project` out). */
  startProject: string;
  ready: ReadyCheck;
  /** The port and the URL as typed; one of them is written, by `ready`. */
  port: string;
  url: string;
  /** Script, agent, git: the trigger, and the schedule's values. */
  trigger: TriggerKind;
  schedule: ScheduleValues;
  /** The hook's event as written: the form edits the events it offers (`triggerWords.ts`), and says
   *  any other in words. */
  hookEvent: string;
  /** A first open's or an agent session hook's project filter, its id as written; empty is any
   *  project. */
  hookProject: string;
  /** An agent session hook's agent filter, its roster id as written; empty is any agent. */
  hookAgent: string;
  /** A session status hook's status (`active` · `on-hold` · `done` · `done-skip`), as written. */
  hookStatus: string;
  /** A service: whether a chain acts on it (`after:`). */
  serviceChain: boolean;
  /** A chain's job, its id as written; empty until one is chosen. A script's chain and a service's
   *  share it, so a switch of kind keeps it. */
  chainJob: string;
  chainResult: ChainResult;
  /** What a service's chain does to it. */
  chainAction: ServiceAction;
  /** What a missed run becomes; applies to a job on a schedule. */
  missed: MissedPolicy;
  /** With `missed: run-on-wake`: until the next scheduled run, or until `worthAt`. */
  worth: WorthUntil;
  /** A time of day as typed; written when `worth` is `time`. */
  worthAt: string;
  overlap: OverlapPolicy;
  lowPriority: boolean;
  /** A duration as typed (`45m`, `2h`, `1h30m`); empty is no limit. */
  timeLimit: string;
  notify: Notify;
  /** A git job: the operation, and the repos by the name Pomade's Git panel shows, in the order
   *  they run. */
  operation: GitOperation;
  repos: readonly string[];
  /** An agent job: the agent's roster id, its mode, and the prompt — the file's body, trimmed. */
  agent: string;
  mode: string;
  prompt: string;
}

export type FormField = keyof FormValues;

/** What a kind makes of the form: the file's fields, and which form field an error about a file
 *  field belongs to. Each kind is registered here and its sections in `kinds.tsx`. */
export interface KindFile {
  /** The job file's fields from the values; `undefined` leaves a field out. */
  fields(values: FormValues): Record<string, FieldInput | undefined>;
  /** File field (its top-level name; `body` for the body) → the form field that shows its errors. */
  errorFields: Readonly<Record<string, FormField>>;
  /** The file's body the kind writes from the values; `undefined` leaves the body as it is. */
  body?(values: FormValues): string;
}

/** The values whose default depends on the kind: switching kind resets them unless the person set them. */
export const KIND_DEFAULT_FIELDS = ["missed", "overlap", "lowPriority", "notify"] as const satisfies readonly FormField[];

function kindDefaults(kind: JobKind): Pick<FormValues, (typeof KIND_DEFAULT_FIELDS)[number]> {
  return { missed: KIND_DEFAULTS[kind].missed ?? "run-on-wake", overlap: "skip", lowPriority: KIND_DEFAULTS[kind].lowPriority, notify: KIND_DEFAULTS[kind].notify };
}

/** The fields every kind writes the same way. */
function commonFields(values: FormValues): Record<string, FieldInput | undefined> {
  const defaults = kindDefaults(values.kind);
  return {
    kind: values.kind,
    name: values.name.trim(),
    project: values.project ?? undefined,
    folder: values.folder.trim(),
    enabled: values.enabled,
    "low-priority": values.lowPriority === defaults.lowPriority ? undefined : values.lowPriority,
    notify: values.notify === defaults.notify ? undefined : values.notify,
  };
}

const COMMON_ERROR_FIELDS: Readonly<Record<string, FormField>> = {
  kind: "kind",
  name: "name",
  project: "project",
  folder: "folder",
  enabled: "enabled",
  "low-priority": "lowPriority",
  notify: "notify",
};

/** A port as typed: a number when it is digits, else the text, so the validator says what is wrong. */
function portValue(text: string): number | string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/** A chain's `after:` — the job (left out while none is chosen, so the checker asks for one) and the
 *  result, written out; a service's with its action. */
function chainInput(values: FormValues): FieldInput {
  const job = values.chainJob.trim() === "" ? null : values.chainJob.trim();
  return values.kind === "service" ? { job, result: values.chainResult, action: values.chainAction } : { job, result: values.chainResult };
}

const SERVICE: KindFile = {
  fields: (values) => ({
    ...commonFields(values),
    command: values.command.trim(),
    start: values.start === "login" ? undefined : values.start,
    "start-project": values.start === "login" || values.startProject.trim() === "" ? undefined : values.startProject.trim(),
    ready: values.ready === "alive" ? undefined : values.ready === "port" ? { port: portValue(values.port) } : { url: values.url.trim() === "" ? null : values.url.trim() },
    after: values.serviceChain ? chainInput(values) : undefined,
  }),
  errorFields: { ...COMMON_ERROR_FIELDS, command: "command", start: "start", "start-project": "start", ready: "ready", after: "chainJob" },
};

/** A job that runs once per trigger writes its one trigger — a schedule, a hook's event, or a chain
 *  — and, for a schedule, its missed-run policy (`worth-until` only with `run-on-wake`); and its
 *  overlap and time limit. A policy at its default is left out; a limit of digits only is written
 *  as a number, so the checker says it has no unit. A hook writes its event and the filters its
 *  event takes — a first open's project; a session finished's project and agent; a status change's
 *  status, project and agent — a filter left empty is left out; an edit that keeps the file's hook
 *  writes no hook, so a comment on it stays. */
function runFields(values: FormValues): Record<string, FieldInput | undefined> {
  const scheduled = values.trigger === "schedule";
  const timeLimit = values.timeLimit.trim();
  return {
    schedule: scheduled ? scheduleInput(values.schedule) : undefined,
    hook: values.trigger === "hook" ? hookInput(values) : undefined,
    after: values.trigger === "chain" ? chainInput(values) : undefined,
    missed: scheduled && values.missed !== kindDefaults(values.kind).missed ? values.missed : undefined,
    "worth-until": scheduled && values.missed === "run-on-wake" && values.worth === "time" ? values.worthAt.trim() : undefined,
    overlap: values.overlap === "skip" ? undefined : values.overlap,
    "time-limit": timeLimit === "" ? undefined : /^\d+$/.test(timeLimit) ? Number(timeLimit) : timeLimit,
  };
}

/** A hook's `hook:` — its event, then the filters its event takes that are picked. */
function hookInput(values: FormValues): FieldInput {
  const event = values.hookEvent;
  const picked = (filter: HookFilter): string => (filter === "project" ? values.hookProject : filter === "agent" ? values.hookAgent : values.hookStatus).trim();
  const filters = HOOK_FILTER_ORDER.filter((filter) => isHookEvent(event) && [...HOOK_FILTERS[event].required, ...HOOK_FILTERS[event].optional].includes(filter) && picked(filter) !== "");
  return { event, ...Object.fromEntries(filters.map((filter) => [filter, picked(filter)])) };
}

/** The order a hook's filters are written in: `{ event: session-status, status: done, project: p1, agent: claude }`. */
const HOOK_FILTER_ORDER: readonly HookFilter[] = ["status", "project", "agent"];

const isHookEvent = (event: string): event is HookEvent => (HOOK_EVENTS as readonly string[]).includes(event);

/** A hook's errors show on the trigger; a chain's — a chain that loops back among them — on its job. */
const RUN_ERROR_FIELDS: Readonly<Record<string, FormField>> = {
  schedule: "schedule",
  hook: "trigger",
  after: "chainJob",
  missed: "missed",
  "worth-until": "worthAt",
  overlap: "overlap",
  "time-limit": "timeLimit",
};

const SCRIPT: KindFile = {
  fields: (values) => ({ ...commonFields(values), command: values.command.trim(), ...runFields(values) }),
  errorFields: { ...COMMON_ERROR_FIELDS, command: "command", ...RUN_ERROR_FIELDS },
};

/** A git job names no folder: `pomade-git` works in the repos it names. */
const GIT: KindFile = {
  fields: (values) => ({ ...commonFields(values), folder: undefined, git: { operation: values.operation, repos: values.repos }, ...runFields(values) }),
  errorFields: { ...COMMON_ERROR_FIELDS, git: "repos", ...RUN_ERROR_FIELDS },
};

/** An agent job: the agent, the folder it starts in, the mode (Normal left out), and the prompt as the body. */
const AGENT: KindFile = {
  fields: (values) => ({ ...commonFields(values), agent: values.agent.trim(), mode: values.mode === "normal" ? undefined : values.mode, ...runFields(values) }),
  errorFields: { ...COMMON_ERROR_FIELDS, agent: "agent", mode: "mode", body: "prompt", ...RUN_ERROR_FIELDS },
  body: (values) => (values.prompt.trim() === "" ? "" : `${values.prompt.trim()}\n`),
};

/** The kinds the form builds. */
export const FORM_KINDS: Record<JobKind, KindFile> = { service: SERVICE, script: SCRIPT, agent: AGENT, git: GIT };

/** A form's state: the values, what the person set, and the file it edits. */
export interface FormState {
  values: FormValues;
  /** The fields the person set in this form. */
  touched: readonly FormField[];
  /** The values of the file as last read — a new job's: the blank form's. An edit writes what
   *  differs from them. */
  base: FormValues;
  /** The file's text as last read; `null` for a new job. */
  text: string | null;
  /** The file's path, workspace-relative, as last read; `null` for a new job. */
  path: string | null;
  /** Fields the file changed on disk after the person set them; their edits stay. */
  clashes: readonly FormField[];
  /** Save was pressed: every error shows. */
  tried: boolean;
}

export function blankValues(kind: JobKind): FormValues {
  return { kind, name: "", project: null, folder: "", enabled: true, command: "", start: "login", startProject: "", ready: "alive", port: "", url: "", trigger: "schedule", schedule: blankSchedule(), hookEvent: "login", hookProject: "", hookAgent: "", hookStatus: "done", serviceChain: false, chainJob: "", chainResult: "done", chainAction: "restart", worth: "next-run", worthAt: "12:00", timeLimit: "", operation: "commit-push", repos: [], agent: "claude", mode: "normal", prompt: "", ...kindDefaults(kind) };
}

/** A new job's form. */
export function newForm(kind: JobKind): FormState {
  const values = blankValues(kind);
  return { values, touched: [], base: values, text: null, path: null, clashes: [], tried: false };
}

const asText = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const isMapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The values a job file's text says; `null` when its frontmatter cannot be read or its kind is not
 *  one the format has. A value the form cannot show stands at its default. */
export function valuesFromText(text: string): FormValues | null {
  const read = readJobDocument(text);
  if (!read.ok) return null;
  const fields = read.doc.fields;
  const kind = JOB_KINDS.find((candidate) => candidate === fields.kind);
  if (kind === undefined) return null;
  const values = blankValues(kind);
  const ready = fields.ready;
  const choice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.find((candidate) => candidate === value) ?? fallback);
  const worthUntil = asText(fields["worth-until"]).trim();
  const hook = fields.hook;
  const after = fields.after;
  const worthTime = worthUntil !== "" && worthUntil !== "next-run";
  const git = isMapping(fields.git) ? fields.git : {};
  return {
    ...values,
    name: asText(fields.name),
    project: typeof fields.project === "string" && fields.project.trim() !== "" ? fields.project.trim() : null,
    folder: asText(fields.folder),
    enabled: typeof fields.enabled === "boolean" ? fields.enabled : true,
    command: asText(fields.command),
    start: choice(fields.start, SERVICE_STARTS, "login"),
    startProject: asText(fields["start-project"]).trim(),
    ready: isMapping(ready) && ready.port != null ? "port" : isMapping(ready) && ready.url != null ? "url" : "alive",
    port: isMapping(ready) ? asText(ready.port) : "",
    url: isMapping(ready) ? asText(ready.url) : "",
    trigger: kind !== "service" && fields.schedule === undefined && fields.hook !== undefined ? "hook" : kind !== "service" && fields.schedule === undefined && fields.after !== undefined ? "chain" : "schedule",
    schedule: readSchedule(fields.schedule),
    hookEvent: isMapping(hook) ? asText(hook.event).trim() : hook === undefined ? values.hookEvent : "",
    hookProject: isMapping(hook) ? asText(hook.project).trim() : "",
    hookAgent: isMapping(hook) ? asText(hook.agent).trim() : "",
    hookStatus: isMapping(hook) && hook.status != null ? asText(hook.status).trim() : values.hookStatus,
    serviceChain: kind === "service" && after !== undefined,
    chainJob: isMapping(after) ? asText(after.job).trim() : "",
    chainResult: isMapping(after) ? choice(after.result, CHAIN_RESULTS, values.chainResult) : values.chainResult,
    chainAction: isMapping(after) ? choice(after.action, SERVICE_ACTIONS, values.chainAction) : values.chainAction,
    missed: choice(fields.missed, MISSED_POLICIES, values.missed),
    worth: worthTime ? "time" : "next-run",
    worthAt: worthTime ? worthUntil : values.worthAt,
    overlap: choice(fields.overlap, OVERLAP_POLICIES, values.overlap),
    timeLimit: asText(fields["time-limit"]).trim(),
    lowPriority: typeof fields["low-priority"] === "boolean" ? fields["low-priority"] : values.lowPriority,
    notify: choice(fields.notify, NOTIFY_VALUES, values.notify),
    operation: choice(git.operation, GIT_OPERATIONS, values.operation),
    repos: gitRepos(git.repos),
    agent: asText(fields.agent).trim() || values.agent,
    mode: asText(fields.mode).trim() || values.mode,
    prompt: read.doc.body.trim(),
  };
}

/** A git job's repos as the file lists them — one written as a lone name, too; what is not a name
 *  is left out (the checker says so on the file). */
function gitRepos(value: unknown): string[] {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  return list.flatMap((repo) => (typeof repo === "string" && repo.trim() !== "" ? [repo.trim()] : []));
}

/** The form editing the job file at `path` with `text`; `null` when the form cannot show it. */
export function editForm(path: string, text: string): FormState | null {
  const values = valuesFromText(text);
  if (values === null) return null;
  return { values, touched: [], base: values, text, path, clashes: [], tried: false };
}

const touch = (touched: readonly FormField[], field: FormField): readonly FormField[] => (touched.includes(field) ? touched : [...touched, field]);

/** The person sets a value. */
export function setValue<F extends FormField>(state: FormState, field: F, value: FormValues[F]): FormState {
  return { ...state, values: { ...state.values, [field]: value }, touched: touch(state.touched, field) };
}

/** The project a folder belongs to: the one whose root holds it, the deepest; `undefined` for none. */
export function projectOfFolder(folder: string, projects: readonly ProjectRecord[]): ProjectRecord | undefined {
  const path = folder.trim().replace(/\/+$/, "");
  let best: ProjectRecord | undefined;
  for (const project of projects) {
    if (project.root === "" || !(path === project.root || path.startsWith(`${project.root}/`))) continue;
    if (best === undefined || project.root.length > best.root.length) best = project;
  }
  return best;
}

/** The person sets the folder: a folder inside a project fills in that project. */
export function setFolder(state: FormState, folder: string, projects: readonly ProjectRecord[]): FormState {
  const next = setValue(state, "folder", folder);
  const project = projectOfFolder(folder, projects);
  return project === undefined || project.id === next.values.project ? next : setValue(next, "project", project.id);
}

/** The person picks another kind: what they set stays; the defaults they left alone become the new kind's. */
export function switchKind(state: FormState, kind: JobKind): FormState {
  if (state.values.kind === kind) return state;
  const values: FormValues = { ...state.values, kind };
  const defaults = kindDefaults(kind);
  for (const field of KIND_DEFAULT_FIELDS) if (!state.touched.includes(field)) Object.assign(values, { [field]: defaults[field] });
  return { ...state, values, touched: touch(state.touched, "kind") };
}

/** The file changed on disk: the fields the person left alone follow it; the ones they set stay, and
 *  those the file changed too are clashes. A text the form cannot read keeps the values. */
export function followText(state: FormState, text: string): FormState {
  const read = valuesFromText(text);
  if (read === null) return { ...state, text };
  const values = { ...state.values };
  const clashes = [...state.clashes];
  for (const field of Object.keys(read) as FormField[]) {
    if (!state.touched.includes(field)) Object.assign(values, { [field]: read[field] });
    else if (!sameValue(read[field], state.base[field]) && !clashes.includes(field)) clashes.push(field);
  }
  return { ...state, values, base: read, text, clashes };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameInput(a: FieldInput | undefined, b: FieldInput | undefined): boolean {
  return sameValue(a, b);
}

/** The field changes an edit writes: every file field whose value differs from the file as read,
 *  in the order fields are written; `undefined` removes one. */
export function fieldChanges(state: FormState): FieldChanges {
  const now = FORM_KINDS[state.values.kind].fields(state.values);
  const was = FORM_KINDS[state.base.kind].fields(state.base);
  const keys = [...FIELD_ORDER, ...Object.keys({ ...was, ...now }).filter((key) => !(FIELD_ORDER as readonly string[]).includes(key))];
  const changes: Record<string, FieldInput | undefined> = {};
  for (const key of keys) if ((key in now || key in was) && !sameInput(now[key], was[key])) changes[key] = now[key];
  return changes;
}

/** The body an edit writes: the kind's, when it differs from the file's as read; `undefined` when
 *  the body stays. */
export function bodyChange(state: FormState): string | undefined {
  const write = FORM_KINDS[state.values.kind].body;
  if (write === undefined || state.text === null) return undefined;
  return state.values.prompt.trim() === state.base.prompt.trim() && state.values.kind === state.base.kind ? undefined : write(state.values);
}

/** A new job's body: the one its kind writes, else none. */
/** Whether a new job starts as it is created: an enabled service that starts at login, or on the
 *  first open of a project already opened since Pomade started (`opened`, ids) — its start project
 *  the one picked, else the job's own. */
export function startsOnCreate(values: FormValues, opened: ReadonlySet<string>): boolean {
  if (values.kind !== "service" || !values.enabled) return false;
  if (values.start === "login") return true;
  const project = values.startProject.trim() || values.project;
  return project !== null && project !== "" && opened.has(project);
}

export function newBody(values: FormValues): string {
  return FORM_KINDS[values.kind].body?.(values) ?? "";
}

/** A new job's fields: the ones its kind writes. */
function newFields(values: FormValues): Record<string, FieldInput> {
  const fields = FORM_KINDS[values.kind].fields(values);
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, FieldInput] => entry[1] !== undefined));
}

/** The sub-folder of the jobs folder a project's jobs sit in; `null` for the Workspace. A project
 *  Pomade does not list keeps `fallback`. */
function subFolderOf(project: string | null, projects: readonly ProjectRecord[], fallback: string | null): string | null {
  if (project === null) return null;
  const record = projects.find((candidate) => candidate.id === project);
  return record === undefined ? fallback : projectJobsFolder(record);
}

/** The sub-folder a job file sits in (`Apps/pomade-runner/jobs/<sub>/x.md`); `null` at the top. */
function subFolderOfPath(path: string): string | null {
  const parts = path.slice(JOBS_FOLDER.length + 1).split("/");
  return parts.length > 1 ? (parts[0] ?? null) : null;
}

/** The file the form would write: its path, its whole text, and the path it leaves when the project
 *  moves it to another sub-folder. */
export interface WouldBe {
  path: string;
  text: string;
  /** The file's path now, when the save moves it; `null` otherwise. */
  movesFrom: string | null;
}

export function wouldBe(state: FormState, snapshot: JobsSnapshot, projects: readonly ProjectRecord[]): WouldBe {
  if (state.path === null || state.text === null) {
    const taken = new Set(snapshot.jobs.map((entry) => (entry.valid ? entry.job.path : entry.invalid.path)));
    let path = "";
    for (const candidate of jobFileCandidates(subFolderOf(state.values.project, projects, null), state.values.name)) {
      if (!taken.has(candidate)) {
        path = candidate;
        break;
      }
    }
    return { path, text: newJobText(newFields(state.values), newBody(state.values)), movesFrom: null };
  }
  const written = setJobFields(state.text, fieldChanges(state));
  const body = bodyChange(state);
  const withBody = written.ok && body !== undefined ? setBody(written.text, body) : written;
  const text = withBody.ok ? withBody.text : state.text;
  if (state.values.project === state.base.project) return { path: state.path, text, movesFrom: null };
  const sub = subFolderOf(state.values.project, projects, subFolderOfPath(state.path));
  const path = `${JOBS_FOLDER}/${sub === null ? "" : `${sub}/`}${baseName(state.path)}`;
  return { path, text, movesFrom: path === state.path ? null : state.path };
}

/** The validator's errors of the file the form would write. */
export function formErrors(state: FormState, snapshot: JobsSnapshot, projects: readonly ProjectRecord[] | null): JobError[] {
  const file = wouldBe(state, snapshot, projects ?? []);
  return checkJobAmong({ path: file.path.slice(JOBS_FOLDER.length + 1), text: file.text }, snapshot, { projects, replaces: file.movesFrom ?? undefined });
}

/** Where an error shows: on a form field, or — about something the form has no field for — on the file. */
export type ErrorPlace = FormField | "file";

export function errorPlace(error: JobError, values: FormValues): ErrorPlace {
  const top = error.field.split(/[.[]/)[0] ?? "";
  const place = FORM_KINDS[values.kind].errorFields[top] ?? "file";
  return place !== "file" && !drawn(values, place) ? "file" : place;
}

/** Whether the form draws the control of a field now: a missed-run policy only for a job on a
 *  schedule, and its time of day only with `run-on-wake` until a time; a chain's job only while
 *  the job has a chain. An error about a control that is not drawn is the file's. */
function drawn(values: FormValues, field: FormField): boolean {
  const scheduled = values.trigger === "schedule";
  if (field === "chainJob") return values.kind === "service" ? values.serviceChain : values.trigger === "chain";
  if (field === "missed") return scheduled;
  if (field === "worthAt") return scheduled && values.missed === "run-on-wake" && values.worth === "time";
  return true;
}

/** Errors by where they show, each in the validator's order. */
export function errorsByPlace(errors: readonly JobError[], values: FormValues): Map<ErrorPlace, JobError[]> {
  const places = new Map<ErrorPlace, JobError[]>();
  for (const error of errors) {
    const place = errorPlace(error, values);
    places.set(place, [...(places.get(place) ?? []), error]);
  }
  return places;
}

function filled(values: FormValues, field: FormField): boolean {
  if (field === "schedule") return true;
  if (field === "ready") return values.ready === "alive" || (values.ready === "port" ? values.port : values.url).trim() !== "";
  const value = values[field];
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "string" || value.trim() !== "";
}

/**
 * Whether a place's errors show now. Editing a job, always: the file on disk has them. A new job's
 * show once Save was pressed, or on a field the person filled in — an empty field is not an error
 * before they try to save.
 */
export function errorShows(state: FormState, place: ErrorPlace): boolean {
  if (state.path !== null || state.tried) return true;
  return place !== "file" && state.touched.includes(place) && filled(state.values, place);
}

/** Whether the errors keep Save from writing: a new job's all do; an edit's, those on the form's
 *  fields — a problem the form has no field for is the file's, and stays as it is. */
export function blocksSave(state: FormState, place: ErrorPlace): boolean {
  return state.path === null || place !== "file";
}

/** Whether the person changed anything the file would get. */
export function hasChanges(state: FormState): boolean {
  return state.path === null || Object.keys(fieldChanges(state)).length > 0 || bodyChange(state) !== undefined;
}

/** The file's own value of a field as last read — for what the form shows but does not edit
 *  (a missed-run policy, a time limit); `undefined` for a new job or a field the file lacks. */
export function fileValue(state: FormState, field: string): unknown {
  if (state.text === null) return undefined;
  const read = readJobDocument(state.text);
  return read.ok ? read.doc.fields[field] : undefined;
}

/** The project and folder choices Pomade gives, as the checks need them. */
export function projectRecords(projects: readonly { id: string; name: string; root: string }[]): ProjectRecord[] {
  return projects.map(({ id, name, root }) => ({ id, name, root }));
}
