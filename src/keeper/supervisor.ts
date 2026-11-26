// Service supervision (docs/ARCHITECTURE.md "Services"): keeps every service job in the state its file
// and the person ask for. Every tick it compares each service with its session in the keeper and
// acts — starts what should run, one at a time; stops what is disabled or whose file is gone; tells
// when a starting service is up — and every session's end it hears from the keeper (`onExit`)
// updates the service's supervision record: a crash schedules a restart after a back-off, and 5
// crashes within a minute give up (`failed`); Ctrl+C in its tab, or Stop, leaves it stopped until
// Start; turning it off in its file clears that. A Pomade-bound service (`start: pomade-started`,
// `project-first-open`) runs only while Pomade runs: where Pomade stands comes from `pomade`, and
// once it quit (`pomadeEnded`) such a service is stopped and its record starts fresh. The records are what the keeper does not know — holds, crash counts, a restart due — so a
// restarted scheduler carries on where the last one stopped; it reattaches running services and
// never restarts them. The services the Owner stopped are kept with the workspace, the rest on this
// Mac (`fileStore`).
//
// Every action — a tick, Start, Stop, Restart — runs in one lane, one after another. Time comes from
// the clock and the network checks from `probe`, both given, so every rule is tested without waiting.
//
// Every start, stop, restart and give-up is a service event (`onEvent`, docs/ARCHITECTURE.md "Service
// events"), written to History with its cause: what made a staged start due — the Mac login, Pomade's
// start, its project's first open, its job file — is kept until it starts; Start, Stop and Restart
// are yours, or a chain's (whose record the runs write); a stop in its tab is heard as its session's
// end. A crash window's restarts are one event, kept in the service's record with the row's id so a
// restarted scheduler goes on updating the same row; the window ends when the crash count resets
// (10 minutes up, Start, turned off, its Pomade start over) or the service gives up — its own event.
//
// One timebase: the scheduler's clock. The keeper stamps a session's start and end on the system
// clock; supervision takes each stamp onto its own clock once, when it first hears of it — its clock's
// now, less how long ago it was on the system clock — and measures every age, back-off and crash
// window there. In production both clocks are the system's and a stamp stays as it is; under a test
// clock, a session started a moment ago is a moment old whatever the real date.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SessionAction } from "pomade-kit/protocol";

import type { JobsSnapshot, ServiceAction, ServiceJob } from "../jobs/model";
import { entryId, pomadeBound } from "../jobs/model";
import { serviceHoldsPath, supervisionRecordPath, type RecordsFolder, type StateFolder } from "../locations";
import type { Clock } from "../scheduler/clock";
import type { Log } from "../scheduler/log";
import type { CrashEnd, RunRecord, RunResult, ServiceEventCause, ServiceEventKind } from "../scheduler/model";
import { newRunId } from "./ids";
import { LOOP_CRASHES, LOOP_WINDOW_MS, type ChainActionOutcome, type RunnerSession, type ServiceActionResult, type ServicesReport, type ServiceState, type ServiceStatus } from "./model";
import type { NetworkReadiness } from "./readiness";
import { findService, jobIdOf, RESTART_ACTION, serviceCommand, START_ACTION } from "./services";
import type { Sessions } from "./sessions";

/** How long a move waits for a stopped service's session to end. */
const MOVE_WAIT_MS = 6_000;
const MOVE_POLL_MS = 50;

/** A service with the default readiness is up once it has run this long. */
export const ALIVE_MS = 5_000;
/** The staged start moves to the next service when the current one is up, or after this long. */
export const START_CAP_MS = 30_000;
/** The wait before restarting after the 1st, 2nd, … crash since the count last reset; the last repeats. */
export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
export { LOOP_CRASHES, LOOP_WINDOW_MS };
/** After this much uptime the crash count and the last crash reset. */
export const RESET_UPTIME_MS = 10 * 60_000;
/** A service whose file is gone is stopped once it has been gone this long: an editor that saves by
 *  deleting and writing again does not stop it. */
export const REMOVED_GRACE_MS = 2_000;

/** What supervision keeps of a service beyond what the keeper knows. Plain JSON. */
export interface SupervisionRecord {
  /** Why it is not started again: Ctrl+C or Stop (`stopped-by-you`), a crash loop (`failed`). */
  hold: "stopped-by-you" | "failed" | null;
  /** Restarts after a crash since the count last reset. */
  restarts: number;
  /** Epoch ms; `null` since the count last reset. */
  lastCrashAt: number | null;
  /** The crashes of the last `LOOP_WINDOW_MS` (epoch ms). */
  crashes: number[];
  /** A restart after a crash is due at this time (epoch ms); `null` when none is. */
  retryAt: number | null;
  /** Why its last start failed. */
  problem: string | null;
  /** The crash window going: its History row, written at each restart; `null` when none goes. */
  window: CrashWindow | null;
}

/** A crash window: the crashes since the crash count last reset and the restarts after them, one
 *  History row (`run`) updated as they add up. */
export interface CrashWindow {
  /** The row's id. */
  run: string;
  /** Its first restart (epoch ms, the scheduler's clock): the row's time; `null` before it. */
  at: number | null;
  /** Restarts so far. */
  restarts: number;
  /** The crashes' ends, each distinct one once; the latest crash's. */
  ends: CrashEnd[];
  last: CrashEnd | null;
  /** The sessions the crashes ended, by their start stamps; the one the latest restart started. */
  ended: number[];
  session: number | null;
}

/** Where Pomade stands, as the scheduler tells it: `running` — ready, its start known · `closed` —
 *  it quit, or the scheduler found it closed · `unsure` — neither yet: the scheduler just started,
 *  Pomade is starting, or its link dropped and the quit grace is not over. */
export type PomadeState = "running" | "closed" | "unsure";

