// The `pomade-runner` command: what it prints and how it exits, for the arguments it is given.

import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { APP_VERSION } from "../../app";
import { exitWords, type KeeperLink, type RunnerSession, type ServiceStatus } from "../../keeper/model";
import type { ControlCallResult } from "../../scheduler/control/client";
import type { ControlMethod, ControlMethods, ControlParams } from "../../scheduler/control/protocol";
import { gitRepoLine } from "../../scheduler/git-runs";
import { dayTime, durationWords, runTriggerWords, runWords, SWITCH_WORDS, type ActiveRun, type JobListing, type NeedsYouItem, type RunRecord, type SwitchPosition, type SwitchState } from "../../scheduler/model";
import { checkSettings, SETTINGS_PATH } from "../../scheduler/settings";
import { checkJobs, projectJobsFolder } from "../check";
import { formatJobError } from "../format";
import { entryPath, JOBS_FOLDER, type ProjectRecord } from "../model";
import type { JobFileInput } from "../parse";

export const COMMAND = "pomade-runner";

/** How many runs `history` prints. */
export const HISTORY_LIMIT = 20;

/** Exit codes: 0 done · 1 problems found (or Pomade needed and closed) · 2 the command could not run. */
export const EXIT_OK = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

/** A run whose output log is not on this Mac, as `history` says it. */
const OUTPUT_NOT_HERE = "output not on this Mac";

export interface CliDeps {
  out(text: string): void;
  err(text: string): void;
  /** The directory the command runs in, for reading and printing paths. */
  cwd: string;
  /** Calls a method of the scheduler's control protocol; `null` when the command does not run
   *  under Pomade's shim, so there is no scheduler to find. */
  ask<M extends ControlMethod>(method: M, params: ControlParams[M]): Promise<ControlCallResult<ControlMethods[M]> | null>;
  /** The workspace root (absolute, by its real path), with Pomade open or closed; `null` when none is recorded. */
  workspace(): string | null;
  /** An absolute path by its real path (symlinks resolved), as far as it exists. */
  realPath(path: string): string;
  /** The job files under an absolute jobs folder; `null` when it does not exist. */
  readJobFiles(folder: string): Promise<JobFileInput[] | null>;
  /** The settings file's text in a workspace; `null` when it does not exist. */
  readSettings(workspace: string): Promise<string | null>;
  /** Pomade's projects; `null` when Pomade is not running (or this is not run through its shim). */
  projects(): Promise<ProjectRecord[] | null>;
  /** Whether a file is on this Mac: a run's output log is not when its record came with the
   *  workspace from another. */
  exists(path: string): boolean;
}

export const USAGE = `${COMMAND} ${APP_VERSION} — Runner from the command line

Usage:
  ${COMMAND} check [file…]        check job files and the settings file: every one in the
                                 workspace, or the files given; prints
                                 path:line: field — problem. Fix: … per problem; exit 1 on any
  ${COMMAND} projects             Pomade's projects: the id a project job's project: takes and the
                                 sub-folder of ${JOBS_FOLDER}/ its jobs sit in (needs Pomade
                                 running)
  ${COMMAND} list                 every job: its kind, trigger in words, next run and last result
  ${COMMAND} run <job>            run a job now, by its id or name: a script or git job runs (or
                                 queues behind its run going, as its overlap says); a service
                                 starts — one stopped by you or failed too
  ${COMMAND} history [job]        the latest ${HISTORY_LIMIT} finished runs, newest first: of every job, or one
  ${COMMAND} runs                 the runs going — running, queued and what each waits for — the
                                 switch, and what needs you
  ${COMMAND} pause [low|all]      hold scheduled runs: of low-priority jobs, or all (the default);
                                 Run now still runs, services keep running
  ${COMMAND} resume               let held runs go: the late ones follow their missed-run policy
  ${COMMAND} resume-job <job>     let hooks and chains fire a job the loop guard paused again
  ${COMMAND} enable <job>         write enabled: true into a job's file
  ${COMMAND} disable <job>        write enabled: false into a job's file; a running service stops
  ${COMMAND} services             every service: its state, restarts and last crash
  ${COMMAND} stop <service>       stop a service; it stays stopped until run
  ${COMMAND} restart <service>    restart a service with its job file as it is now
  ${COMMAND} sessions             the keeper and its sessions: each one's job, state and output log
  ${COMMAND} --version            print the version and whether the scheduler is running
  ${COMMAND} --help               print this help

Every command but check and projects needs the scheduler running.
`;

