// The run lifecycle (docs/DESIGN.md "Runs", "Missed runs and load"): every tick the scheduler looks
// at the schedules, fires what is due on time, hands what was missed to each job's missed-run
// policy, starts queued runs as keeper sessions as far as the switch, the warm-up and the slots let
// it, stops a run past its time limit, warns of a long one, and records every run that ends in the
// history — then forgets its session. Run now does the same on a click.
//
// - **The look.** A tick looks at each enabled, valid script or git job's schedule since the previous look
//   (`dueOccurrences`): an occurrence at most `ON_TIME_MS` old runs; the others are missed and go to
//   the job's policy (`missed.ts`): one caught-up run, a missed run that waits for the person, or a
//   missed record. The previous look is the scheduler's last alive time, kept in `runs.json`, so a
//   scheduler started after the Mac was off — or after any stop — sees what it missed. Nothing is
//   due while the keeper is not followed: the look waits for it.
// - **Wake** is a gap between two ticks longer than `WAKE_GAP_MS` on the scheduler's clock: the Mac
//   slept (or the clock jumped ahead). It, like a login, begins the staged start:
//   once the services are up (`servicesSettled`), a warm-up (a setting) before caught-up runs start.
//   On-time runs never wait for it.
// - **The switch** holds a job's schedule while it holds the job: its look stays where it was, so
//   on release its occurrences come due — on time, or missed and to its policy. A queued run it
//   held goes to its job's policy on release when it is late by then.
// - **The queue** (`queue.ts`) starts what it can, oldest first; the rest wait — for Run at…'s time,
//   the switch, the warm-up, the job's previous run, Pomade (an agent run), or a low-priority slot.
//   An agent run that waits for Pomade has Runner open it (`pomade-open.ts`), one opening for every
//   run that waits; when Pomade cannot be opened, those runs fail with why.
// - **Overlap**, when the job has a run going: `skip` records a skipped run ("previous run still
//   going") · `parallel` queues another · `queue` holds one queued run; while one is held, a further
//   one is skipped ("a run is already queued"). An on-time run covers a caught-up one still queued.
// - **A run** is a keeper session `run:<job>:<run id>`: a script's command in the job's folder, a
//   git job's `pomade-git` in the workspace root (`git-runs.ts`), run by the login shell, with low
//   priority as the job says and its context in the environment (`runEnv`). Its end comes from the
//   keeper's list: exit 0 is `done`, any other end `failed`, Ctrl+C or Stop `stopped-by-you`; a git
//   run's is read with the result `pomade-git` wrote. Past its job's `time-limit` Runner stops it
//   (`failed`, "stopped: time limit, 45 min"). Going longer than the long-run warning (a setting) makes
//   it a Needs-you item, once — it keeps running. The record keeps the last lines of the output log,
//   a git run's result per repo.
// - **Hooks and chains.** An event fires the jobs whose hook it matches (`hooks.ts`): Runner's own
//   `login` once per login — a scheduler start that finds no keeper running — and the platform's
//   events through `hook()`. A run that ends `done` or `failed` fires the jobs that follow it (`chains.ts`):
//   a script or git job runs (trigger `chain`, linked to its parent), a service gets its action through the
//   supervisor, recorded in the history. Every such firing passes the loop guard (`loop-guard.ts`)
//   first: one too many within its window pauses the job until Resume. Hook and chain runs join the
//   queue like any run; a hook run waits for the warm-up, a chain run does not.
// - **Records.** The runs going, each job's latest record, the last look, the held looks and the
//   loop guard live in `runs.json` in Runner's records folder in the workspace, written on every change and at least
//   every `ALIVE_EVERY_MS`, so a restarted scheduler picks up the runs that are going — and the ends
//   that came while it was down, firing their chains once — where the last one left them.
//
// Every action — a tick, Run now, a hook, the switch, a missed run's choice, Resume — runs in one
// lane, one after another. Time comes from the clock given, so every rule is tested without
// waiting.

import { randomBytes, randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isGitRunOutput, type GitRunOutput, type NoticeParams } from "pomade-kit/protocol";
import { nextOccurrence } from "pomade-kit/schedule";

import { agentMode, modeWords, type AgentsApi } from "../integrations/agents";
import type { PomadeForRuns } from "../integrations/pomade-open";
import { entryId, type AgentJob, type GitJob, type Job, type JobsSnapshot, type ScriptJob, type ServiceAction, type ServiceJob } from "../jobs/model";
import { KIND_DEFAULTS } from "../jobs/parse";
import type { AgentTurns } from "../keeper/agent-turns";
import { newRunId, sessionIdOf } from "../keeper/ids";
import type { ChainActionOutcome, RunnerSession } from "../keeper/model";
import { jobIdOf } from "../keeper/services";
import type { Sessions } from "../keeper/sessions";
import { liveOutputLogPath, runsRecordPath, type RecordsFolder, type StateFolder } from "../locations";
import { AGENT_EXIT_WAIT_MS, agentArgv, agentEnd, lookupWindow, pickSession, SESSION_LOOKUP_EVERY_MS } from "./agent-runs";
import { chainCause, followers, parentResult } from "./chains";
import type { Clock } from "./clock";
import { gitCommandLine, gitRunEnd, type SessionEnd } from "./git-runs";
import { foundRecord, keptRecord, lastLines, type History } from "./history";
import { hooked, LOGIN, type HookFiring } from "./hooks";
import type { Log } from "./log";
import { createLoopGuard, FIRING_LIMIT, FIRING_WINDOW_MS, parseLoopGuard, type LoopGuardRecords } from "./loop-guard";
import { decideMissed, parseRunAt, pastWords, type MissedDecision } from "./missed";
import {
  clockTime,
  dayTime,
  durationWords,
  isActiveRun,
  limitWords,
  NEXT_UP_RUNS,
  parseRunRecord,
  runTriggerWords,
  SWITCH_WORDS,
  waitsWords,
  withAgentDefaults,
  type ActiveRun,
  type AgentRun,
  type AgentWait,
  type JobRuns,
  type MissedChoice,
  type MissedChoiceResult,
  type NeedsYouItem,
  type NextRun,
  type ResumeResult,
  type RunActionResult,
  type RunCause,
  type RunRecord,
  type RunStopResult,
  type RunTrigger,
  type RunView,
  type SwitchPosition,
  type SwitchState,
} from "./model";
import { longRunNotice, loopNotice, missedNotice, waitingNotice, WAIT_WORDS } from "./needs-you";
import { holds, planQueue } from "./queue";
import type { Settings } from "./settings";
import type { SwitchStore } from "./switch";
import { dueOccurrences, ON_TIME_MS } from "./triggers";

/** A gap between two ticks longer than this on the scheduler's clock is a wake: the Mac slept, or
 *  the clock jumped ahead. A tick is a second; a busy moment stalls it far less. */
export const WAKE_GAP_MS = 60_000;
/** The last look is written at least this often, so a scheduler started after a power-off knows,
 *  within this much, since when it missed. A look that fires or misses something is written at
 *  once. */
export const ALIVE_EVERY_MS = 60_000;
/** How old a session's end (this Mac's clock) is before its run is recorded: the keeper may still be
 *  appending the program's last output to the log when it reports the exit. */
export const LOG_SETTLE_MS = 500;

/** What `runs.json` keeps. Plain JSON. */
export interface RunsRecords {
  /** Missed runs waiting for the person, queued and running runs, oldest first. */
  active: ActiveRun[];
  /** Each job's latest record, by job id. */
  last: Record<string, RunRecord>;
  /** The scheduler's latest look at the schedules — its last alive time (epoch ms); `null` before
   *  the first. */
  lookedAt: number | null;
  /** The jobs the switch holds: the look their schedule waits at (epoch ms), by job id. */
  held: Record<string, number>;
  /** The loop guard: recent hook and chain firings, and the jobs it paused. */
  guard: LoopGuardRecords;
}

