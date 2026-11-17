// The `pomade-runner` command: what it prints and how it exits, for the arguments it is given.

import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { APP_VERSION } from "../../app";
import { exitWords, type KeeperLink, type RunnerSession, type SessionsReport } from "../../keeper/model";
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
  ${COMMAND} check [file…]   check job files: every one in the workspace, or the files given;
                            prints path:line: field — problem. Fix: … per problem; exit 1 on any
  ${COMMAND} projects        Pomade's projects: the id a project job's project: takes and the
                            sub-folder of ${JOBS_FOLDER}/ its jobs sit in (needs Pomade running)
  ${COMMAND} sessions        the keeper and its sessions: each one's job, state and output log
                            (needs the scheduler running)
  ${COMMAND} --version       print the version and whether the scheduler is running
  ${COMMAND} --help          print this help
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

async function sessions(deps: CliDeps): Promise<number> {
  const result = await deps.sessions();
  if (result === null || result.status !== "ok") {
    const why =
      result === null
        ? `there is no scheduler to ask — ${COMMAND} was not started through Pomade's command folder`
        : result.status === "not-running"
          ? "the scheduler is not running — it holds the sessions; Pomade runs it as Runner's background part"
          : `the scheduler did not answer — ${result.message}`;
    deps.err(`${COMMAND} sessions: ${why}.\n`);
    return EXIT_PROBLEMS;
  }
  const { keeper, sessions: list } = result.value;
  deps.out(`${keeperLine(keeper)}\n`);
  if (list.length === 0) deps.out("No sessions.\n");
  for (const session of [...list].sort((a, b) => a.id.localeCompare(b.id))) deps.out(`${sessionLine(session)}\n`);
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
  if (first === "check" || first === "projects" || first === "sessions") {
    const option = rest.find((arg) => arg.startsWith("-"));
    if (option !== undefined || (first !== "check" && rest.length > 0)) {
      deps.err(`${COMMAND} ${first}: unexpected "${option ?? rest[0] ?? ""}". Run \`${COMMAND} --help\` for what it takes.\n`);
      return EXIT_USAGE;
    }
    if (first === "check") return check(rest, deps);
    return first === "projects" ? projects(deps) : sessions(deps);
  }
  const what = first.startsWith("-") ? "option" : "command";
  deps.err(`${COMMAND}: unknown ${what} "${first}". Run \`${COMMAND} --help\` for what it takes.\n`);
  return EXIT_USAGE;
}
