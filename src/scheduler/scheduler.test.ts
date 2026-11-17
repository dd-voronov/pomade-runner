import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeHost, type FakeHost } from "pomade-kit/fake-host";
import { connect, type HostClient } from "pomade-kit/sdk";
import type { NoticeParams, Surface } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../../app/manifest.json" with { type: "json" };
import { APP_VERSION } from "../app";
import {
  DISMISS_METHOD,
  HISTORY_LIST_METHOD,
  isJobsSnapshot,
  JOBS_CHANGED_EVENT,
  JOBS_LIST_METHOD,
  MISSED_METHOD,
  RESUME_METHOD,
  RUN_FINISHED_EVENT,
  RUN_GET_METHOD,
  RUN_NOW_METHOD,
  RUN_OUTPUT_METHOD,
  RUN_STARTED_EVENT,
  RUN_STOP_METHOD,
  RUNS_CHANGED_EVENT,
  RUNS_LIST_METHOD,
  SERVICE_METHODS,
  SERVICES_CHANGED_EVENT,
  SERVICES_LIST_METHOD,
  SET_ENABLED_METHOD,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_GET_METHOD,
  SETTINGS_SET_METHOD,
  SWITCH_METHOD,
} from "../integrations/runner-api";
import { noticePoster, type PostNotice } from "../integrations/notices";
import type { PomadeLinkHandlers } from "../integrations/pomade";
import { isServiceActionResult, isServicesReport, type RunnerSession } from "../keeper/model";
import type { SessionOwner } from "../keeper/ids";
import type { SessionCommand, Sessions } from "../keeper/sessions";
import type { SupervisionStore } from "../keeper/supervisor";
import { callScheduler } from "./control/client";
import { CONTROL_PROTOCOL } from "./control/protocol";
import { isHistoryPage, isRunActionResult, isRunsReport } from "./model";
import { isSettingsReport } from "./settings";
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

/** Sessions without a keeper: they hold what the scheduler starts and record what it asks of them. */
interface StubSessions extends Sessions {
  refreshes: number;
  closed: boolean;
  spawned: { job: string; command: SessionCommand }[];
  restarted: { job: string; command: SessionCommand }[];
  stopped: { id: string; reason: string }[];
  forgotten: string[];
  /** Report an exit, as a refresh that sees one does. */
  end(session: RunnerSession): void;
  /** A run's session ends with `code`, as the keeper's list then says. */
  exit(id: string, code: number): void;
}

function stubSessions(): StubSessions {
  const listeners = new Set<(session: RunnerSession) => void>();
  const held = new Map<string, RunnerSession>();
  const session = (owner: SessionOwner, command: SessionCommand): RunnerSession => {
    const run = owner.kind === "run" ? owner.run : "20261117-080000-abcdef";
    const id = owner.kind === "run" ? `run:${owner.job}:${run}` : `svc:${owner.job}`;
    return {
      id,
      job: owner.job,
      kind: owner.kind,
      run,
      log: `/state/output/${owner.job}/${run}.log`,
      info: { id, title: command.title, command: command.command, cwd: command.cwd, pid: 7, startedAt: Date.now(), cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: command.actions ?? [] },
    };
  };
  const stub: StubSessions = {
    refreshes: 0,
    closed: false,
    spawned: [],
    restarted: [],
    stopped: [],
    forgotten: [],
    keeper: () => ({ state: "connected", version: "v1", pid: 9 }),
    list: () => [...held.values()],
    followed: () => true,
    startedKeeper: () => true,
    report: () => ({ keeper: stub.keeper(), sessions: [...held.values()] }),
    refresh() {
      stub.refreshes++;
      return Promise.resolve();
    },
    spawn(owner, command) {
      stub.spawned.push({ job: owner.job, command });
      const started = session(owner, command);
      held.set(started.id, started);
      return Promise.resolve(started);
    },
    stop(id, reason) {
      stub.stopped.push({ id, reason });
      return Promise.resolve();
    },
    restartService(job, command) {
      stub.restarted.push({ job, command });
      const started = session({ kind: "service", job }, command);
      held.set(started.id, started);
      return Promise.resolve(started);
    },
    forget(id) {
      stub.forgotten.push(id);
      held.delete(id);
      return Promise.resolve();
    },
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
    exit(id, code) {
      const ended = held.get(id);
      if (ended === undefined) throw new Error(`no session ${id}`);
      held.set(id, { ...ended, info: { ...ended.info, pid: null, state: "exited", exit: { code, signal: null, reason: code === 0 ? "exited" : "crashed", at: ended.info.startedAt + 1500 } } });
    },
  };
  return stub;
}

