// The scheduler's hold on the keeper: it keeps the keeper running (`startKeeper`), stays connected
// to it as the owner, updates it when this build ships a different keeper, and starts, stops,
// restarts and forgets sessions in it. The keeper keeps the sessions; the scheduler only follows
// them — a restarted scheduler rebuilds its view from the keeper's `list`, with no effect on any
// session. What `list` does not carry — the job and run a session belongs to and its output log —
// is kept in Runner's state folder (`sessions.json`), with each session's end once it is reported,
// so every end is reported once, an end while the scheduler was down included.
//
// The view follows the keeper on every `refresh()` (the scheduler's tick): a session that ended
// since is reported to `onExit` with the keeper's exit reason.
//
// Before an agent run starts, `checkKeychain` runs the keychain check (`keychain.ts`) as a short
// session in the keeper; `replaceKeeper` ends a keeper that failed it and starts a fresh one the way
// a tick starts a keeper that died — never the keeper's own update hand-off, whose successor the
// old keeper spawns and which would inherit the fault.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { connectKeeper, startKeeper, type KeeperClient } from "pomade-kit/node";
import { EXIT_REASONS, type SessionAction, type SessionExit, type SessionInfo } from "pomade-kit/protocol";

import { APP_ID } from "../app";
import { keeperOutPath, liveOutputLogPath, sessionsRecordPath, type StateFolder } from "../locations";
import type { Clock } from "../scheduler/clock";
import type { Log } from "../scheduler/log";
import { newRunId, sessionIdOf, sessionOwner, type SessionOwner } from "./ids";
import { KEYCHAIN_CHECK_TIMEOUT_MS, keychainVerdict, processStartedAt, type KeychainCheck } from "./keychain";
import type { KeeperLink, RunnerSession, SessionsReport } from "./model";
import { keeperNeedsUpdate } from "./version";

/** Why Runner stops a session: `stopped` by Runner itself · `stopped-by-you` on a person's Stop ·
 *  `time-limit` for a run past its limit. */
export type StopReason = "stopped" | "stopped-by-you" | "time-limit";

/** What a session runs. */
export interface SessionCommand {
  /** The job's name, the attached tab's title. */
  title: string;
  /** A command line, run by the user's login shell. */
  command: string;
  /** Or a program and its arguments, run directly, in place of `command` (an agent run's shell). */
  argv?: string[];
  /** The folder it runs in (absolute). */
  cwd: string;
  /** Added to the session's environment. */
  env?: Record<string, string>;
  /** macOS background priority (`taskpolicy -b`). */
  background: boolean;
  /** Header actions on its attached tabs. */
  actions?: SessionAction[];
}

export interface SessionsOptions {
  /** `POMADE_KEEPER_SOCKET`. */
  socketPath: string;
  /** The app's key: the keeper accepts the owner by it. */
  key: string;
  /** The shipped keeper: its entry (absolute) and version. */
  keeper: { entry: string; version: string };
  /** Runner's state folder: the session records, the keeper's own folder, each run's output log. */
  state: StateFolder;
  clock: Clock;
  log: Log;
  /** What the keychain check runs (`keychainCheckArgv`). */
  keychainCheck: string[];
}

