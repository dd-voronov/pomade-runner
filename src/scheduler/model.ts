// Runner's view of runs (docs/DESIGN.md "Runs", "History", "Needs you", "Missed runs and load"):
// what the scheduler holds and serves to the `pomade-runner` command and to Runner's frames — the
// runs going now and what each queued one waits for, the history records of finished ones, what
// runs next, the switch, and what needs the person. Plain JSON. Pure: shared by the scheduler, the
// control protocol, the command and the UI.

import { JOB_KINDS, type JobKind } from "../jobs/model";
import { isServiceStatus, type ServiceStatus } from "../keeper/model";

/** What started a run: its schedule on time · `caught-up`, a missed run run late, once however many
 *  were missed · Run now. Hooks and chains come with later epics. */
export const RUN_TRIGGERS = ["scheduled", "caught-up", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** A run that has not ended: `missed-waiting` a missed run of a `wait-for-me` job, waiting for the
 *  person to pick Run now, Run at… or Skip · `queued` waits to start (`waits` says for what) ·
 *  `running` is a keeper session. */
export const ACTIVE_STATES = ["missed-waiting", "queued", "running"] as const;
export type ActiveState = (typeof ACTIVE_STATES)[number];

/** How a run ended: `done` exit 0 · `failed` exit ≠ 0, a signal, a time limit, a start the keeper
 *  refused or a session lost · `skipped` never started (the reason says why) · `missed` never
 *  started because it was missed, and its policy did not run it (the reason says what happened) ·
 *  `stopped-by-you` Ctrl+C or Stop in its tab, or Stop on its long-run warning. */
export const RUN_RESULTS = ["done", "failed", "skipped", "missed", "stopped-by-you"] as const;
export type RunResult = (typeof RUN_RESULTS)[number];

/** The global switch's positions: everything runs · runs of low-priority jobs are held · every run
 *  but Run now is held. Services keep running in every position. */
export const SWITCH_POSITIONS = ["running", "pause-low", "pause-all"] as const;
export type SwitchPosition = (typeof SWITCH_POSITIONS)[number];

export interface SwitchState {
  position: SwitchPosition;
  /** When it was set (epoch ms); `null` for the default, never set. */
  since: number | null;
}

/** What a queued run waits for, the first that holds it: Run at…'s time · the switch · the warm-up
 *  after login or wake (a caught-up run; `until` is `null` while the services still start) · the
 *  job's previous run (overlap `queue`) · a free low-priority slot, with how many runs have to end
 *  before it starts: the slot-waiting runs ahead of it and the one whose slot it takes. */
export type Waits =
  | { kind: "time"; at: number }
  | { kind: "switch"; position: Exclude<SwitchPosition, "running"> }
  | { kind: "warm-up"; until: number | null }
  | { kind: "previous-run" }
  | { kind: "slot"; ahead: number };

export type RunState = ActiveState | RunResult;

/** What every run carries, going or ended. */
interface RunBase {
  /** The job's id (`backup`, `coda-helper/nightly`). */
  job: string;
  /** The job's name when the run was due. */
  name: string;
  kind: JobKind;
  /** The stable project id; `null` for a workspace job. */
  project: string | null;
  /** The working folder, workspace-relative (`""` is the root). */
  folder: string;
  /** The run id (`20261117-080509-a1b2c3`): sorts by when the run was due; names its session and output log. */
  run: string;
  trigger: RunTrigger;
  /** When it was due — the schedule's time, or the click (epoch ms, the scheduler's clock). */
  dueAt: number;
}

/** A run that has not ended. */
export interface ActiveRun extends RunBase {
  state: ActiveState;
  /** Whether it runs — or is to run — with macOS background priority: the job's `low-priority`.
   *  Low-priority runs share the slots and are held by Pause low-priority. */
  lowPriority: boolean;
  /** Run at…: it starts no earlier than this (epoch ms); `null` for no such time. */
  runAt: number | null;
  /** A caught-up run is worth starting until this moment (epoch ms) — its job's `worth-until`; past
   *  it, it is missed · skipped. `null` for any other run, or no such moment. */
  deadline: number | null;
  /** What a queued run waits for; `null` for one about to start and every other state. */
  waits: Waits | null;
  /** When its session started (epoch ms, the scheduler's clock); `null` while queued. */
  startedAt: number | null;
  /** The keeper session (`run:<job>:<run>`) once it runs; `null` while queued. */
  session: string | null;
  /** Its output log (absolute) once it runs. */
  log: string | null;
  /** The time limit Runner stopped it at, in minutes; `null` while it has not. */
  limitHit: number | null;
  /** When it became a long-run warning (epoch ms); `null` before. */
  warnedAt: number | null;
  /** The person dismissed its long-run warning. */
  warningDismissed: boolean;
}

/** A finished run: one history record. */
export interface RunRecord extends RunBase {
  state: RunResult;
  /** A failed or skipped run's reason in words ("previous run still going", "lost in a keeper
   *  crash"); `null` when the exit code says it all. */
  reason: string | null;
  /** When its session started; `null` for a run that never started. */
  startedAt: number | null;
  /** When it ended — for a skipped run, when it was skipped. */
  endedAt: number;
  /** How long it ran (ms); `null` for a run that never started. */
  durationMs: number | null;
  exitCode: number | null;
  /** The signal that ended it (`SIGINT`), or `null`. */
  signal: string | null;
  /** The full output (absolute); `null` for a run that never started. */
  log: string | null;
  /** The last lines of the output, plain text (escape sequences removed), at most `LAST_LINES`. */
  lastLines: string[];
}

export type RunView = ActiveRun | RunRecord;

/** How many lines of a run's output its record keeps. */
export const LAST_LINES = 20;

/** The next run of a scheduled job. */
export interface NextRun {
  job: string;
  name: string;
  project: string | null;
  /** Epoch ms. */
  at: number;
}

/** A job's runs in brief, for its row. */
export interface JobRuns {
  job: string;
  /** Its next scheduled run (epoch ms); `null` when none is due — no schedule, disabled, or finished. */
  next: number | null;
  /** A schedule with no run ahead ("once at" past its time): the job is finished. */
  finished: boolean;
  /** Its latest finished run. */
  last: RunRecord | null;
}

/** Something Runner cannot settle alone: a run that failed, a service that gave up, a missed run of
 *  a `wait-for-me` job, a run going longer than the long-run warning. */
export type NeedsYouItem =
  | {
      /** `run-failed:<job>`: one per job. */
      id: string;
      kind: "run-failed";
      job: string;
      name: string;
      project: string | null;
      /** The latest failed run. */
      run: string;
      /** When it failed (epoch ms). */
      at: number;
      /** Failed runs of the job since the item came. */
      count: number;
      /** The run's reason or exit in words: "exit 1". */
      detail: string;
    }
  | {
      /** `service-failed:<job>`. */
      id: string;
      kind: "service-failed";
      job: string;
      name: string;
      project: string | null;
      /** When it gave up: its last crash (epoch ms). */
      at: number;
      detail: string;
    }
  | {
      /** `missed:<job>`: one per job. */
      id: string;
      kind: "missed";
      job: string;
      name: string;
      project: string | null;
      /** The waiting run. */
      run: string;
      /** Its latest missed time (epoch ms). */
      at: number;
      detail: string;
    }
  | {
      /** `long-run:<job>:<run>`. */
      id: string;
      kind: "long-run";
      job: string;
      name: string;
      project: string | null;
      run: string;
      /** When the warning came (epoch ms). */
      at: number;
      /** When the run started (epoch ms). */
      startedAt: number;
      detail: string;
    };

/** What the panel, the Jobs view and the badge show: everything about runs that changes on its own. */
export interface RunsReport {
  /** Missed runs waiting for the person, queued and running runs, oldest first. */
  active: ActiveRun[];
  /** Every enabled scheduled job's next run, soonest first. */
  nextUp: NextRun[];
  /** Each run job's next and last run, by job id. */
  jobs: JobRuns[];
  /** Newest first. */
  needsYou: NeedsYouItem[];
  switch: SwitchState;
}

/** A page of history, newest first. */
export interface HistoryPage {
  records: RunRecord[];
  /** Where the next, older page starts: pass it as `before`; `null` at the oldest record. */
  next: string | null;
}

/** A run's full output, as the keeper wrote it (escape sequences included). */
export interface RunOutput {
  text: string;
  /** Only the end of a longer log is in `text`. */
  truncated: boolean;
}

/** The answer to Run now: the run it started or queued (a service: its status after Start), or why
 *  it was refused. */
export type RunActionResult = { ok: true; run: ActiveRun } | { ok: true; service: ServiceStatus } | { ok: false; reason: string };

/** A job enabled or disabled. */
export type EnableResult = { ok: true; job: string; enabled: boolean } | { ok: false; reason: string };

/** What the person picks for a missed run that waits for them: Run now · Run at… (a time, a day and
 *  a time, or a date phrase: `23:00`, `tomorrow 9:00`, `+2h`) · Skip. */
export type MissedChoice = { kind: "run-now" } | { kind: "run-at"; at: string } | { kind: "skip" };

/** The answer to a missed run's choice: when it runs (`at`: epoch ms; `null` for Skip), or why not. */
export type MissedChoiceResult = { ok: true; at: number | null } | { ok: false; reason: string };

/** The answer to Stop on a run. */
export type RunStopResult = { ok: true } | { ok: false; reason: string };

export function isMissedChoiceResult(value: unknown): value is MissedChoiceResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.reason === "string";
  return value.ok === true && nullableNumber(value.at);
}

