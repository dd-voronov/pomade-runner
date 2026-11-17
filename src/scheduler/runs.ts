// The run lifecycle (docs/DESIGN.md "Runs"): every tick the scheduler fires the scheduled jobs whose
// time has come, applies each job's overlap policy, starts runs as keeper sessions, and records
// every run that ends in the history — then forgets its session. Run now does the same on a click.
//
// - **Due.** A tick looks at each enabled, valid script job's schedule since its previous look
//   (`dueOccurrences`): an occurrence at most `ON_TIME_MS` old runs; the others are missed, which
//   is E-003's to act on — the scheduler logs them. Nothing before the scheduler started is due.
//   Nothing is due while the keeper is not followed: the look waits for it, so a short keeper
//   outage delays a run instead of losing it.
// - **Overlap**, when the job has a run going: `skip` records a skipped run ("previous run still
//   going") · `parallel` starts another · `queue` holds one run that starts when the job has none
//   going; while one is held, a further one is skipped ("a run is already queued").
// - **A run** is a keeper session `run:<job>:<run id>` in the job's folder, its command run by the
//   login shell, with low priority as the job says and its context in the environment
//   (`runEnv`). Its end comes from the keeper's list: exit 0 is `done`, any other end `failed`,
//   Ctrl+C or Stop in its tab `stopped-by-you`. The record keeps the last lines of the output log.
// - **Records.** The queued and running runs and each job's latest record live in `runs.json` in
//   Runner's state folder, written on every change, so a restarted scheduler picks up the runs that
//   are going — and the ends that came while it was down — where the last one left them.
//
// Every action — a tick, Run now — runs in one lane, one after another. Time comes from the clock
// given, so every rule is tested without waiting.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { nextOccurrence } from "pomade-kit/schedule";

import { entryId, type Job, type JobsSnapshot, type ScriptJob } from "../jobs/model";
import { newRunId, sessionIdOf } from "../keeper/ids";
import type { RunnerSession } from "../keeper/model";
import { jobIdOf } from "../keeper/services";
import type { Sessions } from "../keeper/sessions";
import type { Clock } from "./clock";
import { lastLines, type History } from "./history";
import type { Log } from "./log";
import { isActiveRun, isRunRecord, type ActiveRun, type JobRuns, type NextRun, type RunActionResult, type RunRecord, type RunTrigger, type RunView } from "./model";
import { dueOccurrences } from "./triggers";