export interface Sessions {
  keeper(): KeeperLink;
  /** Every session the keeper holds, as of the latest refresh. */
  list(): RunnerSession[];
  /** Whether `list()` is the keeper's: the latest refresh read the keeper's list. */
  followed(): boolean;
  /** Whether this scheduler found no keeper running and started it before it first connected —
   *  Runner was just installed, or the keeper ended (a Mac restart, a crash). `false` when a keeper
   *  was running and before the first connection. A login is told without it, by the console
   *  login, as long as one is kept (`src/scheduler/console-login.ts`). */
  startedKeeper(): boolean;
  report(): SessionsReport;
  /** Make sure the keeper runs and the connection to it is up, and follow its sessions; reports
   *  exits. Refreshes never overlap. */
  refresh(): Promise<void>;
  /** Start a session: a service's (`svc:<job>`, refused while it runs; a new run id each start)
   *  or one run's (`run:<job>:<run>`, the run id its caller made with `newRunId`). */
  spawn(owner: SessionOwner, command: SessionCommand): Promise<RunnerSession>;
  /** SIGTERM, then SIGKILL after `graceMs` (default the keeper's 3 s). */
  stop(id: string, reason: StopReason, graceMs?: number): Promise<void>;
  /** Stop a service's session (reason `stopped`) when it runs, wait for its end, and start it again
   *  under the same id; attached tabs follow the new session. */
  restartService(job: string, command: SessionCommand): Promise<RunnerSession>;
  /** Drop an ended session from the keeper and from Runner's records. */
  forget(id: string): Promise<void>;
  /** Set a session's header actions; its attached tabs show them at once. */
  setActions(id: string, actions: SessionAction[]): Promise<void>;
  /** Called once for each session's end. */
  onExit(listener: (session: RunnerSession) => void): () => void;
  /** Run the keychain check in the keeper: a short session, read by its exit status, then
   *  forgotten. A failed check and one that could not run — the keeper not connected, the session
   *  refused or not ending within `KEYCHAIN_CHECK_TIMEOUT_MS` — are logged with the keeper's pid and
   *  start time. Never throws. */
  checkKeychain(): Promise<KeychainCheck>;
  /** End the keeper (SIGTERM to the pid it reported, SIGKILL after `KEEPER_END_WAIT_MS`) and start
   *  a fresh one; resolves once the fresh one is followed. The sessions the old one held end
   *  `lost-in-keeper-crash`. Throws when it cannot. */
  replaceKeeper(why: string): Promise<void>;
  /** Close the connection, once the records are written; the keeper and its sessions keep running. */
  close(): Promise<void>;
}

/** A session's record in `sessions.json`. */
interface SessionRecord {
  job: string;
  kind: "service" | "run";
  run: string | null;
  log: string | null;
  /** How the session ended, once that is reported; `null` until then. */
  exit: SessionExit | null;
}

/** How long, after a keeper hand-off begins, the scheduler only reconnects and never starts a
 *  keeper: the keeper's own wait for its successor (15 s) and a margin. A keeper started in the gap
 *  would take the socket from the successor that holds the sessions. */
