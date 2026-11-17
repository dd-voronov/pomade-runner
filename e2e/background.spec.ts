// The scheduler and the `pomade-runner` command as processes, from a copy of the built app folder
// in a temp folder — where, as in an installed copy, there is no `node_modules` — with Pomade
// closed: the environment names a Pomade home and user data that no Pomade runs on.

import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const VERSION = manifest.version;

/** The time of the scheduler's latest tick; `null` before its first. */
async function lastTick(socketPath: string): Promise<string | null> {
  const result = await callScheduler(socketPath, "status");
  if (result.status !== "ok") throw new Error(`the scheduler's status: ${result.status}`);
  return result.value.lastTickAt;
}

test.describe("scheduler and command", () => {
  let tmp: string;
  let build: string;
  let socketPath: string;
  let env: Record<string, string>;
  const started: SchedulerProcess[] = [];

  function startScheduler(): SchedulerProcess {
    const scheduler = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), { ...env, POMADE_CLIENT: "backend" });
    started.push(scheduler);
    return scheduler;
  }

  function command(...args: string[]) {
    return run(process.execPath, [join(build, "cli/pomade-runner.mjs"), ...args], { env: { ...env, POMADE_CLIENT: "command" }, cwd: tmp });
  }

  test.beforeEach(async () => {
    tmp = await tempDir();
    build = join(tmp, "apps", manifest.id);
    await cp(DIST, build, { recursive: true });
    const userData = join(tmp, "ud");
    const keyFile = join(userData, "app-keys", manifest.id);
    await mkdir(join(userData, "app-keys"), { recursive: true });
    await writeFile(keyFile, "test-key\n", { mode: 0o600 });
    socketPath = join(userData, "app-state", manifest.id, "scheduler.sock");
    env = cleanEnv({
      POMADE_APP_ID: manifest.id,
      POMADE_APP_KEY_FILE: keyFile,
      POMADE_HOME: join(tmp, "home"),
      POMADE_RUNNER_TICK_MS: "20",
    });
  });

  test.afterEach(async () => {
    for (const scheduler of started.splice(0)) await scheduler.kill();
    await removeDir(tmp);
  });

  test("the scheduler starts with Pomade closed, logs to stdout and ticks at the overridden tick", async () => {
    const scheduler = startScheduler();
    await expect.poll(() => scheduler.output()).toMatch(new RegExp(`^\\S+Z scheduler ${VERSION} started \\(pid ${scheduler.child.pid}, tick 20 ms\\)\\n`));

    const first = await callScheduler(socketPath, "status");
    expect(first).toMatchObject({ status: "ok", value: { version: VERSION, pid: scheduler.child.pid, pomade: "disconnected" } });
    await expect.poll(() => lastTick(socketPath)).not.toBeNull();
    const seen = await lastTick(socketPath);
    await expect.poll(() => lastTick(socketPath)).not.toBe(seen);
  });

  test("pomade-runner --version reports the scheduler: not running, then running, then stopped", async () => {
    expect(await command("--version")).toEqual({ code: 0, stdout: `pomade-runner ${VERSION}\nscheduler: not running\n`, stderr: "" });

    const scheduler = startScheduler();
    await expect.poll(() => scheduler.output()).toContain("started");
    const running = await command("--version");
    expect(running.code).toBe(0);
    expect(running.stdout).toMatch(
      new RegExp(`^pomade-runner ${VERSION}\\nscheduler: running — ${VERSION}, pid ${scheduler.child.pid}, since \\S+Z, Pomade closed\\n$`),
    );

    scheduler.child.kill("SIGTERM");
    expect(await scheduler.exited).toBe(0);
    expect(scheduler.output()).toMatch(/Z scheduler stopped\n$/);
    await expect(stat(socketPath)).rejects.toThrow();
    expect((await command("--version")).stdout).toBe(`pomade-runner ${VERSION}\nscheduler: not running\n`);
  });

  test("SIGINT stops the scheduler cleanly too", async () => {
    const scheduler = startScheduler();
    await expect.poll(() => scheduler.output()).toContain("started");
    scheduler.child.kill("SIGINT");
    expect(await scheduler.exited).toBe(0);
    await expect(stat(socketPath)).rejects.toThrow();
  });

  test("a second scheduler leaves the first in charge and exits cleanly", async () => {
    const first = startScheduler();
    await expect.poll(() => first.output()).toContain("started");
    const second = startScheduler();
    expect(await second.exited).toBe(0);
    expect(second.output()).toMatch(/Z another scheduler is running; this one exits\n$/);
    expect(await callScheduler(socketPath, "status")).toMatchObject({ status: "ok", value: { pid: first.child.pid } });
  });

  test("a scheduler started after one was killed takes over", async () => {
    const first = startScheduler();
    await expect.poll(() => first.output()).toContain("started");
    await first.kill();
    expect((await stat(socketPath)).isSocket()).toBe(true);

    const second = startScheduler();
    await expect.poll(() => second.output()).toContain("started");
    expect(await callScheduler(socketPath, "status")).toMatchObject({ status: "ok", value: { pid: second.child.pid } });
  });

  test("the scheduler refuses to start outside Pomade", async () => {
    const { POMADE_APP_KEY_FILE: _keyFile, ...outside } = env;
    const scheduler = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), outside);
    started.push(scheduler);
    expect(await scheduler.exited).toBe(1);
    expect(scheduler.output()).toContain("not started: POMADE_APP_KEY_FILE is not set");
  });

  test("pomade-runner prints its help, and refuses an unknown command with exit code 2", async () => {
    const help = await command("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(`pomade-runner ${VERSION} — Runner from the command line`);
    expect(help.stdout).toContain("pomade-runner --version");
    expect(help.stderr).toBe("");

    expect(await command("frobnicate")).toEqual({
      code: 2,
      stdout: "",
      stderr: 'pomade-runner: unknown command "frobnicate". Run `pomade-runner --help` for what it takes.\n',
    });
  });
});
