// Stand-ins for the run lifecycle's tests (`runs.test.ts`, `load.test.ts`): sessions held in memory
// as the keeper would hold them, records and the switch kept in memory as their files keep them, and
// a script job file; the Agents app and Pomade for agent runs as a test scripts them.

import type { ExitReason, RosterAgent } from "pomade-kit/protocol";
import type { AgentKind, AgentPrompt } from "pomade-kit/scanners";

import { agentMode, type AgentsApi, type AgentsError, type FoundSession, type LastMessage, type LaunchSpec, type LaunchSpecParams } from "../integrations/agents";
import type { PomadeForRuns } from "../integrations/pomade-open";
import type { AgentTurns, TurnHandlers } from "../keeper/agent-turns";
import { sessionIdOf, type SessionOwner } from "../keeper/ids";
import type { KeeperLink, RunnerSession } from "../keeper/model";
import type { KeychainCheck } from "../keeper/keychain";
import type { SessionCommand, Sessions, StopReason } from "../keeper/sessions";
import { liveOutputLogPath, stateFolderOf } from "../locations";
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
    /** The user-data folder whose state folder keeps the runs' output logs. */
    private readonly userData: string,
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
      log: liveOutputLogPath(stateFolderOf(this.userData), owner.job, owner.run),
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

  /** What the keychain checks answer, in turn; once they run out, `reachable`. */
  readonly keychain: KeychainCheck[] = [];
  /** How many keychain checks ran, and in which keeper (its pid). */
  readonly checks: number[] = [];
  /** Every keeper replacement asked for: why. */
  readonly replaced: string[] = [];

  checkKeychain(): Promise<KeychainCheck> {
    this.checks.push(this.link.state === "connected" ? this.link.pid : 0);
    return Promise.resolve(this.keychain.shift() ?? { status: "reachable" });
  }

  /** A fresh keeper: the next pid; what the old one ran ends `lost-in-keeper-crash`. */
  replaceKeeper(why: string): Promise<void> {
    this.replaced.push(why);
    for (const session of this.list()) if (session.info.exit === null) this.end(session.id, "lost-in-keeper-crash", null, 0);
    this.link = { state: "connected", version: "v1", pid: (this.link.state === "connected" ? this.link.pid : 0) + 1 };
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

/** Agent runs' turns as a test plays them: a followed agent works at once unless `workAtOnce` is
 *  off, then `works(session)` is it starting; `done(session)` is the agent's turn completing,
 *  `waits(session, prompt)` a prompt coming up for the person and `waits(session, null)` it
 *  answered; what Runner typed is in `typed`. */
export class FakeTurns implements AgentTurns {
  readonly followed = new Map<string, TurnHandlers>();
  readonly typed: { session: string; text: string }[] = [];
  /** Whether a followed agent is working at once; `false`: it stays at a screen until `works`. */
  workAtOnce = true;

  watch(session: string, _provider: AgentKind, handlers: TurnHandlers): void {
    if (this.followed.has(session)) return;
    this.followed.set(session, handlers);
    if (this.workAtOnce) handlers.onWorking();
  }

  type(session: string, text: string): void {
    this.typed.push({ session, text });
  }

  unwatch(session: string): void {
    this.followed.delete(session);
  }

  watched = (): string[] => [...this.followed.keys()];
  close = (): void => this.followed.clear();

  /** The agent of `session` works. */
  works(session: string): void {
    this.followed.get(session)?.onWorking();
  }

  /** The agent of `session` finished its turn. */
  done(session: string): void {
    this.followed.get(session)?.onTurnDone();
  }

  /** The agent of `session` waits at `prompt` for the person; `null`: the prompt was answered. */
  waits(session: string, prompt: AgentPrompt | null): void {
    this.followed.get(session)?.onWaiting(prompt);
  }
}

/** The Agents app as a test scripts it: a roster, the launch specs it answers (recorded in
 *  `launches`), the sessions `findSessions` finds, the last message; `fail` makes every call reject
 *  with it. */
export class FakeAgents implements AgentsApi {
  agents: RosterAgent[] = [{ id: "claude", name: "Claude", command: "claude", provider: "claude" }];
  readonly launches: LaunchSpecParams[] = [];
  found: FoundSession[] = [];
  /** Pre-assign the session id the launch asks for, as Claude Code does; `false` as Codex does. */
  preassigns = true;
  fail: AgentsError | null = null;
  /** What `lastMessage` answers for every session; `null`: the agent never answered. */
  message: LastMessage | null = { text: "Done.", at: null };
  /** The sessions `lastMessage` was asked about, in order. */
  readonly asked: string[] = [];

  private check(): void {
    if (this.fail !== null) throw this.fail;
  }

  roster(): Promise<RosterAgent[]> {
    this.check();
    return Promise.resolve(this.agents);
  }

  projectsFor(): Promise<string[]> {
    this.check();
    return Promise.resolve([]);
  }

  launchSpec(params: LaunchSpecParams): Promise<LaunchSpec> {
    this.check();
    this.launches.push(params);
    const agent = this.agents.find((candidate) => candidate.id === params.agent);
    const args = [...((agent === undefined ? undefined : agentMode(agent, params.mode))?.args ?? []), ...(this.preassigns && params.sessionId !== undefined ? ["--session-id", params.sessionId] : []), ...(params.prompt === undefined ? [] : [params.prompt])];
    return Promise.resolve({ command: agent?.command ?? params.agent, args, line: [agent?.command ?? params.agent, ...args.map((arg) => `'${arg}'`)].join(" "), sessionId: this.preassigns ? (params.sessionId ?? null) : null, exit: "/exit" });
  }

  findSessions(): Promise<FoundSession[]> {
    this.check();
    return Promise.resolve(this.found);
  }

  lastMessage(session: string): Promise<LastMessage | null> {
    this.asked.push(session);
    this.check();
    return Promise.resolve(this.message);
  }
}

/** Pomade for agent runs as a test scripts it: `isUp` says whether it is up; each opening is held
 *  until the test settles it (`settle`), and counted in `opened`. */
export class FakePomade implements PomadeForRuns {
  isUp = true;
  opened = 0;
  private pending: ((why: string | null) => void) | null = null;

  up = (): boolean => this.isUp && this.pending === null;

  open(): Promise<string | null> {
    this.opened++;
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  /** End the opening under way: up (`null`), or why not. */
  settle(why: string | null): void {
    const resolve = this.pending;
    this.pending = null;
    if (why === null) this.isUp = true;
    resolve?.(why);
  }
}
