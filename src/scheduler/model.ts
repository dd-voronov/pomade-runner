// Runner's view of runs (docs/DESIGN.md "Runs", "History", "Needs you", "Missed runs and load"):
// what the scheduler holds and serves to the `pomade-runner` command and to Runner's frames — the
// runs going now and what each queued one waits for, the history records of finished ones, what
// runs next, the switch, and what needs the person. Plain JSON. Pure: shared by the scheduler, the
// control protocol, the command and the UI.

import { isGitRunOutput, type GitRunOutput } from "pomade-kit/protocol";

import { HOOK_EVENTS, JOB_KINDS, SERVICE_ACTIONS, SESSION_STATUS_WORDS, SESSION_STATUSES, type HookEvent, type JobKind, type ServiceAction } from "../jobs/model";
import { isServiceStatus, type ServiceStatus } from "../keeper/model";

/** What started a run: its schedule on time · `caught-up`, a missed run run late, once however many
 *  were missed · Run now · a hook's event · a chain: another job finished. */
export const RUN_TRIGGERS = ["scheduled", "caught-up", "manual", "hook", "chain"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** The parent results a chain follows: a run that ended `done` or `failed`. */
export const PARENT_RESULTS = ["done", "failed"] as const;
export type ParentResult = (typeof PARENT_RESULTS)[number];

/** What fired a hook or chain run: the event, with the context its run gets in its environment
 *  (`POMADE_PROJECT`, `POMADE_SESSION_ID`…; empty for `login`) and the name of the event's project
 *  as it was then (absent when the event has none) · the parent run that finished. */
export type RunCause =
  | { kind: "hook"; event: HookEvent; context: Record<string, string>; projectName?: string }
  | { kind: "chain"; job: string; name: string; run: string; result: ParentResult };

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
 *  after login or wake (a caught-up or hook run; `until` is `null` while the services still start) · the
 *  job's previous run (overlap `queue`) · Pomade, for an agent run while Runner opens it · a fresh
 *  keeper, for an agent run while the keeper cannot reach the macOS keychain and runs are going · a free
 *  low-priority slot, with how many runs have to end before it starts: the slot-waiting runs ahead
 *  of it and the one whose slot it takes. */
export type Waits =
  | { kind: "time"; at: number }
  | { kind: "switch"; position: Exclude<SwitchPosition, "running"> }
  | { kind: "warm-up"; until: number | null }
  | { kind: "previous-run" }
  | { kind: "pomade" }
  | { kind: "keeper" }
  | { kind: "slot"; ahead: number };

export type RunState = ActiveState | RunResult;

/** An agent run's own: who ran, how, in which session (docs/DESIGN.md "Agent runs"). */
export interface AgentRun {
  /** The agent's roster id. */
  agent: string;
  /** Its name, as the roster gave it at the launch. */
  name: string;
  /** Which CLI it is: the output its turns are read from. */
  provider: "claude" | "codex";
  /** The mode's id and name at the launch. */
  mode: string;
  modeName: string;
  /** The session the run is; `null` until it is known (a provider that cannot pre-assign it is
   *  looked up by folder and start time). */
  sessionId: string | null;
  /** The folder the agent started in: absolute, symlinks resolved. */
  cwd: string;
  /** When its session started (ISO 8601, this Mac's clock): what the session lookup goes by. */
  startedAt: string;
  /** What to type to end the agent, from its launch spec ("/exit"). */
  exit: string;
  /** When Runner typed `exit` once the turn was done (epoch ms, the scheduler's clock); `null` before. */
  exitSentAt: number | null;
  /** The agent works on past the exit command's own moment of work (`WORKS_AGAIN_MS`) with no idle
   *  and no prompt for the person seen since: the exit wait does not stop it, and an exit of its own
   *  still ends the run as the command's. Its turn's next end types the command again. */
  workedOn: boolean;
  /** Whether the agent has started working: the scanner has seen it work once. */
  worked: boolean;
  /** What the agent waits at for the person now; `null` while it does not wait. */
  waiting: AgentWait | null;
  /** How long its earlier waits for the person lasted (ms): left out of its time limit. */
  waitedMs: number;
  /** The agent's background work as Runner last read it: `idle` — its turn is over, work it put in
   *  the background still goes, and the run waits for that work; `asked` — it answered Runner's exit
   *  command with its background-work question; `null` — none read. Never a wait for the person. */
  background: AgentBackground | null;
  /** The options Runner picked at the agent's question forms, in order: in Full autonomy it answers
   *  a question form itself with the option the agent highlights. */
  answered: string[];
}

export const AGENT_BACKGROUND = ["idle", "asked"] as const;
export type AgentBackground = (typeof AGENT_BACKGROUND)[number];

/** An agent run going whose agent's background work still goes: it waits for that work. */
export function waitsForBackground(run: { state: string; agent: AgentRun | null }): boolean {
  return run.state === "running" && run.agent?.waiting == null && run.agent?.background != null;
}

/** A run's state while its agent's background work goes. */
export const BACKGROUND_WORDS = "running · waiting for the agent's background work";

/** What an agent waits at — approval of a tool call, trust for the folder it started in, its
 *  question form, or a screen Runner does not know after it worked (`unknown`; the kit's
 *  `AgentPrompt`), or a screen it has not started working past (`not-started`) — and since when
 *  (epoch ms, the scheduler's clock). */
export interface AgentWait {
  prompt: AgentWaitKind;
  since: number;
}

export const AGENT_WAIT_KINDS = ["permission", "trust", "question", "unknown", "not-started"] as const;
export type AgentWaitKind = (typeof AGENT_WAIT_KINDS)[number];

const isAgentWaitKind = (value: unknown): value is AgentWaitKind => AGENT_WAIT_KINDS.includes(value as AgentWaitKind);

/** An agent run going that waits for the person at a prompt. */
export function waitingAt(run: { agent: AgentRun | null }): AgentWait | null {
  return run.agent?.waiting ?? null;
}

/** What every run carries, going or ended. */
interface RunBase {
  /** The job's id (`backup`, `blog/nightly`). */
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
  /** A hook or chain run's cause; `null` for any other run. */
  cause: RunCause | null;
  /** When it was due — the schedule's time, the click, the event (epoch ms, the scheduler's clock). */
  dueAt: number;
  /** An agent run's agent, mode and session once it started; `null` for any other run, and for an
   *  agent run before its start. */
  agent: AgentRun | null;
  /** The runs its job missed that this one stands for — a caught-up run, a missed run waiting for
   *  the person, a missed record, a run of a Run all: how many, and the first and last missed time;
   *  `null` for any other run. */
  missed: MissedRuns | null;
  /** A run of a Run all: the `n`-th of the `of` runs that make up its job's missed runs, run one
   *  after another; `null` for any other run. */
  series: RunSeries | null;
}

/** Where a run of a Run all stands among them: the `n`-th of `of` (1-based). */
export interface RunSeries {
  n: number;
  of: number;
}

/** Above this many runs, Run all asks once more, naming the number. */
export const RUN_ALL_CONFIRM_ABOVE = 20;

/** The occurrences a job missed — while the switch held it, the Mac slept or Runner was off — that
 *  one missed-run decision is about: how many, the first and the last (epoch ms). */
export interface MissedRuns {
  count: number;
  first: number;
  last: number;
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

/** A finished run: one history record. A chain's action on a service is a record too, with its
 *  `action`: `done` once the service was restarted, started or stopped, `skipped` or `failed` with
 *  the reason; it never started a run (`startedAt` is `null`). */
export interface RunRecord extends RunBase {
  state: RunResult;
  /** A chain's action on a service; `null` for a run. */
  action: ServiceAction | null;
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
  /** The last lines of the output, plain text (escape sequences removed), at most `LAST_LINES`; a git
   *  run's are one line per repo when `pomade-git` gave its result. */
  lastLines: string[];
  /** A git run's result as `pomade-git --json` printed it, one result per repo; `null` for any other
   *  run, and for a git run that gave none. */
  git: GitRunOutput | null;
  /** The job's time limit Runner stopped it at, in minutes: a failed run that reads "stopped: time
   *  limit, 45 min"; `null` for every other run. */
  limitHit: number | null;
}

export type RunView = ActiveRun | RunRecord;

/** How many lines of a run's output its record keeps. */
export const LAST_LINES = 20;

/** How many runs Next up lists. */
export const NEXT_UP_RUNS = 5;

/** One of the next runs: a scheduled job's occurrence, or a run set with Run at…. */
export interface NextRun {
  job: string;
  name: string;
  project: string | null;
  /** Epoch ms. */
  at: number;
  /** The switch's position now holds it: Pause all holds every run, Pause low-priority a
   *  low-priority job's. */
  held: boolean;
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
  /** The switch's position now holds its scheduled runs. */
  held: boolean;
}

/** Something Runner cannot settle alone: a run that failed, a service that gave up, a missed run of
 *  a `wait-for-me` job, an agent run waiting for the person at a prompt, a run going longer than the
 *  long-run warning, a job the loop guard paused. */
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
      /** Why it gave up in words: the reason its last start failed, else "crashed 5 times within a minute". */
      detail: string;
      /** Why its last start failed (the keeper refused it: a folder that does not exist…), or `null`. */
      problem: string | null;
      /** Whether it has a terminal session to open: `false` when its command never started. */
      session: boolean;
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
      /** The runs the job missed that it stands for; `null` for one. */
      missed: MissedRuns | null;
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
    }
  | {
      /** `waiting:<job>:<run>`: an agent run at a permission or trust prompt, or one whose agent has
       *  not started working. */
      id: string;
      kind: "waiting";
      job: string;
      name: string;
      project: string | null;
      run: string;
      /** What it waits at. */
      prompt: AgentWait["prompt"];
      /** When it began to wait (epoch ms). */
      at: number;
      detail: string;
    }
  | {
      /** `loop-paused:<job>`. */
      id: string;
      kind: "loop-paused";
      job: string;
      name: string;
      project: string | null;
      /** When the loop guard paused it (epoch ms). */
      at: number;
      detail: string;
    };

/** What the panel, the Jobs view and the badge show: everything about runs that changes on its own. */
export interface RunsReport {
  /** Missed runs waiting for the person, queued and running runs, oldest first. */
  active: ActiveRun[];
  /** The next runs, soonest first, at most `NEXT_UP_RUNS`: every enabled scheduled job's
   *  occurrences — a job more than once when it fires several times soon — and the Run at… ones. */
  nextUp: NextRun[];
  /** Each run job's next and last run, by job id. */
  jobs: JobRuns[];
  /** Newest first. */
  needsYou: NeedsYouItem[];
  switch: SwitchState;
  /** The scheduled runs the switch has held so far: the occurrences of the jobs it holds since it
   *  caught each. Each becomes a missed run when the switch lets its job go. */
  heldRuns: number;
}

/** The runs the switch has held of one job so far — History's held row, from the first held run
 *  until the switch lets the job go, when the record its missed-run policy writes takes its place.
 *  Derived from the look the job's schedule waits at, never stored. */
export interface HeldRun {
  state: "held";
  job: string;
  /** The job's name now. */
  name: string;
  kind: JobKind;
  project: string | null;
  /** The working folder, workspace-relative (`""` is the root). */
  folder: string;
  /** How many runs it held so far, the first and the latest (epoch ms). */
  missed: MissedRuns;
}

/** A page of history, newest first. */
export interface HistoryPage {
  /** On the newest page (no `before`): the jobs the switch holds now, one row each — of the job
   *  asked for, when one is; `[]` on every older page. */
  held: HeldRun[];
  records: RunRecord[];
  /** Where the next, older page starts: pass it as `before`; `null` at the oldest record. */
  next: string | null;
}

/** A run's full output, as the keeper wrote it (escape sequences included). */
export interface RunOutput {
  text: string;
  /** Only the end of a longer log is in `text`. */
  truncated: boolean;
  /** The run has an output log, and it is not on this Mac: its record came with the workspace
   *  from another Mac, or the log was removed. */
  missing: boolean;
}

/** The answer to Run now: the run it started or queued (a service: its status after Start), or why
 *  it was refused. */
export type RunActionResult = { ok: true; run: ActiveRun } | { ok: true; service: ServiceStatus } | { ok: false; reason: string };

/** A job enabled or disabled. */
export type EnableResult = { ok: true; job: string; enabled: boolean } | { ok: false; reason: string };

/** What the person picks for a job's missed runs: for the missed run that waits for them, Run now
 *  (Run once, when it stands for more than one) · Run at… (a time, a day and a time, or a date
 *  phrase: `23:00`, `tomorrow 9:00`, `+2h`) · Skip · Run all — every run it stands for, one after
 *  another; for a caught-up run that stood for more than one, `run-others` — the other runs. */
export type MissedChoice = { kind: "run-now" } | { kind: "run-at"; at: string } | { kind: "skip" } | { kind: "run-all" } | { kind: "run-others"; run: string };

/** The answer to a missed-run choice: when it runs (`at`: epoch ms; `null` for Skip) and how many
 *  runs it made (`runs`: 0 for Skip, the whole number for Run all), or why not. */
export type MissedChoiceResult = { ok: true; at: number | null; runs: number } | { ok: false; reason: string };

/** The answer to Stop on a run. */
export type RunStopResult = { ok: true } | { ok: false; reason: string };

/** The answer to Resume on a job the loop guard paused: the job, or why not. */
export type ResumeResult = { ok: true; job: string; name: string } | { ok: false; reason: string };

export function isResumeResult(value: unknown): value is ResumeResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.reason === "string";
  return value.ok === true && typeof value.job === "string" && typeof value.name === "string";
}

