// Service supervision on a clock the tests set, against sessions that stand in for the keeper: every
// rule — staged start, readiness, back-off, the crash loop, holds, file changes — without waiting.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExitReason, SessionAction } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import type { JobsSnapshot } from "../jobs/model";
import { recordsFolderOf, stateFolderOf, type RecordsFolder, type StateFolder } from "../locations";
import { sessionIdOf } from "./ids";
import type { KeychainCheck } from "./keychain";
import type { KeeperLink, RunnerSession, ServicesReport, ServiceStatus } from "./model";
import { runWords, type RunRecord } from "../scheduler/model";
import type { NetworkReadiness } from "./readiness";
import type { SessionCommand, Sessions, StopReason } from "./sessions";
import {
  ALIVE_MS,
  BACKOFF_MS,
  createSupervisor,
  fileStore,
  NOT_WITH_POMADE,
  REMOVED_GRACE_MS,
  RESET_UPTIME_MS,
  START_CAP_MS,
  type PomadeState,
  type SupervisionRecord,
  type SupervisionStore,
  type Supervisor,
} from "./supervisor";

const WS = "/ws";
const T0 = Date.parse("2026-11-17T08:00:00.000Z");

/** A service job file. */
function service(name: string, extra = ""): string {
  return `---\nkind: service\nname: ${name}\nfolder: .\ncommand: ./${name.toLowerCase()}.sh\n${extra}---\n`;
}

/** Sessions held in memory, as the keeper would hold them: a stop ends its session on the next
 *  refresh, with the reason given; `end` ends one as the program would. */
class FakeSessions implements Sessions {
  readonly sessions = new Map<string, RunnerSession>();
  readonly spawned: { job: string; command: SessionCommand }[] = [];
  readonly stops: { id: string; reason: StopReason }[] = [];
  readonly restarted: string[] = [];
  readonly forgotten: string[] = [];
  /** Spawns fail with this message while it is set. */
  refuse: string | null = null;
  following = true;
  link: KeeperLink = { state: "connected", version: "v1", pid: 1 };
  private readonly listeners = new Set<(session: RunnerSession) => void>();
  private readonly pending = new Map<string, StopReason>();
  private pid = 100;

  constructor(private readonly now: () => number) {}

  keeper = (): KeeperLink => this.link;
  list = (): RunnerSession[] => [...this.sessions.values()];
  followed = (): boolean => this.following;
  startedKeeper = (): boolean => false;
  report = () => ({ keeper: this.link, sessions: this.list() });

  refresh(): Promise<void> {
    for (const [id, reason] of [...this.pending]) {
      this.pending.delete(id);
      this.finish(id, reason, reason === "stopped-by-you" ? 130 : 143);
    }
    return Promise.resolve();
  }

  spawn(owner: { kind: "service" | "run"; job: string }, command: SessionCommand): Promise<RunnerSession> {
    if (this.refuse !== null) return Promise.reject(new Error(this.refuse));
    const id = sessionIdOf({ kind: "service", job: owner.job }) ?? "";
    if (this.sessions.get(id)?.info.state === "running") return Promise.reject(new Error(`session ${id} is running`));
    const startedAt = this.now();
    const session: RunnerSession = {
      id,
      job: owner.job,
      kind: "service",
      run: `run-${this.spawned.length}`,
      log: null,
      info: { id, title: command.title, command: command.command, cwd: command.cwd, pid: this.pid++, startedAt, cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: command.actions ?? [] },
    };
    this.sessions.set(id, session);
    this.spawned.push({ job: owner.job, command });
    return Promise.resolve(session);
  }

  stop(id: string, reason: StopReason): Promise<void> {
    this.stops.push({ id, reason });
    this.pending.set(id, reason);
    return Promise.resolve();
  }

  async restartService(job: string, command: SessionCommand): Promise<RunnerSession> {
    const id = sessionIdOf({ kind: "service", job }) ?? "";
    this.restarted.push(job);
    if (this.sessions.get(id)?.info.state === "running") this.finish(id, "stopped", 143);
    return this.spawn({ kind: "service", job }, command);
  }

  forget(id: string): Promise<void> {
    this.forgotten.push(id);
    this.sessions.delete(id);
    return Promise.resolve();
  }

  checkKeychain(): Promise<KeychainCheck> {
    return Promise.resolve({ status: "reachable" });
  }

  replaceKeeper(): Promise<void> {
    return Promise.reject(new Error("runs only"));
  }

  setActions(id: string, actions: SessionAction[]): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) return Promise.reject(new Error(`no session ${id}`));
    this.sessions.set(id, { ...session, info: { ...session.info, actions } });
    return Promise.resolve();
  }

  /** The header actions a service's session carries now. */
  actions(job: string): string[] {
    return this.sessions.get(sessionIdOf({ kind: "service", job }) ?? "")?.info.actions.map((action) => action.id) ?? [];
  }

  onExit(listener: (session: RunnerSession) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** The service's session ends as its program or the keeper says. */
  end(job: string, reason: ExitReason, code: number | null = reason === "exited" ? 0 : 1): void {
    this.finish(sessionIdOf({ kind: "service", job }) ?? "", reason, code);
  }

  /** How many times the job was spawned. */
  starts(job: string): number {
    return this.spawned.filter((spawn) => spawn.job === job).length;
  }

  private finish(id: string, reason: ExitReason, code: number | null): void {
    const session = this.sessions.get(id);
    if (session?.info.state !== "running") return;
    const ended: RunnerSession = { ...session, info: { ...session.info, pid: null, state: "exited", exit: { code, signal: null, reason, at: this.now() } } };
    this.sessions.set(id, ended);
    for (const listener of [...this.listeners]) listener(ended);
  }
}

/** Records kept in memory, as `fileStore` keeps them on disk. */
function memoryStore(): SupervisionStore & { saved: Map<string, SupervisionRecord> } {
  const saved = new Map<string, SupervisionRecord>();
  return {
    saved,
    load: () => Promise.resolve(new Map([...saved].map(([job, record]) => [job, structuredClone(record)]))),
    save(records) {
      saved.clear();
      for (const [job, record] of records) saved.set(job, structuredClone(record));
    },
    flush: () => Promise.resolve(),
  };
}

