// Scheduled scripts as processes: the scheduler of a copy of the built app folder runs the scripts
// of a temp workspace as sessions of a real keeper, with Pomade closed (`support/runner.ts`), on a
// clock set through POMADE_RUNNER_CLOCK in Madrid's time zone — so a day's schedule plays out in
// seconds. Every rule's edge is in the unit tests (`src/scheduler/*.test.ts`); these show E-002's
// acceptance on real processes: the runs, their history and output, overlap, the command, the
// notices that wait in Pomade's queue while it is closed, and the records the workspace carries to
// another Mac.

import { access, cp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { followSession } from "pomade-kit/node";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { createRunnerWorld, type RunnerWorld } from "./support/runner";

const ZONE = { TZ: "Europe/Madrid" };

/** A scheduler clock that starts at `local` (Madrid) and runs `rate` times as fast. */
const clock = (local: string, rate = 1): Record<string, string> => ({ ...ZONE, POMADE_RUNNER_CLOCK: `${local}+01:00`, POMADE_RUNNER_CLOCK_RATE: String(rate) });

const exists = (path: string): Promise<boolean> => access(path).then(
  () => true,
  () => false,
);

/** A script job file. */
const scriptFile = (name: string, command: string, extra: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\n${extra}---\n`;

/** The scheduler's clock at its latest tick (epoch ms); 0 before one. */
async function schedulerTime(world: RunnerWorld): Promise<number> {
  const status = await callScheduler(world.socketPath, "status", null);
  return status.status === "ok" && status.value.lastTickAt !== null ? Date.parse(status.value.lastTickAt) : 0;
}

test.describe("scheduled scripts", () => {
  let world: RunnerWorld;

  test.beforeEach(async () => {
    world = await createRunnerWorld();
  });

  test.afterEach(async () => {
    await world.dispose();
  });

  test("1 · a daily 13:00 script runs at 13:00 in its folder with its context, and lands in History with its output", async () => {
    await world.writeJob("backup.md", scriptFile("Backup", 'echo "backed up as $POMADE_JOB $POMADE_TRIGGER $POMADE_RUN_ID in $PWD"', "schedule:\n  daily: { at: 13:00 }\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T12:59:58"));
    await world.ready(scheduler);
    await expect.poll(() => world.history(), { timeout: 10_000 }).toHaveLength(1);
    const [record] = await world.history();
    expect(record).toMatchObject({ job: "backup", name: "Backup", trigger: "scheduled", state: "done", exitCode: 0, dueAt: Date.parse("2026-11-18T13:00:00+01:00") });
    expect(record?.run).toMatch(/^20261118-120000-[0-9a-f]{6}$/);
    expect(record?.lastLines).toEqual([`backed up as backup scheduled ${record?.run ?? ""} in ${world.tmp}/ws`]);
    expect(await readFile(record?.log ?? "", "utf8")).toContain("backed up as backup scheduled");
    expect(scheduler.output()).toContain(`run backup ${record?.run ?? ""}: started (scheduled)\n`);
    // Recorded, its session is forgotten.
    await expect.poll(async () => (await world.sessions()).sessions.filter((session) => session.kind === "run")).toEqual([]);
    expect((await world.command("list")).stdout).toMatch(/^backup {2}Backup {2}script {2}daily at 13:00 {2}next 2026-11-19T12:00:00\.000Z · last done, \S+, took \d+ ms\n$/);
  });

  test("2 · every 30 min, 9–19, weekdays only: runs on a Wednesday at 9:00 and 9:30", async () => {
    await world.writeJob("check.md", scriptFile("Check", "true", "schedule:\n  every: { minutes: 30, from: 9:00, to: 19:00 }\n  only: weekdays\n"));
    // Two scheduler minutes ahead of 9:00 — under a second here — so a slow start never misses it.
    const scheduler = world.startScheduler(clock("2026-11-18T08:58:00", 180));
    await world.ready(scheduler);
    await expect.poll(async () => (await world.history()).map((record) => record.dueAt), { timeout: 20_000 }).toEqual([Date.parse("2026-11-18T09:30:00+01:00"), Date.parse("2026-11-18T09:00:00+01:00")]);
    expect((await world.history()).map((record) => record.state)).toEqual(["done", "done"]);
  });

  test("2 · every 30 min, 9–19, weekdays only: no runs on a Saturday", async () => {
    await world.writeJob("check.md", scriptFile("Check", "true", "schedule:\n  every: { minutes: 30, from: 9:00, to: 19:00 }\n  only: weekdays\n"));
    const scheduler = world.startScheduler(clock("2026-11-21T08:59:56", 180));
    await world.ready(scheduler);
    await expect.poll(() => schedulerTime(world), { timeout: 20_000 }).toBeGreaterThan(Date.parse("2026-11-21T09:31:00+01:00"));
    expect(await world.history()).toEqual([]);
    expect(scheduler.output()).not.toContain("run check");
    expect((await world.command("list")).stdout).toContain("check  Check  script  every 30 min on weekdays, 9:00–19:00  next 2026-11-23T08:00:00.000Z · never ran\n");
  });

  test("3 · once at 23:00 runs once, then shows as finished", async () => {
    await world.writeJob("tonight.md", scriptFile("Tonight", "echo once", "schedule:\n  once: 2026-11-18 23:00\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T22:59:58", 30));
    await world.ready(scheduler);
    await expect.poll(() => world.history(), { timeout: 10_000 }).toHaveLength(1);
    await expect.poll(() => schedulerTime(world)).toBeGreaterThan(Date.parse("2026-11-18T23:02:00+01:00"));
    expect(await world.history()).toEqual([expect.objectContaining({ job: "tonight", state: "done", lastLines: ["once"] }) as RunRecord]);
    expect((await world.command("list")).stdout).toMatch(/^tonight {2}Tonight {2}script {2}once on Nov 18, 2026 at 23:00 {2}finished · last done, /);
  });

  test("4, 5, 8 · with Pomade closed, a failing script's one notice waits in Pomade's queue, a click opens its result; a success with on-failure makes none", async () => {
    await world.writeJob("fail.md", scriptFile("Fail", "echo working; echo boom >&2; exit 3", "schedule:\n  daily: { at: 13:00 }\n"));
    await world.writeJob("fine.md", scriptFile("Fine", "echo fine", "schedule:\n  daily: { at: 13:00 }\nnotify: on-failure\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T12:59:58"));
    await world.ready(scheduler);
    await expect.poll(() => world.history(), { timeout: 10_000 }).toHaveLength(2);
    const failed = (await world.history("fail"))[0];
    expect(failed).toMatchObject({ state: "failed", exitCode: 3, lastLines: ["working", "boom"] });
    await expect.poll(() => world.queuedNotices()).toHaveLength(1);
    expect(await world.queuedNotices()).toMatchObject([{ source: "pomade-runner", title: "Fail failed", body: "exit 3 · boom", action: { kind: "openApp", route: `run/fail/${failed?.run ?? ""}` } }]);
    expect(scheduler.output()).toContain('notice "Fail failed": queued for Pomade\'s next launch\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await world.queuedNotices()).toHaveLength(1);
  });

  test("6 · overlap: a run still going at the next one is skipped · previous run still going", async () => {
    await world.writeJob("slow.md", scriptFile("Slow", "sleep 3", "schedule:\n  every: { minutes: 1 }\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T12:59:59", 60));
    await world.ready(scheduler);
    await expect.poll(async () => (await world.history()).find((record) => record.state === "skipped"), { timeout: 10_000 }).toMatchObject({ reason: "previous run still going", startedAt: null });
    expect((await world.sessions()).sessions.filter((session) => session.kind === "run" && session.info.state === "running")).toHaveLength(1);
  });

  test("6 · overlap queue: a run due while one goes waits, and runs after it", async () => {
    await world.writeJob("slow.md", scriptFile("Slow", 'echo "start $POMADE_RUN_ID"; sleep 2', "schedule:\n  every: { minutes: 1 }\noverlap: queue\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T12:59:59", 60));
    await world.ready(scheduler);
    await expect.poll(() => scheduler.output(), { timeout: 10_000 }).toMatch(/run slow \S+: queued · after the previous run\n/);
    const queued = /run slow (\S+): queued · after the previous run\n/.exec(scheduler.output())?.[1] ?? "";
    await expect.poll(async () => (await world.history("slow")).find((record) => record.run === queued), { timeout: 15_000 }).toMatchObject({ state: "done", lastLines: [`start ${queued}`] });
    const done = (await world.history("slow")).filter((record) => record.state === "done");
    const first = done.at(-1);
    const second = done.find((record) => record.run === queued);
    expect(first?.run).not.toBe(queued);
    expect(second?.startedAt ?? 0).toBeGreaterThan(first?.startedAt ?? Infinity);
    const log = scheduler.output();
    expect(log.indexOf(`run slow ${queued}: started`)).toBeGreaterThan(log.indexOf(`run slow ${first?.run ?? ""}: done`));
  });

  test("7 · pomade-runner run starts a run visible in History; list and history print the jobs and the runs; a running run is attachable and Ctrl+C stops it as stopped by you", async () => {
    await world.writeJob("backup.md", scriptFile("Backup", "echo copying; sleep 0.3; echo copied", "hook: { event: project-created }\n"));
    await world.writeJob("ticker.md", scriptFile("Ticker", 'i=0; while :; do i=$((i+1)); echo "tick $i"; sleep 0.2; done', "hook: { event: project-created }\n"));
    const scheduler = world.startScheduler(ZONE);
    await world.ready(scheduler);

    const ran = await world.command("run", "backup");
    expect(ran).toMatchObject({ code: 0, stderr: "" });
    expect(ran.stdout).toMatch(/^backup {2}Backup {2}run \d{8}-\d{6}-[0-9a-f]{6} {2}running, output \S+\.log\n$/);
    await expect.poll(() => world.history("backup")).toEqual([expect.objectContaining({ trigger: "manual", state: "done", lastLines: ["copying", "copied"] }) as RunRecord]);
    expect((await world.command("history")).stdout).toMatch(/^backup {2}Backup {2}manual {2}done, \S+, took [\d.]+ m?s {2}output \S+\.log\n$/);
    expect((await world.command("list")).stdout).toMatch(/^backup {2}Backup {2}script {2}when a project is created {2}no next run · last done, [^\n]+\nticker {2}Ticker {2}script {2}when a project is created {2}no next run · never ran\n$/);

    const ticker = await world.command("run", "ticker");
    expect(ticker.code).toBe(0);
    const session = `run:ticker:${/ run (\S+) /.exec(ticker.stdout)?.[1] ?? ""}`;
    let output = "";
    const tab = followSession({ socketPath: world.keeperSocket, app: "pomade", session, cols: 80, rows: 24 }, { onSnapshot: (data) => (output += data), onOutput: (data) => (output += data) });
    try {
      await expect.poll(() => output).toContain("tick 2");
      tab.input("\x03");
      await expect.poll(() => world.history("ticker")).toEqual([expect.objectContaining({ state: "stopped-by-you", trigger: "manual" }) as RunRecord]);
    } finally {
      tab.close();
    }
    expect(await world.queuedNotices()).toEqual([]);
  });

  test("T-027 · a manual job — no schedule, hook or after — checks clean and never runs by itself; pomade-runner run runs it as manual, and its end fires the job chained after it", async () => {
    await world.writeJob("by-hand.md", scriptFile("By hand", "echo by hand", ""));
    await world.writeJob("then.md", scriptFile("Then", "echo then", "after: { job: by-hand }\n"));
    expect(await world.command("check")).toMatchObject({ code: 0, stdout: expect.stringMatching(/^2 job files in \S+: no problems\.\n/) as unknown });
    // Two hours of the scheduler's clock pass in seconds: nothing runs.
    const scheduler = world.startScheduler(clock("2026-11-18T12:00:00", 1800));
    await world.ready(scheduler);
    await expect.poll(() => schedulerTime(world), { timeout: 10_000 }).toBeGreaterThan(Date.parse("2026-11-18T14:00:00+01:00"));
    expect(await world.history()).toEqual([]);
    expect((await world.command("list")).stdout).toMatch(/^by-hand {2}By hand {2}script {2}manual {2}no next run · never ran\n/);

    expect(await world.command("run", "by-hand")).toMatchObject({ code: 0, stderr: "" });
    await expect.poll(() => world.history(), { timeout: 10_000 }).toEqual([
      expect.objectContaining({ job: "then", trigger: "chain", state: "done", lastLines: ["then"] }) as RunRecord,
      expect.objectContaining({ job: "by-hand", trigger: "manual", state: "done", lastLines: ["by hand"] }) as RunRecord,
    ]);
    expect((await world.command("history", "by-hand")).stdout).toMatch(/^by-hand {2}By hand {2}manual {2}done, /);
  });

  test("Enable and Disable write the job's file; a disabled job does not run", async () => {
    await world.writeJob("backup.md", scriptFile("Backup", "true", "schedule:\n  daily: { at: 13:00 }\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T12:59:57"));
    await world.ready(scheduler);
    expect(await world.command("disable", "Backup")).toEqual({ code: 0, stdout: "backup  Backup  disabled\n", stderr: "" });
    expect(await readFile(`${world.jobs}/backup.md`, "utf8")).toContain("enabled: false\n");
    await expect.poll(() => schedulerTime(world), { timeout: 10_000 }).toBeGreaterThan(Date.parse("2026-11-18T13:00:01+01:00"));
    expect(await world.history()).toEqual([]);
    expect((await world.command("run", "backup")).stderr).toBe('pomade-runner run: cannot run "backup": "Backup" is disabled in its file; enable it first.\n');
    expect(await world.command("enable", "backup")).toMatchObject({ code: 0, stdout: "backup  Backup  enabled\n" });
  });

  test("the records live in the workspace: a live run's output grows in the state folder only; at its end the log moves beside its record, and the state folder holds only this Mac's own", async () => {
    await world.writeJob("fail.md", scriptFile("Fail", "echo boom; sleep 1; echo bust; exit 3", "schedule:\n  daily: { at: 13:00 }\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T12:59:58"));
    await world.ready(scheduler);
    const state = join(world.userData, "app-state", manifest.id);
    const records = join(world.workspace, "Apps/pomade-runner/records");
    const started = (): string => /run fail (\S+): started/.exec(scheduler.output())?.[1] ?? "";
    await expect.poll(started).not.toBe("");
    const run = started();
    const running = await world.running(`run:fail:${run}`);
    const live = join(state, "output", "fail", `${run}.log`);
    const kept = join(records, "output", "fail", `${run}.log`);
    // While it runs: its output grows in the state folder, and nothing of it is in the workspace.
    expect(running.log).toBe(live);
    await expect.poll(() => readFile(live, "utf8").catch(() => "")).toContain("boom");
    expect(await exists(kept)).toBe(false);
    expect(await exists(join(records, "output"))).toBe(false);

    await expect.poll(() => world.history(), { timeout: 10_000 }).toHaveLength(1);
    const [record] = await world.history();
    expect(record?.log).toBe(kept);
    expect(await readFile(kept, "utf8")).toContain("bust");
    expect(await exists(live)).toBe(false);
    expect((await world.command("pause", "low")).code).toBe(0);

    await expect.poll(async () => (await readdir(records)).sort()).toEqual(expect.arrayContaining(["history", "needs-you.json", "output", "runs.json", "switch.json"]));
    const day = await readFile(join(records, "history", "2026-11-18.jsonl"), "utf8");
    expect(day).toContain(`"run":"${run}"`);
    expect(day).toContain(`"log":"output/fail/${run}.log"`);
    expect(day).not.toContain(world.tmp);
    expect(await readFile(join(records, "runs.json"), "utf8")).not.toContain(world.tmp);
    // The state folder: the control socket, the keeper, the session records, the output being
    // written, the projects heard, this Mac's service supervision and where it put the agent skill —
    // nothing of the records.
    expect((await readdir(state)).filter((name) => !["keeper", "output", "projects.json", "scheduler.sock", "services.json", "sessions.json", "skill.json"].includes(name))).toEqual([]);
  });

  test("a workspace copied to a fresh user-data folder shows the same History with its output, switch and Needs you; what it missed since its last alive time goes to each job's policy", async () => {
    await world.writeJob("fail.md", scriptFile("Fail", "echo boom; exit 3", "schedule:\n  daily: { at: 13:00 }\nlow-priority: false\n"));
    await world.writeJob("inbox.md", scriptFile("Inbox", "echo triaged", "schedule:\n  daily: { at: 14:00 }\nlow-priority: false\nmissed: wait-for-me\n"));
    const first = world.startScheduler(clock("2026-11-18T12:59:58"));
    await world.ready(first);
    await expect.poll(() => world.history(), { timeout: 10_000 }).toHaveLength(1);
    const run = (await world.history())[0]?.run ?? "";
    expect((await world.command("pause", "low")).code).toBe(0);
    const before = (await world.command("runs")).stdout;
    first.child.kill("SIGTERM");
    expect(await first.exited).toBe(0);

    const copy = await createRunnerWorld();
    try {
      await cp(join(world.workspace, "Apps"), join(copy.workspace, "Apps"), { recursive: true });
      // Two hours on: the 14:00 run of Inbox was missed while no scheduler ran.
      const second = copy.startScheduler(clock("2026-11-18T15:00:00"));
      await copy.ready(second);
      const [failed] = await copy.history();
      expect(failed).toMatchObject({ job: "fail", run, state: "failed", exitCode: 3, lastLines: ["boom"] });
      expect(failed?.log).toBe(join(copy.workspace, "Apps/pomade-runner/records/output/fail", `${run}.log`));
      expect(await readFile(failed?.log ?? "", "utf8")).toContain("boom");
      expect((await copy.command("history", "fail")).stdout).toMatch(new RegExp(`^fail {2}Fail {2}scheduled {2}failed · exit 3, \\S+, took [\\d.]+ m?s {2}output ${failed?.log ?? ""}\\n$`));
      await expect.poll(async () => (await copy.command("runs")).stdout).toContain("needs you: Inbox — ");
      const after = (await copy.command("runs")).stdout;
      expect(after.split("\n")[0]).toBe(before.split("\n")[0]);
      expect(after.split("\n")[0]).toContain("runs of low-priority jobs are held");
      expect(after).toContain("needs you: Fail — failed: exit 3, ");
      expect(after).toMatch(/needs you: Inbox — [^\n]+; it waits for you: pomade-runner missed inbox run-once\|run-at <time>\|skip, or in Runner\n/);
    } finally {
      await copy.dispose();
    }
  });
});