export interface RunsStore {
  load(): Promise<RunsRecords>;
  /** Keep the records; writes happen in order and never overlap. */
  save(records: RunsRecords): void;
  /** Resolves once every save has been written. */
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A run going as `runs.json` keeps it; a field a record of an older build lacks gets its default. */
function parseActiveRun(value: unknown): ActiveRun | null {
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === "string" && Object.hasOwn(KIND_DEFAULTS, value.kind) ? (value.kind as keyof typeof KIND_DEFAULTS) : "script";
  const run = { lowPriority: KIND_DEFAULTS[kind].lowPriority, cause: null, runAt: null, deadline: null, waits: null, limitHit: null, warnedAt: null, warningDismissed: false, ...value, agent: withAgentDefaults(value.agent) };
  return isActiveRun(run) ? run : null;
}

/** The records in `<records>/runs.json`, replaced whole on every save; a run's output log is kept
 *  by name (`keptRecord`) and read back where it is: a run going's in the state folder, a finished
 *  one's where a reader finds it (`foundRecord`). */
export function fileRunsStore(records: RecordsFolder, state: StateFolder, log: Log): RunsStore {
  const file = runsRecordPath(records);
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      const empty: RunsRecords = { active: [], last: {}, lookedAt: null, held: {}, guard: { fired: {}, paused: {} } };
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return empty;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        log(`runs: ${file} is not readable JSON; starting with no runs going`);
        return empty;
      }
      if (!isRecord(data)) return empty;
      const active = Array.isArray(data.active)
        ? data.active.flatMap((value) => {
            const run = parseActiveRun(value);
            return run === null ? [] : [run.log === null ? run : { ...run, log: liveOutputLogPath(state, run.job, run.run) }];
          })
        : [];
      const last: Record<string, RunRecord> = {};
      if (isRecord(data.last)) {
        for (const [job, value] of Object.entries(data.last)) {
          const record = parseRunRecord(value);
          if (record !== null) last[job] = await foundRecord(records, state, record);
        }
      }
      const lookedAt = typeof data.lookedAt === "number" && Number.isFinite(data.lookedAt) ? data.lookedAt : null;
      const held: Record<string, number> = {};
      if (isRecord(data.held)) for (const [job, at] of Object.entries(data.held)) if (typeof at === "number" && Number.isFinite(at)) held[job] = at;
      return { active, last, lookedAt, held, guard: parseLoopGuard(data.guard) };
    },
    save(next) {
      const kept: RunsRecords = { ...next, active: next.active.map(keptRecord), last: Object.fromEntries(Object.entries(next.last).map(([job, record]) => [job, keptRecord(record)])) };
      const data = `${JSON.stringify(kept, null, 2)}\n`;
      writing = writing
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, data);
          await rename(`${file}.tmp`, file);
        })
        .catch((err: unknown) => log(`runs: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`));
    },
    flush: () => writing,
  };
}

/** A run's environment, beyond the login shell's (docs/DESIGN.md "Triggers", "Context for
 *  scripts"): the job, the run and its trigger; the job's project; a hook's context; a chain's
 *  parent. */
export function runEnv(job: Job, run: string, trigger: RunTrigger, projectPath: string | null, cause: RunCause | null): Record<string, string> {
  const env: Record<string, string> = { POMADE_JOB: job.id, POMADE_RUN_ID: run, POMADE_TRIGGER: trigger };
  if (job.project !== null) env.POMADE_PROJECT = job.project;
  if (projectPath !== null) env.POMADE_PROJECT_PATH = projectPath;
  if (cause?.kind === "hook") Object.assign(env, cause.context);
  if (cause?.kind === "chain") Object.assign(env, { POMADE_PARENT_JOB: cause.job, POMADE_PARENT_RUN_ID: cause.run, POMADE_PARENT_RESULT: cause.result });
  return env;
}

/** How long a run has counted toward its time limit and its long-run warning: an agent run leaves
 *  out the time it waited for the person at a prompt, so the limit pauses while it waits. */
export function ranFor(run: ActiveRun, now: number): number {
  if (run.startedAt === null) return 0;
  const wait = run.agent?.waiting ?? null;
  const waited = (run.agent?.waitedMs ?? 0) + (wait === null ? 0 : Math.max(0, now - wait.since));
  return Math.max(0, now - run.startedAt - waited);
}

/** The jobs that run once per trigger: scripts, git jobs and agent jobs. */
export type RunJob = ScriptJob | GitJob | AgentJob;

/** The working folder of a job's runs, workspace-relative: a git job's is the workspace root. */
const runFolder = (job: RunJob): string => (job.kind === "git" ? "" : job.folder);

/** What `pomade-git` wrote to a run's result file; `null` when there is no such file or it is not a
 *  `GitRunOutput`. */
async function readGitResult(file: string): Promise<GitRunOutput | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isGitRunOutput(value) ? value : null;
  } catch {
    return null;
  }
}

export interface RunsOptions {
  sessions: Sessions;
  /** The checked jobs now. */
  jobs(): JobsSnapshot;
  /** The workspace settings now. */
  settings(): Settings;
  /** Whether the services' staged start is done: none waits for its first start or is starting. */
  servicesSettled(): boolean;
  clock: Clock;
  log: Log;
  history: History;
  store: RunsStore;
  switchStore: SwitchStore;
  /** A project's root folder (absolute); `null` when it is not known. */
  projectPath(project: string): string | null;
  /** The `pomade-git` command: in the command folder of the Pomade Runner belongs to. */
  pomadeGit: string;
  /** Where a git run's result goes (absolute): `pomade-git --json`'s output. */
  gitResult(job: string, run: string): string;
  /** Move a finished run's output log to where it is kept; where that is, or `null` when there is
   *  no log. */
  keepLog(job: string, run: string): Promise<string | null>;
  /** Post a notice: a missed run that waits for the person, a long-run warning, a loop-guard pause. */
  post(notice: NoticeParams): void;
  /** A chain's action on a service, through the supervisor; `why` names the chain, for its log. */
  serviceAction(job: string, action: ServiceAction, why: string): Promise<ChainActionOutcome>;
  /** The Agents app through Pomade's broker while Runner is connected to Pomade; `null` while it
   *  is not. */
  agents(): AgentsApi | null;
  /** Pomade for agent runs: whether it is up for them, and opening it when it is not. */
  pomade: PomadeForRuns;
  /** Following agent runs' turns in their sessions. */
  turns: AgentTurns;
  /** The user's login shell: an agent run's line runs in it, interactive. */
  shell: string;
  /** A run's session started. */
  onStarted(run: ActiveRun): void;
  /** A run ended, could not start, was skipped or missed: its record is in the history. */
  onFinished(record: RunRecord): void;
  /** The runs going, a job's latest record, the switch or the runs' Needs-you items changed. */
  onChange(): void;
  /** The six hex digits of a run id; random by default. */
  random?: () => string;
}

