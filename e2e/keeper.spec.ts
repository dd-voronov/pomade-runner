// The keeper as processes: the scheduler of a copy of the built app folder (no `node_modules` but
// what the build ships) starts Runner's keeper as its own detached process and owns its sessions,
// with Pomade closed. Clients attach the way Pomade's attached tabs do — `pomade-kit/node`'s
// `followSession`, as a viewer. Sessions run `/bin/sh` as the login shell in a temp home. Every
// keeper a test started is stopped in teardown, with what it runs.

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { followSession, type Follower } from "pomade-kit/node";
import type { SessionExit, SessionInfo } from "pomade-kit/protocol";

import manifest from "../app/manifest.json" with { type: "json" };
import type { RunnerSession, SessionsReport } from "../src/keeper/model";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { alive, keeperAt, sessionInfo, sessionsReport, startService as startJob, stopKeeper } from "./support/keeper";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

/** A service: a numbered tick a second; a typed line is echoed back at once. */
const TICKER = 'i=0; while :; do i=$((i+1)); echo "tick $i"; if read -t 1 line; then echo "got: $line"; fi; done';
const service = (name: string, command: string): string => `---\nkind: service\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\n---\n`;

test.describe("the keeper", () => {
  let tmp: string;
  let build: string;
  let userData: string;
  let socketPath: string;
  let keeperSocket: string;
  let env: Record<string, string>;
  const started: SchedulerProcess[] = [];
  const followers: Follower[] = [];
  /** Processes the keeper ran: killed in teardown should one outlive its keeper. */
  const pids: number[] = [];

  function startScheduler(): SchedulerProcess {
    const scheduler = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), { ...env, POMADE_CLIENT: "backend" });
    started.push(scheduler);
    return scheduler;
  }

  async function ready(scheduler: SchedulerProcess): Promise<void> {
    await expect.poll(() => scheduler.output()).toMatch(/keeper: connected — version \w+, pid \d+\n/);
  }

  function command(...args: string[]) {
    return run(process.execPath, [join(build, "cli/pomade-runner.mjs"), ...args], { env: { ...env, POMADE_CLIENT: "command" }, cwd: tmp });
  }

  const report = (): Promise<SessionsReport> => sessionsReport(socketPath);
  const session = (id: string): Promise<SessionInfo | undefined> => sessionInfo(socketPath, id);

  async function startService(job: string): Promise<RunnerSession> {
    const started = await startJob(socketPath, job);
    pids.push(started.info.pid ?? 0);
    return started;
  }

  /** The program the session's shim runs (the shell running the command). */
  function childOf(pid: number | null): number {
    const child = Number(execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n")[0]);
    pids.push(child);
    return child;
  }

  /** Attach as Pomade's tabs do; what arrives is collected. */
  function attach(id: string, size = { cols: 100, rows: 30 }) {
    const seen = { snapshot: "", output: "", exit: null as SessionExit | null, attached: false };
    const follower = followSession(
      { socketPath: keeperSocket, app: "pomade", session: id, ...size },
      {
        onSnapshot: (data) => {
          seen.snapshot = data;
          seen.attached = true;
        },
        onOutput: (data) => (seen.output += data),
        onExit: (exit) => (seen.exit = exit),
      },
    );
    followers.push(follower);
    return { follower, seen };
  }

  test.beforeEach(async () => {
    tmp = await tempDir();
    build = join(tmp, "apps", manifest.id);
    await cp(DIST, build, { recursive: true });
    userData = join(tmp, "ud");
    const keyFile = join(userData, "app-keys", manifest.id);
    await mkdir(join(userData, "app-keys"), { recursive: true });
    await writeFile(keyFile, "test-key\n", { mode: 0o600 });
    socketPath = join(userData, "app-state", manifest.id, "scheduler.sock");
    keeperSocket = join(userData, "run", "keepers", `${manifest.id}.sock`);
    const workspace = join(tmp, "ws");
    await mkdir(join(workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await mkdir(join(tmp, "home"), { recursive: true });
    await writeFile(join(tmp, "home", "workspace"), `${workspace}\n`);
    await writeFile(join(workspace, "Apps/pomade-runner/jobs/ticker.md"), service("Ticker", TICKER));
    await writeFile(join(workspace, "Apps/pomade-runner/jobs/sleeper.md"), service("Sleeper", "exec sleep 600"));
    await mkdir(join(tmp, "user"));
    env = cleanEnv({
      POMADE_APP_ID: manifest.id,
      POMADE_APP_KEY_FILE: keyFile,
      POMADE_KEEPER_SOCKET: keeperSocket,
      POMADE_HOME: join(tmp, "home"),
      POMADE_RUNNER_TICK_MS: "50",
      HOME: join(tmp, "user"),
      SHELL: "/bin/sh",
    });
  });

  test.afterEach(async () => {
    for (const follower of followers.splice(0)) follower.close();
    for (const scheduler of started.splice(0)) await scheduler.kill();
    await stopKeeper(keeperSocket, pids.splice(0));
    await removeDir(tmp);
  });

  test("the scheduler starts the keeper as its own process; a session it started survives the scheduler's restart and is listed with its job", async () => {
    const first = startScheduler();
    await ready(first);
    const keeper = await keeperAt(keeperSocket);
    expect(keeper).not.toBeNull();
    expect(execFileSync("ps", ["-o", "command=", "-p", String(keeper?.pid)], { encoding: "utf8" })).toContain(join(build, "backend/keeper.mjs"));

    const ticker = await startService("ticker");
    expect(ticker).toMatchObject({ id: "svc:ticker", job: "ticker", kind: "service", info: { state: "running", actions: [{ id: "restart", title: "Restart" }] } });
    expect(ticker.log).toBe(join(userData, "app-state", manifest.id, "output", "ticker", `${ticker.run ?? ""}.log`));
    await expect.poll(() => readFile(ticker.log ?? "", "utf8").catch(() => "")).toContain("tick 2");

    // The scheduler dies (launchd restarts it after a crash); the keeper and the session run on.
    await first.kill();
    expect(alive(keeper?.pid ?? 0)).toBe(true);
    expect(alive(ticker.info.pid ?? 0)).toBe(true);
    const second = startScheduler();
    await ready(second);
    expect(second.output()).not.toContain("keeper: started");
    expect(await keeperAt(keeperSocket)).toEqual(keeper);
    expect(await session("svc:ticker")).toMatchObject({ state: "running", pid: ticker.info.pid, startedAt: ticker.info.startedAt });
    expect((await report()).sessions).toEqual([expect.objectContaining({ id: "svc:ticker", job: "ticker", run: ticker.run, log: ticker.log })]);

    const listed = await command("sessions");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toBe(
      `keeper: running — version ${keeper?.version ?? ""}, pid ${keeper?.pid ?? ""}\n` +
        `svc:ticker  job ticker  running, pid ${ticker.info.pid ?? ""}, since ${new Date(ticker.info.startedAt).toISOString()}  output ${ticker.log ?? ""}\n`,
    );
    expect(second.output()).not.toContain("ended");
  });

  test("an attached client gets the earlier output, then the live output; its input and size reach the session; detaching leaves it running", async () => {
    await ready(startScheduler());
    const ticker = await startService("ticker");
    await expect.poll(() => readFile(ticker.log ?? "", "utf8").catch(() => "")).toContain("tick 2");

    const { follower, seen } = attach("svc:ticker");
    await expect.poll(() => seen.attached).toBe(true);
    expect(seen.snapshot).toContain("tick 1");
    expect(seen.snapshot).toContain("tick 2");
    await expect.poll(() => seen.output).toMatch(/tick \d+/);
    expect((await session("svc:ticker"))?.clients).toBe(1);

    follower.input("hello keeper\r");
    await expect.poll(() => seen.output).toContain("got: hello keeper");
    follower.resize(120, 40);
    await expect.poll(async () => (await session("svc:ticker"))?.cols).toBe(120);
    expect((await session("svc:ticker"))?.rows).toBe(40);

    follower.close();
    await expect.poll(async () => (await session("svc:ticker"))?.clients).toBe(0);
    expect(await session("svc:ticker")).toMatchObject({ state: "running", pid: ticker.info.pid });
  });

  test("Ctrl+C typed through an attached client ends the session as stopped by you; kill -9 of the program as crashed", async () => {
    const scheduler = startScheduler();
    await ready(scheduler);
    const ticker = await startService("ticker");
    const sleeper = await startService("sleeper");

    const { follower, seen } = attach("svc:ticker");
    // The program runs (the interrupt reaches it, not the keeper's shim around it).
    await expect.poll(() => seen.snapshot + seen.output).toContain("tick 1");
    follower.input("\x03");
    await expect.poll(() => seen.exit?.reason).toBe("stopped-by-you");
    await expect.poll(() => scheduler.output()).toContain("session svc:ticker: ended: stopped-by-you — code 130, SIGINT\n");

    process.kill(childOf(sleeper.info.pid), "SIGKILL");
    await expect.poll(() => scheduler.output()).toContain("session svc:sleeper: ended: crashed — code 137, SIGKILL\n");
    expect(await session("svc:sleeper")).toMatchObject({ state: "exited", pid: null, exit: { reason: "crashed", code: 137, signal: "SIGKILL" } });
    expect((await command("sessions")).stdout).toContain("svc:sleeper  job sleeper  ended: crashed — code 137, SIGKILL, at ");
    expect(ticker.id).toBe("svc:ticker");
  });

  test("a keeper that dies is started again, and reports the sessions it took with it as lost", async () => {
    const scheduler = startScheduler();
    await ready(scheduler);
    const ticker = await startService("ticker");
    await expect.poll(() => readFile(ticker.log ?? "", "utf8").catch(() => "")).toContain("tick 1");
    const before = await keeperAt(keeperSocket);
    process.kill(before?.pid ?? 0, "SIGKILL");

    await expect.poll(() => scheduler.output()).toContain("session svc:ticker: ended: lost-in-keeper-crash");
    const after = await keeperAt(keeperSocket);
    expect(after?.pid).not.toBe(before?.pid);
    expect(after?.version).toBe(before?.version);
    expect(await session("svc:ticker")).toMatchObject({ state: "exited", exit: { reason: "lost-in-keeper-crash" } });
    await expect.poll(() => alive(ticker.info.pid ?? 0)).toBe(false);
  });

  test("a Runner update that ships another keeper updates the running one: sessions keep running with the same pids", async () => {
    const first = startScheduler();
    await ready(first);
    const ticker = await startService("ticker");
    const sleeper = await startService("sleeper");
    const old = await keeperAt(keeperSocket);
    const { seen } = attach("svc:ticker");
    await expect.poll(() => seen.attached).toBe(true);

    // The update: a build whose keeper differs replaces the installed folder, as `pomade apps
    // install` does (stage beside it, swap, delete the old copy); the scheduler restarts.
    const next = "e2e0000000a2";
    const staging = join(tmp, "apps", ".staging");
    await cp(DIST, staging, { recursive: true });
    await writeFile(join(staging, "backend/keeper.mjs"), `${await readFile(join(staging, "backend/keeper.mjs"), "utf8")}\n// the next keeper\n`);
    const scheduler = await readFile(join(staging, "backend/scheduler.mjs"), "utf8");
    expect(scheduler).toContain(`"${old?.version ?? ""}"`);
    await writeFile(join(staging, "backend/scheduler.mjs"), scheduler.replaceAll(`"${old?.version ?? ""}"`, `"${next}"`));
    await rename(build, join(tmp, "apps", ".trash"));
    await rename(staging, build);
    await rm(join(tmp, "apps", ".trash"), { recursive: true });
    first.child.kill("SIGTERM");
    expect(await first.exited).toBe(0);

    const second = startScheduler();
    await expect.poll(() => second.output()).toContain(`keeper: version ${old?.version ?? ""} (pid ${old?.pid ?? ""}) is not this build's ${next}; updating it\n`);
    await expect.poll(() => second.output()).toMatch(new RegExp(`keeper: connected — version ${next}, pid (?!${old?.pid ?? ""}\\b)\\d+\\n`));
    const updated = await keeperAt(keeperSocket);
    expect(updated?.version).toBe(next);
    await expect.poll(() => alive(old?.pid ?? 0)).toBe(false);
    for (const before of [ticker, sleeper]) {
      expect(await session(before.id)).toMatchObject({ state: "running", pid: before.info.pid, startedAt: before.info.startedAt });
    }
    // The attached client followed the session to the new keeper.
    const marker = seen.output.length;
    await expect.poll(() => seen.output.slice(marker)).toMatch(/tick \d+/);
    expect(second.output()).not.toContain("ended");
    expect(second.output()).not.toContain("keeper: started");
  });
});