export function isRunStopResult(value: unknown): value is RunStopResult {
  return isRecord(value) && (value.ok === true || (value.ok === false && typeof value.reason === "string"));
}

/** A job as `pomade-runner list` shows it. */
export interface JobListing {
  job: string;
  name: string;
  kind: JobKind | null;
  enabled: boolean;
  /** Its trigger in words ("weekdays at 7:00", "at login"); `null` for an invalid file. */
  trigger: string | null;
  /** The first problem of an invalid file; `null` when it is valid. */
  problem: string | null;
  next: number | null;
  finished: boolean;
  last: RunRecord | null;
  /** A service's status. */
  service: ServiceStatus | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KINDS: readonly string[] = JOB_KINDS;
const TRIGGERS: readonly string[] = RUN_TRIGGERS;
const ACTIVE: readonly string[] = ACTIVE_STATES;
const RESULTS: readonly string[] = RUN_RESULTS;
const POSITIONS: readonly string[] = SWITCH_POSITIONS;
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const nullableNumber = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value));
const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

function isRunBase(value: Record<string, unknown>): boolean {
  const { job, name, kind, project, folder, run, trigger, dueAt } = value;
  return (
    typeof job === "string" &&
    typeof name === "string" &&
    typeof kind === "string" &&
    KINDS.includes(kind) &&
    nullableString(project) &&
    typeof folder === "string" &&
    typeof run === "string" &&
    typeof trigger === "string" &&
    TRIGGERS.includes(trigger) &&
    finite(dueAt)
  );
}