export interface Runs {
  /** Read the records and the switch. Whether this start is a login is decided once the keeper is
   *  followed. */
  load(): Promise<void>;
  /** Record the runs that ended, look at the schedules, enforce the limits, start what may start.
   *  A tick asked for while one is due is dropped. */
  tick(): Promise<void>;
  /** Run a script, git or agent job now (trigger `manual`), by its id or name, under its overlap policy. */
  runNow(ref: string): Promise<RunActionResult>;
  /** An event: fire every job whose hook it matches, through the loop guard and the queue. Runner
   *  fires `login` itself, once per login; Pomade's and the agents' events come here (E-007). */
  hook(firing: HookFiring): Promise<void>;
  /** Lift the loop guard's pause of a job, by its id or name. */
  resume(ref: string): Promise<ResumeResult>;
  /** The person's choice for the missed run of `ref` that waits for them. */
  missed(ref: string, choice: MissedChoice): Promise<MissedChoiceResult>;
  /** Stop a running run as stopped by you. */
  stop(job: string, run: string): Promise<RunStopResult>;
  /** Dismiss a run's long-run warning; whether there was one. */
  dismissWarning(job: string, run: string): boolean;
  switch(): SwitchState;
  /** Set the switch, once it is written: held runs wait; on release, held runs that are late go to
   *  their policy. */
  setSwitch(position: SwitchPosition): Promise<SwitchState>;
  /** Missed runs waiting for the person, queued and running runs, oldest first. */
  active(): ActiveRun[];
  /** Missed runs waiting for the person, long-run warnings and the jobs the loop guard paused. */
  needsYou(): NeedsYouItem[];
  /** Every enabled scheduled job's next run, and the runs set with Run at…, soonest first. */
  nextUp(): NextRun[];
  /** Each run job's next and latest run. */
  jobRuns(): JobRuns[];
  /** A run going or finished; `null` when there is none. */
  find(job: string, run: string): Promise<RunView | null>;
  /** The output logs and git result files runs write now. */
  logsInUse(): Set<string>;
  /** Resolves once the lane is idle, the service actions under way are recorded and the records
   *  are written. */
  close(): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MINUTE_MS = 60_000;

/** A loop-guard pause in words. */
export const LOOP_WORDS = `triggered ${FIRING_LIMIT}× in ${FIRING_WINDOW_MS / MINUTE_MS} min — looks like a loop`;

/** Whether a job runs once per trigger: a script, a git or an agent job. */
const isRunJob = (job: Job): job is RunJob => job.kind !== "service";

/** The jobs a schedule fires: valid, enabled, scheduled. */
function scheduledRuns(snapshot: JobsSnapshot): RunJob[] {
  return snapshot.jobs.flatMap((entry) => (entry.valid && isRunJob(entry.job) && entry.job.enabled && entry.job.trigger.kind === "schedule" ? [entry.job] : []));
}

/** What a run's session runs: a command line by the login shell, or — an agent run — a program and
 *  its arguments; in `cwd`. An agent run's agent, mode and session. */
interface Launch {
  command: string;
  argv?: string[];
  cwd: string;
  agent: AgentRun | null;
}

/** How a run's session ended, as its record says it. */
function endOf(session: RunnerSession | undefined, run: ActiveRun): SessionEnd {
  const exit = session?.info.exit ?? null;
  if (exit === null) return { state: "failed", reason: "its session is gone", exitCode: null, signal: null, limitHit: null };
  const { code: exitCode, signal } = exit;
  switch (exit.reason) {
    case "exited":
      return { state: "done", reason: null, exitCode, signal, limitHit: null };
    case "crashed":
      return { state: "failed", reason: null, exitCode, signal, limitHit: null };
    case "stopped-by-you":
      return { state: "stopped-by-you", reason: null, exitCode, signal, limitHit: null };
    case "stopped":
      return { state: "failed", reason: "stopped by Runner", exitCode, signal, limitHit: null };
    case "time-limit":
      return { state: "failed", reason: run.limitHit === null ? "stopped: time limit" : limitWords(run.limitHit), exitCode, signal, limitHit: run.limitHit };
    case "lost-in-keeper-crash":
      return { state: "failed", reason: "lost in a keeper crash", exitCode, signal, limitHit: null };
  }
}

export function createRuns(options: RunsOptions): Runs {
  const { sessions, clock, log, history, store } = options;
  const random = options.random ?? ((): string => randomBytes(3).toString("hex"));
  let active: ActiveRun[] = [];
  let last = new Map<string, RunRecord>();
  let held = new Map<string, number>();
  let switchState: SwitchState = { position: "running", since: null };
  /** Runs that were going when the scheduler started: their record may be in the history already. */
  const recovered = new Set<string>();
  /** The scheduler's previous look at the schedules. */
  let lookedAt = clock.now().getTime();
  /** When the look was last written. */
  let savedAt = Number.NEGATIVE_INFINITY;
  /** The previous tick (epoch ms); `null` before the first. */
  let tickedAt: number | null = null;
  /** The staged start after a login or a wake: when the services were up; `null` while they still
   *  start. `null` as a whole when there is none, or once the warm-up is over. */
  let stage: { settledAt: number | null } | null = null;
  let lane: Promise<unknown> = Promise.resolve();
  let tickQueued = false;
  let guard = createLoopGuard();
  /** Whether this start is a login is decided once the keeper is followed. */
  let startDecided = false;
  /** A login: its hooks fire on the first reconcile that can run them. */
  let login = false;
  /** Chain actions on services under way: each records its outcome in the lane when it answers. */
  const acting = new Set<Promise<void>>();
  /** Agent runs whose exit command was typed: by session, when Runner stops it if it has not ended
   *  (`performance.now()` — the agent's own time, whatever the scheduler's clock). */
  const exitDeadlines = new Map<string, number>();
  /** Agent runs whose session is looked up: by session, when it was last asked (`performance.now()`). */
  const lookedUp = new Map<string, number>();
  /** Whether Runner is opening Pomade for the agent runs that wait for it. */
  let opening = false;
  /** Set by `close()`: an opening that ends later changes nothing. */
  let closed = false;

  const now = (): Date => clock.now();
  const key = (job: string, run: string): string => `${job}\n${run}`;
  const save = (): void => {
    savedAt = now().getTime();
    store.save({ active, last: Object.fromEntries(last), lookedAt, held: Object.fromEntries(held), guard: guard.records(savedAt) });
  };

  function inLane<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.then(work);
    lane = result.catch(() => undefined);
    return result;
  }

  /** Write a finished run's record, once, and fire the jobs that follow it — once: a record a
   *  previous scheduler wrote fired them then. */
  async function record(entry: RunRecord): Promise<void> {
    const runKey = key(entry.job, entry.run);
    const written = recovered.delete(runKey) && (await history.find(entry.job, entry.run)) !== null;
    if (!written) await history.append(entry);
    active = active.filter((run) => run.job !== entry.job || run.run !== entry.run);
    last.set(entry.job, entry);
    save();
    options.onChange();
    options.onFinished(entry);
    if (!written) await chain(entry);
  }

  /** A finished run fires the jobs that follow it. */
  async function chain(entry: RunRecord): Promise<void> {
    const result = parentResult(entry);
    if (result === null) return;
    const at = now();
    for (const job of followers(options.jobs(), entry)) await triggered(job, chainCause(entry, result), at);
  }

  /** An event fires the jobs whose hook it matches. */
  async function fireHook(firing: HookFiring): Promise<void> {
    const jobs = hooked(options.jobs(), firing);
    if (jobs.length === 0) return;
    log(`hook ${firing.event}: fires ${jobs.map((job) => job.id).join(", ")}`);
    const at = now();
    for (const job of jobs) await triggered(job, { kind: "hook", event: firing.event, context: firing.context }, at);
  }

  /** A hook or a chain fires a job: past the loop guard, a script's or git job's run joins the
   *  queue; a service gets its chain's action. */
  async function triggered(job: RunJob | ServiceJob, cause: RunCause, at: Date): Promise<void> {
    const verdict = guard.fire(job, at.getTime());
    const why = runTriggerWords({ trigger: cause.kind, cause });
    if (verdict === "paused") {
      log(`job ${job.id}: paused by the loop guard; ${why} does not fire it`);
    } else if (verdict === "pause") {
      log(`job ${job.id}: fired more than ${FIRING_LIMIT} times in ${durationWords(FIRING_WINDOW_MS)} by hooks or chains — looks like a loop; paused until Resume`);
      options.onChange();
      options.post(loopNotice(job.name));
    } else if (job.kind === "service") {
      if (cause.kind === "chain" && job.after !== null) act(job, job.after.action, cause, at);
    } else {
      await fire(job, cause.kind, at, null, cause);
    }
    save();
  }

