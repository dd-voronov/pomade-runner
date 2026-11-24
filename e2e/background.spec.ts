// The scheduler and the `pomade-runner` command as processes, from a copy of the built app folder
// in a temp folder — where, as in an installed copy, there is no `node_modules` but what the build
// ships — with Pomade closed: the environment names a Pomade home and user data that no Pomade runs
// on, and the home points at a temp workspace. Each scheduler starts its keeper there; teardown
// stops it.

import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import { DIST, cleanEnv, removeDir, run, runWithClosedReader, tempDir } from "./support/env";
import { expectNothingLeft, stopKeeper } from "./support/keeper";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const VERSION = manifest.version;

/** The time of the scheduler's latest tick; `null` before its first. */
async function lastTick(socketPath: string): Promise<string | null> {
  const result = await callScheduler(socketPath, "status", null);
  if (result.status !== "ok") throw new Error(`the scheduler's status: ${result.status}`);
  return result.value.lastTickAt;
}

test.describe("scheduler and command", () => {
  let tmp: string;
  let build: string;
  let socketPath: string;
  let keeperSocket: string;
  let workspace: string;
  let env: Record<string, string>;
  const started: SchedulerProcess[] = [];

  function startScheduler(): SchedulerProcess {
    const scheduler = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), { ...env, POMADE_CLIENT: "backend" });
    started.push(scheduler);
    return scheduler;
  }

  /** Point the Pomade home at a workspace, as Pomade does on every switch. */
  async function pointAt(root: string): Promise<void> {
    await mkdir(join(tmp, "home"), { recursive: true });
    await writeFile(join(tmp, "home", "workspace"), `${root}\n`);
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
    await mkdir(join(tmp, "user"));
    socketPath = join(userData, "app-state", manifest.id, "scheduler.sock");
    keeperSocket = join(userData, "run", "keepers", `${manifest.id}.sock`);
    env = cleanEnv({
      POMADE_APP_ID: manifest.id,
      POMADE_APP_KEY_FILE: keyFile,
      POMADE_KEEPER_SOCKET: keeperSocket,
      POMADE_HOME: join(tmp, "home"),
      POMADE_RUNNER_TICK_MS: "20",
      HOME: join(tmp, "user"),
      SHELL: "/bin/sh",
    });
    workspace = join(tmp, "ws");
    await mkdir(join(workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await pointAt(workspace);
  });

  test.afterEach(async () => {
    for (const scheduler of started.splice(0)) await scheduler.kill();
    await stopKeeper(keeperSocket);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  });

  test("the scheduler starts with Pomade closed, logs to stdout and ticks at the overridden tick", async () => {
    const scheduler = startScheduler();
    await expect.poll(() => scheduler.output()).toMatch(new RegExp(`^\\S+Z scheduler ${VERSION} started \\(pid ${scheduler.child.pid}, tick 20 ms\\)\\n`, "m"));

    const first = await callScheduler(socketPath, "status", null);
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
    expect(await callScheduler(socketPath, "status", null)).toMatchObject({ status: "ok", value: { pid: first.child.pid } });
  });

  test("a scheduler started after one was killed takes over", async () => {
    const first = startScheduler();
    await expect.poll(() => first.output()).toContain("started");
    await first.kill();
    expect((await stat(socketPath)).isSocket()).toBe(true);

    const second = startScheduler();
    await expect.poll(() => second.output()).toContain("started");
    expect(await callScheduler(socketPath, "status", null)).toMatchObject({ status: "ok", value: { pid: second.child.pid } });
  });

  test("with no workspace recorded the scheduler waits, serves nothing and writes nothing, then starts once Pomade records one", async () => {
    await rm(join(tmp, "home"), { recursive: true });
    const scheduler = startScheduler();
    await expect.poll(() => scheduler.output()).toContain("waiting for a workspace: Pomade has not recorded one — the scheduler starts once it does\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(scheduler.output().match(/waiting for a workspace/g)).toHaveLength(1);
    expect((await command("--version")).stdout).toBe(`pomade-runner ${VERSION}\nscheduler: not running\n`);
    await expect(stat(join(tmp, "ud", "app-state"))).rejects.toThrow();
    await expect(stat(join(workspace, "Apps/pomade-runner/records"))).rejects.toThrow();

    await pointAt(workspace);
    await expect.poll(() => scheduler.output()).toContain(`jobs: workspace ${workspace}\n`);
    await expect.poll(async () => (await callScheduler(socketPath, "status", null)).status).toBe("ok");
    // The keeper it starts is up before teardown stops it: one still starting would outlive it.
    await expect.poll(() => scheduler.output()).toContain("keeper: connected");
  });

  test("the scheduler refuses to start outside Pomade", async () => {
    const { POMADE_APP_KEY_FILE: _keyFile, ...outside } = env;
    const scheduler = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), outside);
    started.push(scheduler);
    expect(await scheduler.exited).toBe(1);
    expect(scheduler.output()).toContain("not started: POMADE_APP_KEY_FILE is not set");
  });

  test("the scheduler refuses to start without the keeper's socket, or with a key it cannot read", async () => {
    const { POMADE_KEEPER_SOCKET: _keeper, ...noKeeper } = env;
    const unplaced = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), noKeeper);
    started.push(unplaced);
    expect(await unplaced.exited).toBe(1);
    expect(unplaced.output()).toContain("not started: POMADE_KEEPER_SOCKET is not set");

    const keyless = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), { ...env, POMADE_APP_KEY_FILE: join(tmp, "ud", "app-keys", "nobody") });
    started.push(keyless);
    expect(await keyless.exited).toBe(1);
    expect(keyless.output()).toContain(`not started: cannot read the app's key from ${join(tmp, "ud", "app-keys", "nobody")}`);
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

  test.describe("a reader that closes its pipe", () => {
    const entry = (): string => join(build, "cli/pomade-runner.mjs");
    const withClosedReader = (closed: "stdout" | "stderr", ...args: string[]) => runWithClosedReader(process.execPath, [entry(), ...args], { env: { ...env, POMADE_CLIENT: "command" }, cwd: tmp }, closed);

    test("a command ends with its own status and nothing on the other stream, whichever stream's reader closed", async () => {
      const scheduler = startScheduler();
      await expect.poll(() => scheduler.output()).toMatch(/keeper: connected — version \w+, pid \d+\n/);
      for (const args of [["sessions"], ["history"], ["list"], ["runs"], ["services"], ["--help"], ["--version"]]) {
        const printed = await command(...args);
        expect(printed, args.join(" ")).toMatchObject({ code: 0, stderr: "", stdout: expect.stringMatching(/\S/) });
        expect(await withClosedReader("stdout", ...args), args.join(" ")).toEqual({ code: 0, stdout: "", stderr: "" });
      }
    });

    test("a message to stderr ends the same way: a refused command keeps its own status", async () => {
      expect(await command("frobnicate")).toMatchObject({ code: 2, stderr: expect.stringContaining("unknown command") });
      expect(await withClosedReader("stderr", "frobnicate")).toEqual({ code: 2, stdout: "", stderr: "" });
      expect(await command("projects")).toMatchObject({ code: 1, stderr: expect.stringContaining("Pomade is not running") });
      expect(await withClosedReader("stderr", "projects")).toEqual({ code: 1, stdout: "", stderr: "" });
    });
  });

  test.describe("job files", () => {
    const VALID = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
    const BROKEN = VALID.replace("13:00", "25:00");
    const ERROR = 'schedule.daily.at — "25:00" is not a time. Fix: write a time like 7:00 or 13:30 (H:MM, 24-hour).';
    let jobs: string;

    test.beforeEach(() => {
      jobs = join(workspace, "Apps/pomade-runner/jobs");
    });

    test("the scheduler loads the jobs folder with Pomade closed and applies a change within a second", async () => {
      await writeFile(join(jobs, "backup.md"), VALID);
      const scheduler = startScheduler();
      await expect.poll(() => scheduler.output()).toContain(`jobs: workspace ${workspace}\n`);
      await expect.poll(() => scheduler.output()).toContain("jobs: 1 job file, 0 invalid\n");

      await writeFile(join(jobs, "backup.md"), BROKEN);
      await expect.poll(() => scheduler.output(), { timeout: 1000 }).toContain("jobs: 1 job file, 1 invalid\n");
      await rm(join(jobs, "backup.md"));
      await expect.poll(() => scheduler.output(), { timeout: 1000 }).toContain("jobs: 0 job files, 0 invalid\n");
    });

    test("the scheduler follows a workspace switch: it starts again on the other workspace, with its records", async () => {
      const scheduler = startScheduler();
      await expect.poll(() => scheduler.output()).toContain(`jobs: workspace ${workspace}\n`);
      expect((await command("pause")).code).toBe(0);
      await expect.poll(() => stat(join(workspace, "Apps/pomade-runner/records/switch.json")).then(() => true, () => false)).toBe(true);
      const other = join(tmp, "other");
      await mkdir(join(other, "Apps/pomade-runner/jobs"), { recursive: true });
      await writeFile(join(other, "Apps/pomade-runner/jobs/backup.md"), VALID);
      await pointAt(other);
      await expect.poll(() => scheduler.output()).toContain(`workspace: ${other} — the scheduler starts again on it\n`);
      await expect.poll(() => scheduler.output()).toContain(`jobs: workspace ${other}\n`);
      // The other workspace's switch is its own: Running.
      await expect.poll(async () => (await command("runs")).stdout).toMatch(/^switch: .* — scheduled runs run\n/);
      await expect.poll(() => scheduler.output().split(`jobs: workspace ${other}\n`)[1]).toMatch(/Z jobs: 1 job file, 0 invalid\n/);
    });

    test("pomade-runner check validates from disk with Pomade and the scheduler closed", async () => {
      await writeFile(join(jobs, "backup.md"), VALID);
      expect(await command("check")).toEqual({
        code: 0,
        stdout: `1 job file in ws/Apps/pomade-runner/jobs: no problems.\nProject ids were not checked: Pomade is closed. Run it again with Pomade open to check them too.\n`,
        stderr: "",
      });
      await writeFile(join(jobs, "backup.md"), BROKEN);
      const broken = await command("check", join(jobs, "backup.md"));
      expect(broken.code).toBe(1);
      expect(broken.stdout.split("\n")[0]).toBe(`ws/Apps/pomade-runner/jobs/backup.md:7: ${ERROR}`);
      expect(await command("check", "nowhere.md")).toMatchObject({ code: 1, stdout: expect.stringContaining("nowhere.md: not a job file") });
      expect(await command("projects")).toMatchObject({ code: 1, stderr: expect.stringContaining("Pomade is not running") });
    });
  });
});