function isWaits(value: unknown): value is Waits {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "time":
      return finite(value.at);
    case "switch":
      return value.position === "pause-low" || value.position === "pause-all";
    case "warm-up":
      return nullableNumber(value.until);
    case "previous-run":
      return true;
    case "slot":
      return typeof value.ahead === "number" && Number.isSafeInteger(value.ahead) && value.ahead >= 1;
    default:
      return false;
  }
}

export function isActiveRun(value: unknown): value is ActiveRun {
  if (!isRecord(value) || !isRunBase(value)) return false;
  const { state, lowPriority, runAt, deadline, waits, startedAt, session, log, limitHit, warnedAt, warningDismissed } = value;
  return (
    typeof state === "string" &&
    ACTIVE.includes(state) &&
    typeof lowPriority === "boolean" &&
    nullableNumber(runAt) &&
    nullableNumber(deadline) &&
    (waits === null || isWaits(waits)) &&
    nullableNumber(startedAt) &&
    nullableString(session) &&
    nullableString(log) &&
    nullableNumber(limitHit) &&
    nullableNumber(warnedAt) &&
    typeof warningDismissed === "boolean"
  );
}

export function isSwitchState(value: unknown): value is SwitchState {
  return isRecord(value) && typeof value.position === "string" && POSITIONS.includes(value.position) && nullableNumber(value.since);
}

export function isRunRecord(value: unknown): value is RunRecord {
  if (!isRecord(value) || !isRunBase(value)) return false;
  const { state, reason, startedAt, endedAt, durationMs, exitCode, signal, log, lastLines } = value;
  return (
    typeof state === "string" &&
    RESULTS.includes(state) &&
    nullableString(reason) &&
    nullableNumber(startedAt) &&
    finite(endedAt) &&
    nullableNumber(durationMs) &&
    nullableNumber(exitCode) &&
    nullableString(signal) &&
    nullableString(log) &&
    Array.isArray(lastLines) &&
    lastLines.every((line) => typeof line === "string")
  );
}

export function isRunView(value: unknown): value is RunView {
  return isActiveRun(value) || isRunRecord(value);
}

function isNeedsYouItem(value: unknown): value is NeedsYouItem {
  if (!isRecord(value)) return false;
  const { id, kind, job, name, project, at, detail } = value;
  if (typeof id !== "string" || typeof job !== "string" || typeof name !== "string" || !nullableString(project) || !finite(at) || typeof detail !== "string") return false;
  switch (kind) {
    case "run-failed":
      return typeof value.run === "string" && typeof value.count === "number";
    case "service-failed":
      return true;
    case "missed":
      return typeof value.run === "string";
    case "long-run":
      return typeof value.run === "string" && finite(value.startedAt);
    default:
      return false;
  }
}

function isJobRuns(value: unknown): value is JobRuns {
  if (!isRecord(value)) return false;
  const { job, next, finished, last } = value;
  return typeof job === "string" && nullableNumber(next) && typeof finished === "boolean" && (last === null || isRunRecord(last));
}

function isNextRun(value: unknown): value is NextRun {
  return isRecord(value) && typeof value.job === "string" && typeof value.name === "string" && nullableString(value.project) && finite(value.at);
}