  /** A chain's action on a service, through the supervisor; its outcome is recorded once it
   *  answers, without holding the lane while a restart waits for the old session to end. */
  function act(job: ServiceJob, action: ServiceAction, cause: Extract<RunCause, { kind: "chain" }>, at: Date): void {
    const run = newRunId(at, random);
    const why = runTriggerWords({ trigger: "chain", cause });
    const work = options
      .serviceAction(job.id, action, why)
      .catch((err: unknown): ChainActionOutcome => ({ result: "failed", reason: errorText(err) }))
      .then((outcome) =>
        inLane(async () => {
          log(`service ${job.id}: ${action} (${why}) — ${outcome.result === "done" ? "done" : `${outcome.result}: ${outcome.reason}`}`);
          await record({
            job: job.id,
            name: job.name,
            kind: job.kind,
            project: job.project,
            folder: job.folder,
            run,
            trigger: "chain",
            cause,
            dueAt: at.getTime(),
            agent: null,
            state: outcome.result,
            action,
            reason: outcome.result === "done" ? null : outcome.reason,
            startedAt: null,
            endedAt: now().getTime(),
            durationMs: null,
            exitCode: null,
            signal: null,
            log: null,
            lastLines: [],
            git: null,
            limitHit: null,
          });
        }),
      );
    acting.add(work);
    void work.finally(() => acting.delete(work));
  }

  function newRun(job: RunJob, trigger: RunTrigger, dueAt: Date, cause: RunCause | null = null): ActiveRun {
    return {
      job: job.id,
      name: job.name,
      kind: job.kind,
      project: job.project,
      folder: runFolder(job),
      run: newRunId(dueAt, random),
      trigger,
      cause,
      dueAt: dueAt.getTime(),
      state: "queued",
      lowPriority: job.lowPriority,
      runAt: null,
      deadline: null,
      waits: null,
      startedAt: null,
      session: null,
      log: null,
      limitHit: null,
      warnedAt: null,
      warningDismissed: false,
      agent: null,
    };
  }

  /** A run's record: what it was, and how it ended. */
  const ended = (run: ActiveRun, end: Omit<RunRecord, keyof Omit<ActiveRun, "state" | "startedAt" | "log" | "limitHit"> | "action">): RunRecord => ({
    job: run.job,
    name: run.name,
    kind: run.kind,
    project: run.project,
    folder: run.folder,
    run: run.run,
    trigger: run.trigger,
    cause: run.cause,
    dueAt: run.dueAt,
    agent: run.agent,
    action: null,
    ...end,
  });

  /** The record of a run that never started. */
  const notStarted = (run: ActiveRun, state: "failed" | "skipped" | "missed", reason: string): RunRecord =>
    ended(run, { state, reason, startedAt: null, endedAt: now().getTime(), durationMs: null, exitCode: null, signal: null, log: null, lastLines: [], git: null, limitHit: null });

  async function skip(run: ActiveRun, reason: string): Promise<void> {
    log(`run ${run.job} ${run.run}: skipped — ${reason}`);
    await record(notStarted(run, "skipped", reason));
  }

  async function miss(run: ActiveRun, reason: string): Promise<void> {
    log(`run ${run.job} ${run.run}: missed — ${reason}`);
    await record(notStarted(run, "missed", reason));
  }

  /** The valid job that runs once per trigger `id` names now, enabled or not. */
  function runJobOf(id: string): RunJob | null {
    const entry = options.jobs().jobs.find((candidate) => entryId(candidate) === id);
    return entry?.valid === true && isRunJob(entry.job) ? entry.job : null;
  }

  /** The valid job of `kind` that `id` names now, or why it cannot run. */
  function runnable(id: string, kind: ActiveRun["kind"]): { job: RunJob; workspace: string } | string {
    const snapshot = options.jobs();
    const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
    if (snapshot.workspace === null) return "no workspace is known";
    if (entry === undefined) return "its job file is gone";
    if (!entry.valid) return "its job file is invalid";
    if (entry.job.kind !== kind || !isRunJob(entry.job)) return `it is ${entry.job.kind === "agent" ? "an" : "a"} ${entry.job.kind} job now`;
    if (!entry.job.enabled) return "its job is disabled";
    return { job: entry.job, workspace: snapshot.workspace };
  }

  /** What a run's session runs: a script's command in its folder; for a git job, `pomade-git` in the
   *  workspace root with its result into the run's result file; for an agent job, its launch spec's
   *  line — or why it cannot start. */
  async function commandOf(job: RunJob, run: ActiveRun, workspace: string): Promise<Launch | string> {
    if (job.kind === "script") return { command: job.command, cwd: join(workspace, job.folder), agent: null };
    if (job.kind === "agent") return agentLaunch(job, workspace);
    try {
      await access(options.pomadeGit, constants.X_OK);
    } catch {
      return `cannot start — pomade-git is not in Pomade's command folder (${options.pomadeGit}); Pomade puts it there when it starts`;
    }
    const result = options.gitResult(run.job, run.run);
    await mkdir(dirname(result), { recursive: true });
    await rm(result, { force: true });
    return { command: gitCommandLine(options.pomadeGit, job, result), cwd: workspace, agent: null };
  }

  /** An agent run's launch: the agent and its mode from the roster, the launch spec for a session id
   *  Runner makes and the job's prompt, in the job's folder — or why it cannot start. */
  async function agentLaunch(job: AgentJob, workspace: string): Promise<Launch | string> {
    const api = options.agents();
    if (api === null) return "cannot start — Runner is not connected to Pomade, and an agent run needs it";
    let cwd: string;
    try {
      cwd = await realpath(join(workspace, job.folder));
    } catch {
      return `cannot start — its folder ${job.folder === "" ? "the workspace root" : job.folder} does not exist`;
    }
    try {
      const agent = (await api.roster()).find((candidate) => candidate.id === job.agent);
      if (agent === undefined) return `cannot start — the Agents app has no agent "${job.agent}"`;
      const mode = agentMode(agent, job.mode);
      if (mode === undefined) return `cannot start — ${agent.name} has no ${modeWords(job.mode)} mode`;
      const spec = await api.launchSpec({ agent: agent.id, mode: mode.id, sessionId: randomUUID(), prompt: job.prompt });
      return {
        command: spec.line,
        argv: agentArgv(options.shell, spec.line),
        cwd,
        agent: { agent: agent.id, name: agent.name, provider: agent.provider, mode: mode.id, modeName: mode.name, sessionId: spec.sessionId, cwd, startedAt: new Date().toISOString(), exit: spec.exit, exitSentAt: null, waiting: null, waitedMs: 0 },
      };
    } catch (err) {
      return `cannot start — ${errorText(err)}`;
    }
  }