/** Pomade as supervision sees it: its state, and the projects opened since it started (ids). */
export interface PomadeView {
  state: PomadeState;
  opened: ReadonlySet<string>;
}

/** Why Start is refused for a Pomade-bound service while Pomade does not run. */
export const NOT_WITH_POMADE = "starts with Pomade; Pomade is not running";

const freshRecord = (): SupervisionRecord => ({ hold: null, restarts: 0, lastCrashAt: null, crashes: [], retryAt: null, problem: null, window: null });

/** Where the records are kept. */
export interface SupervisionStore {
  load(): Promise<Map<string, SupervisionRecord>>;
  /** Keep the records; writes happen in order and never overlap. */
  save(records: ReadonlyMap<string, SupervisionRecord>): void;
  /** Resolves once every save has been written. */
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const epoch = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

function parseEnd(value: unknown): CrashEnd | null {
  if (!isRecord(value)) return null;
  return { code: epoch(value.code), signal: typeof value.signal === "string" ? value.signal : null };
}

function parseWindow(value: unknown): CrashWindow | null {
  if (!isRecord(value) || typeof value.run !== "string") return null;
  return {
    run: value.run,
    at: epoch(value.at),
    restarts: count(value.restarts),
    ends: Array.isArray(value.ends) ? value.ends.map(parseEnd).filter((end) => end !== null) : [],
    last: parseEnd(value.last),
    ended: Array.isArray(value.ended) ? value.ended.map(epoch).filter((at) => at !== null) : [],
    session: epoch(value.session),
  };
}

function parseRecord(value: unknown): SupervisionRecord | null {
  if (!isRecord(value)) return null;
  const { hold, restarts, lastCrashAt, crashes, retryAt, problem, window } = value;
  return {
    hold: hold === "stopped-by-you" || hold === "failed" ? hold : null,
    restarts: count(restarts),
    lastCrashAt: epoch(lastCrashAt),
    crashes: Array.isArray(crashes) ? crashes.map(epoch).filter((at) => at !== null) : [],
    retryAt: epoch(retryAt),
    problem: typeof problem === "string" ? problem : null,
    window: parseWindow(window),
  };
}

/** Write `text` to `file` whole, through a temporary file beside it. */
async function replace(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

async function readJson(file: string, log: Log, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    log(`services: ${file} is not readable JSON; starting with no ${what}`);
    return null;
  }
}

/** The services the Owner stopped, as `services.json` in the records folder keeps them. */
export async function readServiceHolds(file: string, log: Log): Promise<string[]> {
  const data = await readJson(file, log, "services stopped by you");
  return isRecord(data) && Array.isArray(data.stoppedByYou) ? data.stoppedByYou.filter((job): job is string => typeof job === "string") : [];
}

/** The holds file's text for `jobs`. */
export const serviceHoldsText = (jobs: Iterable<string>): string => `${JSON.stringify({ stoppedByYou: [...jobs].sort() }, null, 2)}\n`;

/** The records in two files, each replaced whole when it changes. What the Owner asked for — the
 *  services they stopped, which stay stopped — is in `services.json` in the records folder, with
 *  the workspace; what describes this Mac's processes — crash counts, a restart due, a service given
 *  up on, the last start's problem — is in `services.json` in the state folder. */
export function fileStore(state: StateFolder, records: RecordsFolder, log: Log): SupervisionStore {
  const machineFile = supervisionRecordPath(state);
  const holdsFile = serviceHoldsPath(records);
  let writing: Promise<void> = Promise.resolve();
  const written = { machine: "", holds: "" };
  return {
    async load() {
      const loaded = new Map<string, SupervisionRecord>();
      const data = await readJson(machineFile, log, "crash counts");
      if (isRecord(data) && isRecord(data.services)) {
        for (const [job, value] of Object.entries(data.services)) {
          const record = parseRecord(value);
          if (record !== null) loaded.set(job, record.hold === "stopped-by-you" ? { ...record, hold: null } : record);
        }
      }
      for (const job of await readServiceHolds(holdsFile, log)) loaded.set(job, { ...(loaded.get(job) ?? freshRecord()), hold: "stopped-by-you" });
      return loaded;
    },
    save(next) {
      const machine = `${JSON.stringify({ services: Object.fromEntries([...next].map(([job, record]) => [job, record.hold === "stopped-by-you" ? { ...record, hold: null } : record])) }, null, 2)}\n`;
      const holds = serviceHoldsText([...next].flatMap(([job, record]) => (record.hold === "stopped-by-you" ? [job] : [])));
      writing = writing.then(async () => {
        for (const [key, file, text] of [["machine", machineFile, machine], ["holds", holdsFile, holds]] as const) {
          if (written[key] === text) continue;
          try {
            await replace(file, text);
            written[key] = text;
          } catch (err) {
            log(`services: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    },
    flush: () => writing,
  };
}

export interface SupervisorOptions {
  sessions: Sessions;
  /** The checked jobs now. */
  jobs(): JobsSnapshot;
  clock: Clock;
  /** The system clock the keeper stamps sessions with (epoch ms); default `Date.now`. */
  systemNow?: () => number;
  log: Log;
  store: SupervisionStore;
  /** Whether this scheduler start is a Mac login; asked once, on the first reconcile. An
   *  always-on service due then starts for the login, else for Runner's own start (`runner-started`). */
  startIsLogin(): Promise<boolean>;
  /** Whether a port or URL check passes now. */
  probe(ready: NetworkReadiness): Promise<boolean>;
  /** Where Pomade stands and the projects opened since it started: a `pomade-started` service is
   *  due while Pomade runs, a first-open one once its start project is among the opened too. */
  pomade(): PomadeView;
  /** The report changed. */
  onChange(report: ServicesReport): void;
  /** A service event to write to History; `put` — a crash window's row, written again as its
   *  restarts add up — replaces the record of the same run. */
  onEvent(record: RunRecord, put: boolean): void;
  /** A project's name, for a first open's event; `null` when it is not known. */
  projectName?(project: string): string | null;
  /** The six hex digits of an event's id; random by default. */
  random?: () => string;
}

export interface Supervisor {
  /** Read the records; before the first tick, so the ends the first refresh reports land on them. */
  load(): Promise<void>;
  /** Compare every service with its session and act. Does nothing while the sessions do not follow
   *  the keeper or no workspace is known. A tick asked for while one waits to begin joins it:
   *  either resolves once a tick begun after the ask is done. */
  tick(): Promise<void>;
  report(): ServicesReport;
  /** Whether the staged start is done: as of the latest tick, no service waits for its turn to
   *  start and none is starting within its 30 s. `false` before the first tick. */
  settled(): boolean;
  /** Start a service now, out of turn: clears its hold and its crash count. A Pomade-bound one is
   *  refused while Pomade does not run (`NOT_WITH_POMADE`). */
  start(ref: string): Promise<ServiceActionResult>;
  /** Stop it as stopped by you: it stays stopped until Start. */
  stop(ref: string): Promise<ServiceActionResult>;
  /** A project's first open since Pomade started, now among `openedProjects`: every valid, enabled
   *  service that starts on it and is not running joins the staged start — unless the Owner stopped
   *  it or it gave up. */
  firstOpen(project: string): Promise<void>;
  /** The Pomade start the bound services ran with is over — Pomade quit, or a new start was found
   *  while one of the last start's still ran: each bound service's record starts fresh (no hold,
   *  no crash count) and a running one is stopped. Under `pomade()` closed none starts again;
   *  under a new start each follows its trigger. */
  pomadeEnded(): Promise<void>;
  /** Its project moved and the jobs' ids change (`ids`, old → new) once `work` moves their files:
   *  each running service of them is stopped and its session forgotten first, then `work` runs;
   *  when it moved them (`true`), each service's record goes to its new id. A service that ran
   *  starts again — at once under the staged start, a first-open one too. */
  move(ids: ReadonlyMap<string, string>, work: () => Promise<boolean>): Promise<boolean>;
  /** Restart it with its file as it is now; one that does not run is started. */
  restart(ref: string): Promise<ServiceActionResult>;
  /** A chain's action on a service (`why` says which chain, for the log): `restart` restarts a
   *  running service and skips one that is not running · `start` starts one that is not running,
   *  as Start does, and skips a running one · `stop` stops it as Stop does. Its event is the runs'
   *  to write, from the outcome: supervision writes none for it. */
  chainAction(ref: string, action: ServiceAction, why: string): Promise<ChainActionOutcome>;
  /** Stop listening for ends; resolves once the records are written. */
  close(): Promise<void>;
}

/** One service: its file — valid, invalid or gone — and its session. */
interface Entry {
  job: string;
  file: "valid" | "invalid" | "gone";
  service: ServiceJob | null;
  name: string;
  project: string | null;
  session: RunnerSession | null;
}

/** Start order: workspace jobs first, then each project's (a sub-folder), each by id. */
const startOrder = (a: string, b: string): number => Number(a.includes("/")) - Number(b.includes("/")) || (a < b ? -1 : a > b ? 1 : 0);

const ACTION_WORDS: Record<ServiceAction, string> = { restart: "Restart", start: "Start", stop: "Stop" };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const { sessions, clock, log, store } = options;
  let records = new Map<string, SupervisionRecord>();
  /** The staged start in flight: the service, its session's start, and when it began. */
  let current: { job: string; startedAt: number; since: number } | null = null;
  /** The session start (`startedAt`) of each service known to be up. */
  const up = new Map<string, number>();
  /** Each service's running session: its start as the keeper stamped it, and on the clock. */
  const starts = new Map<string, { stamp: number; at: number }>();
  /** Services whose network check is under way. */
  const probing = new Set<string>();
  /** Services asked to stop, by the session start asked. */
  const stopping = new Map<string, number>();
  /** When each service's file was first seen gone. */
  const goneSince = new Map<string, number>();
  /** Sessions whose service let go of its hold — turned off, or its Pomade start over — by the
   *  session start: their end as stopped by you, heard later, holds nothing. */
  const released = new Map<string, number>();
  /** Services that ran before their project moved, due to start under their new id until they do. */
  const owed = new Set<string>();
  let lane: Promise<unknown> = Promise.resolve();
  /** The tick asked for and not begun yet; a tick asked for meanwhile joins it. */
  let queuedTick: Promise<void> | null = null;
  let published = "";
  let settled = false;
  const random = options.random ?? ((): string => randomBytes(3).toString("hex"));
  /** What made each service due to start, kept until it starts or is due no more: its event's cause. */
  const dueCauses = new Map<string, { cause: ServiceEventCause; detail: string | null }>();
  /** Whether a reconcile has run: the always-on services due at the first are the Mac login's, or
   *  Runner's own start's. */
  let booted = false;
  /** Whether this scheduler start is a Mac login; known from the first reconcile on. */
  let startIsLogin = false;
  /** Where Pomade stood, and the projects opened since it started, at the latest reconcile. */
  let pomadeBefore: PomadeState | null = null;
  let openedBefore: ReadonlySet<string> = new Set();
  /** Services whose session the keeper lost, by that session's start: started again, a restart. */
  const lost = new Map<string, number>();
  /** Sessions whose stop is written already (Stop) or is a chain's, by the session start: their
   *  end, heard later, writes nothing. */
  const announced = new Map<string, number>();

  const now = (): number => clock.now().getTime();
  const systemNow = options.systemNow ?? Date.now;
  /** A keeper stamp on the clock: now, less how long ago it was on the system clock. */
  const onClock = (stamp: number): number => now() - Math.max(0, systemNow() - stamp);
  /** When a session started, on the clock; taken once per session start. */
  const startOf = (job: string, session: RunnerSession): number => {
    const known = starts.get(job);
    if (known?.stamp === session.info.startedAt) return known.at;
    const at = onClock(session.info.startedAt);
    starts.set(job, { stamp: session.info.startedAt, at });
    return at;
  };
  const save = (): void => store.save(records);
  /** Whether Pomade lets a service run: always for a `login` one, while Pomade runs for a bound one. */
  const pomadeLets = (service: ServiceJob): boolean => !pomadeBound(service.start) || options.pomade().state === "running";
  /** Whether a service is due to start when it does not run and nothing holds it: at login; while
   *  Pomade runs; on its start project's open — at once when that project was opened already — or
   *  owed a start, as far as Pomade lets it run. */
  const startsNow = (job: string, service: ServiceJob): boolean => {
    if (!pomadeLets(service)) return false;
    switch (service.start) {
      case "login":
      case "pomade-started":
        return true;
      case "project-first-open":
        return (service.startProject !== null && options.pomade().opened.has(service.startProject)) || owed.has(job);
    }
  };
  const recordOf = (job: string): SupervisionRecord => {
    let record = records.get(job);
    if (record === undefined) {
      record = freshRecord();
      records.set(job, record);
    }
    return record;
  };

  /** Run `work` in the lane, after everything before it. */
  function inLane<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.then(work);
    lane = result.catch(() => undefined);
    return result;
  }

  /** The session when it runs; `null` when it ended or there is none. */
  const live = (session: RunnerSession | null | undefined): RunnerSession | null => (session?.info.state === "running" ? session : null);
  const isUp = (entry: Entry): boolean => {
    const session = live(entry.session);
    return session !== null && up.get(entry.job) === session.info.startedAt;
  };

  /** Every service: the service jobs of the files (invalid service files included), and every
   *  service session whose job is no longer a valid service. Without a workspace, none. */
  function entries(): Entry[] {
    const snapshot = options.jobs();
    if (snapshot.workspace === null) return [];
    const byJob = new Map<string, RunnerSession>();
    for (const session of sessions.list()) if (session.kind === "service") byJob.set(session.job, session);
    const list: Entry[] = [];
    const seen = new Set<string>();
    for (const entry of snapshot.jobs) {
      const job = entryId(entry);
      const session = byJob.get(job) ?? null;
      if (entry.valid) {
        if (entry.job.kind !== "service") continue;
        list.push({ job, file: "valid", service: entry.job, name: entry.job.name, project: entry.job.project, session });
      } else {
        if (entry.invalid.kind !== "service" && session === null) continue;
        list.push({ job, file: "invalid", service: null, name: entry.invalid.name ?? session?.info.title ?? job, project: entry.invalid.project, session });
      }
      seen.add(job);
    }
    for (const [job, session] of byJob) {
      if (!seen.has(job)) list.push({ job, file: "gone", service: null, name: session.info.title || job, project: null, session });
    }
    return list.sort((a, b) => startOrder(a.job, b.job));
  }

  function stateOf(entry: Entry, record: SupervisionRecord | undefined, at: number): ServiceState {
    if (entry.file === "gone") return "removed";
    if (entry.service === null) return "invalid";
    if (!entry.service.enabled) return "disabled";
    // A running service with a hold is one being stopped by you.
    if (record?.hold != null) return record.hold;
    if (live(entry.session) !== null) return isUp(entry) ? "running" : "starting";
    if (record?.retryAt != null && record.retryAt > at) return "restarting";
    if (startsNow(entry.job, entry.service) || record?.retryAt != null) return "queued";
    return pomadeLets(entry.service) ? "waiting" : "waiting-for-pomade";
  }

  function statusOf(entry: Entry, at: number): ServiceStatus {
    const record = records.get(entry.job);
    const state = stateOf(entry, record, at);
    const { service, session } = entry;
    const workspace = options.jobs().workspace;
    const runs = live(session);
    const needsRestart = service !== null && workspace !== null && runs !== null && (runs.info.command !== service.command || runs.info.cwd !== serviceCommand(service, workspace).cwd);
    return {
      job: entry.job,
      name: entry.name,
      project: entry.project,
      state,
      session,
      restarts: record?.restarts ?? 0,
      lastCrashAt: record?.lastCrashAt ?? null,
      retryAt: state === "restarting" ? (record?.retryAt ?? null) : null,
      needsRestart,
      problem: record?.problem ?? null,
    };
  }

  function report(): ServicesReport {
    const at = now();
    return { keeper: sessions.keeper(), services: entries().map((entry) => statusOf(entry, at)), openedProjects: [...options.pomade().opened] };
  }

  /** The service `job` now, as `entries()` has it. */
  const entryById = (job: string): Entry | undefined => entries().find((candidate) => candidate.job === job);

  /** Write a service event of `entry` (docs/ARCHITECTURE.md "Service events"): `at` its time (default
   *  now), `run` its row's id (default a new one), `put` to replace the row of that id. */
  function emit(
    entry: Entry,
    what: ServiceEventKind,
    cause: ServiceEventCause,
    more: { detail?: string | null; session?: number | null; ended?: number[]; state?: RunResult; reason?: string | null; exit?: CrashEnd | null; restarts?: number; ends?: CrashEnd[]; run?: string; at?: number; put?: boolean } = {},
  ): void {
    const written = now();
    const at = more.at ?? written;
    options.onEvent(
      {
        job: entry.job,
        name: entry.name,
        kind: "service",
        project: entry.project,
        folder: entry.service?.folder ?? "",
        run: more.run ?? newRunId(new Date(at), random),
        trigger: "manual",
        cause: null,
        dueAt: at,
        agent: null,
        missed: null,
        series: null,
        state: more.state ?? "done",
        event: { what, cause, detail: more.detail ?? null, session: more.session ?? null, ended: more.ended ?? [], restarts: more.restarts ?? 0, ends: more.ends ?? [] },
        reason: more.reason ?? null,
        startedAt: null,
        endedAt: written,
        durationMs: null,
        exitCode: more.exit?.code ?? null,
        signal: more.exit?.signal ?? null,
        log: null,
        lastLines: [],
        git: null,
        limitHit: null,
      },
      more.put ?? false,
    );
  }

  /** Why a service not started by a crash is due: the Mac login or Runner's own start (the first
   *  reconcile's), Pomade's start, its project's first open — else its job file, made or turned on. */
  function dueCause(service: ServiceJob): { cause: ServiceEventCause; detail: string | null } {
    if (!booted && service.start === "login") return { cause: startIsLogin ? "login" : "runner-started", detail: null };
    if (service.start === "pomade-started" && pomadeBefore !== "running") return { cause: "pomade-started", detail: null };
    const project = service.startProject;
    if (service.start === "project-first-open" && project !== null && options.pomade().opened.has(project) && !openedBefore.has(project)) {
      return { cause: "first-open", detail: options.projectName?.(project) ?? null };
    }
    return { cause: "job-file", detail: "created" };
  }

  function publish(): void {
    const next = report();
    const text = JSON.stringify(next);
    if (text === published) return;
    published = text;
    options.onChange(next);
  }

  /** A crash (or a start the keeper refused: `stamp` `null`) at `at`, ended `end`: a restart
   *  after the back-off — the crash joins the crash window — or, the 5th within a minute, `failed`
   *  and its own event. */
  function crashed(job: string, record: SupervisionRecord, at: number, what: string, end: CrashEnd, stamp: number | null): void {
    record.crashes = [...record.crashes.filter((when) => at - when < LOOP_WINDOW_MS), at];
    record.lastCrashAt = at;
    if (record.crashes.length >= LOOP_CRASHES) {
      record.hold = "failed";
      record.retryAt = null;
      record.window = null;
      log(`service ${job}: ${what}; failed — ${LOOP_CRASHES} crashes within a minute, no restarts until Start`);
      const entry = entryById(job);
      if (entry !== undefined) emit(entry, "gave-up", "crash", { state: "failed", ended: stamp === null ? [] : [stamp], exit: end, reason: stamp === null ? record.problem : null });
      return;
    }
    const window = (record.window ??= { run: newRunId(new Date(at), random), at: null, restarts: 0, ends: [], last: null, ended: [], session: null });
    if (!window.ends.some((known) => known.code === end.code && known.signal === end.signal)) window.ends.push(end);
    window.last = end;
    if (stamp !== null) window.ended.push(stamp);
    const wait = BACKOFF_MS[Math.min(record.restarts, BACKOFF_MS.length - 1)] ?? 0;
    record.retryAt = at + wait;
    log(`service ${job}: ${what}; restarting in ${seconds(wait)}`);
  }

  function ended(session: RunnerSession): void {
    const { exit } = session.info;
    if (session.kind !== "service" || exit === null) return;
    const { job } = session;
    const at = onClock(exit.at);
    up.delete(job);
    starts.delete(job);
    stopping.delete(job);
    if (current?.job === job) current = null;
    const stamp = session.info.startedAt;
    switch (exit.reason) {
      case "crashed":
      case "exited": {
        const record = recordOf(job);
        if (record.hold === null) crashed(job, record, at, exit.reason === "exited" ? "exited on its own" : "crashed", { code: exit.code, signal: exit.signal }, stamp);
        break;
      }
      case "stopped-by-you": {
        // A Stop that ends after the service let go of its hold holds nothing.
        if (released.get(job) === stamp) {
          released.delete(job);
          return;
        }
        const record = recordOf(job);
        record.hold = "stopped-by-you";
        record.retryAt = null;
        log(`service ${job}: stopped by you; it stays stopped until Start`);
        // Stop wrote its event, and a chain's is the runs'; Ctrl+C or Stop in its tab is heard here.
        if (announced.get(job) === stamp) {
          announced.delete(job);
        } else {
          const entry = entryById(job);
          if (entry !== undefined) emit(entry, "stopped", "you", { detail: "tab", ended: [stamp] });
        }
        break;
      }
      case "lost-in-keeper-crash": {
        // Not its fault: due, it starts again — a restart; not due, it stopped (both in `reconcile`).
        const service = entryById(job)?.service;
        if (service != null && service.enabled) lost.set(job, stamp);
        return;
      }
      case "stopped":
      case "time-limit":
        return;
    }
    save();
  }

  const unwatch = sessions.onExit(ended);

  async function spawn(entry: Entry, service: ServiceJob, workspace: string, record: SupervisionRecord): Promise<RunnerSession | string> {
    try {
      const session = await sessions.spawn({ kind: "service", job: entry.job }, serviceCommand(service, workspace));
      record.problem = null;
      return session;
    } catch (err) {
      record.problem = errorText(err);
      return record.problem;
    }
  }

  /** The staged start's next service, and its event: a crash window's restart, a restart after
   *  the keeper lost its session or its project moved, else a start for what made it due. */
  async function startNext(entry: Entry, service: ServiceJob, workspace: string, at: number): Promise<void> {
    const record = recordOf(entry.job);
    const restart = record.retryAt !== null;
    const started = await spawn(entry, service, workspace, record);
    if (typeof started === "string") {
      crashed(entry.job, record, at, `cannot start — ${started}`, { code: null, signal: null }, null);
    } else {
      const session = started.info.startedAt;
      const lostStamp = lost.get(entry.job);
      if (restart) {
        record.restarts++;
        const window = (record.window ??= { run: newRunId(new Date(at), random), at: null, restarts: 0, ends: [], last: null, ended: [], session: null });
        window.restarts++;
        window.at ??= at;
        window.session = session;
        emit(entry, "restarted", "crash", { run: window.run, at: window.at, session, ended: [...window.ended], restarts: window.restarts, ends: [...window.ends], exit: window.last, put: true });
      } else if (lostStamp !== undefined) {
        emit(entry, "restarted", "keeper", { session, ended: [lostStamp] });
      } else if (owed.has(entry.job)) {
        emit(entry, "restarted", "job-file", { detail: "moved", session });
      } else {
        const due = dueCauses.get(entry.job) ?? dueCause(service);
        emit(entry, "started", due.cause, { detail: due.detail, session });
      }
      lost.delete(entry.job);
      dueCauses.delete(entry.job);
      record.retryAt = null;
      owed.delete(entry.job);
      startOf(entry.job, started);
      current = { job: entry.job, startedAt: started.info.startedAt, since: at };
      log(`service ${entry.job}: ${restart ? `restarted (${record.restarts}×)` : "starting"}`);
    }
    save();
  }

  /** Mark a running service up when its readiness says so; a network check runs on its own. */
  function checkReady(entry: Entry, service: ServiceJob, session: RunnerSession, at: number): void {
    const { startedAt } = session.info;
    if (up.get(entry.job) === startedAt) return;
    const age = at - startOf(entry.job, session);
    const markUp = (): void => {
      up.set(entry.job, startedAt);
      log(`service ${entry.job}: up`);
    };
    const { ready } = service;
    if (ready.kind === "alive") {
      if (age >= ALIVE_MS) markUp();
      return;
    }
    if (probing.has(entry.job)) return;
    probing.add(entry.job);
    void options.probe(ready).then(
      (ok) => {
        probing.delete(entry.job);
        const still = live(sessions.list().find((candidate) => candidate.id === session.id));
        if (ok && still?.info.startedAt === startedAt) markUp();
      },
      () => probing.delete(entry.job),
    );
  }

  /** Stop a running service for `why`, Runner's own stop, and write its event for `cause`. */
  async function stopSession(entry: Entry, session: RunnerSession, why: string, cause: ServiceEventCause, detail: string | null = null): Promise<void> {
    if (stopping.get(entry.job) === session.info.startedAt) return;
    stopping.set(entry.job, session.info.startedAt);
    log(`service ${entry.job}: ${why}; stopping it`);
    try {
      await sessions.stop(session.id, "stopped");
      emit(entry, "stopped", cause, { detail, ended: [session.info.startedAt] });
    } catch (err) {
      stopping.delete(entry.job);
      log(`service ${entry.job}: cannot stop — ${errorText(err)}`);
    }
  }

  /** Keep a session's header actions in step with the service: Restart while it runs; Start once it
   *  ended, when Start would start it (its file valid and enabled); none otherwise. */
  async function syncActions(entry: Entry): Promise<void> {
    const { session } = entry;
    if (session === null) return;
    const want = live(session) !== null ? [RESTART_ACTION] : entry.service?.enabled === true ? [START_ACTION] : [];
    const words = (actions: readonly SessionAction[]): string => actions.map((action) => `${action.id}:${action.title}`).join(" ");
    if (words(session.info.actions) === words(want)) return;
    try {
      await sessions.setActions(session.id, want);
    } catch (err) {
      log(`service ${entry.job}: cannot set its tab's actions — ${errorText(err)}`);
    }
  }

  async function reconcile(): Promise<void> {
    const workspace = options.jobs().workspace;
    if (!sessions.followed() || workspace === null) return;
    if (!booted) startIsLogin = await options.startIsLogin();
    const at = now();
    const list = entries();
    const due: { entry: Entry; service: ServiceJob }[] = [];
    let changed = false;
    for (const entry of list) {
      const { job, session, service } = entry;
      const runs = live(session);
      if (entry.file !== "gone") await syncActions(entry);
      if (entry.file === "gone") {
        const since = goneSince.get(job) ?? at;
        goneSince.set(job, since);
        if (at - since < REMOVED_GRACE_MS) continue;
        if (runs !== null) {
          await stopSession(entry, runs, "its file is gone", "job-file", "removed");
        } else if (session !== null) {
          try {
            await sessions.forget(session.id);
          } catch (err) {
            log(`service ${job}: cannot forget its session — ${errorText(err)}`);
          }
        }
        continue;
      }
      goneSince.delete(job);
      if (service === null) continue;
      if (!service.enabled) {
        // Turned off, a service lets go of Stop and of a crash loop: turned on again, it follows
        // its trigger.
        const record = records.get(job);
        if (record !== undefined && (record.hold !== null || record.retryAt !== null || record.crashes.length > 0 || record.restarts > 0)) {
          records.set(job, { ...freshRecord(), problem: record.problem });
          if (session !== null) released.set(job, session.info.startedAt);
          changed = true;
        }
        if (runs !== null) await stopSession(entry, runs, "disabled in its file", "job-file", "disabled");
        continue;
      }
      if (!pomadeLets(service) && options.pomade().state === "closed") {
        if (runs !== null) await stopSession(entry, runs, "it runs with Pomade, and Pomade is not running", "pomade-quit");
        continue;
      }
      if (runs !== null) {
        checkReady(entry, service, runs, at);
        const record = records.get(job);
        if (record !== undefined && isUp(entry) && at - startOf(job, runs) >= RESET_UPTIME_MS && (record.restarts > 0 || record.lastCrashAt !== null || record.crashes.length > 0 || record.window !== null)) {
          Object.assign(record, { restarts: 0, lastCrashAt: null, crashes: [], window: null });
          changed = true;
        }
        continue;
      }
      const record = records.get(job);
      if (record?.hold != null) continue;
      if (record?.retryAt != null && record.retryAt > at) continue;
      if (record?.retryAt == null && startsNow(job, service)) {
        if (!dueCauses.has(job)) dueCauses.set(job, dueCause(service));
        due.push({ entry, service });
      } else if (record?.retryAt != null && pomadeLets(service)) {
        due.push({ entry, service });
      }
    }
    // What is due no more forgets why it was; a lost session not due to start again stopped.
    for (const job of dueCauses.keys()) if (!due.some((one) => one.entry.job === job)) dueCauses.delete(job);
    for (const [job, stamp] of lost) {
      if (due.some((one) => one.entry.job === job)) continue;
      lost.delete(job);
      const entry = list.find((candidate) => candidate.job === job);
      if (entry !== undefined && live(entry.session) === null) emit(entry, "stopped", "keeper", { ended: [stamp] });
    }
    booted = true;
    pomadeBefore = options.pomade().state;
    openedBefore = new Set(options.pomade().opened);
    // A record outlives its file for the grace period, so a hold survives a save by delete and write.
    const listed = new Set(list.filter((entry) => entry.file !== "gone").map((entry) => entry.job));
    for (const job of records.keys()) {
      if (listed.has(job) || list.some((entry) => entry.job === job)) continue;
      const since = goneSince.get(job) ?? at;
      goneSince.set(job, since);
      if (at - since < REMOVED_GRACE_MS) continue;
      records.delete(job);
      up.delete(job);
      starts.delete(job);
      changed = true;
    }
    for (const job of goneSince.keys()) if (listed.has(job) || (!records.has(job) && !list.some((entry) => entry.job === job))) goneSince.delete(job);
    if (changed) save();

    if (current !== null) {
      const { job, startedAt, since } = current;
      const entry = list.find((candidate) => candidate.job === job);
      const session = live(entry?.session);
      if (entry === undefined || session?.info.startedAt !== startedAt || isUp(entry)) {
        current = null;
      } else if (at - since >= START_CAP_MS) {
        log(`service ${job}: not up after ${seconds(START_CAP_MS)}; starting the next service`);
        current = null;
      }
    }
    const next = due[0];
    if (current === null && next !== undefined) await startNext(next.entry, next.service, workspace, at);
    settled = current === null && due.length === 0;
  }

  /** The entry `ref` names: a job id or name, or the job of a service session. */
  function entryOf(ref: string): Entry | undefined {
    const list = entries();
    const id = jobIdOf(options.jobs(), ref) ?? ref;
    return list.find((entry) => entry.job === id);
  }

  const done = (job: string): ServiceActionResult => {
    publish();
    const entry = entries().find((candidate) => candidate.job === job);
    return entry === undefined ? { ok: false, reason: `no service "${job}"` } : { ok: true, service: statusOf(entry, now()) };
  };

  /** Start a service now, by you or a chain (whose event the runs write). */
  async function startNow(ref: string, fresh: boolean, by: "you" | "chain"): Promise<ServiceActionResult> {
    const found = findService(options.jobs(), ref);
    if (!found.ok) return found;
    const { job: service, workspace } = found;
    if (!service.enabled) return { ok: false, reason: `"${service.name}" is disabled in its file; enable it first` };
    const entry = entries().find((candidate) => candidate.job === service.id);
    if (entry === undefined) return { ok: false, reason: `no service "${ref}"` };
    if (live(entry.session) !== null) return { ok: false, reason: `"${service.name}" is running` };
    if (!pomadeLets(service)) return { ok: false, reason: `"${service.name}" ${NOT_WITH_POMADE}` };
    const record = recordOf(service.id);
    const started = await spawn(entry, service, workspace, record);
    if (typeof started !== "string") {
      if (fresh) Object.assign(record, { restarts: 0, lastCrashAt: null, crashes: [], window: null });
      record.hold = null;
      record.retryAt = null;
      owed.delete(service.id);
      lost.delete(service.id);
      dueCauses.delete(service.id);
      if (by === "you") emit(entry, "started", "you", { session: started.info.startedAt });
    }
    save();
    if (typeof started === "string") return { ok: false, reason: started };
    return done(service.id);
  }

  /** Stop a service as stopped by you: it stays stopped until Start. Its event is written now — a
   *  service waiting to restart after a crash stops too — unless a chain stops it. */
  async function stopNow(entry: Entry, by: "you" | "chain"): Promise<ServiceActionResult> {
    const record = recordOf(entry.job);
    const restarting = record.retryAt !== null;
    record.hold = "stopped-by-you";
    record.retryAt = null;
    save();
    if (current?.job === entry.job) current = null;
    const session = live(entry.session);
    if (session !== null && stopping.get(entry.job) !== session.info.startedAt) {
      stopping.set(entry.job, session.info.startedAt);
      try {
        await sessions.stop(session.id, "stopped-by-you");
      } catch (err) {
        stopping.delete(entry.job);
        return { ok: false, reason: errorText(err) };
      }
      announced.set(entry.job, session.info.startedAt);
      if (by === "you") emit(entry, "stopped", "you", { ended: [session.info.startedAt] });
    } else if (session === null && restarting && by === "you") {
      emit(entry, "stopped", "you");
    }
    return done(entry.job);
  }

  /** Restart a running service with its file as it is now; one that does not run is started. */
  async function restartNow(service: ServiceJob, workspace: string, by: "you" | "chain"): Promise<ServiceActionResult> {
    const entry = entries().find((candidate) => candidate.job === service.id);
    const running = entry === undefined ? null : live(entry.session);
    if (entry === undefined || running === null) return startNow(service.id, false, by);
    if (!service.enabled) return { ok: false, reason: `"${service.name}" is disabled in its file; enable it first` };
    const record = recordOf(service.id);
    record.hold = null;
    record.retryAt = null;
    try {
      const fresh = await sessions.restartService(service.id, serviceCommand(service, workspace));
      record.problem = null;
      if (by === "you") emit(entry, "restarted", "you", { session: fresh.info.startedAt, ended: [running.info.startedAt] });
    } catch (err) {
      record.problem = errorText(err);
      save();
      return { ok: false, reason: record.problem };
    }
    save();
    if (current?.job === service.id) current = null;
    return done(service.id);
  }

  return {
    async load() {
      records = await store.load();
    },

    tick() {
      queuedTick ??= inLane(async () => {
        queuedTick = null;
        await reconcile();
        publish();
      });
      return queuedTick;
    },

    report,

    settled: () => settled,

    start: (ref) =>
      inLane(async () => {
        log(`service ${ref}: Start`);
        return startNow(ref, true, "you");
      }),

    stop: (ref) =>
      inLane(async () => {
        const entry = entryOf(ref);
        if (entry === undefined) return { ok: false, reason: `no service "${ref}"` };
        log(`service ${entry.job}: Stop`);
        return stopNow(entry, "you");
      }),

    restart: (ref) =>
      inLane(async () => {
        const found = findService(options.jobs(), ref);
        if (!found.ok) return found;
        log(`service ${found.job.id}: Restart`);
        return restartNow(found.job, found.workspace, "you");
      }),

    pomadeEnded: () =>
      inLane(async () => {
        for (const entry of entries()) {
          const { service } = entry;
          if (service === null || !pomadeBound(service.start)) continue;
          const record = records.get(entry.job);
          if (record !== undefined) records.set(entry.job, { ...freshRecord(), problem: record.problem });
          if (entry.session !== null) released.set(entry.job, entry.session.info.startedAt);
          owed.delete(entry.job);
          lost.delete(entry.job);
          if (current?.job === entry.job) current = null;
          const runs = live(entry.session);
          if (runs !== null) await stopSession(entry, runs, "its Pomade start is over", "pomade-quit");
        }
        save();
        await reconcile();
        publish();
      }),

    firstOpen: (project) =>
      inLane(async () => {
        for (const entry of entries()) {
          const { service } = entry;
          if (service?.start !== "project-first-open" || service.startProject !== project || !service.enabled || live(entry.session) !== null) continue;
          const hold = records.get(entry.job)?.hold ?? null;
          log(`service ${entry.job}: its project's first open; ${hold === null ? "it starts" : `it stays ${hold === "failed" ? "failed" : "stopped"} until Start`}`);
        }
        await reconcile();
        publish();
      }),

    move: (ids, work) =>
      inLane(async () => {
        const ran = new Set<string>();
        for (const entry of entries()) {
          if (!ids.has(entry.job) || entry.session === null) continue;
          const session = live(entry.session);
          if (session !== null) {
            ran.add(entry.job);
            log(`service ${entry.job}: its project moved; stopping it to start it again as ${ids.get(entry.job) ?? ""}`);
            stopping.set(entry.job, session.info.startedAt);
            try {
              await sessions.stop(session.id, "stopped");
            } catch (err) {
              log(`service ${entry.job}: cannot stop — ${errorText(err)}`);
            }
            const until = performance.now() + MOVE_WAIT_MS;
            while (live(sessions.list().find((candidate) => candidate.id === session.id)) !== null && performance.now() < until) {
              await new Promise((resolve) => setTimeout(resolve, MOVE_POLL_MS));
              await sessions.refresh();
            }
          }
          try {
            await sessions.forget(entry.session.id);
          } catch (err) {
            log(`service ${entry.job}: cannot forget its session — ${errorText(err)}`);
          }
        }
        const moved = await work();
        for (const [from, to] of ids) {
          const job = moved ? to : from;
          const record = records.get(from);
          if (moved && record !== undefined) {
            records.delete(from);
            records.set(to, record);
          }
          for (const map of [up, starts, stopping, goneSince, released]) map.delete(from);
          if (owed.delete(from) || ran.has(from)) owed.add(job);
          if (current?.job === from) current = null;
        }
        save();
        await reconcile();
        publish();
        return moved;
      }),

    chainAction: (ref, action, why) =>
      inLane(async (): Promise<ChainActionOutcome> => {
        const found = findService(options.jobs(), ref);
        if (!found.ok) return { result: "skipped", reason: found.reason };
        const { job: service, workspace } = found;
        if (!service.enabled) return { result: "skipped", reason: "its job is disabled" };
        if (action !== "stop" && !pomadeLets(service)) return { result: "skipped", reason: NOT_WITH_POMADE };
        const entry = entries().find((candidate) => candidate.job === service.id);
        const running = entry !== undefined && live(entry.session) !== null;
        if (action === "restart" && !running) return { result: "skipped", reason: "it is not running" };
        if (action === "start" && running) return { result: "skipped", reason: "it is running already" };
        log(`service ${service.id}: ${ACTION_WORDS[action]} — ${why}`);
        const before = entry === undefined ? null : (live(entry.session)?.info.startedAt ?? null);
        const answer = action === "restart" ? await restartNow(service, workspace, "chain") : action === "start" ? await startNow(service.id, true, "chain") : entry === undefined ? null : await stopNow(entry, "chain");
        if (answer !== null && !answer.ok) return { result: "failed", reason: answer.reason };
        const after = answer === null || action === "stop" ? null : (live(answer.service.session)?.info.startedAt ?? null);
        return { result: "done", session: after, ended: action === "start" ? null : before };
      }),

    async close() {
      unwatch();
      await lane;
      await store.flush();
    },
  };
}

