// The `pomade-runner` command: what it prints and how it exits, for the arguments it is given.

import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { APP_VERSION } from "../../app";
import type { ServiceVerb } from "../../integrations/runner-api";
import { exitWords, type KeeperLink, type RunnerSession, type ServicesReport, type ServiceStatus, type SessionsReport } from "../../keeper/model";
import type { ControlCallResult } from "../../scheduler/control/client";
import type { SchedulerStatus } from "../../scheduler/control/protocol";
import { checkJobs, projectJobsFolder } from "../check";
import { formatJobError } from "../format";
import { entryPath, JOBS_FOLDER, type ProjectRecord } from "../model";
import type { JobFileInput } from "../parse";

export const COMMAND = "pomade-runner";

/** Exit codes: 0 done · 1 problems found (or Pomade needed and closed) · 2 the command could not run. */
export const EXIT_OK = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

export interface CliDeps {
  out(text: string): void;
  err(text: string): void;
  /** The directory the command runs in, for reading and printing paths. */
  cwd: string;
  /** Asks the scheduler for its status; `null` when the command does not run under Pomade's shim,
   *  so there is no scheduler to find. */
  schedulerStatus(): Promise<ControlCallResult<SchedulerStatus> | null>;
  /** Asks the scheduler for the keeper's sessions; `null` as for `schedulerStatus`. */
  sessions(): Promise<ControlCallResult<SessionsReport> | null>;
  /** Asks the scheduler for the services; `null` as for `schedulerStatus`. */
  services(): Promise<ControlCallResult<ServicesReport> | null>;
  /** Asks the scheduler to start, stop or restart a service (by its id or name); `null` as for `schedulerStatus`. */
  serviceAction(action: ServiceVerb, job: string): Promise<ControlCallResult<ServiceStatus> | null>;
  /** The workspace root (absolute, by its real path), with Pomade open or closed; `null` when none is recorded. */
  workspace(): string | null;
  /** An absolute path by its real path (symlinks resolved), as far as it exists. */
  realPath(path: string): string;
  /** The job files under an absolute jobs folder; `null` when it does not exist. */
  readJobFiles(folder: string): Promise<JobFileInput[] | null>;
  /** Pomade's projects; `null` when Pomade is not running (or this is not run through its shim). */
  projects(): Promise<ProjectRecord[] | null>;
}

export const USAGE = `${COMMAND} ${APP_VERSION} — Runner from the command line

Usage:
  ${COMMAND} check [file…]        check job files: every one in the workspace, or the files
                                 given; prints path:line: field — problem. Fix: … per problem;
                                 exit 1 on any
  ${COMMAND} projects             Pomade's projects: the id a project job's project: takes and the
                                 sub-folder of ${JOBS_FOLDER}/ its jobs sit in (needs Pomade
                                 running)
  ${COMMAND} services             every service: its state, restarts and last crash
  ${COMMAND} run <service>        start a service now, by its id or name — one stopped by you or
                                 failed too
  ${COMMAND} stop <service>       stop a service; it stays stopped until run
  ${COMMAND} restart <service>    restart a service with its job file as it is now
  ${COMMAND} sessions             the keeper and its sessions: each one's job, state and output log
  ${COMMAND} --version            print the version and whether the scheduler is running
  ${COMMAND} --help               print this help

services, run, stop, restart and sessions need the scheduler running.
`;