  /** Start a queued run's session. */
  async function start(run: ActiveRun): Promise<void> {
    const found = runnable(run.job, run.kind);
    if (typeof found === "string") {
      await skip(run, found);
      return;
    }
    const { job, workspace } = found;
    const session = sessionIdOf({ kind: "run", job: run.job, run: run.run });
    if (session === null) {
      await record(notStarted(run, "failed", "the job id is too long to name a session"));
      return;
    }
    let what: Awaited<ReturnType<typeof commandOf>>;
    try {
      what = await commandOf(job, run, workspace);
    } catch (err) {
      what = `cannot start — ${errorText(err)}`;
    }
    if (typeof what === "string") {
      log(`run ${run.job} ${run.run}: ${what}`);
      await record(notStarted(run, "failed", what));
      return;
    }
    // The run is recorded as running before its session starts: a scheduler that dies in between
    // finds the session's end later.
    Object.assign(run, { state: "running", lowPriority: job.lowPriority, waits: null, startedAt: now().getTime(), session, agent: what.agent });
    save();
    try {
      const env = runEnv(job, run.run, run.trigger, job.project === null ? null : options.projectPath(job.project), run.cause);
      const started = await sessions.spawn(
        { kind: "run", job: run.job, run: run.run },
        {
          title: job.name,
          command: what.command,
          ...(what.argv === undefined ? {} : { argv: what.argv }),
          cwd: what.cwd,
          // `pomade-git` resolves repo names in the workspace whose jobs these are.
          env: job.kind === "git" ? { ...env, POMADE_WORKSPACE: workspace } : env,
          background: job.lowPriority,
        },
      );
      run.log = started.log;
      // The session lookup goes by the agent's own record of its start: this Mac's clock.
      if (run.agent !== null) run.agent.startedAt = new Date(started.info.startedAt).toISOString();
      save();
      if (run.agent !== null) follow(run, run.agent);
      log(`run ${run.job} ${run.run}: started (${run.trigger})`);
      options.onChange();
      options.onStarted(run);
    } catch (err) {
      const reason = `cannot start — ${errorText(err)}`;
      log(`run ${run.job} ${run.run}: ${reason}`);
      await record(notStarted(run, "failed", reason));
    }
  }

  /** A run is due: queue it, or apply the job's overlap policy. The run, whatever became of it. An
   *  on-time run covers a caught-up run of its job still queued. */
  async function fire(job: RunJob, trigger: RunTrigger, dueAt: Date, deadline: number | null = null, cause: RunCause | null = null): Promise<ActiveRun> {
    const run = newRun(job, trigger, dueAt, cause);
    run.deadline = deadline;
    if (trigger === "scheduled") {
      for (const late of active.filter((candidate) => candidate.job === job.id && candidate.state === "queued" && candidate.trigger === "caught-up" && candidate.runAt === null)) {
        await miss(late, `skipped · the ${clockTime(dueAt.getTime())} run covers it`);
      }
    }
    const going = active.filter((candidate) => candidate.job === job.id && candidate.state !== "missed-waiting");
    if (going.length > 0 && job.overlap === "skip") {
      await skip(run, "previous run still going");
    } else if (going.length > 0 && job.overlap === "queue" && going.some((candidate) => candidate.state === "queued")) {
      await skip(run, "a run is already queued");
    } else {
      active.push(run);
      save();
      options.onChange();
    }
    return run;
  }

  /** The staged start: over, or what it waits for. Begun at a login and on wake: it waits for the
   *  services, then the warm-up. */
  function warmUp(at: number): { over: true } | { over: false; until: number | null } {
    if (stage === null) return { over: true };
    if (stage.settledAt === null) {
      if (!options.servicesSettled()) return { over: false, until: null };
      stage.settledAt = at;
      log(`warm-up: the services are up; caught-up and hook runs wait until ${clockTime(at + options.settings().warmUpMinutes * MINUTE_MS)}`);
    }
    const until = stage.settledAt + options.settings().warmUpMinutes * MINUTE_MS;
    if (at < until) return { over: false, until };
    stage = null;
    log("warm-up: over");
    return { over: true };
  }

  /** Caught-up runs still queued past their deadline are missed. */
  async function expire(at: number): Promise<void> {
    for (const run of active.filter((candidate) => candidate.state === "queued" && candidate.deadline !== null && at >= candidate.deadline)) {
      const job = runJobOf(run.job);
      await miss(run, job === null ? "skipped · past its worth-until" : pastWords({ missed: job.missed, worthUntil: job.worthUntil, schedule: null }));
    }
  }

  /** Start what the queue lets start, and keep what every other queued run waits for. */
  async function advance(): Promise<void> {
    const at = now().getTime();
    await expire(at);
    const snapshot = options.jobs();
    const overlap = (job: string): RunJob["overlap"] | undefined => {
      const entry = snapshot.jobs.find((candidate) => entryId(candidate) === job);
      return entry?.valid === true && entry.job.kind !== "service" ? entry.job.overlap : undefined;
    };
    for (;;) {
      const plan = planQueue(active, {
        now: at,
        maxLowPriority: options.settings().maxLowPriorityRuns,
        position: switchState.position,
        warmUp: warmUp(at),
        overlap,
        pomadeUp: options.pomade.up(),
      });
      if (plan.start.length === 0) {
        let changed = false;
        for (const run of active) {
          const waits = plan.waits.get(run) ?? null;
          if (JSON.stringify(waits) === JSON.stringify(run.waits)) continue;
          run.waits = waits;
          changed = true;
          if (waits !== null) log(`run ${run.job} ${run.run}: queued · ${waitsWords(waits)}`);
        }
        if (changed) {
          save();
          options.onChange();
        }
        if ([...plan.waits.values()].some((waits) => waits.kind === "pomade")) openPomade();
        return;
      }
      for (const run of plan.start) await start(run);
    }
  }

  /** Open Pomade for the agent runs that wait for it, unless that is under way. Once it is up, they
   *  start as the queue lets them; when it cannot be, the runs waiting for it then fail with why. */
  function openPomade(): void {
    if (opening) return;
    opening = true;
    void options.pomade.open().then((why) =>
      inLane(async () => {
        opening = false;
        if (closed) return;
        if (why === null) {
          log("Pomade: up for agent runs");
          if (sessions.followed() && options.jobs().workspace !== null) await advance();
          return;
        }
        const reason = `cannot start — ${why}`;
        for (const run of active.filter((candidate) => candidate.state === "queued" && candidate.waits?.kind === "pomade")) {
          log(`run ${run.job} ${run.run}: ${reason}`);
          await record(notStarted(run, "failed", reason));
        }
      }),
    );
  }

  /** A missed run of a `wait-for-me` job waits for the person: one per job, at its latest missed time. */
  function waitForMe(job: RunJob, dueAt: Date, run: ActiveRun | null = null): void {
    const waiting = active.find((candidate) => candidate.job === job.id && candidate.state === "missed-waiting");
    if (waiting !== undefined) {
      waiting.dueAt = Math.max(waiting.dueAt, dueAt.getTime());
      if (run !== null) active = active.filter((candidate) => candidate !== run);
      log(`run ${waiting.job} ${waiting.run}: missed ${dayTime(waiting.dueAt)}; waits for you`);
      save();
      options.onChange();
      return;
    }
    const next = run ?? newRun(job, "scheduled", dueAt);
    Object.assign(next, { state: "missed-waiting", trigger: "scheduled", dueAt: dueAt.getTime(), runAt: null, deadline: null, waits: null });
    if (!active.includes(next)) active.push(next);
    log(`run ${next.job} ${next.run}: missed ${dayTime(next.dueAt)}; waits for you`);
    save();
    options.onChange();
    options.post(missedNotice(next));
  }

  /** Apply a job's missed-run decision; `run` is a held queued run it is about, when there is one. */
  async function applyMissed(job: RunJob, decision: MissedDecision, run: ActiveRun | null): Promise<void> {
    switch (decision.action) {
      case "catch-up":
        if (run !== null) {
          Object.assign(run, { trigger: "caught-up", runAt: null, deadline: decision.deadline });
          return;
        }
        if (active.some((candidate) => candidate.job === job.id && candidate.state === "queued" && candidate.trigger === "caught-up")) {
          log(`job ${job.id}: a caught-up run is queued already`);
          return;
        }
        await fire(job, "caught-up", decision.dueAt, decision.deadline);
        return;
      case "record":
        await miss(run ?? newRun(job, "scheduled", decision.dueAt), decision.reason);
        return;
      case "wait":
        waitForMe(job, decision.dueAt, run);
        return;
    }
  }