/** The notices posted, as Pomade would take them. */
const posted: NoticeParams[] = [];
const postNotice: PostNotice = (notice) => {
  posted.push(notice);
  return Promise.resolve("pomade");
};

/** Supervision records kept nowhere. */
const noStore: SupervisionStore = { load: () => Promise.resolve(new Map()), save: () => undefined, flush: () => Promise.resolve() };
const supervision = { supervision: noStore, probe: () => Promise.resolve(false) };

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
      ...supervision,
      state: join(dir, "state"),
      postNotice,
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
    expect(lines).toEqual([`scheduler ${APP_VERSION} started (pid ${process.pid}, tick 1000 ms)`, "login: no keeper was running — the staged start begins; the login hooks run after the warm-up"]);
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
    expect(lines).toContain("connected to Pomade");
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
      ...supervision,
      state: join(dir, "state"),
      postNotice,
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

  it("follows the keeper's sessions from its start and on every tick, and logs each end; a tick due while one runs is dropped", async () => {
    await start(20);
    expect(sessions.refreshes).toBe(1);
    for (const expected of [2, 3]) {
      await vi.waitFor(() => {
        vi.advanceTimersByTime(20);
        expect(sessions.refreshes).toBe(expected);
      });
    }
    // Due while that tick runs: dropped.
    vi.advanceTimersByTime(20);
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
    const result = await startScheduler({ socketPath, clock: { now: () => now }, tickMs: 1000, log: () => undefined, linkPomade: () => ({ stop: () => undefined }), workspace: () => null, sessions, ...supervision, state: join(dir, "state"), postNotice });
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
  const job = (name: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./x.sh\nhook: { event: project-created }\n---\n`;

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
      ...supervision,
      state: join(dir, "state"),
      postNotice,
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

  it("supervises the services: starts the ones due at its start, answers services, and starts, stops and restarts one on request", async () => {
    const jobs = join(dir, "ws/Apps/pomade-runner/jobs");
    await mkdir(join(jobs, "coda"));
    await writeFile(join(jobs, "coda/web.md"), "---\nkind: service\nname: Coda web\nproject: p1\nfolder: Projects/coda\ncommand: ./start.sh\nstart: project-first-open\nlow-priority: true\n---\n");
    await writeFile(join(jobs, "api.md"), "---\nkind: service\nname: Api\nfolder: .\ncommand: ./api.sh\n---\n");
    await writeFile(join(jobs, "a.md"), job("A"));
    await writeFile(join(jobs, "broken.md"), "---\nkind: service\n---\n");
    await start();
    const socketPath = join(dir, "state", "scheduler.sock");

    await vi.waitFor(() => expect(sessions.spawned.map((spawned) => spawned.job)).toEqual(["api"]));
    expect(await callScheduler(socketPath, "sessions", null)).toMatchObject({ status: "ok", value: { keeper: { state: "connected", version: "v1", pid: 9 }, sessions: [{ id: "svc:api" }] } });
    const services = await callScheduler(socketPath, "services", null);
    expect(services).toMatchObject({
      status: "ok",
      value: {
        keeper: { state: "connected" },
        services: [
          { job: "api", state: "starting" },
          { job: "broken", state: "invalid" },
          { job: "coda/web", name: "Coda web", project: "p1", state: "waiting", session: null },
        ],
      },
    });

    expect(await callScheduler(socketPath, "run", { job: "Coda web" })).toMatchObject({ status: "ok", value: { service: { job: "coda/web", state: "starting", session: { id: "svc:coda/web" } } } });
    expect(sessions.spawned[1]).toEqual({
      job: "coda/web",
      command: { title: "Coda web", command: "./start.sh", cwd: join(dir, "ws/Projects/coda"), background: true, actions: [{ id: "restart", title: "Restart" }] },
    });
    expect(await callScheduler(socketPath, "stop", { job: "coda/web" })).toMatchObject({ status: "ok", value: { job: "coda/web", state: "stopped-by-you" } });
    expect(sessions.stopped).toEqual([{ id: "svc:coda/web", reason: "stopped-by-you" }]);
    expect(await callScheduler(socketPath, "restart", { job: "api" })).toMatchObject({ status: "ok", value: { job: "api" } });
    expect(sessions.restarted.map((restarted) => restarted.job)).toEqual(["api"]);

    expect(await callScheduler(socketPath, "restart", { job: "a" })).toEqual({ status: "failed", code: "refused", message: 'cannot restart "a": "a" is a script job, not a service' });
    expect(await callScheduler(socketPath, "restart", { job: "nope" })).toEqual({ status: "failed", code: "refused", message: 'cannot restart "nope": no job "nope"' });
    expect(await callScheduler(socketPath, "stop", { job: "nope" })).toEqual({ status: "failed", code: "refused", message: 'cannot stop "nope": no service "nope"' });
    expect(await callScheduler(socketPath, "run", { job: "broken" })).toMatchObject({ status: "failed", code: "refused", message: expect.stringContaining('the job "broken" is invalid') as string });
    expect(await exchange(socketPath, `${JSON.stringify({ protocol: CONTROL_PROTOCOL, id: "p", method: "stop" })}\n`)).toMatchObject({
      error: { code: "invalid-params", message: '"stop" takes params: { job: <a service\'s id or name> }' },
    });
  });

  it("serves services.list, Start, Stop and Restart through Pomade, and tells Runner's frames when a service changes", async () => {
    const jobs = join(dir, "ws/Apps/pomade-runner/jobs");
    const fake = createFakeHost({ manifest });
    const ui = await frame(fake);
    const heard: unknown[] = [];
    await ui.events.subscribe(`pomade-runner:${SERVICES_CHANGED_EVENT}`, (payload) => heard.push(payload));
    await start();
    link?.connected(await frame(fake, "backend"));
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    expect(await ui.apps.call("pomade-runner", SERVICES_LIST_METHOD)).toMatchObject({ services: [] });

    const before = heard.length;
    await writeFile(join(jobs, "web.md"), "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n");
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(before));
    const listed = await ui.apps.call("pomade-runner", SERVICES_LIST_METHOD);
    expect(isServicesReport(listed)).toBe(true);
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", SERVICES_LIST_METHOD)).toMatchObject({ services: [{ job: "web", session: { id: "svc:web" } }] }));

    // Start, Stop and Restart for Runner's frames.
    const stopped = await ui.apps.call("pomade-runner", SERVICE_METHODS.stop, { job: "Web" });
    expect(isServiceActionResult(stopped)).toBe(true);
    expect(stopped).toMatchObject({ ok: true, service: { job: "web", state: "stopped-by-you" } });
    expect(sessions.stopped).toEqual([{ id: "svc:web", reason: "stopped-by-you" }]);
    expect(await ui.apps.call("pomade-runner", SERVICE_METHODS.restart, { job: "web" })).toMatchObject({ ok: true, service: { job: "web" } });
    expect(sessions.restarted.map((restarted) => restarted.job)).toEqual(["web"]);
    expect(await ui.apps.call("pomade-runner", SERVICE_METHODS.start, { job: "web" })).toEqual({ ok: false, reason: '"Web" is running' });
    await expect(ui.apps.call("pomade-runner", SERVICE_METHODS.start, { name: "web" })).rejects.toMatchObject({ code: "invalid-params" });
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
    await vi.waitFor(() => expect(sessions.spawned).toHaveLength(1));

    fake.emitEvent("attachedTab.action", { session: { app: "pomade-runner", session: "svc:web" }, action: "stop-all", projectId: "__workspace__" });
    fake.emitEvent("attachedTab.action", { session: { app: "pomade-runner", session: "svc:web" }, action: "restart", projectId: "__workspace__" });
    await vi.waitFor(() => expect(sessions.restarted).toHaveLength(1));
    expect(sessions.restarted[0]).toEqual({ job: "web", command: { title: "Web", command: "./web.sh", cwd: workspace, background: false, actions: [{ id: "restart", title: "Restart" }] } });
  });
});

describe("scheduler and runs", () => {
  let dir: string;
  let jobs: string;
  let link: PomadeLinkHandlers | null;
  let sessions: StubSessions;
  let fake: FakeHost;
  let ui: HostClient;
  let lines: string[];
  const running: Scheduler[] = [];
  const socketPath = (): string => join(dir, "state", "scheduler.sock");

  async function start(connected = true): Promise<Scheduler> {
    const log = (line: string): void => void lines.push(line);
    const result = await startScheduler({
      socketPath: socketPath(),
      state: join(dir, "state"),
      clock: { now: () => new Date() },
      tickMs: 20,
      log,
      linkPomade: (handlers) => {
        link = handlers;
        return { stop: () => undefined };
      },
      workspace: () => join(dir, "ws"),
      sessions,
      ...supervision,
      postNotice: noticePoster(join(dir, "ud"), log),
    });
    if (result.status !== "started") throw new Error(`not started: ${result.status}`);
    running.push(result.scheduler);
    if (connected) link?.connected(await frame(fake, "backend"));
    return result.scheduler;
  }

  /** The run session the scheduler started last. */
  function lastRun(): RunnerSession {
    const found = sessions.list().filter((session) => session.kind === "run").at(-1);
    if (found === undefined) throw new Error("no run");
    return found;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    jobs = join(dir, "ws/Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "backup.md"), "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 3:00 }\n---\n");
    link = null;
    lines = [];
    sessions = stubSessions();
    fake = createFakeHost({ manifest });
    ui = await frame(fake);
  });

  afterEach(async () => {
    for (const scheduler of running.splice(0)) await scheduler.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("Run now through Pomade runs a script; its end lands in the history, publishes run.started and run.finished, and a failure is noticed, made a Needs-you item and badged", async () => {
    const heard: unknown[] = [];
    await ui.events.subscribe(`pomade-runner:${RUNS_CHANGED_EVENT}`, (payload) => heard.push(payload));
    await start();
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    const listed = await ui.apps.call("pomade-runner", RUNS_LIST_METHOD);
    expect(isRunsReport(listed)).toBe(true);
    expect(listed).toMatchObject({ active: [], nextUp: [{ job: "backup", name: "Backup" }], jobs: [{ job: "backup", finished: false, last: null }], needsYou: [] });

    const started = await ui.apps.call("pomade-runner", RUN_NOW_METHOD, { job: "Backup" });
    expect(isRunActionResult(started)).toBe(true);
    expect(started).toMatchObject({ ok: true, run: { job: "backup", trigger: "manual", state: "running" } });
    expect(sessions.spawned[0]?.command).toMatchObject({ title: "Backup", command: "./backup.sh", cwd: join(dir, "ws"), background: true, env: { POMADE_JOB: "backup", POMADE_TRIGGER: "manual" } });
    await vi.waitFor(() => expect(fake.published.map((event) => event.name)).toContain(RUN_STARTED_EVENT));
    const run = lastRun();
    expect(fake.published.find((event) => event.name === RUN_STARTED_EVENT)?.payload).toEqual({ job: "backup", name: "Backup", run: run.run, kind: "script", folder: "", project: null, trigger: "manual" });
    expect(await ui.apps.call("pomade-runner", RUN_GET_METHOD, { job: "backup", run: run.run })).toMatchObject({ state: "running", session: run.id });

    sessions.exit(run.id, 1);
    await vi.waitFor(() => expect(fake.notices).toEqual([{ title: "Backup failed", body: "exit 1", action: { kind: "openApp", route: `run/backup/${run.run ?? ""}` } }]));
    expect(fake.published.find((event) => event.name === RUN_FINISHED_EVENT)?.payload).toMatchObject({ job: "backup", run: run.run, result: "failed", exitCode: 1 });
    expect(sessions.forgotten).toEqual([run.id]);
    await vi.waitFor(() => expect(fake.badges).toEqual({ runner: { count: 1, urgent: true } }));
    const history = await ui.apps.call("pomade-runner", HISTORY_LIST_METHOD, { job: "backup", limit: 10 });
    expect(isHistoryPage(history)).toBe(true);
    expect(history).toMatchObject({ records: [{ job: "backup", run: run.run, state: "failed", exitCode: 1 }], next: null });
    expect(await ui.apps.call("pomade-runner", HISTORY_LIST_METHOD)).toMatchObject({ records: [{ run: run.run }] });
    expect(await ui.apps.call("pomade-runner", RUN_OUTPUT_METHOD, { job: "backup", run: run.run })).toEqual({ text: "", truncated: false });
    expect(await ui.apps.call("pomade-runner", RUNS_LIST_METHOD)).toMatchObject({ needsYou: [{ id: "run-failed:backup", run: run.run, count: 1 }], jobs: [{ last: { state: "failed" } }] });

    // Opening the result resolves the item; the badge clears.
    expect(await ui.apps.call("pomade-runner", DISMISS_METHOD, { id: "run-failed:backup" })).toEqual({ resolved: true });
    await vi.waitFor(() => expect(fake.badges).toEqual({}));
    expect(await ui.apps.call("pomade-runner", DISMISS_METHOD, { id: "run-failed:backup" })).toEqual({ resolved: false });
    expect(lines).toContain('notice "Backup failed": posted');
  });

  it("refuses bad params and other apps' calls", async () => {
    await start();
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", RUNS_LIST_METHOD)).toBeTruthy());
    for (const [method, params] of [
      [RUN_GET_METHOD, { job: "backup" }],
      [RUN_OUTPUT_METHOD, "backup"],
      [HISTORY_LIST_METHOD, { limit: 0 }],
      [HISTORY_LIST_METHOD, { job: 3 }],
      [RUN_NOW_METHOD, {}],
      [SET_ENABLED_METHOD, { job: "backup" }],
      [DISMISS_METHOD, { id: "" }],
    ] as const) {
      await expect(ui.apps.call("pomade-runner", method, params)).rejects.toMatchObject({ code: "invalid-params" });
    }
    expect(await ui.apps.call("pomade-runner", RUN_GET_METHOD, { job: "backup", run: "20000101-000000-000000" })).toBeNull();
    expect(await ui.apps.call("pomade-runner", RUN_NOW_METHOD, { job: "nope" })).toEqual({ ok: false, reason: 'no job "nope"' });
  });

  it("Enable and Disable write the job's file, field-only, through Pomade and the control socket", async () => {
    const text = "---\nkind: script\nname: Note\nfolder: .\ncommand: ./x.sh   # keep me\nhook: { event: project-created }\n---\nBody stays.\n";
    await writeFile(join(jobs, "note.md"), text);
    await start();
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", RUNS_LIST_METHOD)).toBeTruthy());
    expect(await ui.apps.call("pomade-runner", SET_ENABLED_METHOD, { job: "Note", enabled: false })).toEqual({ ok: true, job: "note", enabled: false });
    expect(await readFile(join(jobs, "note.md"), "utf8")).toBe(text.replace("created }\n", "created }\nenabled: false\n"));
    expect(await callScheduler(socketPath(), "enable", { job: "note" })).toEqual({ status: "ok", value: { job: "note", name: "Note", enabled: true } });
    expect(await readFile(join(jobs, "note.md"), "utf8")).toBe(text.replace("created }\n", "created }\nenabled: true\n"));
    expect(await callScheduler(socketPath(), "disable", { job: "nope" })).toEqual({ status: "failed", code: "refused", message: 'cannot disable "nope": no job "nope"' });
    expect(lines).toContain("job note: disabled");
  });

  it("answers run, list and history over the control socket, with Pomade closed; notices then wait in Pomade's queue", async () => {
    await writeFile(join(jobs, "web.md"), "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n");
    await writeFile(join(jobs, "bad.md"), "---\nkind: script\nname: Bad\n---\n");
    await start(false);
    await vi.waitFor(() => expect(sessions.spawned.map((spawned) => spawned.job)).toEqual(["web"]));
    const ran = await callScheduler(socketPath(), "run", { job: "backup" });
    expect(ran).toMatchObject({ status: "ok", value: { run: { job: "backup", state: "running" } } });
    expect(await callScheduler(socketPath(), "run", { job: "backup" })).toEqual({ status: "failed", code: "refused", message: 'cannot run "backup": "Backup" is running, and its overlap is skip' });
    sessions.exit(lastRun().id, 2);
    await vi.waitFor(async () => expect(await callScheduler(socketPath(), "history", { job: null, limit: 5 })).toMatchObject({ status: "ok", value: { records: [{ job: "backup", state: "failed" }] } }));
    expect(await callScheduler(socketPath(), "history", { job: "Backup", limit: 5 })).toMatchObject({ status: "ok", value: { records: [{ job: "backup" }] } });
    expect(await callScheduler(socketPath(), "history", { job: "web", limit: 5 })).toEqual({ status: "ok", value: { records: [], next: null } });
    await vi.waitFor(async () => expect(await readdir(join(dir, "ud/notices/queue"))).toHaveLength(1));
    const [queued] = await readdir(join(dir, "ud/notices/queue"));
    expect(JSON.parse(await readFile(join(dir, "ud/notices/queue", queued ?? ""), "utf8"))).toMatchObject({ source: "pomade-runner", title: "Backup failed", action: { kind: "openApp", route: expect.stringMatching(/^run\/backup\//) as string } });
    expect(lines).toContain('notice "Backup failed": queued for Pomade\'s next launch');

    const list = await callScheduler(socketPath(), "list", null);
    expect(list).toMatchObject({
      status: "ok",
      value: [
        { job: "backup", kind: "script", enabled: true, trigger: "daily at 3:00", last: { state: "failed" }, service: null },
        { job: "bad", name: "Bad", kind: "script", trigger: null, problem: expect.stringContaining("bad.md") as string },
        { job: "web", kind: "service", trigger: "always on, from login", service: { job: "web" } },
      ],
    });
    expect(await callScheduler(socketPath(), "run", { job: "web" })).toMatchObject({ status: "failed", code: "refused", message: 'cannot run "web": "Web" is running' });
  });

  it("sets the switch through Pomade and the control socket, keeps it across a restart, and reports it with the runs", async () => {
    await start();
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", RUNS_LIST_METHOD)).toMatchObject({ switch: { position: "running", since: null } }));
    expect(await ui.apps.call("pomade-runner", SWITCH_METHOD, { position: "pause-low" })).toMatchObject({ position: "pause-low" });
    expect(await callScheduler(socketPath(), "switch", { position: null })).toMatchObject({ status: "ok", value: { position: "pause-low" } });
    expect(await callScheduler(socketPath(), "switch", { position: "pause-all" })).toMatchObject({ status: "ok", value: { position: "pause-all" } });
    expect(JSON.parse(await readFile(join(dir, "state/switch.json"), "utf8"))).toMatchObject({ position: "pause-all" });
    const runs = await callScheduler(socketPath(), "runs", null);
    expect(runs).toMatchObject({ status: "ok", value: { active: [], switch: { position: "pause-all" } } });
    // Run now still runs; it shows as a run going.
    expect(await ui.apps.call("pomade-runner", RUN_NOW_METHOD, { job: "backup" })).toMatchObject({ ok: true, run: { state: "running" } });
    expect(await callScheduler(socketPath(), "runs", null)).toMatchObject({ status: "ok", value: { active: [{ job: "backup", state: "running" }] } });
    for (const scheduler of running.splice(0)) await scheduler.stop();
    await start(false);
    expect(await callScheduler(socketPath(), "switch", { position: null })).toMatchObject({ status: "ok", value: { position: "pause-all" } });
    expect(lines).toContain("switch: Pause all");
  });

  it("serves the settings through Pomade, writes one field into the file, and tells Runner's frames", async () => {
    const heard: unknown[] = [];
    await ui.events.subscribe(`pomade-runner:${SETTINGS_CHANGED_EVENT}`, (payload) => heard.push(payload));
    await start();
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    const read = await ui.apps.call("pomade-runner", SETTINGS_GET_METHOD);
    expect(isSettingsReport(read)).toBe(true);
    expect(read).toMatchObject({ exists: false, settings: { maxLowPriorityRuns: 2, historyDays: 30 } });
    const heardBefore = heard.length;
    expect(await ui.apps.call("pomade-runner", SETTINGS_SET_METHOD, { field: "max-low-priority-runs", value: 3 })).toMatchObject({ ok: true, settings: { exists: true, settings: { maxLowPriorityRuns: 3 } } });
    expect(await readFile(join(dir, "ws/Apps/pomade-runner/settings.yaml"), "utf8")).toBe("max-low-priority-runs: 3\n");
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(heardBefore));
    expect(await ui.apps.call("pomade-runner", SETTINGS_SET_METHOD, { field: "history-days", value: 0 })).toMatchObject({ ok: false, reason: expect.stringContaining("out of range") as string });
    // An edit by hand applies within a tick.
    await writeFile(join(dir, "ws/Apps/pomade-runner/settings.yaml"), "history-days: 7\n");
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", SETTINGS_GET_METHOD)).toMatchObject({ settings: { maxLowPriorityRuns: 2, historyDays: 7 } }));
  });

  it("a run's end fires its chains: a service restarts through the supervisor and History says so; a runaway chain is paused, noticed and badged, and Resume answers through Pomade and the control socket", async () => {
    await writeFile(join(jobs, "web.md"), "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\nafter: { job: backup }\n---\n");
    await writeFile(join(jobs, "after.md"), "---\nkind: script\nname: After\nfolder: .\ncommand: ./after.sh\nafter: { job: backup }\noverlap: parallel\nlow-priority: false\n---\n");
    await start();
    await vi.waitFor(() => expect(sessions.spawned.map((spawn) => spawn.job)).toContain("web"));
    const backups = (): RunnerSession[] => sessions.list().filter((session) => session.job === "backup");
    for (let i = 1; i <= 11; i++) {
      expect(await ui.apps.call("pomade-runner", RUN_NOW_METHOD, { job: "backup" })).toMatchObject({ ok: true, run: { state: "running" } });
      const run = backups().at(-1);
      sessions.exit(run?.id ?? "", 0);
      await vi.waitFor(() => expect(backups()).toHaveLength(0));
    }
    await vi.waitFor(() => expect(sessions.spawned.filter((spawn) => spawn.job === "after")).toHaveLength(10));
    expect(sessions.spawned.find((spawn) => spawn.job === "after")?.command.env).toMatchObject({ POMADE_TRIGGER: "chain", POMADE_PARENT_JOB: "backup", POMADE_PARENT_RESULT: "done" });
    expect(sessions.restarted.map((restart) => restart.job)).toHaveLength(10);
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", HISTORY_LIST_METHOD, { job: "web", limit: 20 })).toMatchObject({ records: Array<unknown>(10).fill(expect.objectContaining({ kind: "service", trigger: "chain", action: "restart", state: "done", cause: expect.objectContaining({ job: "backup", name: "Backup" }) as unknown })) }));
    expect(lines).toContain("service web: Restart — chain: after Backup");

    const paused = { id: "loop-paused:after", kind: "loop-paused", job: "after", name: "After" };
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", RUNS_LIST_METHOD)).toMatchObject({ needsYou: expect.arrayContaining([expect.objectContaining(paused)]) as unknown }));
    await vi.waitFor(() => expect(fake.notices).toContainEqual(expect.objectContaining({ title: "After paused: triggered 10× in 10 min — looks like a loop" })));
    await vi.waitFor(() => expect(fake.badges.runner?.count).toBeGreaterThanOrEqual(2));
    expect(await ui.apps.call("pomade-runner", DISMISS_METHOD, { id: "loop-paused:after" })).toEqual({ resolved: false });
    expect(await callScheduler(socketPath(), "resumeJob", { job: "After" })).toMatchObject({ status: "ok", value: { job: "after", name: "After" } });
    expect(await callScheduler(socketPath(), "resumeJob", { job: "after" })).toMatchObject({ status: "failed", code: "refused", message: 'cannot resume "after": "after" is not paused' });
    expect(await ui.apps.call("pomade-runner", RESUME_METHOD, { job: "after" })).toEqual({ ok: false, reason: '"after" is not paused' });
    await expect(ui.apps.call("pomade-runner", RESUME_METHOD, {})).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("answers a missed run's choice, Stop and a long-run warning's Dismiss through Pomade, and refuses bad params", async () => {
    await start();
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", RUNS_LIST_METHOD)).toBeTruthy());
    expect(await ui.apps.call("pomade-runner", MISSED_METHOD, { job: "backup", choice: "skip" })).toEqual({ ok: false, reason: 'no missed run of "backup" waits for you' });
    expect(await ui.apps.call("pomade-runner", RUN_STOP_METHOD, { job: "backup", run: "20000101-000000-000000" })).toEqual({ ok: false, reason: 'run 20000101-000000-000000 of "backup" is not running' });
    await ui.apps.call("pomade-runner", RUN_NOW_METHOD, { job: "backup" });
    const run = lastRun();
    expect(await ui.apps.call("pomade-runner", RUN_STOP_METHOD, { job: "backup", run: run.run })).toEqual({ ok: true });
    expect(sessions.stopped).toEqual([{ id: run.id, reason: "stopped-by-you" }]);
    expect(await ui.apps.call("pomade-runner", DISMISS_METHOD, { id: `long-run:backup:${run.run ?? ""}` })).toEqual({ resolved: false });
    for (const [method, params] of [
      [MISSED_METHOD, { job: "backup", choice: "later" }],
      [MISSED_METHOD, { job: "backup", choice: "run-at" }],
      [MISSED_METHOD, { choice: "skip" }],
      [RUN_STOP_METHOD, { job: "backup" }],
      [SWITCH_METHOD, { position: "off" }],
      [SETTINGS_SET_METHOD, { field: "colour", value: 1 }],
      [SETTINGS_SET_METHOD, { field: "warm-up", value: "2m" }],
    ] as const) {
      await expect(ui.apps.call("pomade-runner", method, params)).rejects.toMatchObject({ code: "invalid-params" });
    }
  });
});
