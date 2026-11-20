// Stand-ins for the run lifecycle's tests (`runs.test.ts`, `load.test.ts`): sessions held in memory
// as the keeper would hold them, records and the switch kept in memory as their files keep them, and
// a script job file.

import { join } from "node:path";

import type { ExitReason } from "pomade-kit/protocol";

import { sessionIdOf, type SessionOwner } from "../keeper/ids";
import type { KeeperLink, RunnerSession } from "../keeper/model";
import type { SessionCommand, Sessions, StopReason } from "../keeper/sessions";
import type { SwitchState } from "./model";
import type { RunsRecords, RunsStore } from "./runs";
import type { SwitchStore } from "./switch";

/** A script job file. */
export function script(name: string, extra = "schedule:\n  daily: { at: 13:00 }\n"): string {
  return `---\nkind: script\nname: ${name}\nfolder: Projects/x\ncommand: ./${name.toLowerCase()}.sh\n${extra}---\n`;
}

/** Sessions held in memory, as the keeper would hold them; `end` ends one as its program would. */
export class FakeSessions implements Sessions {
  readonly sessions = new Map<string, RunnerSession>();
  readonly spawned: { owner: Extract<SessionOwner, { kind: "run" }>; command: SessionCommand }[] = [];
  readonly forgotten: string[] = [];
  refuse: string | null = null;
  following = true;
  /** Whether the scheduler found no keeper and started it: a login. */
  loggedIn = true;
  link: KeeperLink = { state: "connected", version: "v1", pid: 1 };

  constructor(
    private readonly now: () => number,
    private readonly logs: string,
  ) {}

  keeper = (): KeeperLink => this.link;
  list = (): RunnerSession[] => [...this.sessions.values()];
  followed = (): boolean => this.following;
  startedKeeper = (): boolean => this.loggedIn;
  report = () => ({ keeper: this.link, sessions: this.list() });
  refresh = (): Promise<void> => Promise.resolve();

  spawn(owner: SessionOwner, command: SessionCommand): Promise<RunnerSession> {
    if (this.refuse !== null) return Promise.reject(new Error(this.refuse));
    if (owner.kind !== "run") throw new Error("runs only");
    const id = sessionIdOf(owner) ?? "";
    const session: RunnerSession = {
      id,
      job: owner.job,
      kind: "run",
      run: owner.run,
      log: join(this.logs, `${owner.run}.log`),
      info: { id, title: command.title, command: command.command, cwd: command.cwd, pid: 100 + this.spawned.length, startedAt: this.now(), cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: [] },
    };
    this.sessions.set(id, session);
    this.spawned.push({ owner, command });
    return Promise.resolve(session);
  }

  /** Every stop asked for, in order. */
  readonly stops: { id: string; reason: StopReason }[] = [];

  stop(id: string, reason: StopReason): Promise<void> {
    this.stops.push({ id, reason });
    return Promise.resolve();
  }

  restartService(): Promise<RunnerSession> {
    return Promise.reject(new Error("runs only"));
  }

  forget(id: string): Promise<void> {
    this.forgotten.push(id);
    this.sessions.delete(id);
    return Promise.resolve();
  }

  setActions(): Promise<void> {
    return Promise.reject(new Error("runs only"));
  }

  onExit(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** The run's session ends as the keeper says, `ranMs` after it started. */
  end(id: string, reason: ExitReason, code: number | null, ranMs = 2000, signal: string | null = null): void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error(`no session ${id}`);
    this.sessions.set(id, { ...session, info: { ...session.info, pid: null, state: "exited", exit: { code, signal, reason, at: session.info.startedAt + ranMs } } });
  }

  /** The session id of the latest spawn of `job`. */
  latest(job: string): string {
    const spawn = [...this.spawned].reverse().find((candidate) => candidate.owner.job === job);
    if (spawn === undefined) throw new Error(`no run of ${job}`);
    return sessionIdOf(spawn.owner) ?? "";
  }
}

/** Records kept in memory, as `runs.json` keeps them. */
export function memoryStore(): RunsStore & { saved: RunsRecords } {
  const store = {
    saved: { active: [], last: {}, lookedAt: null, held: {}, guard: { fired: {}, paused: {} } } as RunsRecords,
    load: () => Promise.resolve(structuredClone(store.saved)),
    save(records: RunsRecords) {
      store.saved = structuredClone(records);
    },
    flush: () => Promise.resolve(),
  };
  return store;
}

/** The switch kept in memory, as `switch.json` keeps it. */
export function memorySwitch(): SwitchStore & { saved: SwitchState } {
  const store = {
    saved: { position: "running", since: null } as SwitchState,
    load: () => Promise.resolve(structuredClone(store.saved)),
    save(state: SwitchState) {
      store.saved = structuredClone(state);
    },
    flush: () => Promise.resolve(),
  };
  return store;
}