describe("service supervision", () => {
  let now: number;
  /** How far the system clock — the keeper's — is ahead of the scheduler's clock. */
  let skew: number;
  let files: Record<string, string>;
  let snapshot: JobsSnapshot;
  let workspace: string | null;
  let sessions: FakeSessions;
  let store: ReturnType<typeof memoryStore>;
  let lines: string[];
  let reports: ServicesReport[];
  /** Pending network checks, answered by the test. */
  let probes: { ready: NetworkReadiness; answer: (ok: boolean) => void }[];
  /** The projects opened since Pomade started, as the scheduler holds them. */
  let opened: Set<string>;
  /** Where Pomade stands, as the scheduler tells it. */
  let pomade: PomadeState;
  let supervisor: Supervisor;
  /** The service events written, a crash window's row replaced as it is put again. */
  let events: RunRecord[];
  let randoms: number;

  function load(): void {
    snapshot = checkJobs(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { workspace, projects: null },
    );
  }

  async function open(): Promise<Supervisor> {
    const created = createSupervisor({
      sessions,
      jobs: () => snapshot,
      clock: { now: () => new Date(now) },
      systemNow: () => now + skew,
      log: (line) => lines.push(line),
      store,
      probe: (ready) => new Promise((resolve) => probes.push({ ready, answer: resolve })),
      pomade: () => ({ state: pomade, opened }),
      onChange: (report) => reports.push(report),
      onEvent: (record, put) => {
        const at = events.findIndex((known) => known.run === record.run);
        if (put && at !== -1) events[at] = record;
        else events.push(record);
      },
      projectName: (project) => (project === "blog" ? "Blog" : null),
      random: () => String(randoms++).padStart(6, "0"),
    });
    await created.load();
    supervisor = created;
    return created;
  }

  /** A project's first open since Pomade started, as the scheduler tells it. */
  async function firstOpen(project: string): Promise<void> {
    opened.add(project);
    await supervisor.firstOpen(project);
  }

  /** A tick as the scheduler runs it: follow the keeper, then supervise. */
  async function tick(): Promise<void> {
    await sessions.refresh();
    await supervisor.tick();
  }

  /** Move the clock on, then tick. */
  async function at(ms: number): Promise<void> {
    now = T0 + ms;
    await tick();
  }

  function status(job: string): ServiceStatus {
    const found = supervisor.report().services.find((candidate) => candidate.job === job);
    if (found === undefined) throw new Error(`no service ${job}`);
    return found;
  }

  const states = (): Record<string, string> => Object.fromEntries(supervisor.report().services.map((candidate) => [candidate.job, candidate.state]));

  beforeEach(async () => {
    now = T0;
    skew = 0;
    workspace = WS;
    files = {};
    sessions = new FakeSessions(() => now + skew);
    store = memoryStore();
    lines = [];
    reports = [];
    probes = [];
    opened = new Set();
    pomade = "running";
    events = [];
    randoms = 0;
    load();
    await open();
  });

  describe("staged start", () => {
    it("starts login services one at a time, workspace jobs first, then each project's by id; the next once the current has run 5 s", async () => {
      files = { "zeta.md": service("Zeta"), "alpha/web.md": service("Web", "project: alpha\n"), "alpha/api.md": service("Api", "project: alpha\n") };
      load();
      await at(0);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["zeta"]);
      expect(states()).toEqual({ zeta: "starting", "alpha/api": "queued", "alpha/web": "queued" });
      await at(ALIVE_MS - 1);
      expect(sessions.spawned).toHaveLength(1);
      await at(ALIVE_MS);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["zeta", "alpha/api"]);
      expect(status("zeta").state).toBe("running");
      await at(2 * ALIVE_MS);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["zeta", "alpha/api", "alpha/web"]);
      await at(3 * ALIVE_MS);
      expect(states()).toEqual({ zeta: "running", "alpha/api": "running", "alpha/web": "running" });
      expect(lines).toEqual(expect.arrayContaining(["service zeta: starting", "service zeta: up", "service alpha/api: starting"]));
    });

    it("is settled once no service waits for its turn and none is starting within its 30 s", async () => {
      expect(supervisor.settled()).toBe(false);
      files = { "zeta.md": service("Zeta"), "alpha/web.md": service("Web", "project: alpha\n") };
      load();
      await at(0);
      expect(supervisor.settled()).toBe(false);
      await at(ALIVE_MS);
      expect(supervisor.settled()).toBe(false);
      await at(2 * ALIVE_MS);
      expect(supervisor.settled()).toBe(true);
      files = {};
      load();
      await at(2 * ALIVE_MS + 1);
      expect(supervisor.settled()).toBe(true);
    });

    it("runs each service as its job says: its command in its folder, titled with its name, with Restart on its tab", async () => {
      files = { "web.md": "---\nkind: service\nname: Web\nfolder: Projects/web\ncommand: npm run dev\nlow-priority: true\n---\n" };
      load();
      await at(0);
      expect(sessions.spawned).toEqual([{ job: "web", command: { title: "Web", command: "npm run dev", cwd: join(WS, "Projects/web"), background: true, actions: [{ id: "restart", title: "Restart" }] } }]);
    });

    it("moves on once a port or URL check passes, before 5 s; keeps checking a service that is not up", async () => {
      files = { "a.md": service("A", "ready: { port: 5173 }\n"), "b.md": service("B", "ready: { url: http://localhost:5173/ }\n"), "c.md": service("C") };
      load();
      await at(0);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["a"]);
      await at(500);
      expect(probes.map((probe) => probe.ready)).toEqual([{ kind: "port", port: 5173 }]);
      probes.shift()?.answer(false);
      await at(1000);
      expect(status("a").state).toBe("starting");
      expect(sessions.spawned).toHaveLength(1);
      probes.shift()?.answer(true);
      await at(1500);
      expect(status("a").state).toBe("running");
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["a", "b"]);
      await at(2000);
      expect(probes.map((probe) => probe.ready)).toEqual([{ kind: "url", url: "http://localhost:5173/" }]);
      expect(lines).toContain("service a: up");
    });

    it("moves on after 30 s when the current service is never up; it stays starting", async () => {
      files = { "a.md": service("A", "ready: { port: 5173 }\n"), "b.md": service("B") };
      load();
      await at(0);
      for (let t = 1000; t < START_CAP_MS; t += 1000) {
        for (const probe of probes.splice(0)) probe.answer(false);
        await at(t);
      }
      expect(sessions.spawned).toHaveLength(1);
      for (const probe of probes.splice(0)) probe.answer(false);
      await at(START_CAP_MS);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["a", "b"]);
      expect(status("a").state).toBe("starting");
      expect(lines).toContain("service a: not up after 30 s; starting the next service");
    });

    it("a start that ends before it is up lets the next one start", async () => {
      files = { "a.md": service("A"), "b.md": service("B") };
      load();
      await at(0);
      sessions.end("a", "crashed");
      await at(100);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["a", "b"]);
    });

    it("a new service file starts promptly; one waits for its project to open, and Start runs it", async () => {
      await at(0);
      files = { "web.md": service("Web"), "p/app.md": service("App", "project: p\nstart: project-first-open\n") };
      load();
      await at(1000);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["web"]);
      await at(60_000);
      expect(states()).toEqual({ web: "running", "p/app": "waiting" });
      expect(await supervisor.start("p/app")).toMatchObject({ ok: true, service: { job: "p/app", state: "starting" } });
      // Once started, it is kept up like any service.
      sessions.end("p/app", "crashed");
      await at(60_500);
      expect(status("p/app").state).toBe("restarting");
      await at(61_000);
      expect(sessions.starts("p/app")).toBe(2);
      // An end that is not its own fault leaves it waiting for its project again.
      sessions.end("p/app", "lost-in-keeper-crash");
      await at(70_000);
      expect(status("p/app").state).toBe("waiting");
    });

    it("a first-open service starts on its start project's first open, through the staged start; a stopped one stays stopped", async () => {
      files = {
        "p/app.md": service("App", "project: p\nstart: project-first-open\n"),
        "docs.md": service("Docs", "start: project-first-open\nstart-project: q\n"),
        "p/off.md": service("Off", "project: p\nstart: project-first-open\nenabled: false\n"),
        "p/held.md": service("Held", "project: p\nstart: project-first-open\n"),
      };
      load();
      await at(0);
      expect(await supervisor.start("p/held")).toMatchObject({ ok: true });
      expect(await supervisor.stop("p/held")).toMatchObject({ ok: true, service: { state: "stopped-by-you" } });
      await at(1000);
      expect(states()).toEqual({ docs: "waiting", "p/app": "waiting", "p/held": "stopped-by-you", "p/off": "disabled" });

      // Another project's first open starts nothing of p's.
      await firstOpen("other");
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["p/held"]);
      await firstOpen("p");
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["p/held", "p/app"]);
      expect(states()).toEqual({ docs: "waiting", "p/app": "starting", "p/held": "stopped-by-you", "p/off": "disabled" });
      expect(lines).toContain("service p/held: its project's first open; it stays stopped until Start");
      // A workspace service on another project's first open waits its turn in the staged start.
      await firstOpen("q");
      expect(status("docs").state).toBe("queued");
      await at(7000);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["p/held", "p/app", "docs"]);
      // Started, it is kept up like any service; a later first open (the next Pomade start) leaves it be.
      await at(20_000);
      await firstOpen("p");
      expect(sessions.starts("p/app")).toBe(1);
      sessions.end("p/app", "crashed");
      await at(20_500);
      await at(21_100);
      expect(sessions.starts("p/app")).toBe(2);
    });

    it("a first-open service of a project opened already starts as soon as it exists — made, enabled, changed to that start or that project; a stopped or failed one stays so", async () => {
      await firstOpen("p");
      await at(0);
      // Made after the open: it starts within a tick, through the staged start.
      files = { "p/app.md": service("App", "project: p\nstart: project-first-open\n") };
      load();
      expect(states()).toEqual({ "p/app": "queued" });
      await at(1000);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["p/app"]);

      // Enabled after the open.
      files["p/off.md"] = service("Off", "project: p\nstart: project-first-open\nenabled: false\n");
      load();
      await at(8000);
      expect(status("p/off").state).toBe("disabled");
      files["p/off.md"] = service("Off", "project: p\nstart: project-first-open\n");
      load();
      await at(16_000);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["p/app", "p/off"]);

      // Changed from a login start, or to a start project opened; one not opened waits.
      files["docs.md"] = service("Docs", "start: project-first-open\nstart-project: q\n");
      files["p/web.md"] = service("Web", "project: p\nenabled: false\n");
      load();
      await at(24_000);
      expect(states()).toMatchObject({ docs: "waiting", "p/web": "disabled" });
      files["docs.md"] = service("Docs", "start: project-first-open\nstart-project: p\n");
      files["p/web.md"] = service("Web", "project: p\nstart: project-first-open\n");
      load();
      await at(32_000);
      await at(40_000);
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["p/app", "p/off", "docs", "p/web"]);

      // Stopped by the person, then edited and saved: it stays stopped.
      expect(await supervisor.stop("p/app")).toMatchObject({ ok: true });
      await at(41_000);
      files["p/app.md"] = service("App", "project: p\nstart: project-first-open\n").replace("./app.sh", "./app2.sh");
      load();
      await at(48_000);
      await firstOpen("p");
      expect(status("p/app").state).toBe("stopped-by-you");
      expect(sessions.starts("p/app")).toBe(1);
      // Failed stays failed.
      let t = 49_000;
      for (let crash = 1; crash <= 5; crash++) {
        now = T0 + t;
        sessions.end("p/off", "crashed");
        await at(t);
        if (crash < 5) {
          t = (status("p/off").retryAt ?? 0) - T0;
          await at(t);
        }
      }
      expect(status("p/off").state).toBe("failed");
      const starts = sessions.starts("p/off");
      await firstOpen("p");
      await at(t + 60_000);
      expect([status("p/off").state, sessions.starts("p/off")]).toEqual(["failed", starts]);
      expect(supervisor.report().openedProjects).toEqual(["p"]);
    });

    it("the opened projects forgotten (a new Pomade start): a first-open service that does not run waits again; a running one is left be", async () => {
      files = { "p/app.md": service("App", "project: p\nstart: project-first-open\n"), "p/later.md": service("Later", "project: p\nstart: project-first-open\nenabled: false\n") };
      load();
      await firstOpen("p");
      await at(0);
      expect(status("p/app").state).toBe("starting");
      opened = new Set();
      files["p/later.md"] = service("Later", "project: p\nstart: project-first-open\n");
      load();
      await at(10_000);
      expect(states()).toEqual({ "p/app": "running", "p/later": "waiting" });
      expect(sessions.spawned.map((spawn) => spawn.job)).toEqual(["p/app"]);
    });

    it("does nothing while the sessions do not follow the keeper, or with no workspace", async () => {
      files = { "web.md": service("Web") };
      load();
      sessions.following = false;
      await at(0);
      expect(sessions.spawned).toHaveLength(0);
      sessions.following = true;
      workspace = null;
      load();
      await at(1000);
      expect(sessions.spawned).toHaveLength(0);
      expect(supervisor.report().services).toEqual([]);
      workspace = WS;
      load();
      await at(2000);
      expect(sessions.spawned).toHaveLength(1);
    });
  });

  describe("services that run with Pomade", () => {
    /** Pomade quit, as the scheduler tells it: closed, nothing opened, the start over. */
    async function quit(): Promise<void> {
      pomade = "closed";
      opened = new Set();
      await supervisor.pomadeEnded();
    }

    it("a pomade-started service waits for Pomade, starts while it runs, stops when it quits and is not started again; Start is refused while Pomade is closed", async () => {
      pomade = "unsure";
      files = { "watch.md": service("Watch", "start: pomade-started\n"), "web.md": service("Web") };
      load();
      await at(0);
      expect(states()).toEqual({ watch: "waiting-for-pomade", web: "starting" });
      expect(await supervisor.start("watch")).toEqual({ ok: false, reason: `"Watch" ${NOT_WITH_POMADE}` });
      pomade = "running";
      await at(ALIVE_MS);
      await at(2 * ALIVE_MS);
      expect(states()).toEqual({ watch: "running", web: "running" });

      await quit();
      expect(sessions.stops).toEqual([{ id: "svc:watch", reason: "stopped" }]);
      await at(2 * ALIVE_MS + 1000);
      await at(60_000);
      expect(states()).toEqual({ watch: "waiting-for-pomade", web: "running" });
      expect(sessions.starts("watch")).toBe(1);
      expect(await supervisor.start("Watch")).toEqual({ ok: false, reason: `"Watch" ${NOT_WITH_POMADE}` });
      expect(await supervisor.chainAction("watch", "start", "after x")).toEqual({ result: "skipped", reason: NOT_WITH_POMADE });

      // The next Pomade start starts it again.
      pomade = "running";
      await at(61_000);
      expect(sessions.starts("watch")).toBe(2);
    });

    it("a first-open service waits for Pomade while it is closed; with Pomade running, Start before its project's open runs it until Pomade quits", async () => {
      pomade = "closed";
      files = { "p/app.md": service("App", "project: p\nstart: project-first-open\n") };
      load();
      await at(0);
      expect(status("p/app").state).toBe("waiting-for-pomade");
      expect(await supervisor.start("p/app")).toMatchObject({ ok: false });
      pomade = "running";
      await at(1000);
      expect(status("p/app").state).toBe("waiting");
      expect(await supervisor.start("p/app")).toMatchObject({ ok: true, service: { state: "starting" } });
      await quit();
      await at(2000);
      await at(3000);
      expect(status("p/app").state).toBe("waiting-for-pomade");
      expect(sessions.starts("p/app")).toBe(1);
    });

    it("a Pomade quit clears stopped by you, failed and the crash counts of the bound services; a login service keeps stopped by you and runs on", async () => {
      files = {
        "p/app.md": service("App", "project: p\nstart: project-first-open\n"),
        "watch.md": service("Watch", "start: pomade-started\n"),
        "db.md": service("Db"),
        "web.md": service("Web"),
      };
      load();
      await firstOpen("p");
      for (let t = 0; t <= 4 * ALIVE_MS; t += ALIVE_MS) await at(t);
      expect(states()).toEqual({ db: "running", "p/app": "running", watch: "running", web: "running" });
      await supervisor.stop("p/app");
      await supervisor.stop("db");
      // Watch crashes into a loop: failed.
      let t = 4 * ALIVE_MS + 1000;
      for (let crash = 1; crash <= 5; crash++) {
        now = T0 + t;
        sessions.end("watch", "crashed");
        await at(t);
        if (crash < 5) {
          t = (status("watch").retryAt ?? 0) - T0;
          await at(t);
        }
      }
      expect(states()).toEqual({ db: "stopped-by-you", "p/app": "stopped-by-you", watch: "failed", web: "running" });

      await quit();
      await at(t + 1000);
      expect(states()).toEqual({ db: "stopped-by-you", "p/app": "waiting-for-pomade", watch: "waiting-for-pomade", web: "running" });
      expect(store.saved.get("watch")).toMatchObject({ hold: null, restarts: 0, crashes: [], lastCrashAt: null, retryAt: null });
      expect(store.saved.get("p/app")?.hold).toBeNull();
      expect(store.saved.get("db")?.hold).toBe("stopped-by-you");

      // Pomade starts again: each waits for its trigger, then starts; Db stays stopped until Start.
      pomade = "running";
      await at(t + 2000);
      expect(states()).toMatchObject({ "p/app": "waiting", watch: "starting", db: "stopped-by-you" });
      await firstOpen("p");
      await at(t + 2000 + ALIVE_MS);
      expect(states()).toMatchObject({ "p/app": "starting", db: "stopped-by-you" });
      expect(sessions.starts("db")).toBe(1);
    });

    it("a scheduler that finds Pomade closed stops a bound service left running; one that is unsure, or finds Pomade running, stops nothing", async () => {
      files = { "watch.md": service("Watch", "start: pomade-started\n"), "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
      await at(2 * ALIVE_MS);
      await supervisor.close();

      // Restarted while Pomade runs, then while it is not known yet: nothing stops, nothing starts again.
      await open();
      await at(2 * ALIVE_MS + 1000);
      pomade = "unsure";
      await at(2 * ALIVE_MS + 2000);
      expect(sessions.stops).toEqual([]);
      expect(states()).toEqual({ watch: "running", web: "running" });
      await supervisor.close();

      // Restarted, and Pomade found closed.
      await open();
      pomade = "closed";
      await at(2 * ALIVE_MS + 3000);
      expect(sessions.stops).toEqual([{ id: "svc:watch", reason: "stopped" }]);
      await at(2 * ALIVE_MS + 4000);
      expect(states()).toEqual({ watch: "waiting-for-pomade", web: "running" });
      expect(lines).toContain("service watch: it runs with Pomade, and Pomade is not running; stopping it");
    });

    it("a Stop that ends after Pomade quit holds nothing", async () => {
      files = { "watch.md": service("Watch", "start: pomade-started\n") };
      load();
      await at(0);
      // FakeSessions ends a stopped session on the next refresh: Pomade quits before then.
      await supervisor.stop("watch");
      await quit();
      await at(1000);
      expect(status("watch").state).toBe("waiting-for-pomade");
      pomade = "running";
      await at(2000);
      expect(sessions.starts("watch")).toBe(2);
    });
  });

  describe("Enabled off and on", () => {
    it("turning a service off clears stopped by you and failed, in every start mode; turned on, it follows its trigger", async () => {
      files = {
        "p/app.md": service("App", "project: p\nstart: project-first-open\n"),
        "q/doc.md": service("Doc", "project: q\nstart: project-first-open\n"),
        "db.md": service("Db"),
      };
      load();
      await at(0);
      expect(await supervisor.start("p/app")).toMatchObject({ ok: true });
      expect(await supervisor.start("q/doc")).toMatchObject({ ok: true });
      await at(ALIVE_MS);
      for (const job of ["p/app", "q/doc", "db"]) await supervisor.stop(job);
      await at(ALIVE_MS + 1000);
      expect(states()).toEqual({ db: "stopped-by-you", "p/app": "stopped-by-you", "q/doc": "stopped-by-you" });
      await firstOpen("p");
      expect(status("p/app").state).toBe("stopped-by-you");

      const off = (file: string): string => file.replace("---\nkind", "---\nenabled: false\nkind");
      const on = { ...files };
      files = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, off(text)]));
      load();
      await at(ALIVE_MS + 2000);
      expect(states()).toEqual({ db: "disabled", "p/app": "disabled", "q/doc": "disabled" });
      expect([...store.saved.values()].map((record) => record.hold)).toEqual([null, null, null]);

      // On again: a login one and one whose project was opened start; one whose project was not waits for it.
      files = on;
      load();
      await at(ALIVE_MS + 3000);
      expect(states()).toMatchObject({ db: "starting", "p/app": "queued", "q/doc": "waiting" });
      for (let t = 2 * ALIVE_MS + 3000; t <= 3 * ALIVE_MS + 3000; t += ALIVE_MS) await at(t);
      expect(sessions.starts("p/app")).toBe(2);
      await firstOpen("q");
      await at(4 * ALIVE_MS + 3000);
      expect(sessions.starts("q/doc")).toBe(2);
    });
  });

  describe("Enabled off and on, Stop not yet ended", () => {
    it("a Stop whose end is heard after the service was turned off holds nothing", async () => {
      files = { "db.md": service("Db") };
      load();
      await at(0);
      await at(ALIVE_MS);
      // FakeSessions ends a stopped session on the next refresh: turn it off before then.
      await supervisor.stop("db");
      files = { "db.md": service("Db", "enabled: false\n") };
      load();
      await supervisor.tick();
      await at(ALIVE_MS + 1000);
      expect(status("db").state).toBe("disabled");
      files = { "db.md": service("Db") };
      load();
      await at(ALIVE_MS + 2000);
      expect(sessions.starts("db")).toBe(2);
    });
  });

  describe("a restarted scheduler", () => {
    it("reattaches running services and never restarts them; one that was not up yet is up 5 s after its own start", async () => {
      files = { "a.md": service("A"), "b.md": service("B") };
      load();
      await at(0);
      await at(ALIVE_MS);
      expect(sessions.spawned).toHaveLength(2);
      await supervisor.close();

      await open();
      await at(ALIVE_MS + 1000);
      expect(sessions.spawned).toHaveLength(2);
      expect(states()).toEqual({ a: "running", b: "starting" });
      await at(2 * ALIVE_MS);
      expect(states()).toEqual({ a: "running", b: "running" });
      expect(sessions.stops).toEqual([]);
    });

    it("keeps holds, crash counts and a restart due across a restart", async () => {
      files = { "a.md": service("A"), "b.md": service("B") };
      load();
      await at(0);
      await at(ALIVE_MS);
      sessions.end("a", "stopped-by-you", 130);
      sessions.end("b", "crashed");
      await at(ALIVE_MS + 100);
      await supervisor.close();

      await open();
      await at(ALIVE_MS + 200);
      expect(states()).toEqual({ a: "stopped-by-you", b: "restarting" });
      await at(ALIVE_MS + BACKOFF_MS[0]!);
      expect(sessions.starts("b")).toBe(2);
      expect(status("b")).toMatchObject({ restarts: 1, lastCrashAt: T0 + ALIVE_MS });
      expect(sessions.starts("a")).toBe(1);
    });
  });

  describe("crashes", () => {
    beforeEach(async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
    });

    it("kill -9 → restarting after 1 s, then running: restarted 1×, with the crash's time", async () => {
      now = T0 + 60_000;
      sessions.end("web", "crashed", 137);
      await at(60_000);
      expect(status("web")).toMatchObject({ state: "restarting", restarts: 0, lastCrashAt: T0 + 60_000, retryAt: T0 + 61_000 });
      await at(60_999);
      expect(sessions.starts("web")).toBe(1);
      await at(61_000);
      expect(sessions.starts("web")).toBe(2);
      expect(status("web")).toMatchObject({ state: "starting", restarts: 1, lastCrashAt: T0 + 60_000, retryAt: null });
      expect(lines).toEqual(expect.arrayContaining(["service web: crashed; restarting in 1 s", "service web: restarted (1×)"]));
    });

    it("an exit with status 0 is a crash too: a service is meant to stay up", async () => {
      now = T0 + 60_000;
      sessions.end("web", "exited");
      await at(60_000);
      expect(status("web")).toMatchObject({ state: "restarting", lastCrashAt: T0 + 60_000 });
      expect(lines).toContain("service web: exited on its own; restarting in 1 s");
    });

    it("backs off 1 s, 2 s, 5 s, 10 s, 30 s, then 60 s on every further crash", async () => {
      const waits: number[] = [];
      let t = 60_000;
      for (let crash = 0; crash < BACKOFF_MS.length + 2; crash++) {
        // Each crash after 2 minutes up: never a loop, never 10 minutes.
        now = T0 + t;
        sessions.end("web", "crashed");
        await at(t);
        const { retryAt } = status("web");
        waits.push((retryAt ?? 0) - (T0 + t));
        t = (retryAt ?? 0) - T0;
        await at(t);
        t += 120_000;
        await at(t);
      }
      expect(waits).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000, 60_000]);
      expect(status("web").restarts).toBe(8);
    });

    it("5 crashes within a minute → failed: no more restarts, kept across a restart, until Start", async () => {
      let t = 60_000;
      for (let crash = 1; crash <= 5; crash++) {
        now = T0 + t;
        sessions.end("web", "crashed");
        await at(t);
        const { retryAt } = status("web");
        if (crash < 5) {
          t = (retryAt ?? 0) - T0;
          await at(t);
        }
      }
      expect(status("web")).toMatchObject({ state: "failed", restarts: 4, retryAt: null });
      expect(sessions.starts("web")).toBe(5);
      expect(lines).toContain("service web: crashed; failed — 5 crashes within a minute, no restarts until Start");
      await at(t + 10 * 60_000);
      expect(sessions.starts("web")).toBe(5);

      await supervisor.close();
      await open();
      await at(t + 11 * 60_000);
      expect(status("web").state).toBe("failed");
      expect(sessions.starts("web")).toBe(5);

      expect(await supervisor.start("web")).toMatchObject({ ok: true, service: { state: "starting", restarts: 0, lastCrashAt: null } });
      expect(sessions.starts("web")).toBe(6);
      // The crash window starts afresh: one crash is one crash.
      now = T0 + t + 11 * 60_000 + 100;
      sessions.end("web", "crashed");
      await at(t + 11 * 60_000 + 100);
      expect(status("web").state).toBe("restarting");
    });

    it("crashes spread over more than a minute are no loop", async () => {
      let t = 60_000;
      for (let crash = 1; crash <= 6; crash++) {
        now = T0 + t;
        sessions.end("web", "crashed");
        await at(t);
        t = (status("web").retryAt ?? 0) - T0;
        await at(t);
        t += 20_000;
        await at(t);
      }
      expect(status("web").state).toBe("running");
      expect(status("web").restarts).toBe(6);
    });

    it("the count and the last crash reset after 10 minutes up", async () => {
      now = T0 + 60_000;
      sessions.end("web", "crashed");
      await at(60_000);
      await at(61_000);
      await at(61_000 + ALIVE_MS);
      expect(status("web")).toMatchObject({ state: "running", restarts: 1 });
      await at(61_000 + RESET_UPTIME_MS - 1);
      expect(status("web").restarts).toBe(1);
      await at(61_000 + RESET_UPTIME_MS);
      expect(status("web")).toMatchObject({ restarts: 0, lastCrashAt: null });
      expect(store.saved.get("web")).toMatchObject({ restarts: 0, lastCrashAt: null, crashes: [] });
    });

    it("a session lost with a keeper crash starts again at once and is not counted", async () => {
      now = T0 + 60_000;
      sessions.end("web", "lost-in-keeper-crash", null);
      await at(60_000);
      expect(sessions.starts("web")).toBe(2);
      expect(status("web")).toMatchObject({ restarts: 0, lastCrashAt: null });
      expect(store.saved.get("web")?.crashes ?? []).toEqual([]);
    });

    it("a start the keeper refuses is a crash: back-off, then failed", async () => {
      sessions.refuse = "no such folder";
      now = T0 + 60_000;
      sessions.end("web", "crashed");
      await at(60_000);
      let t = 60_000;
      for (let i = 0; i < 10 && status("web").state !== "failed"; i++) {
        t = (status("web").retryAt ?? 0) - T0;
        await at(t);
      }
      expect(status("web")).toMatchObject({ state: "failed", problem: "no such folder" });
      expect(lines).toContain("service web: cannot start — no such folder; failed — 5 crashes within a minute, no restarts until Start");
      sessions.refuse = null;
      expect(await supervisor.start("web")).toMatchObject({ ok: true, service: { state: "starting", problem: null } });
    });
  });

  describe("stopped by you", () => {
    beforeEach(async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
    });

    it("Ctrl+C → stopped by you: no restart, ever; Start brings it back", async () => {
      sessions.end("web", "stopped-by-you", 130);
      await at(10_000);
      await at(30 * 60_000);
      expect(status("web").state).toBe("stopped-by-you");
      expect(sessions.starts("web")).toBe(1);
      expect(lines).toContain("service web: stopped by you; it stays stopped until Start");
      expect(await supervisor.start("Web")).toMatchObject({ ok: true, service: { job: "web", state: "starting" } });
      expect(sessions.starts("web")).toBe(2);
    });

    it("Stop stops it as stopped by you; a restart due is called off", async () => {
      expect(await supervisor.stop("web")).toMatchObject({ ok: true, service: { state: "stopped-by-you" } });
      expect(sessions.stops).toEqual([{ id: "svc:web", reason: "stopped-by-you" }]);
      await at(6000);
      expect(status("web").state).toBe("stopped-by-you");
      await supervisor.start("web");
      now = T0 + 7000;
      sessions.end("web", "crashed");
      await at(7000);
      expect(status("web").state).toBe("restarting");
      await supervisor.stop("web");
      await at(20_000);
      expect(status("web").state).toBe("stopped-by-you");
      expect(sessions.starts("web")).toBe(2);
    });
  });

  describe("the attached tab's header actions", () => {
    it("Restart while it runs; Start once it ended — stopped by you, failed, between crashes; Restart again after Start", async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      expect(sessions.actions("web")).toEqual(["restart"]);
      sessions.end("web", "stopped-by-you", 130);
      await at(1000);
      expect(sessions.actions("web")).toEqual(["start"]);
      await supervisor.start("web");
      await at(2000);
      expect(sessions.actions("web")).toEqual(["restart"]);
      now = T0 + 3000;
      sessions.end("web", "crashed");
      await at(3000);
      expect(status("web").state).toBe("restarting");
      expect(sessions.actions("web")).toEqual(["start"]);
    });

    it("none on an ended session whose service is disabled or invalid: Start would be refused", async () => {
      files = { "web.md": service("Web"), "api.md": service("Api") };
      load();
      await at(0);
      await at(ALIVE_MS);
      files = { "web.md": service("Web", "enabled: false\n"), "api.md": "---\nkind: service\nname: Api\n---\n" };
      load();
      sessions.end("api", "stopped-by-you", 130);
      await at(ALIVE_MS + 1000);
      await at(ALIVE_MS + 5000);
      expect(states()).toMatchObject({ web: "disabled", api: "invalid" });
      expect(sessions.actions("web")).toEqual([]);
      expect(sessions.actions("api")).toEqual([]);
    });
  });

  describe("Start and Restart", () => {
    beforeEach(async () => {
      files = { "web.md": service("Web"), "off.md": service("Off", "enabled: false\n"), "job.md": "---\nkind: script\nname: Job\nfolder: .\ncommand: ./j.sh\nhook: { event: project-created }\n---\n", "bad.md": "---\nkind: service\n---\n" };
      load();
      await at(0);
    });

    it("refuses what it cannot start, saying why", async () => {
      expect(await supervisor.start("web")).toEqual({ ok: false, reason: '"Web" is running' });
      expect(await supervisor.start("off")).toEqual({ ok: false, reason: '"Off" is disabled in its file; enable it first' });
      expect(await supervisor.restart("off")).toEqual({ ok: false, reason: '"Off" is disabled in its file; enable it first' });
      expect(await supervisor.start("job")).toEqual({ ok: false, reason: '"job" is a script job, not a service' });
      expect(await supervisor.start("nope")).toEqual({ ok: false, reason: 'no job "nope"' });
      expect(await supervisor.start("bad")).toMatchObject({ ok: false, reason: expect.stringContaining('the job "bad" is invalid') as string });
      expect(await supervisor.stop("nope")).toEqual({ ok: false, reason: 'no service "nope"' });
    });

    it("Restart restarts a running service with its file as it is now, keeping the crash count", async () => {
      now = T0 + 60_000;
      sessions.end("web", "crashed");
      await at(60_000);
      await at(61_000);
      files["web.md"] = service("Web").replace("./web.sh", "./web2.sh");
      load();
      expect(status("web").needsRestart).toBe(true);
      expect(await supervisor.restart("web")).toMatchObject({ ok: true, service: { state: "starting", restarts: 1, needsRestart: false } });
      expect(sessions.restarted).toEqual(["web"]);
      expect(sessions.spawned.at(-1)?.command.command).toBe("./web2.sh");
      await at(62_000);
      expect(status("web").state).toBe("starting");
      expect(sessions.starts("web")).toBe(3);
    });

    it("Restart starts a service that does not run, stopped by you included", async () => {
      await supervisor.stop("web");
      await at(1000);
      expect(await supervisor.restart("web")).toMatchObject({ ok: true, service: { state: "starting" } });
      expect(sessions.restarted).toEqual([]);
      expect(sessions.starts("web")).toBe(2);
    });

    it("says why the keeper refused a start", async () => {
      await supervisor.stop("web");
      await at(1000);
      sessions.refuse = "the keeper is not connected (connecting)";
      expect(await supervisor.start("web")).toEqual({ ok: false, reason: "the keeper is not connected (connecting)" });
      expect(status("web")).toMatchObject({ state: "stopped-by-you", problem: "the keeper is not connected (connecting)" });
    });
  });

  describe("a chain's action", () => {
    const why = "chain: after Pull";

    beforeEach(async () => {
      files = { "web.md": service("Web"), "off.md": service("Off", "enabled: false\n"), "one/later.md": service("Later", "start: project-first-open\nproject: p1\n"), "bad.md": "---\nkind: service\n---\n" };
      load();
      await at(0);
      await at(ALIVE_MS);
    });

    it("restart restarts a running service with its file as it is now", async () => {
      files["web.md"] = service("Web").replace("./web.sh", "./web2.sh");
      load();
      // It says which session it ended and which it started, for the runs' record; it writes none itself.
      now = T0 + ALIVE_MS + 1;
      expect(await supervisor.chainAction("web", "restart", why)).toEqual({ result: "done", session: T0 + ALIVE_MS + 1, ended: T0 });
      expect(events.filter((event) => event.event?.cause !== "login")).toEqual([]);
      expect(sessions.restarted).toEqual(["web"]);
      expect(sessions.spawned.at(-1)?.command.command).toBe("./web2.sh");
      expect(lines).toContain("service web: Restart — chain: after Pull");
    });

    it("restart skips a service that is not running — stopped by you, waiting — and leaves it as it is", async () => {
      await supervisor.stop("web");
      await at(ALIVE_MS + 1000);
      expect(await supervisor.chainAction("web", "restart", why)).toEqual({ result: "skipped", reason: "it is not running" });
      expect(await supervisor.chainAction("one/later", "restart", why)).toEqual({ result: "skipped", reason: "it is not running" });
      expect(states()).toMatchObject({ web: "stopped-by-you", "one/later": "waiting" });
      expect(sessions.restarted).toEqual([]);
    });

    it("start starts a service that is not running, clearing a hold as Start does; it skips a running one", async () => {
      expect(await supervisor.chainAction("web", "start", why)).toEqual({ result: "skipped", reason: "it is running already" });
      await supervisor.stop("web");
      await at(ALIVE_MS + 1000);
      expect(await supervisor.chainAction("web", "start", why)).toEqual({ result: "done", session: T0 + ALIVE_MS + 1000, ended: null });
      expect(await supervisor.chainAction("one/later", "start", why)).toEqual({ result: "done", session: T0 + ALIVE_MS + 1000, ended: null });
      expect(states()).toMatchObject({ web: "starting", "one/later": "starting" });
    });

    it("stop stops it as Stop does: it stays stopped until Start", async () => {
      expect(await supervisor.chainAction("web", "stop", why)).toEqual({ result: "done", session: null, ended: T0 });
      expect(sessions.stops).toEqual([{ id: "svc:web", reason: "stopped-by-you" }]);
      await at(60_000);
      // The stop's end, heard later, is the chain's: no "stopped · you".
      expect(events.map((event) => event.event?.what)).toEqual(["started"]);
      expect(status("web").state).toBe("stopped-by-you");
    });

    it("skips a disabled, invalid, unknown or non-service job, and fails when the keeper refuses", async () => {
      expect(await supervisor.chainAction("off", "restart", why)).toEqual({ result: "skipped", reason: "its job is disabled" });
      expect(await supervisor.chainAction("bad", "start", why)).toMatchObject({ result: "skipped", reason: expect.stringContaining('the job "bad" is invalid') as string });
      expect(await supervisor.chainAction("gone", "start", why)).toEqual({ result: "skipped", reason: 'no job "gone"' });
      await supervisor.stop("web");
      await at(ALIVE_MS + 1000);
      sessions.refuse = "no such folder";
      expect(await supervisor.chainAction("web", "start", why)).toEqual({ result: "failed", reason: "no such folder" });
    });
  });

  describe("job file changes", () => {
    beforeEach(async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
    });

    it("disabling a running service stops it, once; enabling it starts it again", async () => {
      files["web.md"] = service("Web", "enabled: false\n");
      load();
      await at(6000);
      expect(sessions.stops).toEqual([{ id: "svc:web", reason: "stopped" }]);
      expect(lines).toContain("service web: disabled in its file; stopping it");
      await at(7000);
      await at(8000);
      expect(sessions.stops).toHaveLength(1);
      expect(status("web")).toMatchObject({ state: "disabled", session: { info: { state: "exited" } } });
      files["web.md"] = service("Web");
      load();
      await at(9000);
      expect(sessions.starts("web")).toBe(2);
    });

    it("editing its command or folder flags it for a restart and leaves it running", async () => {
      files["web.md"] = service("Web").replace("folder: .", "folder: Projects/web");
      load();
      await at(6000);
      expect(status("web")).toMatchObject({ state: "running", needsRestart: true });
      expect(sessions.stops).toEqual([]);
      files["web.md"] = service("Web");
      load();
      expect(status("web").needsRestart).toBe(false);
    });

    it("an invalid file leaves its running service alone and starts nothing", async () => {
      files["web.md"] = "---\nkind: service\nname: Web\nfolder: .\n---\n";
      load();
      await at(6000);
      expect(status("web")).toMatchObject({ state: "invalid", name: "Web", session: { info: { state: "running" } } });
      sessions.end("web", "crashed");
      await at(20_000);
      expect(sessions.starts("web")).toBe(1);
      expect(sessions.stops).toEqual([]);
    });

    it("deleting the file stops the service after a grace period, then forgets it and its records", async () => {
      await supervisor.stop("web");
      await at(5500);
      await supervisor.start("web");
      expect(store.saved.has("web")).toBe(true);
      delete files["web.md"];
      load();
      await at(6000);
      expect(status("web").state).toBe("removed");
      expect(sessions.stops.filter((stop) => stop.reason === "stopped")).toEqual([]);
      await at(6000 + REMOVED_GRACE_MS);
      expect(sessions.stops.at(-1)).toEqual({ id: "svc:web", reason: "stopped" });
      expect(lines).toContain("service web: its file is gone; stopping it");
      await at(6000 + 2 * REMOVED_GRACE_MS);
      expect(sessions.forgotten).toEqual(["svc:web"]);
      await at(6000 + 3 * REMOVED_GRACE_MS);
      expect(supervisor.report().services).toEqual([]);
      expect(store.saved.has("web")).toBe(false);
    });

    it("a file deleted and written again within the grace period keeps its service and its hold", async () => {
      await supervisor.stop("web");
      await at(6000);
      delete files["web.md"];
      load();
      await at(7000);
      files["web.md"] = service("Web");
      load();
      await at(7000 + REMOVED_GRACE_MS);
      await at(7000 + 3 * REMOVED_GRACE_MS);
      expect(status("web").state).toBe("stopped-by-you");
      expect(sessions.forgotten).toEqual([]);
    });
  });

  describe("one timebase: the scheduler's clock, whatever the system clock says", () => {
    for (const [what, days] of [
      ["the system clock ahead (a test clock set in the past)", 2],
      ["the system clock behind (a test clock set in the future)", -2],
    ] as const) {
      it(`${what}: up after 5 s, a crash restarts after 1 s, 10 minutes up reset the count — on the scheduler's clock`, async () => {
        skew = days * 86_400_000;
        files = { "web.md": service("Web") };
        load();
        await at(0);
        await at(ALIVE_MS - 1);
        expect(status("web").state).toBe("starting");
        await at(ALIVE_MS);
        expect(status("web").state).toBe("running");

        now = T0 + 60_000;
        sessions.end("web", "crashed", 137);
        await at(60_000);
        expect(status("web")).toMatchObject({ state: "restarting", lastCrashAt: T0 + 60_000, retryAt: T0 + 61_000 });
        await at(61_000);
        expect(sessions.starts("web")).toBe(2);
        await at(61_000 + ALIVE_MS);
        expect(status("web")).toMatchObject({ state: "running", restarts: 1 });
        await at(61_000 + RESET_UPTIME_MS - 1);
        expect(status("web").restarts).toBe(1);
        await at(61_000 + RESET_UPTIME_MS);
        expect(status("web")).toMatchObject({ state: "running", restarts: 0, lastCrashAt: null });
      });
    }

    it("a session found running takes its age from the system clock: a restarted scheduler finds it up at once", async () => {
      skew = 2 * 86_400_000;
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
      await supervisor.close();
      now = T0 + 60_000;
      await open();
      await tick();
      expect(status("web").state).toBe("running");
      expect(sessions.starts("web")).toBe(1);
    });
  });

  describe("service events", () => {
    /** Each event as History has it: what, cause, its words and its row's id. */
    const said = (): [string, string, string, string][] => events.map((record) => [record.job, record.event?.what ?? "", record.event?.cause ?? "", runWords(record)]);
    /** Crash `job` at `t` ms with `code`, then tick through its back-off to its restart. */
    async function crash(job: string, t: number, code: number): Promise<number> {
      now = T0 + t;
      sessions.end(job, "crashed", code);
      await at(t);
      const { retryAt } = status(job);
      if (retryAt === null) return t;
      const back = retryAt - T0;
      await at(back);
      return back;
    }

    it("a Mac login starts every always-on service with one event each: started · Mac startup; a file made later starts as its job file's", async () => {
      files = { "a.md": service("A"), "b.md": service("B") };
      load();
      await at(0);
      await at(ALIVE_MS);
      expect(said()).toEqual([
        ["a", "started", "login", "started"],
        ["b", "started", "login", "started"],
      ]);
      expect(events[0]).toMatchObject({ kind: "service", name: "A", state: "done", trigger: "manual", startedAt: null, durationMs: null, dueAt: T0, event: { session: T0, ended: [] } });
      files = { ...files, "c.md": service("C") };
      load();
      await at(2 * ALIVE_MS);
      expect(said().at(-1)).toEqual(["c", "started", "job-file", "started"]);
      expect(events.at(-1)?.event?.detail).toBe("created");
    });

    it("a restarted scheduler that finds its services running writes nothing", async () => {
      files = { "a.md": service("A") };
      load();
      await at(0);
      await supervisor.close();
      events = [];
      await open();
      await at(ALIVE_MS);
      expect(events).toEqual([]);
    });

    it("Start, Stop and Restart each leave one event by you; Ctrl+C in its tab is a stop by you in its tab", async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
      events = [];
      now = T0 + 10_000;
      await supervisor.stop("web");
      await at(10_100);
      await supervisor.start("web");
      now = T0 + 20_000;
      await supervisor.restart("web");
      await at(20_100);
      sessions.end("web", "stopped-by-you", 130);
      await at(20_200);
      expect(said()).toEqual([
        ["web", "stopped", "you", "stopped"],
        ["web", "started", "you", "started"],
        ["web", "restarted", "you", "restarted"],
        ["web", "stopped", "you", "stopped"],
      ]);
      expect(events.map((record) => [record.event?.detail, record.event?.session, record.event?.ended])).toEqual([
        [null, null, [T0]],
        [null, T0 + 10_100, []],
        [null, T0 + 20_000, [T0 + 10_100]],
        ["tab", null, [T0 + 20_000]],
      ]);
    });

    it("four crashes in one window are one row, updated as they add up, with each distinct exit; the fifth gives up in a row of its own", async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
      events = [];
      let t = 60_000;
      const codes = [1, 137, 1, 1, 1];
      t = await crash("web", t, codes[0]!);
      expect(said()).toEqual([["web", "restarted", "crash", "restarted · exit 1"]]);
      const row = events[0]?.run;
      for (const code of codes.slice(1, 4)) t = await crash("web", t + 100, code);
      expect(said()).toEqual([["web", "restarted", "crash", "restarted 4× · exit 1, 137"]]);
      expect(events[0]).toMatchObject({ run: row, dueAt: T0 + 61_000, endedAt: T0 + t, exitCode: 1, event: { restarts: 4, ends: [{ code: 1, signal: null }, { code: 137, signal: null }] } });
      expect(events[0]?.event?.ended).toHaveLength(4);
      t = await crash("web", t + 100, 2);
      expect(status("web").state).toBe("failed");
      expect(said()).toEqual([
        ["web", "restarted", "crash", "restarted 4× · exit 1, 137"],
        ["web", "gave-up", "crash", "gave up after 5 crashes"],
      ]);
      expect(events[1]).toMatchObject({ state: "failed", exitCode: 2, event: { ended: [events[0]?.event?.session] } });

      // Start after giving up: a start by you, and a new window for the next crash.
      await supervisor.start("web");
      await crash("web", t + 120_000, 3);
      expect(said().slice(2)).toEqual([
        ["web", "started", "you", "started"],
        ["web", "restarted", "crash", "restarted · exit 3"],
      ]);
      expect(events[3]?.run).not.toBe(row);
    });

    it("a scheduler restarted mid-window goes on updating the window's row", async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
      events = [];
      const t = await crash("web", 60_000, 1);
      await supervisor.close();
      await open();
      await crash("web", t + 100, 1);
      expect(said()).toEqual([["web", "restarted", "crash", "restarted 2× · exit 1"]]);
    });

    it("10 minutes up ends the window: the next crash starts a new row", async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      await at(ALIVE_MS);
      events = [];
      let t = await crash("web", 60_000, 1);
      await at(t + ALIVE_MS);
      t += RESET_UPTIME_MS + ALIVE_MS;
      await at(t);
      await crash("web", t + 1000, 1);
      expect(said()).toEqual([
        ["web", "restarted", "crash", "restarted · exit 1"],
        ["web", "restarted", "crash", "restarted · exit 1"],
      ]);
      expect(events[0]?.run).not.toBe(events[1]?.run);
    });

    it("Pomade's start, a project's first open and Pomade's quit are the causes of a Pomade-bound service's start and stop", async () => {
      pomade = "unsure";
      files = { "watch.md": service("Watch", "start: pomade-started\n"), "docs.md": service("Docs", "start: project-first-open\nstart-project: blog\n") };
      load();
      await at(0);
      expect(events).toEqual([]);
      pomade = "running";
      await at(1000);
      await firstOpen("blog");
      await at(1000 + ALIVE_MS);
      await at(1000 + 2 * ALIVE_MS);
      pomade = "closed";
      opened = new Set();
      await supervisor.pomadeEnded();
      expect(said()).toEqual([
        ["watch", "started", "pomade-started", "started"],
        ["docs", "started", "first-open", "started"],
        ["docs", "stopped", "pomade-quit", "stopped"],
        ["watch", "stopped", "pomade-quit", "stopped"],
      ]);
      expect(events[1]?.event?.detail).toBe("Blog");
    });

    it("turned off in its file, it stops as its job file's; a session the keeper lost starts again as a restart", async () => {
      files = { "web.md": service("Web"), "api.md": service("Api") };
      load();
      await at(0);
      await at(ALIVE_MS);
      await at(2 * ALIVE_MS);
      events = [];
      files = { ...files, "web.md": service("Web", "enabled: false\n") };
      load();
      await at(2 * ALIVE_MS + 100);
      sessions.end("api", "lost-in-keeper-crash", null);
      await at(2 * ALIVE_MS + 200);
      expect(said()).toEqual([
        ["web", "stopped", "job-file", "stopped"],
        ["api", "restarted", "keeper", "restarted"],
      ]);
      expect(events.map((record) => record.event?.detail)).toEqual(["disabled", null]);
      expect(events[1]?.event?.ended).toEqual([T0]);
    });
  });

  describe("the report", () => {
    it("is published when it changes, and only then", async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      const count = reports.length;
      await at(100);
      expect(reports).toHaveLength(count);
      await at(ALIVE_MS);
      expect(reports.length).toBe(count + 1);
      expect(reports.at(-1)?.services[0]).toMatchObject({ job: "web", state: "running" });
    });

    it("carries the keeper's link and each service's session", async () => {
      files = { "web.md": service("Web") };
      load();
      await at(0);
      expect(supervisor.report()).toMatchObject({
        keeper: { state: "connected" },
        services: [{ job: "web", name: "Web", project: null, state: "starting", session: { id: "svc:web", job: "web" }, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null }],
      });
    });
  });
});