export function isMissedChoiceResult(value: unknown): value is MissedChoiceResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.reason === "string";
  return value.ok === true && nullableNumber(value.at) && typeof value.runs === "number" && Number.isSafeInteger(value.runs) && value.runs >= 0;
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
const EVENTS: readonly string[] = HOOK_EVENTS;
const ACTIONS: readonly string[] = SERVICE_ACTIONS;
const PARENTS: readonly string[] = PARENT_RESULTS;
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const nullableNumber = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value));
const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

function isRunCause(value: unknown): value is RunCause {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "hook":
      return (
        typeof value.event === "string" &&
        EVENTS.includes(value.event) &&
        isRecord(value.context) &&
        Object.values(value.context).every((v) => typeof v === "string") &&
        (value.projectName === undefined || typeof value.projectName === "string")
      );
    case "chain":
      return typeof value.job === "string" && typeof value.name === "string" && typeof value.run === "string" && typeof value.result === "string" && PARENTS.includes(value.result);
    default:
      return false;
  }
}

function isAgentWait(value: unknown): value is AgentWait {
  return isRecord(value) && isAgentWaitKind(value.prompt) && finite(value.since);
}

function isAgentRun(value: unknown): value is AgentRun {
  if (!isRecord(value)) return false;
  const { agent, name, provider, mode, modeName, sessionId, cwd, startedAt, exit, exitSentAt, workedOn, worked, waiting, waitedMs, background, answered } = value;
  return (
    typeof worked === "boolean" &&
    Array.isArray(answered) &&
    answered.every((option) => typeof option === "string") &&
    (background === null || AGENT_BACKGROUND.includes(background as AgentBackground)) &&
    (waiting === null || isAgentWait(waiting)) &&
    finite(waitedMs) &&
    typeof agent === "string" &&
    typeof name === "string" &&
    (provider === "claude" || provider === "codex") &&
    typeof mode === "string" &&
    typeof modeName === "string" &&
    nullableString(sessionId) &&
    typeof cwd === "string" &&
    typeof startedAt === "string" &&
    typeof exit === "string" &&
    nullableNumber(exitSentAt) &&
    typeof workedOn === "boolean"
  );
}