function schedulerLine(result: ControlCallResult<SchedulerStatus> | null): string {
  if (result === null) return `scheduler: unknown — ${COMMAND} was not started through Pomade's command folder`;
  if (result.status === "not-running") return "scheduler: not running";
  if (result.status === "failed") return `scheduler: not answering — ${result.message}`;
  const { version, pid, startedAt, pomade } = result.value;
  const link = pomade === "connected" ? "connected to Pomade" : pomade === "rejected" ? "refused by Pomade" : "Pomade closed";
  return `scheduler: running — ${version}, pid ${pid}, since ${startedAt}, ${link}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

async function check(files: readonly string[], deps: CliDeps): Promise<number> {
  const workspace = deps.workspace();
  if (workspace === null) {
    deps.err(`${COMMAND}: no workspace — Pomade records the one it has open; open Pomade once, or set POMADE_WORKSPACE.\n`);
    return EXIT_USAGE;
  }
  const folder = join(workspace, JOBS_FOLDER);
  const show = (path: string): string => {
    const shown = relative(deps.cwd, path);
    if (shown === "") return ".";
    return shown.startsWith("..") || isAbsolute(shown) ? path : shown;
  };

  const wanted = new Set<string>();
  const problems: string[] = [];
  for (const file of files) {
    const absolute = deps.realPath(resolve(deps.cwd, file));
    const inside = relative(folder, absolute);
    if (inside.startsWith("..") || isAbsolute(inside) || !absolute.endsWith(".md")) {
      problems.push(`${file}: not a job file — Runner reads job files only from ${folder}. Fix: move it there (a project job into its project's sub-folder), as <slug>.md.`);
    } else {
      wanted.add(inside.split(sep).join("/"));
    }
  }

  const read = (await deps.readJobFiles(folder)) ?? [];
  const snapshot = checkJobs(read, { workspace, projects: await deps.projects() });
  const present = new Set(read.map((f) => f.path));
  for (const path of wanted) {
    if (!present.has(path)) problems.push(`${show(join(folder, path))}: no such job file. Fix: check the path, or write the file first.`);
  }
  const checked = snapshot.jobs.filter((entry) => wanted.size === 0 || wanted.has(entryPath(entry).slice(JOBS_FOLDER.length + 1)));
  let invalid = 0;
  for (const entry of checked) {
    if (entry.valid) continue;
    invalid++;
    for (const error of entry.invalid.errors) problems.push(formatJobError(error, show(join(workspace, error.path))));
  }

  for (const line of problems) deps.out(`${line}\n`);
  const scope = wanted.size === 0 ? `${plural(checked.length, "job file")} in ${show(folder)}` : plural(checked.length, "job file");
  if (problems.length === 0) deps.out(`${scope}: no problems.\n`);
  else deps.out(`${plural(problems.length, "problem")}${invalid > 0 ? ` in ${invalid} of ${scope}` : ""}.\n`);
  if (!snapshot.projectsChecked) deps.out("Project ids were not checked: Pomade is closed. Run it again with Pomade open to check them too.\n");
  return problems.length === 0 ? EXIT_OK : EXIT_PROBLEMS;
}

async function projects(deps: CliDeps): Promise<number> {
  const list = await deps.projects();
  if (list === null) {
    deps.err(`${COMMAND}: Pomade is not running — project ids come from Pomade. Open Pomade and run it again.\n`);
    return EXIT_PROBLEMS;
  }
  if (list.length === 0) {
    deps.out("Pomade has no projects.\n");
    return EXIT_OK;
  }
  for (const project of list) {
    deps.out(`${project.id}  ${project.name}  (${project.root})  → ${JOBS_FOLDER}/${projectJobsFolder(project)}/\n`);
  }
  return EXIT_OK;
}

function keeperLine(keeper: KeeperLink): string {
  switch (keeper.state) {
    case "connected":
      return `keeper: running — version ${keeper.version}, pid ${keeper.pid}`;
    case "connecting":
      return "keeper: connecting";
    case "unreachable":
      return `keeper: not reachable — ${keeper.reason}`;
    case "rejected":
      return `keeper: refused the scheduler — ${keeper.reason}`;
  }
}

function sessionLine({ id, job, log, info }: RunnerSession): string {
  const state =
    info.exit === null
      ? `running, pid ${info.pid ?? "?"}, since ${new Date(info.startedAt).toISOString()}`
      : `ended: ${exitWords(info.exit)}, at ${new Date(info.exit.at).toISOString()}`;
  return `${id}  job ${job}  ${state}${log === null ? "" : `  output ${log}`}`;
}

/** The scheduler's answer, or why there is none: a refusal says why itself. */
function answerOf<T>(result: ControlCallResult<T> | null, holds: string): { ok: true; value: T } | { ok: false; why: string } {
  if (result === null) return { ok: false, why: `there is no scheduler to ask — ${COMMAND} was not started through Pomade's command folder` };
  if (result.status === "ok") return { ok: true, value: result.value };
  if (result.status === "not-running") return { ok: false, why: `the scheduler is not running — it ${holds}; Pomade runs it as Runner's background part` };
  return { ok: false, why: result.code === "refused" ? result.message : `the scheduler did not answer — ${result.message}` };
}

