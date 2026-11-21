import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeHost, type FakeHost } from "pomade-kit/fake-host";
import type { LaunchResult } from "pomade-kit/node";
import { connect, type HostClient } from "pomade-kit/sdk";
import { checkRepoJobs, REPO_JOBS_APP_ID, REPO_JOBS_METHOD, type JsonValue, type NoticeParams, type RepoJobsParams, type Surface } from "pomade-kit/protocol";
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
  ENVIRONMENT_GET_METHOD,
  SETTINGS_GET_METHOD,
  SETTINGS_SET_METHOD,
  SWITCH_METHOD,
} from "../integrations/runner-api";
import { noticePoster, type PostNotice } from "../integrations/notices";
import type { PomadeLinkHandlers } from "../integrations/pomade";
import { isServiceActionResult, isServicesReport, type RunnerSession } from "../keeper/model";
import { sessionIdOf, type SessionOwner } from "../keeper/ids";
import type { SessionCommand, Sessions } from "../keeper/sessions";
import type { SupervisionStore } from "../keeper/supervisor";
import { stateFolderOf } from "../locations";
import { callScheduler } from "./control/client";
import { CONTROL_PROTOCOL } from "./control/protocol";
import { isHistoryPage, isRunActionResult, isRunsReport, NEXT_UP_RUNS } from "./model";
import { isEnvironmentReport } from "./environment";
import { isSettingsReport } from "./settings";
import { FakeTurns } from "./runs-fixture";
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
    const id = sessionIdOf(owner.kind === "run" ? { ...owner, run } : owner) ?? "";
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
    setActions(id, actions) {
      const known = held.get(id);
      if (known !== undefined) held.set(id, { ...known, info: { ...known.info, actions } });
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
/** No Pomade to open: the scheduler's tests connect it themselves. */
const noLaunch = (): Promise<LaunchResult> => Promise.resolve({ status: "failed", reason: "no Pomade in this test" });
/** The Pomade start the tests run under. */
const noStart = (): Promise<string | null> => Promise.resolve("start-1");

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
      workspace: join(dir, "ws"),
      sessions,
      ...supervision,
      state: stateFolderOf(join(dir, "ud")),
      postNotice,
      pomadeGit: "/nowhere/bin/pomade-git", turns: new FakeTurns(), shell: "/bin/sh", launchPomade: noLaunch, pomadeStart: noStart,
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
    expect(lines).toEqual(
      expect.arrayContaining([`scheduler ${APP_VERSION} started (pid ${process.pid}, tick 1000 ms)`, "login: no keeper was running — the staged start begins; the login hooks run after the warm-up"]),
    );
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
      workspace: join(dir, "ws"),
      sessions: second,
      ...supervision,
      state: stateFolderOf(join(dir, "ud")),
      postNotice,
      pomadeGit: "/nowhere/bin/pomade-git", turns: new FakeTurns(), shell: "/bin/sh", launchPomade: noLaunch, pomadeStart: noStart,
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
    const result = await startScheduler({ socketPath, clock: { now: () => now }, tickMs: 1000, log: () => undefined, linkPomade: () => ({ stop: () => undefined }), workspace: join(dir, "ws"), sessions, ...supervision, state: stateFolderOf(join(dir, "ud")), postNotice, pomadeGit: "/nowhere/bin/pomade-git", turns: new FakeTurns(), shell: "/bin/sh", launchPomade: noLaunch, pomadeStart: noStart });
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
  let workspace: string;
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
      workspace,
      sessions,
      ...supervision,
      state: stateFolderOf(join(dir, "ud")),
      postNotice,
      pomadeGit: "/nowhere/bin/pomade-git", turns: new FakeTurns(), shell: "/bin/sh", launchPomade: noLaunch, pomadeStart: noStart,
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

  it("serves jobs.list through Pomade, checks projects, and tells Runner's frames when the jobs change", async () => {
    const fake = createFakeHost({ manifest, projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }] });
    const ui = await frame(fake);
    const heard: unknown[] = [];
    await ui.events.subscribe(`pomade-runner:${JOBS_CHANGED_EVENT}`, (payload) => heard.push(payload));
    await writeFile(join(dir, "ws/Apps/pomade-runner/jobs/a.md"), job("A"));
    await start();
    link?.connected(await frame(fake, "backend"));
    fake.ready();

    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", JOBS_LIST_METHOD)).toMatchObject({ projectsChecked: true }));
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

  it("serves jobs.forRepo: the git jobs that target a repo, in the kit's shape, well within Pomade's 1.5 s", async () => {
    const fake = createFakeHost({ manifest });
    const ui = await frame(fake);
    await writeFile(
      join(dir, "ws/Apps/pomade-runner/jobs/knowledge.md"),
      "---\nkind: git\nname: Knowledge twice daily\ngit: { operation: commit-push, repos: [Knowledge] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n",
    );
    await writeFile(join(dir, "ws/Apps/pomade-runner/jobs/a.md"), job("A"));
    await start();
    link?.connected(await frame(fake, "backend"));
    const params = { repo: { name: "Knowledge", path: join(dir, "ws/Knowledge") } } satisfies RepoJobsParams;
    await vi.waitFor(async () => expect(await ui.apps.call(REPO_JOBS_APP_ID, REPO_JOBS_METHOD, params)).toBeTruthy());
    const asked = performance.now();
    const answer = await ui.apps.call(REPO_JOBS_APP_ID, REPO_JOBS_METHOD, params);
    expect(performance.now() - asked).toBeLessThan(150);
    const jobs = checkRepoJobs(answer);
    expect(answer).toEqual({ jobs });
    expect(jobs).toEqual([{ id: "knowledge", name: "Knowledge twice daily", operation: "commit-push", schedule: "daily at 13:00 and 20:00", nextRun: expect.any(String) as string, lastResult: null, route: "jobs/knowledge" }]);
    expect(await ui.apps.call(REPO_JOBS_APP_ID, REPO_JOBS_METHOD, { repo: { name: "Pomade", path: join(dir, "ws/Projects/Pomade") } })).toEqual({ jobs: [] });
    for (const bad of [null, {}, { repo: "Knowledge" }, { repo: { name: "Knowledge" } }, { repo: { name: "", path: "/x" } }]) {
      await expect(ui.apps.call(REPO_JOBS_APP_ID, REPO_JOBS_METHOD, bad)).rejects.toMatchObject({ code: "invalid-params" });
    }
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

    expect(await callScheduler(socketPath, "run", { job: "Coda web" })).toMatchObject({ status: "ok", value: { service: { job: "coda/web", state: "starting", session: { id: "svc:coda.web" } } } });
    expect(sessions.spawned[1]).toEqual({
      job: "coda/web",
      command: { title: "Coda web", command: "./start.sh", cwd: join(dir, "ws/Projects/coda"), background: true, actions: [{ id: "restart", title: "Restart" }] },
    });
    expect(await callScheduler(socketPath, "stop", { job: "coda/web" })).toMatchObject({ status: "ok", value: { job: "coda/web", state: "stopped-by-you" } });
    expect(sessions.stopped).toEqual([{ id: "svc:coda.web", reason: "stopped-by-you" }]);
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

  it("starts a service when Start is clicked on its attached tab", async () => {
    const jobs = join(dir, "ws/Apps/pomade-runner/jobs");
    // Started on its project's first open: nothing but Start runs it here.
    await mkdir(join(jobs, "alpha"));
    await writeFile(join(jobs, "alpha/web.md"), "---\nkind: service\nname: Web\nproject: alpha\nfolder: .\ncommand: ./web.sh\nstart: project-first-open\n---\n");
    const fake = createFakeHost({ manifest, projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }] });
    const heard: unknown[] = [];
    await (await frame(fake)).events.subscribe(`pomade-runner:${JOBS_CHANGED_EVENT}`, (payload) => heard.push(payload));
    await start();
    link?.connected(await frame(fake, "backend"));
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    expect(sessions.spawned).toHaveLength(0);

    fake.emitEvent("attachedTab.action", { session: { app: "pomade-runner", session: "svc:alpha.web" }, action: "start", projectId: "alpha" });
    await vi.waitFor(() => expect(sessions.spawned).toHaveLength(1));
    expect(sessions.spawned[0]?.job).toBe("alpha/web");
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
      state: stateFolderOf(join(dir, "ud")),
      clock: { now: () => new Date() },
      tickMs: 20,
      log,
      linkPomade: (handlers) => {
        link = handlers;
        return { stop: () => undefined };
      },
      workspace: join(dir, "ws"),
      sessions,
      ...supervision,
      postNotice: noticePoster(join(dir, "ud"), log),
      pomadeGit: "/nowhere/bin/pomade-git", turns: new FakeTurns(), shell: "/bin/sh", launchPomade: noLaunch, pomadeStart: noStart,
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
    expect(listed).toMatchObject({ active: [], nextUp: Array.from({ length: NEXT_UP_RUNS }, () => ({ job: "backup", name: "Backup", held: false })), jobs: [{ job: "backup", finished: false, last: null }], needsYou: [] });

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
    expect(await ui.apps.call("pomade-runner", RUN_OUTPUT_METHOD, { job: "backup", run: run.run })).toEqual({ text: "", truncated: false, missing: true });
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
        { job: "web", kind: "service", trigger: "always on · starts at login", service: { job: "web" } },
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
    expect(JSON.parse(await readFile(join(dir, "ws/Apps/pomade-runner/records/switch.json"), "utf8"))).toMatchObject({ position: "pause-all" });
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

  it("tells Runner's frames about the Mac: the notification permission and the skill's links", async () => {
    await start();
    await vi.waitFor(async () => expect(isEnvironmentReport(await ui.apps.call("pomade-runner", ENVIRONMENT_GET_METHOD))).toBe(true));
    expect(await ui.apps.call("pomade-runner", ENVIRONMENT_GET_METHOD)).toMatchObject({ notifications: "unavailable", skill: { folders: expect.any(Number) as number } });
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

describe("scheduler and Pomade's hooks", () => {
  let dir: string;
  let workspace: string;
  let jobs: string;
  let link: PomadeLinkHandlers | null;
  let sessions: StubSessions;
  let fake: FakeHost;
  let lines: string[];
  /** The Pomade start the scheduler finds: a new value is a new Pomade start. */
  let pomadeStart: string | null;
  const running: Scheduler[] = [];
  // Normal priority and parallel: every firing starts at once, none waits for a slot or another run.
  const script = (name: string, hook: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./${name.toLowerCase()}.sh\nhook: ${hook}\nlow-priority: false\noverlap: parallel\n---\n`;

  async function start(): Promise<Scheduler> {
    const log = (line: string): void => void lines.push(line);
    const result = await startScheduler({
      socketPath: join(dir, "state", "scheduler.sock"),
      state: stateFolderOf(join(dir, "ud")),
      clock: { now: () => new Date() },
      tickMs: 20,
      log,
      linkPomade: (handlers) => {
        link = handlers;
        return { stop: () => undefined };
      },
      workspace,
      sessions,
      ...supervision,
      postNotice: noticePoster(join(dir, "ud"), log),
      pomadeGit: "/nowhere/bin/pomade-git",
      turns: new FakeTurns(),
      shell: "/bin/sh",
      launchPomade: noLaunch,
      pomadeStart: () => Promise.resolve(pomadeStart),
    });
    if (result.status !== "started") throw new Error(`not started: ${result.status}`);
    running.push(result.scheduler);
    return result.scheduler;
  }

  /** Pomade connects the scheduler, as a (re)connection does; it listens once it announced the jobs. */
  async function connect(): Promise<void> {
    const announced = (): number => fake.published.filter((event) => event.name === JOBS_CHANGED_EVENT).length;
    const before = announced();
    link?.connected(await frame(fake, "backend"));
    await vi.waitFor(() => expect(announced()).toBeGreaterThan(before));
  }

  /** The runs started, by job, with what their environment says of the event. */
  const started = (): { job: string; trigger: string | undefined; project: string | undefined; path: string | undefined }[] =>
    sessions.spawned.filter((spawn) => spawn.command.env?.POMADE_TRIGGER !== undefined).map(({ job, command }) => ({ job, trigger: command.env?.POMADE_TRIGGER, project: command.env?.POMADE_PROJECT, path: command.env?.POMADE_PROJECT_PATH }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    workspace = join(dir, "ws");
    jobs = join(workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(workspace, "Apps/pomade-runner/settings.yaml"), "warm-up: 0m\n");
    await writeFile(join(jobs, "updates.md"), script("Updates", "{ event: pomade-started }"));
    await writeFile(join(jobs, "any-open.md"), script("Any open", "{ event: project-first-open }"));
    await writeFile(join(jobs, "alpha-open.md"), script("Alpha open", "{ event: project-first-open, project: alpha }"));
    await writeFile(join(jobs, "init.md"), script("Init", "{ event: project-created }"));
    link = null;
    lines = [];
    pomadeStart = "start-1";
    sessions = stubSessions();
    fake = createFakeHost({
      manifest,
      projects: [
        { id: "alpha", name: "Alpha", root: "Projects/alpha" },
        { id: "beta", name: "Beta", root: "Projects/beta" },
      ],
    });
  });

  afterEach(async () => {
    for (const scheduler of running.splice(0)) await scheduler.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("Pomade started fires once per Pomade start: not again on a reconnect or a restarted scheduler, again after Pomade starts anew", async () => {
    const scheduler = await start();
    await connect();
    fake.ready();
    await vi.waitFor(() => expect(started()).toEqual([{ job: "updates", trigger: "hook", project: undefined, path: undefined }]));
    expect(lines).toContain("Pomade started");

    // The same Pomade: a reconnect hears the sticky ready again, and fires nothing.
    await connect();
    await vi.waitFor(() => expect(lines).toContain("Pomade ready: the Pomade started hooks fired for this Pomade start already"));
    // A scheduler restarted (an update) while the same Pomade runs: nothing either.
    await scheduler.stop();
    running.splice(0);
    lines = [];
    await start();
    await connect();
    await vi.waitFor(() => expect(lines).toContain("Pomade ready: the Pomade started hooks fired for this Pomade start already"));
    expect(started().map((run) => run.job)).toEqual(["updates"]);

    // Pomade quit and started again.
    pomadeStart = "start-2";
    link?.disconnected();
    await connect();
    await vi.waitFor(() => expect(started().map((run) => run.job)).toEqual(["updates", "updates"]));
    expect(await readFile(join(dir, "ud/app-state/pomade-runner/pomade-started.json"), "utf8")).toBe(`${JSON.stringify({ fired: { [workspace]: "start-2" } }, null, 2)}\n`);

    // A Pomade start that cannot be told fires nothing and says why.
    pomadeStart = null;
    await connect();
    await vi.waitFor(() => expect(lines).toContain("Pomade ready: cannot tell which Pomade start this is — its socket is not found; the Pomade started hooks do not fire"));
    expect(started()).toHaveLength(2);
  });

  it("a project's first open fires its hooks once per Pomade start, with the project in the run's environment; the project in front at ready counts as opened", async () => {
    await start();
    fake.setActiveProject("alpha");
    await connect();
    fake.ready();
    const alpha = { trigger: "hook", project: "alpha", path: join(workspace, "Projects/alpha") };
    await vi.waitFor(() => expect(started()).toHaveLength(3));
    expect(started()).toEqual(expect.arrayContaining([{ job: "updates", trigger: "hook", project: undefined, path: undefined }, { job: "any-open", ...alpha }, { job: "alpha-open", ...alpha }]));

    // Pomade's own project.opened for the launch project fires nothing twice; a second open is no event.
    fake.emitEvent("project.opened", { id: "alpha", kind: "project", name: "Alpha", root: "Projects/alpha" });
    fake.emitEvent("project.opened", { id: "__workspace__", kind: "workspace", name: "Workspace", root: "" });
    fake.emitEvent("project.opened", { id: "beta", kind: "project", name: "Beta", root: "Projects/beta" });
    await vi.waitFor(() => expect(started()).toHaveLength(4));
    expect(started()[3]).toEqual({ job: "any-open", trigger: "hook", project: "beta", path: join(workspace, "Projects/beta") });
    // Another workspace's project (Pomade switched; this scheduler follows soon): not this workspace's.
    fake.emitEvent("project.opened", { id: "elsewhere", kind: "project", name: "Elsewhere", root: "Projects/elsewhere" });
    await vi.waitFor(() => expect(lines).toContain("project Elsewhere (elsewhere) opened: not a project of this workspace"));
    expect(started()).toHaveLength(4);
    const history = await vi.waitFor(async () => {
      const ui = await frame(fake);
      const runs = await ui.apps.call("pomade-runner", RUNS_LIST_METHOD);
      if (!isRunsReport(runs)) throw new Error("no report");
      return runs;
    });
    expect(history.active.find((run) => run.job === "alpha-open")?.cause).toEqual({ kind: "hook", event: "project-first-open", context: { POMADE_PROJECT: "alpha", POMADE_PROJECT_PATH: join(workspace, "Projects/alpha") }, projectName: "Alpha" });
  });

  it("a project created fires its hooks with the new project", async () => {
    await start();
    await connect();
    fake.emitEvent("project.created", { id: "gamma", kind: "project", name: "Gamma", root: "Projects/gamma" });
    await vi.waitFor(() => expect(started()).toEqual([{ job: "init", trigger: "hook", project: "gamma", path: join(workspace, "Projects/gamma") }]));
    expect(lines).toContain("project Gamma (gamma) created");
  });

  /** An Agents app session event's payload (`../pomade-agents/docs/CONTRACTS.md` "Published events"). */
  const sessionPayload = (more: Record<string, JsonValue>): JsonValue => ({
    sessionId: "s-1",
    provider: "claude-code",
    agent: "claude",
    project: { id: "alpha", root: "Projects/alpha" },
    cwd: join(workspace, "Projects/alpha"),
    transcript: "/home/.claude/projects/x/s-1.jsonl",
    name: null,
    status: "active",
    startedByRunner: false,
    job: null,
    at: "2026-11-21T10:00:00.000Z",
    ...more,
  });

  /** The session context the runs of `job` got. */
  const sessionEnv = (job: string): Record<string, string | undefined>[] =>
    sessions.spawned
      .filter((spawn) => spawn.job === job)
      .map(({ command }) => ({
        project: command.env?.POMADE_PROJECT,
        path: command.env?.POMADE_PROJECT_PATH,
        session: command.env?.POMADE_SESSION_ID,
        agent: command.env?.POMADE_AGENT,
        status: command.env?.POMADE_SESSION_STATUS,
        transcript: command.env?.POMADE_SESSION_TRANSCRIPT,
      }));

  it("an agent session finished fires its hooks by project and agent, with the session in the run's environment — never one Runner started, whatever its reason", async () => {
    await writeFile(join(jobs, "lint.md"), script("Lint", "{ event: session-finished, project: alpha, agent: claude }"));
    await writeFile(join(jobs, "any-end.md"), script("Any end", "{ event: session-finished }"));
    await start();
    await connect();
    // Pomade's projects are read once it is ready: the run's cause names the project.
    fake.ready();
    await vi.waitFor(() => expect(lines).toContain("Pomade started"));
    fake.emitEvent("pomade-agents:session.closed", sessionPayload({ reason: "exit" }));
    const alpha = { project: "alpha", path: join(workspace, "Projects/alpha"), session: "s-1", agent: "claude", status: "active", transcript: "/home/.claude/projects/x/s-1.jsonl" };
    await vi.waitFor(() => expect([sessionEnv("lint"), sessionEnv("any-end")]).toEqual([[alpha], [alpha]]));

    // Another agent in the Workspace bucket: only the hook without filters, without a project.
    fake.emitEvent("pomade-agents:session.closed", sessionPayload({ sessionId: "s-2", agent: "codex", provider: "codex", project: null, reason: "crash", status: "done" }));
    await vi.waitFor(() => expect(sessionEnv("any-end")).toHaveLength(2));
    expect(sessionEnv("any-end")[1]).toEqual({ project: undefined, path: undefined, session: "s-2", agent: "codex", status: "done", transcript: "/home/.claude/projects/x/s-1.jsonl" });
    // A reason Runner does not know is an end too.
    fake.emitEvent("pomade-agents:session.closed", sessionPayload({ sessionId: "s-3", reason: "detached" }));
    await vi.waitFor(() => expect(sessionEnv("lint")).toHaveLength(2));

    // The loop guard: a session Runner started fires nothing, by a run's end or a tab's.
    fake.emitEvent("pomade-agents:session.closed", sessionPayload({ sessionId: "s-4", startedByRunner: true, job: "Nightly", reason: "run-finished" }));
    fake.emitEvent("pomade-agents:session.closed", sessionPayload({ sessionId: "s-5", startedByRunner: true, job: "Nightly", reason: "tab-closed" }));
    await vi.waitFor(() => expect(lines).toContain("agent session s-5 (claude) finished: tab-closed, started by Runner (Nightly)"));
    // A payload that is not the contract's is logged and ignored.
    fake.emitEvent("pomade-agents:session.closed", sessionPayload({ sessionId: "s-6", status: "parked", reason: "exit" }));
    await vi.waitFor(() => expect(lines.some((line) => line.startsWith("ignored a pomade-agents:session.closed that is not the Agents app's contract:"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([sessionEnv("lint").length, sessionEnv("any-end").length]).toEqual([2, 3]);
    const report = await (await frame(fake)).apps.call("pomade-runner", RUNS_LIST_METHOD);
    if (!isRunsReport(report)) throw new Error("no report");
    expect(report.active.find((run) => run.job === "lint")?.cause).toMatchObject({ kind: "hook", event: "session-finished", projectName: "Alpha" });
  });

  it("a session's status changed fires the hooks on its new status, a session Runner started too", async () => {
    await writeFile(join(jobs, "analyze.md"), script("Analyze", "{ event: session-status, status: done }"));
    await writeFile(join(jobs, "held.md"), script("Held", "{ event: session-status, status: on-hold, agent: codex }"));
    await start();
    await connect();
    fake.emitEvent("pomade-agents:session.statusChanged", sessionPayload({ status: "done", from: "active", to: "done", startedByRunner: true, job: "Nightly" }));
    await vi.waitFor(() => expect(sessionEnv("analyze")).toEqual([{ project: "alpha", path: join(workspace, "Projects/alpha"), session: "s-1", agent: "claude", status: "done", transcript: "/home/.claude/projects/x/s-1.jsonl" }]));
    // On hold, but not codex's; then codex's.
    fake.emitEvent("pomade-agents:session.statusChanged", sessionPayload({ status: "on-hold", from: "active", to: "on-hold" }));
    fake.emitEvent("pomade-agents:session.statusChanged", sessionPayload({ sessionId: "s-2", agent: "codex", status: "on-hold", from: "done", to: "on-hold" }));
    await vi.waitFor(() => expect(sessionEnv("held")).toHaveLength(1));
    expect(sessionEnv("held")[0]?.session).toBe("s-2");
    // `status` must be `to`.
    fake.emitEvent("pomade-agents:session.statusChanged", sessionPayload({ status: "active", from: "active", to: "done" }));
    await vi.waitFor(() => expect(lines.some((line) => line.startsWith("ignored a pomade-agents:session.statusChanged that is not the Agents app's contract:"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionEnv("analyze")).toHaveLength(1);

    // The safety net: a job fired more than 10 times in 10 minutes by the agents' events is paused.
    for (let index = 0; index < 10; index++) fake.emitEvent("pomade-agents:session.statusChanged", sessionPayload({ sessionId: `s-loop-${index}`, status: "done", from: "active", to: "done" }));
    await vi.waitFor(() => expect(lines).toContain("job analyze: fired more than 10 times in 10 min by hooks or chains — looks like a loop; paused until Resume"));
    expect(sessionEnv("analyze")).toHaveLength(10);
  });

  it("a service that starts on a project's first open starts then, not at login", async () => {
    await mkdir(join(jobs, "alpha"));
    await writeFile(join(jobs, "alpha/web.md"), "---\nkind: service\nname: Web\nproject: alpha\nfolder: .\ncommand: ./web.sh\nstart: project-first-open\n---\n");
    await writeFile(join(jobs, "docs.md"), "---\nkind: service\nname: Docs\nfolder: .\ncommand: ./docs.sh\nstart: project-first-open\nstart-project: beta\n---\n");
    await start();
    await connect();
    fake.ready();
    await vi.waitFor(() => expect(lines).toContain("Pomade started"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessions.spawned.filter((spawn) => spawn.command.env?.POMADE_TRIGGER === undefined)).toEqual([]);
    fake.emitEvent("project.opened", { id: "beta", kind: "project", name: "Beta", root: "Projects/beta" });
    await vi.waitFor(() => expect(sessions.spawned.filter((spawn) => spawn.command.env?.POMADE_TRIGGER === undefined).map((spawn) => spawn.job)).toEqual(["docs"]));
    // Beta's first open is not Alpha's.
    const ui = await frame(fake);
    expect(await ui.apps.call("pomade-runner", SERVICES_LIST_METHOD)).toMatchObject({ services: [{ job: "docs", state: "starting" }, { job: "alpha/web", state: "waiting" }] });
  });

  it("a project moved: its jobs follow it — sub-folder, folders, ids — keep their history and latest run, and its running service starts again in its new folder", async () => {
    await mkdir(join(jobs, "alpha"));
    await mkdir(join(workspace, "Projects/alpha"), { recursive: true });
    await writeFile(join(jobs, "alpha/web.md"), "---\nkind: service\nname: Web\nproject: alpha\nfolder: Projects/alpha\ncommand: ./web.sh\n---\n");
    await writeFile(join(jobs, "alpha/nightly.md"), "---\nkind: script\nname: Nightly\nproject: alpha\nfolder: Projects/alpha\ncommand: ./n.sh\nhook: { event: project-created }\nlow-priority: false\n---\n");
    await start();
    await connect();
    fake.ready();
    const ui = await frame(fake);
    await vi.waitFor(() => expect(sessions.spawned.map((spawn) => spawn.job)).toContain("alpha/web"));
    await vi.waitFor(() => expect(lines).toContain("Pomade started"));
    expect(await ui.apps.call("pomade-runner", RUN_NOW_METHOD, { job: "alpha/nightly" })).toMatchObject({ ok: true });
    const run = sessions.list().find((session) => session.job === "alpha/nightly");
    sessions.exit(run?.id ?? "", 0);
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", HISTORY_LIST_METHOD, { job: "alpha/nightly" })).toMatchObject({ records: [{ job: "alpha/nightly", state: "done" }] }));

    await rename(join(workspace, "Projects/alpha"), join(workspace, "Projects/alpha-2"));
    fake.updateProject("alpha", { name: "Alpha 2", root: "Projects/alpha-2" });
    // The service is stopped before its file moves; once its session ends, the move goes on.
    await vi.waitFor(() => expect(sessions.stopped).toEqual([{ id: "svc:alpha.web", reason: "stopped" }]));
    sessions.exit("svc:alpha.web", 143);
    await vi.waitFor(() => expect(sessions.spawned.map((spawn) => spawn.job)).toContain("alpha-2/web"), { timeout: 5000 });
    expect(sessions.forgotten).toContain("svc:alpha.web");
    expect(sessions.spawned.find((spawn) => spawn.job === "alpha-2/web")?.command.cwd).toBe(join(workspace, "Projects/alpha-2"));
    expect(await readFile(join(jobs, "alpha-2/nightly.md"), "utf8")).toContain("\nfolder: Projects/alpha-2\n");
    expect(lines).toContain("project Alpha (alpha) moved: Projects/alpha → Projects/alpha-2");

    // Listed, valid, under the new ids; the history and the latest run follow the job.
    await vi.waitFor(async () => expect(await ui.apps.call("pomade-runner", JOBS_LIST_METHOD)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ valid: true, job: expect.objectContaining({ id: "alpha-2/nightly" }) })]) as unknown }));
    expect(await ui.apps.call("pomade-runner", HISTORY_LIST_METHOD, { job: "alpha-2/nightly" })).toMatchObject({ records: [{ job: "alpha/nightly", state: "done" }] });
    expect(await ui.apps.call("pomade-runner", RUNS_LIST_METHOD)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ job: "alpha-2/nightly", last: expect.objectContaining({ state: "done" }) as unknown })]) as unknown });
    expect(await readFile(join(workspace, "Apps/pomade-runner/records/renamed.json"), "utf8")).toBe(`${JSON.stringify({ renamed: { "alpha/nightly": "alpha-2/nightly", "alpha/web": "alpha-2/web" } }, null, 2)}\n`);
    // And it still fires: bound to the project by its id.
    fake.emitEvent("project.created", { id: "gamma", kind: "project", name: "Gamma", root: "Projects/gamma" });
    // (Its run then waits for the warm-up: the moved service is starting again.)
    await vi.waitFor(() => expect(lines).toContain("hook project-created: fires alpha-2/nightly, init"));
  });
});