export function isRunsReport(value: unknown): value is RunsReport {
  if (!isRecord(value)) return false;
  const { active, nextUp, jobs, needsYou } = value;
  return (
    Array.isArray(active) &&
    active.every(isActiveRun) &&
    Array.isArray(nextUp) &&
    nextUp.every(isNextRun) &&
    Array.isArray(jobs) &&
    jobs.every(isJobRuns) &&
    Array.isArray(needsYou) &&
    needsYou.every(isNeedsYouItem) &&
    isSwitchState(value.switch)
  );
}

export function isHistoryPage(value: unknown): value is HistoryPage {
  return isRecord(value) && Array.isArray(value.records) && value.records.every(isRunRecord) && nullableString(value.next);
}

export function isRunOutput(value: unknown): value is RunOutput {
  return isRecord(value) && typeof value.text === "string" && typeof value.truncated === "boolean";
}

export function isRunActionResult(value: unknown): value is RunActionResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.reason === "string";
  return value.ok === true && (isActiveRun(value.run) || isServiceStatus(value.service));
}

export function isEnableResult(value: unknown): value is EnableResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.reason === "string";
  return value.ok === true && typeof value.job === "string" && typeof value.enabled === "boolean";
}

function isJobListing(value: unknown): value is JobListing {
  if (!isRecord(value)) return false;
  const { job, name, kind, enabled, trigger, problem, next, finished, last, service } = value;
  return (
    typeof job === "string" &&
    typeof name === "string" &&
    (kind === null || (typeof kind === "string" && KINDS.includes(kind))) &&
    typeof enabled === "boolean" &&
    nullableString(trigger) &&
    nullableString(problem) &&
    nullableNumber(next) &&
    typeof finished === "boolean" &&
    (last === null || isRunRecord(last)) &&
    (service === null || isServiceStatus(service))
  );
}

export function isJobListings(value: unknown): value is JobListing[] {
  return Array.isArray(value) && value.every(isJobListing);
}

/** A time of day on this Mac's clock, `HH:MM`. */
export function clockTime(epochMs: number): string {
  const at = new Date(epochMs);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A moment as its weekday and time of day: "Wed 13:00". */
export function dayTime(epochMs: number): string {
  return `${WEEKDAYS[new Date(epochMs).getDay()] ?? ""} ${clockTime(epochMs)}`;
}

/** What started a run, in words: "scheduled", "caught up", "manual". */
export const TRIGGER_WORDS: Record<RunTrigger, string> = { scheduled: "scheduled", "caught-up": "caught up", manual: "manual" };

/** The switch's position in words. */
export const SWITCH_WORDS: Record<SwitchPosition, string> = { running: "Running", "pause-low": "Pause low-priority", "pause-all": "Pause all" };

/** What a queued run waits for, in words: "1 ahead", "warm-up until 08:32". */
export function waitsWords(waits: Waits | null): string {
  if (waits === null) return "starting";
  switch (waits.kind) {
    case "time":
      return `at ${dayTime(waits.at)}`;
    case "switch":
      return `held · ${SWITCH_WORDS[waits.position]}`;
    case "warm-up":
      return waits.until === null ? "warm-up · services start first" : `warm-up until ${clockTime(waits.until)}`;
    case "previous-run":
      return "after the previous run";
    case "slot":
      return `${waits.ahead} ahead`;
  }
}

/** A run's state in words: "failed · exit 1", "queued · 1 ahead", "missed · skipped". */
export function runWords(view: RunView): string {
  switch (view.state) {
    case "missed-waiting":
      return "missed · waiting for you";
    case "queued":
      return `queued · ${waitsWords(view.waits)}`;
    case "running":
      return "running";
    case "done":
      return "done";
    case "stopped-by-you":
      return "stopped by you";
    case "skipped":
      return view.reason === null ? "skipped" : `skipped · ${view.reason}`;
    case "missed":
      return view.reason === null ? "missed" : `missed · ${view.reason}`;
    case "failed":
      return `failed · ${failureWords(view)}`;
  }
}

/** Why a run failed, in a few words: its reason, else its exit code or signal. */
export function failureWords(record: RunRecord): string {
  if (record.reason !== null) return record.reason;
  if (record.exitCode !== null) return `exit ${record.exitCode}`;
  return record.signal ?? "ended";
}

/** How long, in words: "850 ms", "12 s", "3 min 4 s", "2 h 5 min". */
export function durationWords(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** Terminal escape sequences: CSI (colours, cursor moves), OSC (titles, links), and the two-byte ones. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** A terminal's output as plain lines: escape sequences gone, and a line rewritten with `\r` (a
 *  progress bar) as it ended up. */
export function plainLines(text: string): string[] {
  return text
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.replace(/\r+$/, "");
      return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
    });
}