export function isMissedRuns(value: unknown): value is MissedRuns {
  return isRecord(value) && typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 1 && finite(value.first) && finite(value.last) && (value.first as number) <= (value.last as number);
}

export function isRunSeries(value: unknown): value is RunSeries {
  if (!isRecord(value)) return false;
  const { n, of } = value;
  return typeof n === "number" && typeof of === "number" && Number.isSafeInteger(n) && Number.isSafeInteger(of) && n >= 1 && n <= of;
}

function isRunBase(value: Record<string, unknown>): boolean {
  const { job, name, kind, project, folder, run, trigger, cause, dueAt, agent, missed, series } = value;
  return (
    (agent === null || isAgentRun(agent)) &&
    (missed === null || isMissedRuns(missed)) &&
    (series === null || isRunSeries(series)) &&
    typeof job === "string" &&
    typeof name === "string" &&
    typeof kind === "string" &&
    KINDS.includes(kind) &&
    nullableString(project) &&
    typeof folder === "string" &&
    typeof run === "string" &&
    typeof trigger === "string" &&
    TRIGGERS.includes(trigger) &&
    (cause === null || isRunCause(cause)) &&
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
    case "pomade":
    case "keeper":
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
  const { state, action, reason, startedAt, endedAt, durationMs, exitCode, signal, log, lastLines, git } = value;
  return (
    typeof state === "string" &&
    RESULTS.includes(state) &&
    (action === null || (typeof action === "string" && ACTIONS.includes(action))) &&
    nullableString(reason) &&
    nullableNumber(startedAt) &&
    finite(endedAt) &&
    nullableNumber(durationMs) &&
    nullableNumber(exitCode) &&
    nullableString(signal) &&
    nullableString(log) &&
    Array.isArray(lastLines) &&
    lastLines.every((line) => typeof line === "string") &&
    (git === null || isGitRunOutput(git)) &&
    nullableNumber(value.limitHit)
  );
}

/** A run's agent as a file keeps it; a field a record of an older build lacks gets its default — its
 *  agent counts as one that started working, with no background work read and no question answered. */
export function withAgentDefaults(agent: unknown): unknown {
  return isRecord(agent) ? { worked: true, waiting: null, waitedMs: 0, background: null, answered: [], workedOn: false, ...agent } : (agent ?? null);
}

/** A history record as a file keeps it; a field a record of an older build lacks gets its default. */
export function parseRunRecord(value: unknown): RunRecord | null {
  if (!isRecord(value)) return null;
  const record = { cause: null, action: null, git: null, limitHit: null, missed: null, series: null, ...value, agent: withAgentDefaults(value.agent) };
  return isRunRecord(record) ? record : null;
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
      return nullableString(value.problem) && typeof value.session === "boolean";
    case "missed":
      return typeof value.run === "string" && (value.missed === null || isMissedRuns(value.missed));
    case "waiting":
      return typeof value.run === "string" && isAgentWaitKind(value.prompt);
    case "long-run":
      return typeof value.run === "string" && finite(value.startedAt);
    case "loop-paused":
      return true;
    default:
      return false;
  }
}