/** What `runs.json` keeps. Plain JSON. */
export interface RunsRecords {
  /** Queued and running runs, oldest first. */
  active: ActiveRun[];
  /** Each job's latest record, by job id. */
  last: Record<string, RunRecord>;
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

/** The records in `<state>/runs.json`, replaced whole on every save. */
export function fileRunsStore(state: string, log: Log): RunsStore {
  const file = join(state, "runs.json");
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      const empty: RunsRecords = { active: [], last: {} };
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
      const active = Array.isArray(data.active) ? data.active.filter(isActiveRun) : [];
      const last: Record<string, RunRecord> = {};
      if (isRecord(data.last)) for (const [job, record] of Object.entries(data.last)) if (isRunRecord(record)) last[job] = record;
      return { active, last };
    },
    save(records) {
      const data = `${JSON.stringify(records, null, 2)}\n`;
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

/** A run's environment, beyond the login shell's (docs/DESIGN.md "Triggers", "Context for scripts"). */
export function runEnv(job: Job, run: string, trigger: RunTrigger, projectPath: string | null): Record<string, string> {
  const env: Record<string, string> = { POMADE_JOB: job.id, POMADE_RUN_ID: run, POMADE_TRIGGER: trigger };
  if (job.project !== null) env.POMADE_PROJECT = job.project;
  if (projectPath !== null) env.POMADE_PROJECT_PATH = projectPath;
  return env;
}

export interface RunsOptions {
  sessions: Sessions;
  /** The checked jobs now. */
  jobs(): JobsSnapshot;
  clock: Clock;
  log: Log;
  history: History;
  store: RunsStore;
  /** A project's root folder (absolute); `null` when it is not known. */
  projectPath(project: string): string | null;
  /** A run's session started. */
  onStarted(run: ActiveRun): void;
  /** A run ended, could not start, or was skipped: its record is in the history. */
  onFinished(record: RunRecord): void;
  /** The runs going, or a job's latest record, changed. */
  onChange(): void;
  /** The six hex digits of a run id; random by default. */
  random?: () => string;
}

export interface Runs {
  /** Read the records; before the first tick. */
  load(): Promise<void>;
  /** Record the runs that ended, fire what is due, start what was queued. A tick asked for while
   *  one is due is dropped. */
  tick(): Promise<void>;
  /** Run a script job now (trigger `manual`), by its id or name, under its overlap policy. */
  runNow(ref: string): Promise<RunActionResult>;
  /** Queued and running runs, oldest first. */
  active(): ActiveRun[];
  /** Every enabled scheduled script job's next run, soonest first. */
  nextUp(): NextRun[];
  /** Each run job's next and latest run. */
  jobRuns(): JobRuns[];
  /** A run going or finished; `null` when there is none. */
  find(job: string, run: string): Promise<RunView | null>;
  /** The output logs runs write now. */
  logsInUse(): Set<string>;
  /** Resolves once the lane is idle and the records are written. */
  close(): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clockTime = (at: Date): string => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** The script jobs a schedule fires: valid, enabled, scheduled. */
function scheduledScripts(snapshot: JobsSnapshot): ScriptJob[] {
  return snapshot.jobs.flatMap((entry) => (entry.valid && entry.job.kind === "script" && entry.job.enabled && entry.job.trigger.kind === "schedule" ? [entry.job] : []));
}

/** How a run's session ended, as its record says it. */
function endOf(session: RunnerSession | undefined): Pick<RunRecord, "state" | "reason" | "exitCode" | "signal"> {
  const exit = session?.info.exit ?? null;
  if (exit === null) return { state: "failed", reason: "its session is gone", exitCode: null, signal: null };
  const { code: exitCode, signal } = exit;
  switch (exit.reason) {
    case "exited":
      return { state: "done", reason: null, exitCode, signal };
    case "crashed":
      return { state: "failed", reason: null, exitCode, signal };
    case "stopped-by-you":
      return { state: "stopped-by-you", reason: null, exitCode, signal };
    case "stopped":
      return { state: "failed", reason: "stopped by Runner", exitCode, signal };
    case "time-limit":
      return { state: "failed", reason: "stopped: time limit", exitCode, signal };
    case "lost-in-keeper-crash":
      return { state: "failed", reason: "lost in a keeper crash", exitCode, signal };
  }
}

export function createRuns(options: RunsOptions): Runs {
  const { sessions, clock, log, history, store } = options;
  const random = options.random ?? ((): string => randomBytes(3).toString("hex"));
  let active: ActiveRun[] = [];
  let last = new Map<string, RunRecord>();
  /** Runs that were going when the scheduler started: their record may be in the history already. */
  const recovered = new Set<string>();
  /** The scheduler's previous look at the schedules: its start, at first. */
  let lookedAt = clock.now();
  let lane: Promise<unknown> = Promise.resolve();
  let tickQueued = false;

  const now = (): Date => clock.now();
  const key = (job: string, run: string): string => `${job}\n${run}`;
  const save = (): void => store.save({ active, last: Object.fromEntries(last) });

  function inLane<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.then(work);
    lane = result.catch(() => undefined);
    return result;
  }

  /** Write a finished run's record, once. */
  async function record(entry: RunRecord): Promise<void> {
    const runKey = key(entry.job, entry.run);
    const written = recovered.delete(runKey) && (await history.find(entry.job, entry.run)) !== null;
    if (!written) await history.append(entry);
    active = active.filter((run) => run.job !== entry.job || run.run !== entry.run);
    last.set(entry.job, entry);
    save();
    options.onChange();
    options.onFinished(entry);
  }

  function newRun(job: ScriptJob, trigger: RunTrigger, dueAt: Date): ActiveRun {
    return {
      job: job.id,
      name: job.name,
      kind: job.kind,
      project: job.project,
      folder: job.folder,
      run: newRunId(dueAt, random),
      trigger,
      dueAt: dueAt.getTime(),
      state: "queued",
      startedAt: null,
      session: null,
      log: null,
    };
  }

  /** A run's record: what it was, and how it ended. */
  const ended = (run: ActiveRun, end: Omit<RunRecord, keyof Omit<ActiveRun, "state" | "startedAt" | "log">>): RunRecord => ({
    job: run.job,
    name: run.name,
    kind: run.kind,
    project: run.project,
    folder: run.folder,
    run: run.run,
    trigger: run.trigger,
    dueAt: run.dueAt,
    ...end,
  });

  /** The record of a run that never started. */
  const notStarted = (run: ActiveRun, state: "failed" | "skipped", reason: string): RunRecord =>
    ended(run, { state, reason, startedAt: null, endedAt: now().getTime(), durationMs: null, exitCode: null, signal: null, log: null, lastLines: [] });

  async function skip(run: ActiveRun, reason: string): Promise<void> {
    log(`run ${run.job} ${run.run}: skipped — ${reason}`);
    await record(notStarted(run, "skipped", reason));
  }

  /** The valid script job `id` names now, or why it cannot run. */
  function scriptJob(id: string): { job: ScriptJob; workspace: string } | string {
    const snapshot = options.jobs();
    const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
    if (snapshot.workspace === null) return "no workspace is known";
    if (entry === undefined) return "its job file is gone";
    if (!entry.valid) return "its job file is invalid";
    if (entry.job.kind !== "script") return `it is a ${entry.job.kind} job now`;
    if (!entry.job.enabled) return "its job is disabled";
    return { job: entry.job, workspace: snapshot.workspace };
  }

  /** Start a run's session: a new run, or a queued one whose turn came. */
  async function start(run: ActiveRun): Promise<void> {
    const found = scriptJob(run.job);
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
    // The run is recorded as running before its session starts: a scheduler that dies in between
    // finds the session's end later.
    Object.assign(run, { state: "running", startedAt: now().getTime(), session });
    if (!active.includes(run)) active.push(run);
    save();
    try {
      const started = await sessions.spawn(
        { kind: "run", job: run.job, run: run.run },
        {
          title: job.name,
          command: job.command,
          cwd: join(workspace, job.folder),
          env: runEnv(job, run.run, run.trigger, job.project === null ? null : options.projectPath(job.project)),
          background: job.lowPriority,
        },
      );
      run.log = started.log;
      save();
      log(`run ${run.job} ${run.run}: started (${run.trigger})`);
      options.onChange();
      options.onStarted(run);
    } catch (err) {
      const reason = `cannot start — ${errorText(err)}`;
      log(`run ${run.job} ${run.run}: ${reason}`);
      await record(notStarted(run, "failed", reason));
    }
  }

  /** A run is due: start it, or apply the job's overlap policy. The run, whatever became of it. */
  async function fire(job: ScriptJob, trigger: RunTrigger, dueAt: Date): Promise<ActiveRun> {
    const run = newRun(job, trigger, dueAt);
    const going = active.filter((candidate) => candidate.job === job.id);
    if (going.length > 0 && job.overlap === "skip") {
      await skip(run, "previous run still going");
    } else if (going.length > 0 && job.overlap === "queue") {
      if (going.some((candidate) => candidate.state === "queued")) {
        await skip(run, "a run is already queued");
      } else {
        active.push(run);
        save();
        log(`run ${run.job} ${run.run}: queued after the previous run`);
        options.onChange();
      }
    } else {
      await start(run);
    }
    return run;
  }

  /** Record every run whose session ended or is gone; forget ended run sessions no run claims. */
  async function collect(): Promise<void> {
    const byId = new Map(sessions.list().map((session) => [session.id, session]));
    for (const run of active.filter((candidate) => candidate.state === "running")) {
      const session = run.session === null ? undefined : byId.get(run.session);
      if (session !== undefined && session.info.exit === null) continue;
      const end = endOf(session);
      const durationMs = session?.info.exit == null ? null : Math.max(0, session.info.exit.at - session.info.startedAt);
      const endedAt = durationMs !== null && run.startedAt !== null ? run.startedAt + durationMs : now().getTime();
      const output = run.log ?? session?.log ?? null;
      const lines = output === null ? [] : await lastLines(output);
      log(`run ${run.job} ${run.run}: ${end.state}${end.exitCode === null ? "" : ` — exit ${end.exitCode}`}${end.reason === null ? "" : ` — ${end.reason}`}`);
      await record(ended(run, { ...end, startedAt: run.startedAt, endedAt, durationMs, log: output, lastLines: lines }));
      if (session !== undefined) await forget(session.id);
    }
    for (const session of sessions.list()) {
      if (session.kind === "run" && session.info.exit !== null && !active.some((run) => run.session === session.id)) await forget(session.id);
    }
  }

  async function forget(id: string): Promise<void> {
    try {
      await sessions.forget(id);
    } catch (err) {
      log(`session ${id}: cannot forget — ${errorText(err)}`);
    }
  }

  /** Fire every scheduled job whose occurrence came since the previous look. */
  async function fireDue(at: Date): Promise<void> {
    const since = lookedAt;
    lookedAt = at;
    for (const job of scheduledScripts(options.jobs())) {
      if (job.trigger.kind !== "schedule") continue;
      const due = dueOccurrences(job.trigger.schedule, since, at);
      if (due.missed.length > 0) log(`job ${job.id}: missed ${due.missed.map(clockTime).join(", ")} — not run`);
      if (due.fire !== null) await fire(job, "scheduled", due.fire);
    }
  }

  async function reconcile(): Promise<void> {
    if (!sessions.followed()) return;
    await collect();
    if (options.jobs().workspace === null) return;
    await fireDue(now());
    for (const run of active.filter((candidate) => candidate.state === "queued")) {
      if (!active.some((candidate) => candidate.job === run.job && candidate.state === "running")) await start(run);
    }
  }

  return {
    async load() {
      lookedAt = now();
      const loaded = await store.load();
      active = loaded.active;
      last = new Map(Object.entries(loaded.last));
      for (const run of active) recovered.add(key(run.job, run.run));
    },

    tick() {
      if (tickQueued) return Promise.resolve();
      tickQueued = true;
      return inLane(async () => {
        tickQueued = false;
        await reconcile();
      });
    },

    runNow: (ref) =>
      inLane(async () => {
        const snapshot = options.jobs();
        const id = jobIdOf(snapshot, ref);
        const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
        if (entry === undefined) return { ok: false, reason: `no job "${ref}"` };
        if (!entry.valid) return { ok: false, reason: `the job "${entryId(entry)}" is invalid: ${entry.invalid.errors[0]?.problem ?? "see pomade-runner check"}` };
        const { job } = entry;
        if (job.kind !== "script") return { ok: false, reason: `"${job.name}" is ${job.kind === "agent" ? "an" : "a"} ${job.kind} job; Run now runs scripts and services` };
        if (!job.enabled) return { ok: false, reason: `"${job.name}" is disabled in its file; enable it first` };
        if (!sessions.followed()) return { ok: false, reason: "the keeper is not connected" };
        if (job.overlap === "skip" && active.some((run) => run.job === job.id)) return { ok: false, reason: `"${job.name}" is running, and its overlap is skip` };
        if (job.overlap === "queue" && active.some((run) => run.job === job.id && run.state === "queued")) return { ok: false, reason: `"${job.name}" has a run queued already` };
        log(`job ${job.id}: Run now`);
        const run = await fire(job, "manual", now());
        if (active.includes(run)) return { ok: true, run };
        const ended = last.get(job.id);
        return { ok: false, reason: ended?.run === run.run && ended.reason !== null ? ended.reason : "the run did not start" };
      }),

    active: () => [...active],

    nextUp() {
      const at = now();
      const next: NextRun[] = [];
      for (const job of scheduledScripts(options.jobs())) {
        if (job.trigger.kind !== "schedule") continue;
        const when = nextOccurrence(job.trigger.schedule, at);
        if (when !== null) next.push({ job: job.id, name: job.name, project: job.project, at: when.getTime() });
      }
      return next.sort((a, b) => a.at - b.at || a.job.localeCompare(b.job));
    },

    jobRuns() {
      const at = now();
      return options.jobs().jobs.flatMap((entry): JobRuns[] => {
        if (!entry.valid || entry.job.kind === "service") return [];
        const { job } = entry;
        const ahead = job.trigger.kind === "schedule" ? nextOccurrence(job.trigger.schedule, at) : null;
        const next = job.enabled && job.kind === "script" ? ahead : null;
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
      return new Set(active.flatMap((run) => (run.log === null ? [] : [run.log])));
    },

    async close() {
      await lane;
      await store.flush();
    },
  };
}
