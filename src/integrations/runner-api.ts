// Runner's own API through Pomade's broker, its events, and the routes of its tab: what the
// scheduler serves and publishes and the UI calls and renders. The scheduler holds the checked
// jobs, supervises the services and runs the rest; a frame asks with `apps.call` to Runner itself
// and hears `jobs.changed`, `services.changed` or `runs.changed` when the answer would change.
// Pure: shared by the scheduler and the UI.

import type { JobsSnapshot } from "../jobs/model";
import { decodeJobId, encodeJobId } from "../keeper/ids";

/** `apps.call("pomade-runner", JOBS_LIST_METHOD)` → `JobsSnapshot`. */
export const JOBS_LIST_METHOD = "jobs.list";

/** Published by the scheduler when the checked jobs change, and when it (re)connects to Pomade. */
export const JOBS_CHANGED_EVENT = "jobs.changed";

/** `apps.call("pomade-runner", SERVICES_LIST_METHOD)` → `ServicesReport` (`isServicesReport`). */
export const SERVICES_LIST_METHOD = "services.list";

/** Published by the scheduler when a service's state changes, and when it (re)connects to Pomade. */
export const SERVICES_CHANGED_EVENT = "services.changed";

/** `apps.call("pomade-runner", SERVICE_METHODS[verb], { job })` → `ServiceActionResult`
 *  (`isServiceActionResult`): Start, Stop or Restart a service, by its id or name. Runner's own
 *  frames only. A start or restart waits for the service's running session to end first: call
 *  with `timeoutMs` of `SERVICE_ACTION_TIMEOUT_MS`. */
export const SERVICE_METHODS = { start: "services.start", stop: "services.stop", restart: "services.restart" } as const;
export type ServiceVerb = keyof typeof SERVICE_METHODS;
export const SERVICE_ACTION_TIMEOUT_MS = 15_000;

/** `apps.call("pomade-runner", RUNS_LIST_METHOD)` → `RunsReport` (`isRunsReport`): the runs going,
 *  what runs next, each job's latest run, and Needs you. */
export const RUNS_LIST_METHOD = "runs.list";

/** Published by the scheduler when the runs report changes, and when it (re)connects to Pomade. */
export const RUNS_CHANGED_EVENT = "runs.changed";

/** `{ job?, before?, limit? }` → `HistoryPage` (`isHistoryPage`): finished runs, newest first. */
export const HISTORY_LIST_METHOD = "history.list";

/** `{ job, run }` → `RunView | null` (`isRunView`): one run, going or finished. */
export const RUN_GET_METHOD = "runs.get";

/** `{ job, run }` → `RunOutput` (`isRunOutput`): the end of a run's output log. */
export const RUN_OUTPUT_METHOD = "runs.output";

/** `{ job }` → `RunActionResult` (`isRunActionResult`): Run now — a script runs (or is queued), a
 *  service starts. Runner's own frames only. */
export const RUN_NOW_METHOD = "jobs.run";

/** `{ job, enabled }` → `EnableResult` (`isEnableResult`): writes `enabled:` into the job's file.
 *  Runner's own frames only. */
export const SET_ENABLED_METHOD = "jobs.setEnabled";

/** `{ id }` → `{ resolved: boolean }`: resolve a Needs-you item — a failed run's, once its result
 *  is opened or it is dismissed; a long-run warning's, dismissed. Runner's own frames only. */
export const DISMISS_METHOD = "needsYou.dismiss";

/** `{ job, choice: "run-now" | "run-at" | "skip", at? }` → `MissedChoiceResult`
 *  (`isMissedChoiceResult`): the person's choice for a missed run that waits for them; `at` is
 *  Run at…'s time as typed (`23:00`, `tomorrow 9:00`, `2026-11-20T23:00`). Runner's own frames only. */
export const MISSED_METHOD = "runs.missed";

/** `{ job, run }` → `RunStopResult` (`isRunStopResult`): stop a running run as stopped by you.
 *  Runner's own frames only. */