function isJobRuns(value: unknown): value is JobRuns {
  if (!isRecord(value)) return false;
  const { job, next, finished, last, held } = value;
  return typeof job === "string" && nullableNumber(next) && typeof finished === "boolean" && (last === null || isRunRecord(last)) && typeof held === "boolean";
}

function isNextRun(value: unknown): value is NextRun {
  return isRecord(value) && typeof value.job === "string" && typeof value.name === "string" && nullableString(value.project) && finite(value.at) && typeof value.held === "boolean";
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
    isSwitchState(value.switch) &&
    typeof value.heldRuns === "number" &&
    Number.isSafeInteger(value.heldRuns) &&
    value.heldRuns >= 0
  );
}

function isHeldRun(value: unknown): value is HeldRun {
  return (
    isRecord(value) &&
    value.state === "held" &&
    typeof value.job === "string" &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    KINDS.includes(value.kind) &&
    nullableString(value.project) &&
    typeof value.folder === "string" &&
    isMissedRuns(value.missed)
  );
}

export function isHistoryPage(value: unknown): value is HistoryPage {
  return isRecord(value) && Array.isArray(value.held) && value.held.every(isHeldRun) && Array.isArray(value.records) && value.records.every(isRunRecord) && nullableString(value.next);
}

export function isRunOutput(value: unknown): value is RunOutput {
  return isRecord(value) && typeof value.text === "string" && typeof value.truncated === "boolean" && typeof value.missing === "boolean";
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

/** What started a run, in words: "scheduled", "caught up", "manual", "hook", "chain". */
export const TRIGGER_WORDS: Record<RunTrigger, string> = { scheduled: "scheduled", "caught-up": "caught up", manual: "manual", hook: "hook", chain: "chain" };

/** A hook's event in words, as a run's cause says it: "Mac login", "first open of blog",
 *  "agent session finished", "session marked Done". */
export function hookCauseWords(cause: Extract<RunCause, { kind: "hook" }>): string {
  const project = cause.projectName;
  switch (cause.event) {
    case "login":
      return "Mac login";
    case "pomade-started":
      return "Pomade started";
    case "project-first-open":
      return `first open of ${project ?? "a project"}`;
    case "project-opened":
      return `${project ?? "a project"} opened`;
    case "project-created":
      return project === undefined ? "project created" : `project ${project} created`;
    case "session-finished":
      return "agent session finished";
    case "session-status": {
      const status = SESSION_STATUSES.find((one) => one === cause.context.POMADE_SESSION_STATUS);
      return status === undefined ? "session status changed" : `session marked ${SESSION_STATUS_WORDS[status]}`;
    }
  }
}

/** How many runs a job missed, and when, in words — "missed 4 runs, 17:40–17:46", "missed 2 runs,
 *  Sun 23:00–Mon 07:00" across days; `null` for a single missed run, which reads as it always has.
 *  History, the result card, the missed-run card, Needs you, the notice and `pomade-runner` all say
 *  it with these words. */
export function missedRunsWords(missed: MissedRuns | null): string | null {
  if (missed === null || missed.count <= 1) return null;
  return `missed ${missed.count} runs, ${spanWords(missed)}`;
}

/** When a job's missed or held runs fell: "17:40–17:46", across days "Tue 23:40–Wed 00:20"; one
 *  run's time alone. */
function spanWords(runs: MissedRuns): string {
  if (runs.count <= 1) return clockTime(runs.last);
  const sameDay = new Date(runs.first).toDateString() === new Date(runs.last).toDateString();
  return sameDay ? `${clockTime(runs.first)}–${clockTime(runs.last)}` : `${dayTime(runs.first)}–${dayTime(runs.last)}`;
}

/** A held row's words: "held · 2 runs so far, 17:40–17:42", "held · 1 run so far, 17:40". History
 *  and `pomade-runner history` say it. */
export function heldRowWords(held: MissedRuns): string {
  return `held · ${heldRunsWords(held.count) ?? "no runs so far"}, ${spanWords(held)}`;
}

/** How many scheduled runs the switch has held, in words: "4 runs so far", "1 run so far"; `null`
 *  for none. The note under the switch and `pomade-runner runs` say it. */
export function heldRunsWords(count: number): string | null {
  return count <= 0 ? null : `${count} ${count === 1 ? "run" : "runs"} so far`;
}

/** A caught-up run's words after its missed runs: "caught up once" for one that stands for them
 *  all, "caught up 2 of 4" for a run of a Run all. */
export function caughtUpWords(series: RunSeries | null): string {
  return series === null ? "caught up once" : `caught up ${series.n} of ${series.of}`;
}

/** What started a run, in words, with its cause: "scheduled", "hook: Mac login", "chain: after
 *  Backup", "caught up" — "missed 4 runs, 17:40–17:46 · caught up once" for one that stands for
 *  more than one missed run; a run of a Run all stands for one of them: "caught up 2 of 4". */
export function runTriggerWords(run: { trigger: RunTrigger; cause: RunCause | null; missed?: MissedRuns | null; series?: RunSeries | null }): string {
  if (run.cause?.kind === "chain") return `chain: after ${run.cause.name}`;
  if (run.cause?.kind === "hook") return `hook: ${hookCauseWords(run.cause)}`;
  if (run.trigger === "caught-up" && run.series != null) return caughtUpWords(run.series);
  const missed = run.trigger === "caught-up" ? missedRunsWords(run.missed ?? null) : null;
  return missed === null ? TRIGGER_WORDS[run.trigger] : `${missed} · ${caughtUpWords(null)}`;
}

/** How many other runs a caught-up run that ran can still run (Run the other N): the runs it stood
 *  for but itself, while it is its job's latest run (`latest`) and no Run all of the job is going
 *  (`active`); 0 for any other run. */
export function otherMissedRuns(view: RunView, latest: RunRecord | null, active: readonly ActiveRun[]): number {
  if (!RESULTS.includes(view.state) || view.startedAt === null || view.trigger !== "caught-up" || view.series !== null || view.missed === null || view.missed.count < 2) return 0;
  if (latest?.run !== view.run || active.some((run) => run.job === view.job && run.series !== null)) return 0;
  return view.missed.count - 1;
}

/** A chain's action on a service, done, in words. */
export const ACTION_DONE_WORDS: Record<ServiceAction, string> = { restart: "restarted", start: "started", stop: "stopped" };

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
    case "pomade":
      return "opening Pomade";
    case "keeper":
      return "a fresh keeper, after the runs going";
    case "slot":
      return `${waits.ahead} ahead`;
  }
}