async function sessions(deps: CliDeps): Promise<number> {
  const answer = answerOf(await deps.sessions(), "holds the sessions");
  if (!answer.ok) {
    deps.err(`${COMMAND} sessions: ${answer.why}.\n`);
    return EXIT_PROBLEMS;
  }
  const { keeper, sessions: list } = answer.value;
  deps.out(`${keeperLine(keeper)}\n`);
  if (list.length === 0) deps.out("No sessions.\n");
  for (const session of [...list].sort((a, b) => a.id.localeCompare(b.id))) deps.out(`${sessionLine(session)}\n`);
  return EXIT_OK;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Where a service stands, in words. */
function stateWords({ state, session, retryAt }: ServiceStatus): string {
  const runs = session?.info.state === "running" ? `, pid ${session.info.pid ?? "?"}, since ${iso(session.info.startedAt)}` : "";
  switch (state) {
    case "queued":
      return "queued to start";
    case "starting":
      return `starting${runs}`;
    case "running":
      return `running${runs}`;
    case "restarting":
      return `restarting at ${retryAt === null ? "?" : iso(retryAt)}`;
    case "failed":
      return "failed: 5 crashes within a minute";
    case "stopped-by-you":
      return "stopped by you";
    case "waiting":
      return "waits for its project to open";
    case "disabled":
      return "disabled in its file";
    case "invalid":
      return `its job file is invalid — see ${COMMAND} check${runs === "" ? "" : `; still running${runs}`}`;
    case "removed":
      return "its job file is gone; stopping";
  }
}

/** A service in one line: `web  Web  running, pid 501, since … · restarted 2×, last crash …`. */
function serviceLine(status: ServiceStatus): string {
  const notes = [
    status.restarts > 0 ? `restarted ${status.restarts}×` : null,
    status.lastCrashAt === null ? null : `last crash ${iso(status.lastCrashAt)}`,
    status.needsRestart ? "its job file changed: restart to apply it" : null,
    status.problem === null ? null : `last start failed: ${status.problem}`,
  ].filter((note) => note !== null);
  return `${status.job}  ${status.name}  ${stateWords(status)}${notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}`;
}

async function services(deps: CliDeps): Promise<number> {
  const answer = answerOf(await deps.services(), "supervises the services");
  if (!answer.ok) {
    deps.err(`${COMMAND} services: ${answer.why}.\n`);
    return EXIT_PROBLEMS;
  }
  const { keeper, services: list } = answer.value;
  deps.out(`${keeperLine(keeper)}\n`);
  if (list.length === 0) deps.out("No services.\n");
  for (const status of list) deps.out(`${serviceLine(status)}\n`);
  return EXIT_OK;
}

const VERBS: Record<string, ServiceVerb> = { run: "start", stop: "stop", restart: "restart" };

async function serviceAction(name: string, verb: ServiceVerb, job: string, deps: CliDeps): Promise<number> {
  const answer = answerOf(await deps.serviceAction(verb, job), "supervises the services");
  if (!answer.ok) {
    deps.err(`${COMMAND} ${name}: ${answer.why}.\n`);
    return EXIT_PROBLEMS;
  }
  deps.out(`${serviceLine(answer.value)}\n`);
  return EXIT_OK;
}

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [first, ...rest] = args;
  if (first === undefined || first === "--help" || first === "-h") {
    deps.out(USAGE);
    return EXIT_OK;
  }
  if (first === "--version" || first === "-V") {
    deps.out(`${COMMAND} ${APP_VERSION}\n${schedulerLine(await deps.schedulerStatus())}\n`);
    return EXIT_OK;
  }
  if (first === "check" || first === "projects" || first === "sessions" || first === "services") {
    const option = rest.find((arg) => arg.startsWith("-"));
    if (option !== undefined || (first !== "check" && rest.length > 0)) {
      deps.err(`${COMMAND} ${first}: unexpected "${option ?? rest[0] ?? ""}". Run \`${COMMAND} --help\` for what it takes.\n`);
      return EXIT_USAGE;
    }
    if (first === "check") return check(rest, deps);
    if (first === "projects") return projects(deps);
    return first === "sessions" ? sessions(deps) : services(deps);
  }
  const verb = Object.hasOwn(VERBS, first) ? VERBS[first] : undefined;
  if (verb !== undefined) {
    const [job, ...extra] = rest;
    if (job === undefined || job === "" || job.startsWith("-") || extra.length > 0) {
      const problem = job === undefined || job === "" ? "names no service" : `unexpected "${job.startsWith("-") ? job : (extra[0] ?? "")}"`;
      deps.err(`${COMMAND} ${first}: ${problem}. Usage: ${COMMAND} ${first} <service> — its id or its name.\n`);
      return EXIT_USAGE;
    }
    return serviceAction(first, verb, job, deps);
  }
  const what = first.startsWith("-") ? "option" : "command";
  deps.err(`${COMMAND}: unknown ${what} "${first}". Run \`${COMMAND} --help\` for what it takes.\n`);
  return EXIT_USAGE;
}