export const RUN_STOP_METHOD = "runs.stop";

/** `{ position: "running" | "pause-low" | "pause-all" }` → `SwitchState` (`isSwitchState`): set the
 *  global switch. Runner's own frames only; the position is in `runs.list`. */
export const SWITCH_METHOD = "switch.set";

/** `{ job }` → `ResumeResult` (`isResumeResult`): lift the loop guard's pause of a job, by its id
 *  or name, so hooks and chains fire it again. Runner's own frames only. */
export const RESUME_METHOD = "jobs.resume";

/** `{ job }` → `DeleteResult` (`isDeleteResult`): delete a job, by its id or name — a running
 *  service stopped first, as Stop does, and its session's end waited for; then its file removed.
 *  Refused while a run of the job is going. Runner's own frames only: call with `timeoutMs` of
 *  `DELETE_JOB_TIMEOUT_MS`. */
export const DELETE_JOB_METHOD = "jobs.delete";
export const DELETE_JOB_TIMEOUT_MS = 15_000;

/** `settings.get` → `SettingsReport` (`isSettingsReport`): the workspace settings that apply, and the
 *  settings file's problems. */
export const SETTINGS_GET_METHOD = "settings.get";

/** `{ field, value }` → `SettingsWriteResult` (`isSettingsWriteResult`): write one field of the
 *  settings file, field-only — a count, a duration in minutes, or `null` for its default. Runner's
 *  own frames only. */
export const SETTINGS_SET_METHOD = "settings.set";

/** `environment.get` → `EnvironmentReport` (`isEnvironmentReport`): what the Settings view shows
 *  read-only about the Mac — the notification permission and the agent skill's links. */
export const ENVIRONMENT_GET_METHOD = "environment.get";

/** Published by the scheduler when the settings change, and when it (re)connects to Pomade. */
export const SETTINGS_CHANGED_EVENT = "settings.changed";

/** Published on the bus when a run's session starts: `RunStartedPayload`. */
export const RUN_STARTED_EVENT = "run.started";

/** Published on the bus when a run that started ends: `RunFinishedPayload`. */
export const RUN_FINISHED_EVENT = "run.finished";

/** `run.started`'s payload (docs/DESIGN.md "Interfaces"). */
export interface RunStartedPayload {
  /** The job's id. */
  job: string;
  /** The job's name. */
  name: string;
  run: string;
  kind: string;
  /** Workspace-relative. */
  folder: string;
  /** The stable project id; `null` for a workspace job. */
  project: string | null;
  trigger: string;
  /** An agent run's only — the shape `pomade-agents` reads (it ignores an agent run without `cwd`):
   *  its session (`null` while not known; `run.finished` carries one found after the start), the
   *  agent's roster id, the mode, the folder it started in (absolute, symlinks resolved), that
   *  Runner started it, and when (ISO 8601). */
  sessionId?: string | null;
  agent?: string;
  mode?: string;
  cwd?: string;
  startedByRunner?: true;
  startedAt?: string;
}

/** `run.finished`'s payload: `run.started`'s and how it ended. */
export interface RunFinishedPayload extends RunStartedPayload {
  /** `done` · `failed` · `stopped-by-you`. */
  result: string;
  exitCode: number | null;
}

/** Where the Runner tab is: its route (`host.welcome.route`, `onRouteChange`, `tabs.openApp`). */
export type RunnerRoute =
  /** Every job; `job` is the one the route opens (a repo row's Scheduled line), `null` for none. */
  | { view: "jobs"; job: string | null }
  | { view: "history" }
  | { view: "services" }
  | { view: "settings" }
  /** A run's result card. */
  | { view: "run"; job: string; run: string }
  /** A run's full output. */
  | { view: "output"; job: string; run: string }
  /** The job form, for a new job; `project` is the project it starts in, `null` for none. */
  | { view: "new"; project: string | null }
  /** The job form, editing a job. */
  | { view: "edit"; job: string };