const HANDOFF_MS = 20_000;
/** How long `restartService` waits for the stopped session to end, past its grace period. */
const RESTART_WAIT_MS = 6_000;
const POLL_MS = 50;
/** How long a replaced keeper has to end after SIGTERM, and again after SIGKILL. */
const KEEPER_END_WAIT_MS = 5_000;
/** How long the fresh keeper has to answer once the old one ended. */
const KEEPER_START_WAIT_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Send `pid` a signal; one already gone is no error. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/** Wait until process `pid` is gone; whether it went within `ms`. */
async function ended(pid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (alive(pid)) {
    if (performance.now() > deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REASONS: readonly string[] = EXIT_REASONS;

function parseExit(value: unknown): SessionExit | null {
  if (!isRecord(value)) return null;
  const { code, signal, reason, at } = value;
  if ((code !== null && typeof code !== "number") || (signal !== null && typeof signal !== "string")) return null;
  if (typeof reason !== "string" || !REASONS.includes(reason) || typeof at !== "number") return null;
  return { code, signal, reason: reason as SessionExit["reason"], at };
}

function parseRecords(data: unknown): Map<string, SessionRecord> {
  const records = new Map<string, SessionRecord>();
  if (!isRecord(data) || !isRecord(data.sessions)) return records;
  for (const [id, value] of Object.entries(data.sessions)) {
    if (!isRecord(value)) continue;
    const { job, kind, run, log, exit } = value;
    if (typeof job !== "string" || (kind !== "service" && kind !== "run")) continue;
    records.set(id, {
      job,
      kind,
      run: typeof run === "string" ? run : null,
      log: typeof log === "string" ? log : null,
      exit: parseExit(exit),
    });
  }
  return records;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createSessions(options: SessionsOptions): Sessions {
  const { clock, log } = options;
  const recordFile = sessionsRecordPath(options.state);
  let records: Map<string, SessionRecord> | null = null;
  let view = new Map<string, RunnerSession>();
  let client: KeeperClient | null = null;
  let link: KeeperLink = { state: "connecting" };
  let handoffUntil = 0;
  /** Versions of running keepers an update was tried from: each is tried once per scheduler. */
  const updatesTried = new Set<string>();
  const exitListeners = new Set<(session: RunnerSession) => void>();
  let refreshing: Promise<void> | null = null;
  /** Whether a keeper start of this scheduler's came before its first connection; `null` until it
   *  first connects. */
  let startedFirst: boolean | null = null;
  let startedOne = false;
  let following = false;
  let writing: Promise<void> = Promise.resolve();
  let closed = false;

  const setLink = (next: KeeperLink): void => {
    const changed = JSON.stringify(next) !== JSON.stringify(link);
    link = next;
    if (!changed) return;
    if (next.state === "connected") log(`keeper: connected — version ${next.version}, pid ${next.pid}`);
    else if (next.state === "unreachable") log(`keeper: not reachable — ${next.reason}`);
    else if (next.state === "rejected") log(`keeper: refused the scheduler — ${next.reason}`);
  };

  async function loadRecords(): Promise<Map<string, SessionRecord>> {
    if (records !== null) return records;
    let text: string | null = null;
    try {
      text = await readFile(recordFile, "utf8");
    } catch {
      // No records yet.
    }
    let loaded = new Map<string, SessionRecord>();
    if (text !== null) {
      try {
        loaded = parseRecords(JSON.parse(text));
      } catch {
        log(`keeper: ${recordFile} is not readable JSON; starting from the keeper's list alone`);
      }
    }
    records ??= loaded;
    return records;
  }

  /** Write the records; writes never overlap and the file is replaced whole. */
  function saveRecords(): void {
    const data = JSON.stringify({ sessions: Object.fromEntries(records ?? []) }, null, 2);
    writing = writing
      .then(async () => {
        await mkdir(dirname(recordFile), { recursive: true });
        await writeFile(`${recordFile}.tmp`, `${data}\n`);
        await rename(`${recordFile}.tmp`, recordFile);
      })
      .catch((err: unknown) => log(`keeper: cannot write ${recordFile}: ${errorText(err)}`));
  }

  const sessionOf = (info: SessionInfo, record: SessionRecord): RunnerSession => ({
    id: info.id,
    job: record.job,
    kind: record.kind,
    run: record.run,
    log: record.log,
    info,
  });

  /** Take the keeper's list as the view; report every end not reported yet. */
  function observe(known: Map<string, SessionRecord>, infos: readonly SessionInfo[]): void {
    let changed = false;
    const ended: RunnerSession[] = [];
    const next = new Map<string, RunnerSession>();
    for (const info of infos) {
      let record = known.get(info.id);
      if (record === undefined) {
        const owner = sessionOwner(info.id);
        if (owner === null) continue;
        record = { job: owner.job, kind: owner.kind, run: owner.kind === "run" ? owner.run : null, log: null, exit: null };
        known.set(info.id, record);
        changed = true;
      }
      const session = sessionOf(info, record);
      next.set(info.id, session);
      if (info.exit !== null && record.exit?.at !== info.exit.at) {
        record.exit = info.exit;
        changed = true;
        ended.push(session);
      }
    }
    for (const id of [...known.keys()]) {
      if (next.has(id)) continue;
      known.delete(id);
      changed = true;
    }
    view = next;
    if (changed) saveRecords();
    for (const session of ended) for (const listener of [...exitListeners]) listener(session);
  }

  function adopt(keeper: KeeperClient): void {
    client = keeper;
    startedFirst ??= startedOne;
    // A keeper answers: any hand-off is over, and a keeper that dies from now on is started again.
    handoffUntil = 0;
    setLink({ state: "connected", version: keeper.keeper.version, pid: keeper.keeper.pid });
    keeper.onEvent((event) => {
      if (event.type === "keeper-restarting") handoffUntil = performance.now() + HANDOFF_MS;
    });
    keeper.onClose(() => {
      if (client !== keeper) return;
      client = null;
      if (!closed) {
        log("keeper: connection closed; reconnecting");
        setLink({ state: "connecting" });
      }
    });
  }

  /** The owner connection: as it is, or a new one — starting the keeper first unless a hand-off is
   *  under way, and updating a keeper of another version once. */
  async function connect(): Promise<KeeperClient | null> {
    if (client !== null) return client;
    if (performance.now() >= handoffUntil) {
      const out = keeperOutPath(options.state);
      await mkdir(dirname(out), { recursive: true });
      const started = await startKeeper({
        entry: options.keeper.entry,
        args: [options.keeper.version],
        socketPath: options.socketPath,
        app: APP_ID,
        logFile: out,
      });
      if (started.status === "failed") {
        setLink({ state: "unreachable", reason: started.reason });
        return null;
      }
      if (started.started) {
        startedOne = true;
        log(`keeper: started — pid ${started.pid}`);
      }
    }
    const result = await connectKeeper({ socketPath: options.socketPath, app: APP_ID, role: "owner", key: options.key });
    if (closed) {
      if (result.status === "connected") result.keeper.close();
      return null;
    }
    if (result.status === "rejected") {
      setLink({ state: "rejected", reason: result.message });
      return null;
    }
    if (result.status === "not-running") {
      setLink({ state: "unreachable", reason: result.reason });
      return null;
    }
    const keeper = result.keeper;
    const running = keeper.keeper.version;
    if (keeperNeedsUpdate(running, options.keeper.version)) {
      if (!updatesTried.has(running)) {
        updatesTried.add(running);
        log(`keeper: version ${running} (pid ${keeper.keeper.pid}) is not this build's ${options.keeper.version}; updating it`);
        handoffUntil = performance.now() + HANDOFF_MS;
        const gone = new Promise<void>((resolve) => keeper.onClose(resolve));
        try {
          await keeper.upgrade(options.keeper.entry, [options.keeper.version]);
          await gone;
        } catch (err) {
          handoffUntil = 0;
          keeper.close();
          log(`keeper: the update was refused — ${errorText(err)}`);
        }
        return null;
      }
      log(`keeper: the update from version ${running} did not take; the keeper stays at it`);
    }
    adopt(keeper);
    return keeper;
  }

  async function follow(keeper: KeeperClient): Promise<void> {
    const known = await loadRecords();
    let infos: SessionInfo[];
    try {
      infos = await keeper.list();
    } catch {
      following = false;
      return;
    }
    observe(known, infos);
    following = true;
  }

  /** Run the check's session to its end, or to the timeout, and forget it. Its id is one Runner
   *  does not make for a job (`sessionOwner` gives `null`), so no view or record ever holds it. */
  async function runCheck(keeper: KeeperClient): Promise<KeychainCheck> {
    const id = `check:keychain-${randomBytes(3).toString("hex")}`;
    try {
      await keeper.spawn({ id, title: "Keychain check", argv: options.keychainCheck, cwd: "/", background: false });
    } catch (err) {
      return { status: "unknown", detail: `the keeper did not start it: ${errorText(err)}` };
    }
    try {
      const deadline = performance.now() + KEYCHAIN_CHECK_TIMEOUT_MS;
      for (;;) {
        const exit = (await keeper.list()).find((info) => info.id === id)?.exit;
        if (exit === undefined) return { status: "unknown", detail: "its session is gone" };
        if (exit !== null) return keychainVerdict(exit);
        if (performance.now() > deadline) {
          await keeper.stop(id, { reason: "stopped", graceMs: 0 });
          return { status: "unknown", detail: `it did not end within ${KEYCHAIN_CHECK_TIMEOUT_MS / 1000} s` };
        }
        await sleep(POLL_MS);
      }
    } catch (err) {
      return { status: "unknown", detail: errorText(err) };
    } finally {
      await forgetCheck(keeper, id);
    }
  }

  /** Drop the check's session once it ended; a session still ending is forgotten when it has. */
  async function forgetCheck(keeper: KeeperClient, id: string): Promise<void> {
    const deadline = performance.now() + RESTART_WAIT_MS;
    try {
      while ((await keeper.list()).some((info) => info.id === id && info.exit === null)) {
        if (performance.now() > deadline) return;
        await sleep(POLL_MS);
      }
      await keeper.forget(id);
    } catch {
      // The keeper went away: it took the check's session with it.
    }
  }

  function connected(): KeeperClient {
    if (client !== null) return client;
    const why = link.state === "unreachable" || link.state === "rejected" ? link.reason : "connecting";
    throw new Error(`the keeper is not connected (${why})`);
  }

  const sessions: Sessions = {
    keeper: () => link,
    list: () => [...view.values()],
    followed: () => following && client !== null,
    startedKeeper: () => startedFirst === true,
    report: () => ({ keeper: link, sessions: [...view.values()] }),

    refresh() {
      if (closed) return Promise.resolve();
      refreshing ??= (async () => {
        try {
          const keeper = await connect();
          if (keeper === null) following = false;
          else await follow(keeper);
        } catch (err) {
          following = false;
          log(`keeper: ${errorText(err)}`);
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    },

    async spawn(owner, command) {
      const keeper = connected();
      const run = owner.kind === "run" ? owner.run : newRunId(clock.now(), () => randomBytes(3).toString("hex"));
      const id = sessionIdOf(owner.kind === "service" ? owner : { kind: "run", job: owner.job, run });
      if (id === null) throw new Error(`the job id "${owner.job}" is too long to name a session`);
      const output = liveOutputLogPath(options.state, owner.job, run);
      const info = await keeper.spawn({
        id,
        title: command.title,
        ...(command.argv === undefined ? { command: command.command } : { argv: command.argv }),
        cwd: command.cwd,
        background: command.background,
        log: output,
        ...(command.env === undefined ? {} : { env: command.env }),
        ...(command.actions === undefined ? {} : { actions: command.actions }),
      });
      const record: SessionRecord = { job: owner.job, kind: owner.kind, run, log: output, exit: null };
      (await loadRecords()).set(id, record);
      saveRecords();
      const session = sessionOf(info, record);
      view.set(id, session);
      log(`session ${id}: started — pid ${info.pid ?? "?"}, in ${info.cwd}`);
      return session;
    },

    async stop(id, reason, graceMs) {
      await connected().stop(id, { reason, ...(graceMs === undefined ? {} : { graceMs }) });
    },

    async restartService(job, command) {
      const keeper = connected();
      const id = sessionIdOf({ kind: "service", job });
      if (id === null) throw new Error(`the job id "${job}" is too long to name a session`);
      const known = await loadRecords();
      const running = (infos: readonly SessionInfo[]): boolean => infos.some((info) => info.id === id && info.state === "running");
      let infos = await keeper.list();
      if (running(infos)) {
        await keeper.stop(id, { reason: "stopped" });
        const deadline = performance.now() + RESTART_WAIT_MS;
        while (running(infos)) {
          if (performance.now() > deadline) throw new Error(`session ${id} did not end after it was stopped`);
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          infos = await keeper.list();
        }
      }
      observe(known, infos);
      return sessions.spawn({ kind: "service", job }, command);
    },

    async forget(id) {
      await connected().forget(id);
      (await loadRecords()).delete(id);
      view.delete(id);
      saveRecords();
    },

    async setActions(id, actions) {
      const info = await connected().update(id, { actions });
      const known = view.get(id);
      if (known !== undefined) view.set(id, { ...known, info });
    },

    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },

    async checkKeychain() {
      const keeper = client;
      if (keeper === null) {
        let why = "connecting";
        if (link.state === "unreachable" || link.state === "rejected") why = link.reason;
        log(`keeper: the keychain check could not run — the keeper is not connected (${why})`);
        return { status: "unknown", detail: `the keeper is not connected (${why})` };
      }
      const { pid } = keeper.keeper;
      const verdict = await runCheck(keeper);
      if (verdict.status === "reachable") return verdict;
      const since = await processStartedAt(pid);
      if (verdict.status === "unreachable") log(`keeper: the keychain check failed in keeper pid ${pid}, started ${since} — ${verdict.detail}`);
      else log(`keeper: the keychain check could not run in keeper pid ${pid}, started ${since} — ${verdict.detail}`);
      return verdict;
    },

    async replaceKeeper(why) {
      const old = connected().keeper.pid;
      log(`keeper: replacing pid ${old}, started ${await processStartedAt(old)} — ${why}`);
      signal(old, "SIGTERM");
      if (!(await ended(old, KEEPER_END_WAIT_MS))) {
        signal(old, "SIGKILL");
        if (!(await ended(old, KEEPER_END_WAIT_MS))) throw new Error(`the keeper (pid ${old}) did not end`);
      }
      const deadline = performance.now() + KEEPER_START_WAIT_MS;
      for (;;) {
        await sessions.refresh();
        const fresh = client?.keeper.pid;
        if (fresh !== undefined && fresh !== old && following) {
          log(`keeper: replaced pid ${old} with pid ${fresh}, started ${await processStartedAt(fresh)}`);
          return;
        }
        if (performance.now() > deadline) throw new Error(`no fresh keeper answered after pid ${old} ended`);
        await sleep(POLL_MS);
      }
    },

    async close() {
      closed = true;
      client?.close();
      client = null;
      await writing;
    },
  };
  return sessions;
}
