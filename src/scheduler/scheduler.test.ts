import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeHost, type FakeHost } from "pomade-kit/fake-host";
import { connect, type HostClient } from "pomade-kit/sdk";
import type { Surface } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../../app/manifest.json" with { type: "json" };
import { APP_VERSION } from "../app";
import { isJobsSnapshot, JOBS_CHANGED_EVENT, JOBS_LIST_METHOD } from "../integrations/runner-api";
import type { PomadeLinkHandlers } from "../integrations/pomade";
import type { RunnerSession } from "../keeper/model";
import type { SessionCommand, Sessions } from "../keeper/sessions";
import { callScheduler } from "./control/client";
import { CONTROL_PROTOCOL } from "./control/protocol";
import { startScheduler, type Scheduler } from "./scheduler";

/** One raw line to the socket, and the first line that comes back. */
function exchange(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let text = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(line));
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end === -1) return;
      socket.destroy();
      resolve(JSON.parse(text.slice(0, end)));
    });
  });
}

/** Sessions without a keeper: they record what the scheduler asks of them. */
interface StubSessions extends Sessions {
  refreshes: number;
  closed: boolean;
  spawned: { job: string; command: SessionCommand }[];
  restarted: { job: string; command: SessionCommand }[];
  /** Report an exit, as a refresh that sees one does. */
  end(session: RunnerSession): void;
}

function stubSessions(): StubSessions {
  const listeners = new Set<(session: RunnerSession) => void>();
  const session = (job: string, command: SessionCommand): RunnerSession => ({
    id: `svc:${job}`,
    job,
    kind: "service",
    run: "20261117-080000-abcdef",
    log: `/state/output/${job}/20261117-080000-abcdef.log`,
    info: { id: `svc:${job}`, title: command.title, command: command.command, cwd: command.cwd, pid: 7, startedAt: 1, cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: command.actions ?? [] },
  });
  const stub: StubSessions = {
    refreshes: 0,
    closed: false,
    spawned: [],
    restarted: [],
    keeper: () => ({ state: "connected", version: "v1", pid: 9 }),
    list: () => [],
    report: () => ({ keeper: stub.keeper(), sessions: [] }),
    refresh() {
      stub.refreshes++;
      return Promise.resolve();
    },
    spawn(owner, command) {
      stub.spawned.push({ job: owner.job, command });
      return Promise.resolve(session(owner.job, command));
    },
    stop: () => Promise.resolve(),
    restartService(job, command) {
      stub.restarted.push({ job, command });
      return Promise.resolve(session(job, command));
    },
    forget: () => Promise.resolve(),
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      stub.closed = true;
      return Promise.resolve();
    },
    end(ended) {
      for (const listener of listeners) listener(ended);
    },
  };
  return stub;
}

/** A client of the fake host: a frame of Runner, or its backend. */
async function frame(fake: FakeHost, surface: Surface = "tab"): Promise<HostClient> {
  const result = await connect({ transport: fake.createTransport({ surface }), keySource: null });
  if (result.status !== "connected") throw new Error(`fake host: ${result.status}`);
  return result.host;
}