  /** Fire every scheduled job whose occurrence came since its look; hand the missed ones to their
   *  policy. A job the switch holds keeps its look where it was. */
  async function look(at: Date): Promise<void> {
    const since = lookedAt;
    lookedAt = at.getTime();
    let handled = false;
    const jobs = scheduledRuns(options.jobs());
    for (const job of jobs) {
      if (job.trigger.kind !== "schedule") continue;
      if (holds(switchState.position, { trigger: "scheduled", lowPriority: job.lowPriority })) {
        if (!held.has(job.id)) {
          held.set(job.id, since);
          handled = true;
        }
        continue;
      }
      const from = held.get(job.id) ?? since;
      if (held.delete(job.id)) handled = true;
      const due = dueOccurrences(job.trigger.schedule, new Date(from), at);
      if (due.missed.length > 0) {
        handled = true;
        const decision = decideMissed({ missed: job.missed, worthUntil: job.worthUntil, schedule: job.trigger.schedule }, due.missed, at, due.fire);
        const times = due.missed.length > 3 ? `${due.missed.length} runs, the latest ${dayTime(decision.dueAt.getTime())}` : due.missed.map((time) => dayTime(time.getTime())).join(", ");
        log(`job ${job.id}: missed ${times} — ${decisionWords(decision)}`);
        await applyMissed(job, decision, null);
      }
      if (due.fire !== null) {
        handled = true;
        await fire(job, "scheduled", due.fire);
      }
    }
    const scheduled = new Set(jobs.map((job) => job.id));
    for (const job of [...held.keys()]) {
      if (scheduled.has(job)) continue;
      held.delete(job);
      handled = true;
    }
    if (handled || lookedAt - savedAt >= ALIVE_EVERY_MS) save();
  }

  /** Stop a run past its job's time limit; warn of a run going longer than the long-run warning. */
  async function enforce(at: number): Promise<void> {
    const warnAfter = options.settings().longRunWarningMinutes * MINUTE_MS;
    for (const run of active.filter((candidate) => candidate.state === "running")) {
      const ran = ranFor(run, at);
      const limit = runJobOf(run.job)?.timeLimitMinutes ?? null;
      if (limit !== null && run.limitHit === null && run.session !== null && ran >= limit * MINUTE_MS) {
        run.limitHit = limit;
        save();
        log(`run ${run.job} ${run.run}: ran over its time limit of ${durationWords(limit * MINUTE_MS)}; stopping it`);
        try {
          await sessions.stop(run.session, "time-limit");
        } catch (err) {
          run.limitHit = null;
          save();
          log(`run ${run.job} ${run.run}: cannot stop — ${errorText(err)}`);
        }
      }
      if (run.warnedAt === null && ran >= warnAfter) {
        run.warnedAt = at;
        save();
        log(`run ${run.job} ${run.run}: running ${durationWords(warnAfter)}; still expected?`);
        options.onChange();
        options.post(longRunNotice(run, minutesOf(ran)));
      }
    }
  }

  /** Follow a running agent run's turns: a prompt it waits at makes it wait for the person; once
   *  the turn is done, its exit command is typed. */
  function follow(run: ActiveRun, agent: AgentRun): void {
    if (run.session === null || agent.exitSentAt !== null) return;
    const { job, run: id } = run;
    options.turns.watch(run.session, agent.provider, {
      onTurnDone: () => void inLane(async () => endTurn(job, id)),
      onWaiting: (prompt) => void inLane(async () => waitAt(job, id, prompt)),
    });
  }

  /** An agent run's prompt for the person came (`prompt`) or went (`null`): it waits for you — a
   *  Needs-you item and a notice — or goes on, its wait left out of its time limit. A prompt that
   *  turns into another is one wait. */
  function waitAt(job: string, id: string, prompt: AgentWait["prompt"] | null): void {
    const run = active.find((candidate) => candidate.job === job && candidate.run === id && candidate.state === "running");
    if (run?.agent == null) return;
    const agent = run.agent;
    const at = now().getTime();
    const wait = agent.waiting;
    if (prompt === null) {
      if (wait === null) return;
      agent.waitedMs += Math.max(0, at - wait.since);
      agent.waiting = null;
      log(`run ${job} ${id}: answered; the agent goes on`);
    } else {
      if (wait?.prompt === prompt) return;
      agent.waiting = { prompt, since: wait?.since ?? at };
      log(`run ${job} ${id}: waiting for you — ${WAIT_WORDS[prompt]}`);
      if (wait === null) options.post(waitingNotice(run, prompt));
    }
    save();
    options.onChange();
  }

  /** An agent run's turn is done: type its exit command, once. */
  function endTurn(job: string, id: string): void {
    const run = active.find((candidate) => candidate.job === job && candidate.run === id && candidate.state === "running");
    if (run?.agent == null || run.session === null || run.agent.exitSentAt !== null) return;
    run.agent.exitSentAt = now().getTime();
    exitDeadlines.set(run.session, performance.now() + AGENT_EXIT_WAIT_MS);
    save();
    log(`run ${job} ${id}: the agent's turn is done; typing ${run.agent.exit}`);
    options.turns.type(run.session, run.agent.exit);
  }

  /** Look up the session of an agent run whose provider could not pre-assign one — by its folder and
   *  start time, at most every `SESSION_LOOKUP_EVERY_MS` unless `now` — and keep it on the run. */
  async function lookUp(run: ActiveRun, agent: AgentRun, now = false): Promise<void> {
    const api = options.agents();
    if (agent.sessionId !== null || api === null || run.session === null) return;
    const asked = lookedUp.get(run.session);
    if (!now && asked !== undefined && performance.now() - asked < SESSION_LOOKUP_EVERY_MS) return;
    lookedUp.set(run.session, performance.now());
    try {
      const found = pickSession(await api.findSessions({ cwd: agent.cwd, ...lookupWindow(agent.startedAt, new Date()), agent: agent.agent }), agent.startedAt);
      if (found === null) return;
      agent.sessionId = found.id;
      log(`run ${run.job} ${run.run}: its session is ${found.id}`);
      save();
      options.onChange();
    } catch (err) {
      log(`run ${run.job} ${run.run}: cannot look up its session — ${errorText(err)}`);
    }
  }

  /** The agent runs going: follow their turns — after a restart too — look up a session not known
   *  yet, and stop one that did not end after its exit command. */
  async function agentRuns(): Promise<void> {
    for (const run of active) {
      if (run.state !== "running" || run.agent === null || run.session === null) continue;
      follow(run, run.agent);
      await lookUp(run, run.agent);
      if (run.agent.exitSentAt === null) continue;
      const deadline = exitDeadlines.get(run.session);
      if (deadline === undefined) exitDeadlines.set(run.session, performance.now() + AGENT_EXIT_WAIT_MS);
      else if (performance.now() >= deadline) {
        exitDeadlines.set(run.session, Number.POSITIVE_INFINITY);
        log(`run ${run.job} ${run.run}: the agent did not end after ${run.agent.exit}; stopping its session`);
        try {
          await sessions.stop(run.session, "stopped");
        } catch (err) {
          log(`run ${run.job} ${run.run}: cannot stop — ${errorText(err)}`);
        }
      }
    }
  }