/** A run's state in words: "failed · exit 1", "queued · 1 ahead", "missed · skipped", "missed 4
 *  runs, 17:40–17:46 · skipped". */
export function runWords(view: RunView): string {
  const missed = missedRunsWords(view.missed) ?? "missed";
  switch (view.state) {
    case "missed-waiting":
      return `${missed} · waiting for you`;
    case "queued":
      return `queued · ${waitsWords(view.waits)}`;
    case "running":
      return waitingAt(view) !== null ? "waiting for you" : waitsForBackground(view) ? BACKGROUND_WORDS : "running";
    case "done":
      return "action" in view && view.action !== null ? ACTION_DONE_WORDS[view.action] : "done";
    case "stopped-by-you":
      return "stopped by you";
    case "skipped":
      return view.reason === null ? "skipped" : `skipped · ${view.reason}`;
    case "missed":
      return view.reason === null ? missed : `${missed} · ${view.reason}`;
    case "failed":
      return view.limitHit === null ? `failed · ${failureWords(view)}` : limitWords(view.limitHit);
  }
}

/** A run stopped at its job's time limit, in words: "stopped: time limit, 45 min". */
export function limitWords(minutes: number): string {
  return `stopped: time limit, ${durationWords(minutes * 60_000)}`;
}

/** Why a run failed, in a few words: its time limit, its reason, else its exit code or signal. */
export function failureWords(record: RunRecord): string {
  if (record.limitHit !== null) return limitWords(record.limitHit);
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

/** The answer to Delete on a job: its id and the file removed — `stopped` when its service was
 *  running and was stopped first — or why it was refused. */
export type DeleteResult = { ok: true; job: string; path: string; stopped: boolean } | { ok: false; reason: string };

export function isDeleteResult(value: unknown): value is DeleteResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.reason === "string";
  return value.ok === true && typeof value.job === "string" && typeof value.path === "string" && typeof value.stopped === "boolean";
}