/** The Jobs view at one job: `jobs/<encoded job id>` — what a repo row's Scheduled line opens. */
export function jobsRoute(job: string): string {
  return `jobs/${encodeJobId(job)}`;
}

/** A run's result card: `run/<encoded job id>/<run id>` — what a run's notice opens. */
export function runRoute(job: string, run: string): string {
  return `run/${encodeJobId(job)}/${run}`;
}

/** A run's full output: `output/<encoded job id>/<run id>`. */
export function outputRoute(job: string, run: string): string {
  return `output/${encodeJobId(job)}/${run}`;
}

/** The manifest's tab kind (`tabKinds`) of a run's output tab. */
export const OUTPUT_TAB_KIND = "output";

/** A run's output tab: its own keyed tab (`tabs.openApp` `key`), one per run —
 *  `out:<encoded job id>:<run id>`, at most 128 characters as a key allows: an encoded job id leaves
 *  room for a run session's id (`run:<encoded job id>:<run id>`), which is as long. */
export function outputTabKey(job: string, run: string): string {
  return `out:${encodeJobId(job)}:${run}`;
}

/** A run's output tab's title: the job's name and what the tab is (`Backup · output`). */
export function outputTabTitle(name: string): string {
  return `${name} · output`;
}

/** What `tabs.openApp` takes to open or focus a run's output tab at `outputRoute`. */
export function outputTab(job: string, run: string, name: string): { route: string; key: string; title: string; kind: string } {
  return { route: outputRoute(job, run), key: outputTabKey(job, run), title: outputTabTitle(name), kind: OUTPUT_TAB_KIND };
}

/** The job form for a new job: `new` — what "New job" opens — or `new/<encoded project id>` when
 *  the job starts in a project (the Jobs view's "This project" chip is on). */
export function newRoute(project: string | null = null): string {
  return project === null ? "new" : `new/${encodeJobId(project)}`;
}

/** The job form editing a job: `edit/<encoded job id>`. */
export function editRoute(job: string): string {
  return `edit/${encodeJobId(job)}`;
}

/** The view a route names; an unknown route is the Jobs view. */
export function parseRoute(route: string): RunnerRoute {
  if (route === "new") return { view: "new", project: null };
  const starting = /^new\/([^/]+)$/.exec(route);
  const project = starting === null ? null : decodeJobId(starting[1] ?? "");
  if (project !== null) return { view: "new", project };
  const edit = /^edit\/([^/]+)$/.exec(route);
  const editing = edit === null ? null : decodeJobId(edit[1] ?? "");
  if (editing !== null) return { view: "edit", job: editing };
  if (route === "history") return { view: "history" };
  if (route === "services") return { view: "services" };
  if (route === "settings") return { view: "settings" };
  const at = /^jobs\/([^/]+)$/.exec(route);
  if (at !== null) return { view: "jobs", job: decodeJobId(at[1] ?? "") };
  const match = /^(run|output)\/([^/]+)\/([^/]+)$/.exec(route);
  const job = match === null ? null : decodeJobId(match[2] ?? "");
  if (match === null || job === null) return { view: "jobs", job: null };
  return { view: match[1] === "run" ? "run" : "output", job, run: match[3] ?? "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shape check a caller runs on a `jobs.list` answer before trusting it. */
export function isJobsSnapshot(value: unknown): value is JobsSnapshot {
  if (!isRecord(value)) return false;
  const { workspace, projectsChecked, jobs } = value;
  if ((workspace !== null && typeof workspace !== "string") || typeof projectsChecked !== "boolean" || !Array.isArray(jobs)) return false;
  return jobs.every(
    (entry: unknown) =>
      isRecord(entry) &&
      ((entry.valid === true && isRecord(entry.job) && typeof entry.job.id === "string" && typeof entry.job.path === "string") ||
        (entry.valid === false && isRecord(entry.invalid) && typeof entry.invalid.path === "string" && Array.isArray(entry.invalid.errors))),
  );
}