describe("the records on disk", () => {
  let dir: string;
  let state: StateFolder;
  let records: RecordsFolder;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prsv-"));
    state = stateFolderOf(join(dir, "ud"));
    records = recordsFolderOf(join(dir, "ws"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));

  it("keep this Mac's crash counts in the state folder and the services you stopped in the workspace, and read both back", async () => {
    const store = fileStore(state, records, () => undefined);
    expect(await store.load()).toEqual(new Map());
    const failed: SupervisionRecord = { hold: "failed", restarts: 4, lastCrashAt: 5, crashes: [1, 2, 3, 4, 5], retryAt: null, problem: "p", window: { run: "20261117-080000-abcdef", at: 2, restarts: 4, ends: [{ code: 1, signal: null }, { code: null, signal: "SIGKILL" }], last: { code: 1, signal: null }, ended: [1, 2, 3, 4], session: 5 } };
    const stopped: SupervisionRecord = { hold: "stopped-by-you", restarts: 1, lastCrashAt: 3, crashes: [3], retryAt: null, problem: null, window: null };
    store.save(new Map([["blog/web", failed], ["api", stopped]]));
    await store.flush();
    expect(await read(join(dir, "ud/app-state/pomade-runner/services.json"))).toEqual({ services: { "blog/web": failed, api: { ...stopped, hold: null } } });
    expect(await read(join(dir, "ws/Apps/pomade-runner/records/services.json"))).toEqual({ stoppedByYou: ["api"] });
    expect(await fileStore(state, records, () => undefined).load()).toEqual(new Map([["blog/web", failed], ["api", stopped]]));
  });

  it("carry the services you stopped to a Mac that has no crash counts for them, and only those", async () => {
    const first = fileStore(stateFolderOf(join(dir, "mac-a")), records, () => undefined);
    first.save(new Map([["api", { hold: "stopped-by-you", restarts: 0, lastCrashAt: null, crashes: [], retryAt: null, problem: null, window: null }], ["web", { hold: "failed", restarts: 5, lastCrashAt: 9, crashes: [9], retryAt: null, problem: null, window: null }]]));
    await first.flush();
    expect(await fileStore(state, records, () => undefined).load()).toEqual(new Map([["api", { hold: "stopped-by-you", restarts: 0, lastCrashAt: null, crashes: [], retryAt: null, problem: null, window: null }]]));
  });

  it("write the workspace's file only when the services you stopped change", async () => {
    const store = fileStore(state, records, () => undefined);
    const record = (restarts: number): SupervisionRecord => ({ hold: "stopped-by-you", restarts, lastCrashAt: null, crashes: [], retryAt: null, problem: null, window: null });
    store.save(new Map([["api", record(0)]]));
    await store.flush();
    const holds = join(dir, "ws/Apps/pomade-runner/records/services.json");
    await writeFile(holds, JSON.stringify({ stoppedByYou: ["api"], touched: true }));
    store.save(new Map([["api", record(1)]]));
    await store.flush();
    expect(await read(holds)).toEqual({ stoppedByYou: ["api"], touched: true });
    store.save(new Map([["api", { ...record(1), hold: null }]]));
    await store.flush();
    expect(await read(holds)).toEqual({ stoppedByYou: [] });
  });

  it("read what they can of a damaged file, and say when it is not JSON", async () => {
    const machine = join(dir, "ud/app-state/pomade-runner/services.json");
    await mkdir(dirname(machine), { recursive: true });
    await writeFile(machine, JSON.stringify({ services: { a: { hold: "maybe", restarts: -1, crashes: [1, "x"], retryAt: "soon" }, b: 7 } }));
    expect(await fileStore(state, records, () => undefined).load()).toEqual(new Map([["a", { hold: null, restarts: 0, lastCrashAt: null, crashes: [1], retryAt: null, problem: null, window: null }]]));
    await writeFile(machine, "{ nope");
    const lines: string[] = [];
    expect(await fileStore(state, records, (line) => lines.push(line)).load()).toEqual(new Map());
    expect(lines).toEqual([`services: ${machine} is not readable JSON; starting with no crash counts`]);
  });
});