  /** Record every run whose session ended or is gone; forget ended run sessions no run claims. */
  async function collect(): Promise<void> {
    const byId = new Map(sessions.list().map((session) => [session.id, session]));
    for (const run of active.filter((candidate) => candidate.state === "running")) {
      const session = run.session === null ? undefined : byId.get(run.session);
      if (session !== undefined && session.info.exit === null) continue;
      // The keeper reports an end as soon as the program exits; its last output may still be on
      // its way into the log. A run is recorded once its end is `LOG_SETTLE_MS` old.
      const age = session?.info.exit == null ? null : Date.now() - session.info.exit.at;
      if (age !== null && age >= 0 && age < LOG_SETTLE_MS) continue;
      if (run.agent !== null) await lookUp(run, run.agent, true);
      if (run.agent?.waiting != null) {
        // A run that ended at a prompt: its record keeps how long it waited.
        run.agent.waitedMs += Math.max(0, now().getTime() - run.agent.waiting.since);
        run.agent.waiting = null;
      }
      const scriptEnd = endOf(session, run);
      const end = run.agent === null ? scriptEnd : agentEnd(scriptEnd, run.agent, session?.info.exit?.reason ?? null);
      const durationMs = session?.info.exit == null ? null : Math.max(0, session.info.exit.at - session.info.startedAt);
      const endedAt = durationMs !== null && run.startedAt !== null ? run.startedAt + durationMs : now().getTime();
      const output = run.log ?? session?.log ?? null;
      const lines = output === null ? [] : await lastLines(output);
      const result = run.kind === "git" ? options.gitResult(run.job, run.run) : null;
      const how = result === null ? { ...end, git: null, lastLines: lines } : gitRunEnd(end, await readGitResult(result), lines);
      log(`run ${run.job} ${run.run}: ${how.state}${how.exitCode === null ? "" : ` — exit ${how.exitCode}`}${how.reason === null ? "" : ` — ${how.reason}`}`);
      await record(ended(run, { ...how, startedAt: run.startedAt, endedAt, durationMs, log: output === null ? null : await keep(run, output) }));
      // The record holds the result now.
      if (result !== null) await rm(result, { force: true });
      if (run.session !== null) {
        options.turns.unwatch(run.session);
        exitDeadlines.delete(run.session);
        lookedUp.delete(run.session);
      }
      if (session !== undefined) await forget(session.id);
    }
    for (const session of sessions.list()) {
      if (session.kind === "run" && session.info.exit !== null && !active.some((run) => run.session === session.id)) await forget(session.id);
    }
  }

  /** A finished run's output log moved to where it is kept, before its record is written; where a
   *  move that failed left it, said in the log. */
  async function keep(run: ActiveRun, output: string): Promise<string> {
    try {
      return (await options.keepLog(run.job, run.run)) ?? output;
    } catch (err) {
      log(`run ${run.job} ${run.run}: cannot keep its output log — ${errorText(err)}; it stays at ${output}`);
      return output;
    }
  }

  async function forget(id: string): Promise<void> {
    try {
      await sessions.forget(id);
    } catch (err) {
      log(`session ${id}: cannot forget — ${errorText(err)}`);
    }
  }

  /** A start is a login when the scheduler found no keeper running: the user's processes ended —
   *  a log-out, a shutdown — so the user's session begins. An update or a restart of the scheduler
   *  finds the keeper alive and is no login: no staged start, no login hooks. */
  function decideStart(): void {
    if (startDecided) return;
    startDecided = true;
    if (sessions.startedKeeper()) {
      log("login: no keeper was running — the staged start begins; the login hooks run after the warm-up");
      stage = { settledAt: null };
      login = true;
    } else {
      log("start: the keeper was running — no login: no warm-up, no login hooks");
    }
  }

  async function reconcile(): Promise<void> {
    if (!sessions.followed()) return;
    decideStart();
    await collect();
    if (options.jobs().workspace === null) return;
    const at = now();
    if (at.getTime() < lookedAt) {
      // The clock was set back: a fresh start from here, with nothing due.
      lookedAt = at.getTime();
      held = new Map([...held].map(([job, since]) => [job, Math.min(since, lookedAt)]));
    }
    await settleOrphans();
    await agentRuns();
    if (login) {
      login = false;
      await fireHook(LOGIN);
    }
    await look(at);
    await enforce(at.getTime());
    await advance();
  }

  /** A missed run waiting for the person whose job is gone, invalid or disabled waits no longer. */
  async function settleOrphans(): Promise<void> {
    for (const run of active.filter((candidate) => candidate.state === "missed-waiting")) {
      const found = runnable(run.job, run.kind);
      if (typeof found === "string") await miss(run, `skipped · ${found}`);
    }
  }

  /** Run now: the job's checks, then a run queued and started as far as the queue lets it. */
  async function runNowIn(ref: string): Promise<RunActionResult> {
    const snapshot = options.jobs();
    const id = jobIdOf(snapshot, ref);
    const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
    if (entry === undefined) return { ok: false, reason: `no job "${ref}"` };
    if (!entry.valid) return { ok: false, reason: `the job "${entryId(entry)}" is invalid: ${entry.invalid.errors[0]?.problem ?? "see pomade-runner check"}` };
    const { job } = entry;
    if (job.kind === "service") return { ok: false, reason: `"${job.name}" is a service job; Run now runs scripts, git jobs, agent jobs and services` };
    if (!job.enabled) return { ok: false, reason: `"${job.name}" is disabled in its file; enable it first` };
    if (!sessions.followed()) return { ok: false, reason: "the keeper is not connected" };
    const going = active.filter((run) => run.job === job.id && run.state !== "missed-waiting");
    if (job.overlap === "skip" && going.length > 0) return { ok: false, reason: `"${job.name}" is running, and its overlap is skip` };
    if (job.overlap === "queue" && going.some((run) => run.state === "queued")) return { ok: false, reason: `"${job.name}" has a run queued already` };
    log(`job ${job.id}: Run now`);
    const run = await fire(job, "manual", now());
    await advance();
    if (active.includes(run)) return { ok: true, run };
    const ended = last.get(job.id);
    return { ok: false, reason: ended?.run === run.run && ended.reason !== null ? ended.reason : "the run did not start" };
  }

  const minutesOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