describe("scheduler", () => {
  let dir: string;
  let socketPath: string;
  let now: Date;
  let lines: string[];
  let link: PomadeLinkHandlers | null;
  let linkStopped: boolean;
  let sessions: StubSessions;
  const running: Scheduler[] = [];

  async function start(tick = 1000): Promise<Scheduler> {
    const result = await startScheduler({
      socketPath,
      clock: { now: () => now },
      tickMs: tick,
      log: (message) => lines.push(message),
      linkPomade: (handlers) => {
        link = handlers;
        return { stop: () => void (linkStopped = true) };
      },
      workspace: () => null,
      sessions,
    });
    if (result.status !== "started") throw new Error(`not started: ${result.status}`);
    running.push(result.scheduler);
    return result.scheduler;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    socketPath = join(dir, "state", "scheduler.sock");
    now = new Date("2026-11-17T08:00:00.000Z");
    lines = [];
    link = null;
    linkStopped = false;
    sessions = stubSessions();
  });

  afterEach(async () => {
    for (const scheduler of running.splice(0)) await scheduler.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("answers its status over the control socket", async () => {
    await start();
    expect(await callScheduler(socketPath, "status", null)).toEqual({
      status: "ok",
      value: { version: APP_VERSION, pid: process.pid, startedAt: "2026-11-17T08:00:00.000Z", lastTickAt: null, pomade: "disconnected" },
    });
    expect(lines).toEqual([`scheduler ${APP_VERSION} started (pid ${process.pid}, tick 1000 ms)`]);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it("ticks on the clock it was given, at the tick it was given", async () => {
    const scheduler = await start(20);
    now = new Date("2026-11-17T08:00:05.000Z");
    vi.advanceTimersByTime(19);
    expect(scheduler.status().lastTickAt).toBeNull();
    vi.advanceTimersByTime(1);
    expect(scheduler.status().lastTickAt).toBe("2026-11-17T08:00:05.000Z");
    now = new Date("2026-11-17T08:00:09.000Z");
    vi.advanceTimersByTime(20);
    expect(scheduler.status().lastTickAt).toBe("2026-11-17T08:00:09.000Z");
  });

  it("follows its connection to Pomade", async () => {
    const scheduler = await start();
    link?.connected(await frame(createFakeHost({ manifest }), "backend"));
    expect(scheduler.status().pomade).toBe("connected");
    link?.disconnected();
    expect(scheduler.status().pomade).toBe("disconnected");
    link?.rejected("unauthorized");
    expect(scheduler.status().pomade).toBe("rejected");
    expect(lines.slice(1, 2)).toEqual(["connected to Pomade"]);
    expect(lines.slice(-2)).toEqual(["Pomade went away; reconnecting", "Pomade refused the connection: unauthorized"]);
  });

  it("leaves a running scheduler in charge", async () => {
    await start();
    const second = stubSessions();
    const result = await startScheduler({
      socketPath,
      clock: { now: () => now },
      tickMs: 1000,
      log: (message) => lines.push(message),
      linkPomade: () => {
        throw new Error("a second scheduler must not connect to Pomade");
      },
      workspace: () => null,
      sessions: second,
    });
    expect(result).toEqual({ status: "already-running" });
    expect(second.refreshes).toBe(0);
    expect((await callScheduler(socketPath, "status", null)).status).toBe("ok");
  });

  it("takes over the socket file a killed scheduler left behind", async () => {
    await mkdir(join(dir, "state"));
    const holder = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"))`], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await once(holder.stdout, "data");
    holder.kill("SIGKILL");
    await once(holder, "exit");
    expect((await stat(socketPath)).isSocket()).toBe(true);

    await start();
    expect((await callScheduler(socketPath, "status", null)).status).toBe("ok");
  });

  it("replaces a file at the socket path that is not a socket", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(socketPath, "");
    await start();
    expect((await callScheduler(socketPath, "status", null)).status).toBe("ok");
  });

  it("follows the keeper's sessions from its start and on every tick, and logs each end", async () => {
    await start(20);
    expect(sessions.refreshes).toBe(1);
    vi.advanceTimersByTime(40);
    expect(sessions.refreshes).toBe(3);
    const info = { id: "svc:web", title: "Web", command: "./w", cwd: "/ws", pid: null, startedAt: 1, cols: 80, rows: 24, state: "exited" as const, clients: 0, actions: [] };
    sessions.end({ id: "svc:web", job: "web", kind: "service", run: null, log: null, info: { ...info, exit: { code: 137, signal: "SIGKILL", reason: "crashed", at: 2 } } });
    sessions.end({ id: "svc:web", job: "web", kind: "service", run: null, log: null, info: { ...info, exit: { code: null, signal: null, reason: "lost-in-keeper-crash", at: 3 } } });
    expect(lines.slice(-2)).toEqual(["session svc:web: ended: crashed — code 137, SIGKILL", "session svc:web: ended: lost-in-keeper-crash"]);
  });

  it("stops: no socket, no ticks, the connection to Pomade closed", async () => {
    const scheduler = await start(20);
    await scheduler.stop();
    running.length = 0;
    expect(linkStopped).toBe(true);
    expect(await callScheduler(socketPath, "status", null)).toEqual({ status: "not-running" });
    await expect(stat(socketPath)).rejects.toThrow();
    vi.advanceTimersByTime(100);
    expect(scheduler.status().lastTickAt).toBeNull();
    expect(sessions.closed).toBe(true);
    expect(sessions.refreshes).toBe(1);
    expect(lines.at(-1)).toBe("scheduler stopped");
  });

  it("refuses a socket path macOS cannot bind", async () => {
    socketPath = join(dir, "x".repeat(120), "scheduler.sock");
    const result = await startScheduler({ socketPath, clock: { now: () => now }, tickMs: 1000, log: () => undefined, linkPomade: () => ({ stop: () => undefined }), workspace: () => null, sessions });
    expect(result.status).toBe("failed");
  });

  it("tells a caller of another protocol version so, and refuses unknown methods and non-requests", async () => {
    await start();
    expect(await exchange(socketPath, `${JSON.stringify({ protocol: CONTROL_PROTOCOL + 1, id: "a", method: "status" })}\n`)).toEqual({
      protocol: CONTROL_PROTOCOL,
      id: "a",
      ok: false,
      error: { code: "protocol-mismatch", message: `the scheduler speaks control protocol ${CONTROL_PROTOCOL}, the caller ${CONTROL_PROTOCOL + 1}` },
    });
    expect(await exchange(socketPath, `${JSON.stringify({ protocol: CONTROL_PROTOCOL, id: "b", method: "launch" })}\n`)).toMatchObject({
      id: "b",
      ok: false,
      error: { code: "unknown-method" },
    });
    expect(await exchange(socketPath, `"hello"\n`)).toMatchObject({ id: "", ok: false, error: { code: "invalid-request" } });
  });
});

describe("scheduler and the job files", () => {
  let dir: string;
  let workspace: string | null;
  let link: PomadeLinkHandlers | null;
  let sessions: StubSessions;
  const running: Scheduler[] = [];
  const job = (name: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./x.sh\nhook: { event: login }\n---\n`;

  async function start(): Promise<Scheduler> {
    const result = await startScheduler({
      socketPath: join(dir, "state", "scheduler.sock"),
      clock: { now: () => new Date() },
      tickMs: 20,
      log: () => undefined,
      linkPomade: (handlers) => {
        link = handlers;
        return { stop: () => undefined };
      },
      workspace: () => workspace,
      sessions,
    });
    if (result.status !== "started") throw new Error(`not started: ${result.status}`);
    running.push(result.scheduler);
    return result.scheduler;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    workspace = join(dir, "ws");
    link = null;
    sessions = stubSessions();
    await mkdir(join(workspace, "Apps/pomade-runner/jobs"), { recursive: true });
  });

  afterEach(async () => {
    for (const scheduler of running.splice(0)) await scheduler.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("holds the checked jobs of the workspace from its start, and follows changes", async () => {
    await writeFile(join(dir, "ws/Apps/pomade-runner/jobs/a.md"), job("A"));
    const scheduler = await start();
    expect(scheduler.jobs()).toMatchObject({ workspace, projectsChecked: false, jobs: [{ valid: true, job: { id: "a" } }] });
    await writeFile(join(dir, "ws/Apps/pomade-runner/jobs/b.md"), "---\nkind: nope\n---\n");
    await vi.waitFor(() => expect(scheduler.jobs().jobs.map((e) => e.valid)).toEqual([true, false]));
  });

  it("follows a workspace switch", async () => {
    const scheduler = await start();
    expect(scheduler.jobs().jobs).toEqual([]);
    workspace = join(dir, "other");
    await mkdir(join(workspace, "Apps/pomade-runner/jobs/alpha"), { recursive: true });
    await writeFile(join(workspace, "Apps/pomade-runner/jobs/b.md"), job("B"));
    await vi.waitFor(() => expect(scheduler.jobs()).toMatchObject({ workspace, jobs: [{ job: { id: "b" } }] }));
  });

  it("serves jobs.list through Pomade, checks projects, and tells Runner's frames when the jobs change", async () => {
    const fake = createFakeHost({ manifest, projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }] });
    const ui = await frame(fake);
    const heard: unknown[] = [];
    await ui.events.subscribe(`pomade-runner:${JOBS_CHANGED_EVENT}`, (payload) => heard.push(payload));
    await writeFile(join(dir, "ws/Apps/pomade-runner/jobs/a.md"), job("A"));
    await start();
    link?.connected(await frame(fake, "backend"));

    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    const listed = await ui.apps.call("pomade-runner", JOBS_LIST_METHOD);
    expect(isJobsSnapshot(listed)).toBe(true);
    expect(listed).toMatchObject({ workspace, projectsChecked: true, jobs: [{ valid: true, job: { id: "a", name: "A" } }] });

    const before = heard.length;
    await mkdir(join(dir, "ws/Apps/pomade-runner/jobs/alpha"));
    await writeFile(join(dir, "ws/Apps/pomade-runner/jobs/alpha/web.md"), job("Web").replace("name: Web", "name: Web\nproject: gone"));
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(before));
    expect(await ui.apps.call("pomade-runner", JOBS_LIST_METHOD)).toMatchObject({
      jobs: [{ valid: true }, { valid: false, invalid: { errors: [{ field: "project", fix: "write project: alpha (Alpha)" }] } }],
    });
  });

  it("answers sessions, and starts a service on start — refusing a job that is not a valid service", async () => {
    const jobs = join(dir, "ws/Apps/pomade-runner/jobs");
    await mkdir(join(jobs, "coda"));
    await writeFile(join(jobs, "coda/web.md"), "---\nkind: service\nname: Coda web\nproject: p1\nfolder: Projects/coda\ncommand: ./start.sh\nlow-priority: true\n---\n");
    await writeFile(join(jobs, "a.md"), job("A"));
    await writeFile(join(jobs, "broken.md"), "---\nkind: service\n---\n");
    await start();
    const socketPath = join(dir, "state", "scheduler.sock");

    expect(await callScheduler(socketPath, "sessions", null)).toEqual({ status: "ok", value: { keeper: { state: "connected", version: "v1", pid: 9 }, sessions: [] } });
    const started = await callScheduler(socketPath, "start", { job: "coda/web" });
    expect(started).toMatchObject({ status: "ok", value: { id: "svc:coda/web", job: "coda/web" } });
    expect(sessions.spawned).toEqual([
      {
        job: "coda/web",
        command: { title: "Coda web", command: "./start.sh", cwd: join(dir, "ws/Projects/coda"), background: true, actions: [{ id: "restart", title: "Restart" }] },
      },
    ]);
    expect(await callScheduler(socketPath, "start", { job: "a" })).toEqual({ status: "failed", code: "refused", message: 'cannot start "a": "a" is a script job, not a service' });
    expect(await callScheduler(socketPath, "start", { job: "nope" })).toEqual({ status: "failed", code: "refused", message: 'cannot start "nope": no job "nope"' });
    expect(await callScheduler(socketPath, "start", { job: "broken" })).toMatchObject({ status: "failed", code: "refused", message: expect.stringContaining('the job "broken" is invalid') as string });
    expect(await exchange(socketPath, `${JSON.stringify({ protocol: CONTROL_PROTOCOL, id: "p", method: "start" })}\n`)).toMatchObject({
      error: { code: "invalid-params", message: '"start" takes params: { job: <a service job\'s id> }' },
    });
  });

  it("restarts a service when Restart is clicked on its attached tab, and ignores other actions", async () => {
    const jobs = join(dir, "ws/Apps/pomade-runner/jobs");
    await writeFile(join(jobs, "web.md"), "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n");
    const fake = createFakeHost({ manifest });
    const heard: unknown[] = [];
    await (await frame(fake)).events.subscribe(`pomade-runner:${JOBS_CHANGED_EVENT}`, (payload) => heard.push(payload));
    await start();
    link?.connected(await frame(fake, "backend"));
    // Runner's offer subscribes to the tab actions before it announces the jobs.
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));

    fake.emitEvent("attachedTab.action", { session: { app: "pomade-runner", session: "svc:web" }, action: "stop-all", projectId: "__workspace__" });
    fake.emitEvent("attachedTab.action", { session: { app: "pomade-runner", session: "svc:web" }, action: "restart", projectId: "__workspace__" });
    await vi.waitFor(() => expect(sessions.restarted).toHaveLength(1));
    expect(sessions.restarted[0]).toEqual({ job: "web", command: { title: "Web", command: "./web.sh", cwd: workspace, background: false, actions: [{ id: "restart", title: "Restart" }] } });
  });
});
