// Service supervision on a clock the tests set, against sessions that stand in for the keeper: every
// rule — staged start, readiness, back-off, the crash loop, holds, file changes — without waiting.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExitReason } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import type { JobsSnapshot } from "../jobs/model";
import { sessionIdOf } from "./ids";
import type { KeeperLink, RunnerSession, ServicesReport, ServiceStatus } from "./model";
import type { NetworkReadiness } from "./readiness";
import type { SessionCommand, Sessions, StopReason } from "./sessions";
import {
  ALIVE_MS,
  BACKOFF_MS,
  createSupervisor,
  fileStore,
  REMOVED_GRACE_MS,
  RESET_UPTIME_MS,
  START_CAP_MS,
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
  let files: Record<string, string>;
  let snapshot: JobsSnapshot;
  let workspace: string | null;
  let sessions: FakeSessions;
  let store: ReturnType<typeof memoryStore>;
  let lines: string[];
  let reports: ServicesReport[];
  /** Pending network checks, answered by the test. */
  let probes: { ready: NetworkReadiness; answer: (ok: boolean) => void }[];
  let supervisor: Supervisor;

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
      log: (line) => lines.push(line),
      store,
      probe: (ready) => new Promise((resolve) => probes.push({ ready, answer: resolve })),
      onChange: (report) => reports.push(report),
    });
    await created.load();
    supervisor = created;
    return created;
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
    workspace = WS;
    files = {};
    sessions = new FakeSessions(() => now);
    store = memoryStore();
    lines = [];
    reports = [];
    probes = [];
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

  describe("Start and Restart", () => {
    beforeEach(async () => {
      files = { "web.md": service("Web"), "off.md": service("Off", "enabled: false\n"), "job.md": "---\nkind: script\nname: Job\nfolder: .\ncommand: ./j.sh\nhook: { event: login }\n---\n", "bad.md": "---\nkind: service\n---\n" };
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
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prsv-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are written whole and read back", async () => {
    const store = fileStore(dir, () => undefined);
    expect(await store.load()).toEqual(new Map());
    const record: SupervisionRecord = { hold: "failed", restarts: 4, lastCrashAt: 5, crashes: [1, 2, 3, 4, 5], retryAt: null, problem: "p" };
    store.save(new Map([["coda/web", record]]));
    await store.flush();
    expect(JSON.parse(await readFile(join(dir, "services.json"), "utf8"))).toEqual({ services: { "coda/web": record } });
    expect(await fileStore(dir, () => undefined).load()).toEqual(new Map([["coda/web", record]]));
  });

  it("read what they can of a damaged file, and say when it is not JSON", async () => {
    await writeFile(join(dir, "services.json"), JSON.stringify({ services: { a: { hold: "maybe", restarts: -1, crashes: [1, "x"], retryAt: "soon" }, b: 7 } }));
    expect(await fileStore(dir, () => undefined).load()).toEqual(new Map([["a", { hold: null, restarts: 0, lastCrashAt: null, crashes: [1], retryAt: null, problem: null }]]));
    await writeFile(join(dir, "services.json"), "{ nope");
    const lines: string[] = [];
    expect(await fileStore(dir, (line) => lines.push(line)).load()).toEqual(new Map());
    expect(lines).toEqual([`services: ${join(dir, "services.json")} is not readable JSON; starting with no holds or crash counts`]);
  });
});