  return {
    async load() {
      const at = now().getTime();
      const loaded = await store.load();
      active = loaded.active;
      last = new Map(Object.entries(loaded.last));
      lookedAt = loaded.lookedAt ?? at;
      held = new Map(Object.entries(loaded.held));
      guard = createLoopGuard(loaded.guard);
      switchState = await options.switchStore.load();
      for (const run of active) recovered.add(key(run.job, run.run));
      if (loaded.lookedAt !== null && at - loaded.lookedAt > WAKE_GAP_MS) log(`runs: last alive ${new Date(loaded.lookedAt).toISOString()}; what was missed since goes to its policy`);
      if (switchState.position !== "running") log(`switch: ${SWITCH_WORDS[switchState.position]}`);
    },

    tick() {
      const at = now().getTime();
      if (tickedAt !== null && at - tickedAt > WAKE_GAP_MS) {
        log(`wake: ${durationWords(at - tickedAt)} since the previous tick; caught-up and hook runs wait for the warm-up`);
        stage = { settledAt: null };
      }
      tickedAt = at;
      if (tickQueued) return Promise.resolve();
      tickQueued = true;
      return inLane(async () => {
        tickQueued = false;
        await reconcile();
      });
    },

    runNow: (ref) => inLane(() => runNowIn(ref)),

    hook: (firing) =>
      inLane(async () => {
        await fireHook(firing);
        if (sessions.followed() && options.jobs().workspace !== null) await advance();
      }),

    resume: (ref) =>
      inLane(async (): Promise<ResumeResult> => {
        const id = jobIdOf(options.jobs(), ref) ?? ref;
        const pause = guard.paused().get(id);
        if (pause === undefined || !guard.resume(id)) return { ok: false, reason: `"${ref}" is not paused` };
        log(`job ${id}: Resume — hooks and chains fire it again`);
        save();
        options.onChange();
        return { ok: true, job: id, name: pause.name };
      }),

    missed: (ref, choice) =>
      inLane(async (): Promise<MissedChoiceResult> => {
        const id = jobIdOf(options.jobs(), ref) ?? ref;
        const waiting = active.find((run) => run.job === id && run.state === "missed-waiting");
        if (waiting === undefined) return { ok: false, reason: `no missed run of "${ref}" waits for you` };
        switch (choice.kind) {
          case "skip":
            log(`run ${waiting.job} ${waiting.run}: Skip`);
            await miss(waiting, "skipped by you");
            return { ok: true, at: null };
          case "run-at": {
            const parsed = parseRunAt(choice.at, now());
            if (!parsed.ok) return parsed;
            Object.assign(waiting, { state: "queued", trigger: "caught-up", runAt: parsed.at, deadline: null });
            log(`run ${waiting.job} ${waiting.run}: Run at ${dayTime(parsed.at)}`);
            save();
            options.onChange();
            await advance();
            return { ok: true, at: parsed.at };
          }
          case "run-now": {
            log(`run ${waiting.job} ${waiting.run}: Run now`);
            active = active.filter((run) => run !== waiting);
            const result = await runNowIn(waiting.job);
            if (result.ok) return { ok: true, at: now().getTime() };
            active.push(waiting);
            save();
            options.onChange();
            return result;
          }
        }
      }),

    stop: (job, run) =>
      inLane(async (): Promise<RunStopResult> => {
        const going = active.find((candidate) => candidate.job === job && candidate.run === run && candidate.state === "running");
        if (going?.session == null) return { ok: false, reason: `run ${run} of "${job}" is not running` };
        log(`run ${job} ${run}: Stop`);
        try {
          await sessions.stop(going.session, "stopped-by-you");
        } catch (err) {
          return { ok: false, reason: errorText(err) };
        }
        return { ok: true };
      }),

    dismissWarning(job, run) {
      const warned = active.find((candidate) => candidate.job === job && candidate.run === run && candidate.warnedAt !== null && !candidate.warningDismissed);
      if (warned === undefined) return false;
      warned.warningDismissed = true;
      log(`run ${job} ${run}: long-run warning dismissed`);
      save();
      options.onChange();
      return true;
    },

    switch: () => switchState,

    setSwitch: (position) =>
      inLane(async () => {
        const previous = switchState.position;
        if (position === previous) return switchState;
        const at = now().getTime();
        switchState = { position, since: at };
        options.switchStore.save(switchState);
        await options.switchStore.flush();
        log(`switch: ${SWITCH_WORDS[position]}`);
        for (const run of active.filter((candidate) => candidate.state === "queued" && (candidate.runAt === null || candidate.runAt <= at))) {
          if (!holds(previous, run) || holds(position, run)) continue;
          if (run.trigger !== "caught-up" && at - (run.runAt ?? run.dueAt) <= ON_TIME_MS) continue;
          const job = runJobOf(run.job);
          if (job === null || job.trigger.kind !== "schedule") continue;
          const decision = decideMissed({ missed: job.missed, worthUntil: job.worthUntil, schedule: job.trigger.schedule }, [new Date(run.dueAt)], new Date(at));
          log(`run ${run.job} ${run.run}: held by the switch — ${decisionWords(decision)}`);
          await applyMissed(job, decision, run);
        }
        save();
        options.onChange();
        await advance();
        return switchState;
      }),

    active: () => [...active],

    needsYou() {
      const runs = active.flatMap((run): NeedsYouItem[] => {
        const base = { job: run.job, name: run.name, project: run.project, run: run.run };
        if (run.state === "missed-waiting") return [{ id: `missed:${run.job}`, kind: "missed", ...base, at: run.dueAt, detail: `missed ${dayTime(run.dueAt)}` }];
        const wait = run.state === "running" ? (run.agent?.waiting ?? null) : null;
        const waiting: NeedsYouItem[] = wait === null ? [] : [{ id: `waiting:${run.job}:${run.run}`, kind: "waiting", ...base, prompt: wait.prompt, at: wait.since, detail: WAIT_WORDS[wait.prompt] }];
        if (run.state !== "running" || run.warnedAt === null || run.warningDismissed || run.startedAt === null) return waiting;
        const words = durationWords(minutesOf(run.warnedAt - run.startedAt));
        return [...waiting, { id: `long-run:${run.job}:${run.run}`, kind: "long-run", ...base, at: run.warnedAt, startedAt: run.startedAt, detail: `running ${words} — still expected?` }];
      });
      // A paused job's item shows while its file is there; the pause itself lasts until Resume.
      const present = new Set(options.jobs().jobs.map(entryId));
      const paused = [...guard.paused()].flatMap(([job, pause]): NeedsYouItem[] =>
        present.has(job) ? [{ id: `loop-paused:${job}`, kind: "loop-paused", job, name: pause.name, project: pause.project, at: pause.at, detail: LOOP_WORDS }] : [],
      );
      return [...runs, ...paused];
    },

    nextUp() {
      const at = now();
      const held = (run: { trigger: RunTrigger; lowPriority: boolean }): boolean => holds(switchState.position, run);
      const next: NextRun[] = [];
      for (const job of scheduledRuns(options.jobs())) {
        if (job.trigger.kind !== "schedule") continue;
        // A job's own next runs, as many as could make the list.
        let when = nextOccurrence(job.trigger.schedule, at);
        for (let count = 0; when !== null && count < NEXT_UP_RUNS; count++) {
          next.push({ job: job.id, name: job.name, project: job.project, at: when.getTime(), held: held({ trigger: "scheduled", lowPriority: job.lowPriority }) });
          when = nextOccurrence(job.trigger.schedule, when);
        }
      }
      for (const run of active) if (run.state === "queued" && run.runAt !== null && run.runAt > at.getTime()) next.push({ job: run.job, name: run.name, project: run.project, at: run.runAt, held: held(run) });
      return next.sort((a, b) => a.at - b.at || a.job.localeCompare(b.job)).slice(0, NEXT_UP_RUNS);
    },

    jobRuns() {
      const at = now();
      return options.jobs().jobs.flatMap((entry): JobRuns[] => {
        if (!entry.valid || entry.job.kind === "service") return [];
        const { job } = entry;
        const ahead = job.trigger.kind === "schedule" ? nextOccurrence(job.trigger.schedule, at) : null;
        const next = job.enabled ? ahead : null;
        return [{ job: job.id, next: next?.getTime() ?? null, finished: job.trigger.kind === "schedule" && ahead === null, last: last.get(job.id) ?? null }];
      });
    },

    async find(job, run) {
      const going = active.find((candidate) => candidate.job === job && candidate.run === run);
      if (going !== undefined) return going;
      const latest = last.get(job);
      if (latest?.run === run) return latest;
      return history.find(job, run);
    },

    logsInUse() {
      return new Set(active.flatMap((run) => [...(run.log === null ? [] : [run.log]), ...(run.kind === "git" && run.state === "running" ? [options.gitResult(run.job, run.run)] : [])]));
    },

    async close() {
      closed = true;
      while (acting.size > 0) await Promise.all(acting);
      await lane;
      save();
      await store.flush();
      await options.switchStore.flush();
    },
  };
}

/** A missed-run decision in words, for the log. */
function decisionWords(decision: MissedDecision): string {
  switch (decision.action) {
    case "catch-up":
      return decision.deadline === null ? "one caught-up run" : `one caught-up run, worth it until ${dayTime(decision.deadline)}`;
    case "record":
      return `missed · ${decision.reason}`;
    case "wait":
      return "waits for you";
  }
}