function schedulerLine(result: ControlCallResult<ControlMethods["status"]> | null): string {
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
  const settingsFile = join(workspace, SETTINGS_PATH);
  let settings = files.length === 0;
  for (const file of files) {
    const absolute = deps.realPath(resolve(deps.cwd, file));
    const inside = relative(folder, absolute);
    if (absolute === deps.realPath(settingsFile)) {
      settings = true;
    } else if (inside.startsWith("..") || isAbsolute(inside) || !absolute.endsWith(".md")) {
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
  const checked = files.length === 0 || wanted.size > 0 ? snapshot.jobs.filter((entry) => wanted.size === 0 || wanted.has(entryPath(entry).slice(JOBS_FOLDER.length + 1))) : [];
  let invalid = 0;
  for (const entry of checked) {
    if (entry.valid) continue;
    invalid++;
    for (const error of entry.invalid.errors) problems.push(formatJobError(error, show(join(workspace, error.path))));
  }
  const settingsText = settings ? await deps.readSettings(workspace) : null;
  const settingsErrors = settingsText === null ? [] : checkSettings(settingsText).errors;
  for (const error of settingsErrors) problems.push(formatJobError(error, show(settingsFile)));

  for (const line of problems) deps.out(`${line}\n`);
  const jobsScope = wanted.size === 0 && files.length === 0 ? `${plural(checked.length, "job file")} in ${show(folder)}` : plural(checked.length, "job file");
  const scope = settingsText === null ? jobsScope : `${jobsScope} and ${show(settingsFile)}`;
  if (problems.length === 0) deps.out(`${scope}: no problems.\n`);
  else {
    const where = [invalid > 0 ? `${invalid} of ${jobsScope}` : null, settingsErrors.length > 0 ? show(settingsFile) : null].filter((part) => part !== null);
    deps.out(`${plural(problems.length, "problem")}${where.length > 0 ? ` in ${where.join(" and ")}` : ""}.\n`);
  }
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
  const answer = answerOf(await deps.ask("sessions", null), "holds the sessions");
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
    case "waiting-for-pomade":
      return "waits for Pomade to start";
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
  const answer = answerOf(await deps.ask("services", null), "supervises the services");
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

/** A finished run in words: `failed · exit 1, 2026-11-17T12:00:03.000Z, took 3 s`. */
function runLine(record: RunRecord): string {
  return [runWords(record), iso(record.endedAt), record.durationMs === null ? null : `took ${durationWords(record.durationMs)}`].filter((part) => part !== null).join(", ");
}

/** A job in one line: `backup  Backup  script  daily at 13:00  next … · last done, …`. */
function listingLine(listing: JobListing): string {
  const head = `${listing.job}  ${listing.name}`;
  if (listing.kind === null || listing.trigger === null) return `${head}  invalid — ${listing.problem ?? `see ${COMMAND} check`}`;
  if (listing.service !== null) return `${head}  service  ${listing.trigger}  ${stateWords(listing.service)}`;
  const next = !listing.enabled ? "disabled" : listing.finished ? "finished" : listing.next === null ? "no next run" : `next ${iso(listing.next)}`;
  const last = listing.last === null ? "never ran" : `last ${runLine(listing.last)}`;
  return `${head}  ${listing.kind}  ${listing.trigger}  ${next} · ${last}`;
}

async function list(deps: CliDeps): Promise<number> {
  const answer = answerOf(await deps.ask("list", null), "holds the jobs");
  if (!answer.ok) {
    deps.err(`${COMMAND} list: ${answer.why}.\n`);
    return EXIT_PROBLEMS;
  }
  if (answer.value.length === 0) deps.out("No jobs.\n");
  for (const listing of answer.value) deps.out(`${listingLine(listing)}\n`);
  return EXIT_OK;
}

async function history(job: string | null, deps: CliDeps): Promise<number> {
  const answer = answerOf(await deps.ask("history", { job, limit: HISTORY_LIMIT }), "keeps the history");
  if (!answer.ok) {
    deps.err(`${COMMAND} history: ${answer.why}.\n`);
    return EXIT_PROBLEMS;
  }
  const { records } = answer.value;
  if (records.length === 0) deps.out(job === null ? "No runs yet.\n" : `No runs of ${job} yet.\n`);
  for (const record of records) {
    const output = record.log === null ? "" : deps.exists(record.log) ? `  output ${record.log}` : `  ${OUTPUT_NOT_HERE}`;
    deps.out(`${record.job}  ${record.name}  ${runTriggerWords(record)}  ${runLine(record)}${output}\n`);
    for (const result of record.git?.results ?? []) deps.out(`    ${gitRepoLine(result)}\n`);
  }
  return EXIT_OK;
}

/** A run going in one line: `backup  Backup  run 20261118-…  queued · 1 ahead`. */
function activeLine(run: ActiveRun): string {
  const since = run.state === "running" && run.startedAt !== null ? `, since ${iso(run.agent?.waiting?.since ?? run.startedAt)}` : run.state === "missed-waiting" ? `, due ${iso(run.dueAt)}` : "";
  return `${run.job}  ${run.name}  run ${run.run}  ${runWords(run)}${since}`;
}

/** A Needs-you item in one line. */
function needsYouLine(item: NeedsYouItem): string {
  switch (item.kind) {
    case "run-failed":
      return `needs you: ${item.name} — failed: ${item.detail}${item.count > 1 ? ` · ${item.count}×` : ""}, ${dayTime(item.at)}`;
    case "service-failed":
      return `needs you: ${item.name} — gave up: ${item.detail}`;
    case "missed":
      return `needs you: ${item.name} — ${item.detail}; it waits for you: Run now, Run at… or Skip in Runner`;
    case "waiting":
      return `needs you: ${item.name} — ${item.detail}, since ${dayTime(item.at)}; answer it in the run's terminal tab in Pomade`;
    case "long-run":
      return `needs you: ${item.name} — ${item.detail}`;
    case "loop-paused":
      return `needs you: ${item.name} — paused: ${item.detail}; ${COMMAND} resume-job ${item.job} lets hooks and chains fire it again`;
  }
}

function switchLine({ position, since }: SwitchState): string {
  const what = position === "running" ? "scheduled runs run" : position === "pause-low" ? "runs of low-priority jobs are held" : "every scheduled run is held";
  return `switch: ${SWITCH_WORDS[position]} — ${what}${position === "running" ? "" : "; Run now still runs, services keep running"}${since === null ? "" : ` (since ${iso(since)})`}`;
}

async function runsCommand(deps: CliDeps): Promise<number> {
  const answer = answerOf(await deps.ask("runs", null), "runs the jobs");
  if (!answer.ok) {
    deps.err(`${COMMAND} runs: ${answer.why}.\n`);
    return EXIT_PROBLEMS;
  }
  const { active, needsYou, switch: position } = answer.value;
  deps.out(`${switchLine(position)}\n`);
  if (active.length === 0) deps.out("No runs going.\n");
  for (const run of active) deps.out(`${activeLine(run)}\n`);
  for (const item of needsYou) deps.out(`${needsYouLine(item)}\n`);
  return EXIT_OK;
}

async function switchCommand(name: "pause" | "resume", position: SwitchPosition, deps: CliDeps): Promise<number> {
  const answer = answerOf(await deps.ask("switch", { position }), "holds the switch");
  if (!answer.ok) return refused(name, answer.why, deps);
  deps.out(`${switchLine(answer.value)}\n`);
  return EXIT_OK;
}

/** What `run` started, in a line. */
function startedLine(value: ControlMethods["run"]): string {
  if ("service" in value) return serviceLine(value.service);
  const { run } = value;
  const where = run.state === "running" ? `running${run.log === null ? "" : `, output ${run.log}`}` : runWords(run);
  return `${run.job}  ${run.name}  run ${run.run}  ${where}`;
}

/** The commands that act on one job, and what each needs running. */
const JOB_COMMANDS = {
  run: { holds: "runs the jobs", target: "job" },
  stop: { holds: "supervises the services", target: "service" },
  restart: { holds: "supervises the services", target: "service" },
  enable: { holds: "holds the jobs", target: "job" },
  disable: { holds: "holds the jobs", target: "job" },
  "resume-job": { holds: "runs the jobs", target: "job" },
} as const;
type JobCommand = keyof typeof JOB_COMMANDS;

async function jobCommand(name: JobCommand, job: string, deps: CliDeps): Promise<number> {
  let line: string;
  const { holds } = JOB_COMMANDS[name];
  if (name === "run") {
    const answer = answerOf(await deps.ask("run", { job }), holds);
    if (!answer.ok) return refused(name, answer.why, deps);
    line = startedLine(answer.value);
  } else if (name === "resume-job") {
    const answer = answerOf(await deps.ask("resumeJob", { job }), holds);
    if (!answer.ok) return refused(name, answer.why, deps);
    line = `${answer.value.job}  ${answer.value.name}  resumed: hooks and chains fire it again`;
  } else if (name === "enable" || name === "disable") {
    const answer = answerOf(await deps.ask(name, { job }), holds);
    if (!answer.ok) return refused(name, answer.why, deps);
    line = `${answer.value.job}  ${answer.value.name}  ${answer.value.enabled ? "enabled" : "disabled"}`;
  } else {
    const answer = answerOf(await deps.ask(name, { job }), holds);
    if (!answer.ok) return refused(name, answer.why, deps);
    line = serviceLine(answer.value);
  }
  deps.out(`${line}\n`);
  return EXIT_OK;
}

function refused(name: string, why: string, deps: CliDeps): number {
  deps.err(`${COMMAND} ${name}: ${why}.\n`);
  return EXIT_PROBLEMS;
}

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [first, ...rest] = args;
  if (first === undefined || first === "--help" || first === "-h") {
    deps.out(USAGE);
    return EXIT_OK;
  }
  if (first === "--version" || first === "-V") {
    deps.out(`${COMMAND} ${APP_VERSION}\n${schedulerLine(await deps.ask("status", null))}\n`);
    return EXIT_OK;
  }
  if (first === "pause" || first === "resume") {
    const [which, ...extra] = rest;
    const position: SwitchPosition | null = first === "resume" ? (which === undefined ? "running" : null) : which === undefined || which === "all" ? "pause-all" : which === "low" ? "pause-low" : null;
    if (position === null || extra.length > 0) {
      const usage = first === "pause" ? `${COMMAND} pause [low|all]` : `${COMMAND} resume — for a job the loop guard paused: ${COMMAND} resume-job <job>`;
      deps.err(`${COMMAND} ${first}: unexpected "${extra[0] ?? which ?? ""}". Usage: ${usage}.\n`);
      return EXIT_USAGE;
    }
    return switchCommand(first, position, deps);
  }
  if (first === "check" || first === "projects" || first === "sessions" || first === "services" || first === "list" || first === "history" || first === "runs") {
    const option = rest.find((arg) => arg.startsWith("-"));
    const most = first === "check" ? Infinity : first === "history" ? 1 : 0;
    if (option !== undefined || rest.length > most) {
      deps.err(`${COMMAND} ${first}: unexpected "${option ?? rest[most] ?? ""}". Run \`${COMMAND} --help\` for what it takes.\n`);
      return EXIT_USAGE;
    }
    switch (first) {
      case "check":
        return check(rest, deps);
      case "projects":
        return projects(deps);
      case "sessions":
        return sessions(deps);
      case "services":
        return services(deps);
      case "list":
        return list(deps);
      case "history":
        return history(rest[0] ?? null, deps);
      case "runs":
        return runsCommand(deps);
    }
  }
  if (Object.hasOwn(JOB_COMMANDS, first)) {
    const name = first as JobCommand;
    const { target } = JOB_COMMANDS[name];
    const [job, ...extra] = rest;
    if (job === undefined || job === "" || job.startsWith("-") || extra.length > 0) {
      const problem = job === undefined || job === "" ? `names no ${target}` : `unexpected "${job.startsWith("-") ? job : (extra[0] ?? "")}"`;
      deps.err(`${COMMAND} ${first}: ${problem}. Usage: ${COMMAND} ${first} <${target}> — its id or its name.\n`);
      return EXIT_USAGE;
    }
    return jobCommand(name, job, deps);
  }
  const what = first.startsWith("-") ? "option" : "command";
  deps.err(`${COMMAND}: unknown ${what} "${first}". Run \`${COMMAND} --help\` for what it takes.\n`);
  return EXIT_USAGE;
}
