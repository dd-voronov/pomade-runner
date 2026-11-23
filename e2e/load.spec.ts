// Missed runs and load as processes: the scheduler of a copy of the built app folder runs the
// scripts of a temp workspace as sessions of a real keeper, with Pomade closed
// (`support/runner.ts`), on a clock set through POMADE_RUNNER_CLOCK in Madrid's time zone. Every
// rule's edge is in the unit tests (`src/scheduler/load.test.ts` and its neighbours); these show
// E-003's acceptance on real processes.
//
// Sleep is simulated the way the scheduler detects it: the scheduler process is stopped (SIGSTOP)
// while its clock runs on, so its next tick comes long after the previous one — the gap a Mac's
// sleep leaves. Power-off is the scheduler killed with its keeper — macOS ends the user's
// processes — and started again later on its clock: a login. The clock runs 60 times as fast: a
// second is a minute, so a test machine stalled for over a second looks like one more wake (a tick
// gap over a minute is one). The specs therefore read the log up to the run they ask about.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord, RunsReport } from "../src/scheduler/model";
import { createRunnerWorld, serviceFile, type RunnerWorld } from "./support/runner";
import type { SchedulerProcess } from "./support/scheduler";

const ZONE = { TZ: "Europe/Madrid" };

/** A scheduler clock that starts at `local` (Madrid) and runs `rate` times as fast. */
const clock = (local: string, rate = 60): Record<string, string> => ({ ...ZONE, POMADE_RUNNER_CLOCK: `${local}+01:00`, POMADE_RUNNER_CLOCK_RATE: String(rate) });

/** A script job file. */
const scriptFile = (name: string, command: string, extra: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\n${extra}---\n`;

/** A local time on Madrid's clock, as epoch ms. */
const madrid = (local: string): number => Date.parse(`${local}+01:00`);

async function schedulerTime(world: RunnerWorld): Promise<number> {
  const status = await callScheduler(world.socketPath, "status", null);
  return status.status === "ok" && status.value.lastTickAt !== null ? Date.parse(status.value.lastTickAt) : 0;
}

async function runsReport(world: RunnerWorld): Promise<RunsReport> {
  const result = await callScheduler(world.socketPath, "runs", null);
  if (result.status !== "ok") throw new Error(`runs: ${result.status === "failed" ? result.message : result.status}`);
  return result.value;
}

async function writeSettings(world: RunnerWorld, text: string): Promise<void> {
  await mkdir(join(world.tmp, "ws/Apps/pomade-runner"), { recursive: true });
  await writeFile(join(world.tmp, "ws/Apps/pomade-runner/settings.yaml"), text);
}

/** The scheduler's log up to the line `line` first matches — what led to a run's start. */
function logBefore(scheduler: SchedulerProcess, line: RegExp): string {
  const log = scheduler.output();
  const at = log.search(line);
  if (at < 0) throw new Error(`no ${String(line)} in the log`);
  return log.slice(0, at);
}

/** When the latest warm-up of a log ends, on the scheduler's clock (to the minute it names). */
function warmUpEnd(log: string): number {
  const time = [...log.matchAll(/warm-up: the services are up; caught-up and hook runs wait until (\d\d:\d\d)\n/g)].at(-1)?.[1];
  if (time === undefined) throw new Error("no warm-up in the log");
  return madrid(`2026-11-18T${time}:00`);
}

/** Wait until the scheduler's clock is past a local time. */
async function until(world: RunnerWorld, local: string, timeout = 30_000): Promise<void> {
  await expect.poll(() => schedulerTime(world), { timeout }).toBeGreaterThan(madrid(local));
}

test.describe("missed runs and load", () => {
  let world: RunnerWorld;

  test.beforeEach(async () => {
    world = await createRunnerWorld();
  });

  test.afterEach(async () => {
    await world.dispose();
  });

  test("1 · run on wake: asleep across 7:00, one caught-up run after the warm-up; with worth-until passed, missed · skipped", async () => {
    await world.writeJob("summary.md", scriptFile("Summary", 'echo "summary $POMADE_TRIGGER"', "schedule:\n  daily: { at: 7:00 }\n"));
    await world.writeJob("early.md", scriptFile("Early", "echo early", "schedule:\n  daily: { at: 7:00 }\nworth-until: 7:05\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T06:59:00"));
    await world.ready(scheduler);
    // Asleep from before 7:00 to past 7:05.
    scheduler.child.kill("SIGSTOP");
    await new Promise((resolve) => setTimeout(resolve, 8000));
    scheduler.child.kill("SIGCONT");
    await expect.poll(() => scheduler.output()).toMatch(/wake: \d+ min( \d+ s)? since the previous tick; caught-up and hook runs wait for the warm-up\n/);
    expect(await schedulerTime(world)).toBeGreaterThan(madrid("2026-11-18T07:05:00"));

    await expect.poll(() => world.history("summary"), { timeout: 15_000 }).toEqual([expect.objectContaining({ trigger: "caught-up", state: "done", dueAt: madrid("2026-11-18T07:00:00"), lastLines: ["summary caught-up"] }) as RunRecord]);
    const [caught] = await world.history("summary");
    // After the 2-minute warm-up, counted from the wake.
    const log = logBefore(scheduler, /run summary \S+: started \(caught-up\)/);
    expect(caught?.startedAt ?? 0).toBeGreaterThanOrEqual(warmUpEnd(log));
    expect(await world.history("early")).toEqual([expect.objectContaining({ state: "missed", reason: "skipped · past 7:05", startedAt: null, dueAt: madrid("2026-11-18T07:00:00") }) as RunRecord]);
    expect(log.lastIndexOf("warm-up: the services are up")).toBeGreaterThan(log.indexOf("wake:"));
    expect(log.lastIndexOf("warm-up: over")).toBeGreaterThan(log.lastIndexOf("warm-up: the services are up"));
    // One run, however long it slept.
    await until(world, "2026-11-18T07:20:00");
    expect(await world.history("summary")).toHaveLength(1);
  });

  test("2 · after power-off: the scheduler stopped across two slots makes one caught-up run, not two", async () => {
    await world.writeJob("twice.md", scriptFile("Twice", "echo twice", "schedule:\n  daily: { at: [7:00, 8:00] }\n"));
    const first = world.startScheduler(clock("2026-11-18T06:30:00"));
    await world.ready(first);
    await until(world, "2026-11-18T06:32:00");
    await first.kill();
    await world.logOut();

    const second = world.startScheduler(clock("2026-11-18T09:00:00"));
    await world.ready(second);
    await expect.poll(() => second.output()).toMatch(/runs: last alive 2026-11-18T05:3\d:\S+; what was missed since goes to its policy\n/);
    await expect.poll(() => second.output()).toContain("job twice: missed Wed 07:00, Wed 08:00 — one caught-up run, worth it until Thu 07:00\n");
    await expect.poll(() => world.history("twice"), { timeout: 15_000 }).toEqual([expect.objectContaining({ trigger: "caught-up", state: "done", dueAt: madrid("2026-11-18T08:00:00") }) as RunRecord]);
    await until(world, "2026-11-18T09:10:00");
    expect(await world.history("twice")).toHaveLength(1);
  });

  test("4 · three low-priority jobs due at once: two run, one shows queued · 1 ahead, and starts when one ends", async () => {
    for (const name of ["A", "B", "C"]) await world.writeJob(`${name.toLowerCase()}.md`, scriptFile(name, "sleep 3", "schedule:\n  daily: { at: 13:00 }\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T12:59:57", 1));
    await world.ready(scheduler);
    await expect.poll(async () => (await runsReport(world)).active.map((run) => [run.job, run.state]), { timeout: 10_000 }).toEqual([
      ["a", "running"],
      ["b", "running"],
      ["c", "queued"],
    ]);
    const runs = await world.command("runs");
    expect(runs.stdout).toMatch(/\nc {2}C {2}run \S+ {2}queued · 1 ahead\n/);
    await expect.poll(async () => (await runsReport(world)).active.find((run) => run.job === "c")?.state, { timeout: 10_000 }).toBe("running");
    await expect.poll(() => world.history(), { timeout: 15_000 }).toHaveLength(3);
    const [c] = await world.history("c");
    const ended = Math.min(...(await world.history()).filter((record) => record.job !== "c").map((record) => record.endedAt));
    expect(c?.startedAt ?? 0).toBeGreaterThanOrEqual(ended);
  });

  test("5 · the switch: Pause low-priority holds a script, a job that is not low-priority runs; Pause all holds both, the service keeps running; resume applies the missed-run policies", async () => {
    await world.writeJob("heavy.md", scriptFile("Heavy", "echo heavy", "schedule:\n  every: { minutes: 10 }\n"));
    await world.writeJob("light.md", scriptFile("Light", "echo light", "schedule:\n  every: { minutes: 10 }\nlow-priority: false\nmissed: skip\n"));
    await world.writeJob("web.md", serviceFile("Web", "sleep 600"));
    // Five minutes before 13:00 on a clock 60 times as fast: five real seconds for the pause to
    // land first, on a busy machine too.
    const scheduler = world.startScheduler(clock("2026-11-18T12:55:00"));
    await world.ready(scheduler);
    const paused = await world.command("pause", "low");
    expect(paused.code).toBe(0);
    expect(paused.stdout).toMatch(/^switch: Pause low-priority — runs of low-priority jobs are held; Run now still runs, services keep running \(since \S+\)\n$/);

    await expect.poll(() => world.history("light"), { timeout: 15_000 }).toEqual([expect.objectContaining({ trigger: "scheduled", state: "done", dueAt: madrid("2026-11-18T13:00:00") }) as RunRecord]);
    await until(world, "2026-11-18T13:01:00");
    expect(await world.history("heavy")).toEqual([]);
    expect((await world.command("pause")).stdout).toMatch(/^switch: Pause all — every scheduled run is held/);
    await until(world, "2026-11-18T13:16:00");
    expect(await world.history("heavy")).toEqual([]);
    expect(await world.history("light")).toHaveLength(1);
    expect(await world.service("web")).toMatchObject({ state: "running" });

    expect((await world.command("resume")).stdout).toMatch(/^switch: Running — scheduled runs run/);
    // Heavy (run on wake) catches up once for 13:00 and 13:10; Light (skip) records its 13:10 missed.
    await expect.poll(() => world.history("heavy"), { timeout: 15_000 }).toEqual([expect.objectContaining({ trigger: "caught-up", state: "done", dueAt: madrid("2026-11-18T13:10:00") }) as RunRecord]);
    await expect.poll(() => world.history("light")).toEqual([
      expect.objectContaining({ state: "missed", reason: "skipped", dueAt: madrid("2026-11-18T13:10:00") }) as RunRecord,
      expect.objectContaining({ state: "done", dueAt: madrid("2026-11-18T13:00:00") }) as RunRecord,
    ]);
    expect(await world.service("web")).toMatchObject({ state: "running" });
    // The position survives a restart.
    await world.command("pause", "low");
    await scheduler.kill();
    const again = world.startScheduler(clock("2026-11-18T14:00:00"));
    await world.ready(again);
    expect((await runsReport(world)).switch.position).toBe("pause-low");
  });

  test("6 · a 1-minute time limit stops a long script: failed, stopped: time limit, 1 min, in its record, a notice and pomade-runner history", async () => {
    await world.writeJob("long.md", scriptFile("Long", "echo working; sleep 600", "hook: { event: project-created }\ntime-limit: 1m\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T10:00:00"));
    await world.ready(scheduler);
    expect((await world.command("run", "long")).code).toBe(0);
    await expect.poll(() => world.history("long"), { timeout: 15_000 }).toEqual([expect.objectContaining({ state: "failed", reason: "stopped: time limit, 1 min", limitHit: 1, lastLines: ["working"] }) as RunRecord]);
    expect(scheduler.output()).toMatch(/run long \S+: ran over its time limit of 1 min; stopping it\n/);
    await expect.poll(() => world.queuedNotices()).toEqual([expect.objectContaining({ title: "Long failed", body: "stopped: time limit, 1 min · working" })]);
    expect((await world.command("history", "long")).stdout).toMatch(/^long {2}Long {2}manual {2}stopped: time limit, 1 min, /);
  });

  test("7 · with the long-run warning at 1 minute, the warning appears, and the run keeps going", async () => {
    await writeSettings(world, "long-run-warning: 1m\n");
    await world.writeJob("long.md", scriptFile("Long", "sleep 600", "hook: { event: project-created }\n"));
    const scheduler = world.startScheduler(clock("2026-11-18T10:00:00"));
    await world.ready(scheduler);
    await expect.poll(() => scheduler.output()).toContain("settings: Apps/pomade-runner/settings.yaml — max low-priority runs 2, warm-up 2 min, long-run warning 1 min, history 30 days, skills folder Knowledge/_skills/apps/\n");
    expect((await world.command("run", "long")).code).toBe(0);
    await expect.poll(async () => (await world.command("runs")).stdout, { timeout: 15_000 }).toContain("needs you: Long — running 1 min — still expected?\n");
    await expect.poll(() => world.queuedNotices()).toEqual([expect.objectContaining({ title: "Long has been running 1 min — still expected?" })]);
    await until(world, "2026-11-18T10:05:00");
    expect((await runsReport(world)).active).toEqual([expect.objectContaining({ job: "long", state: "running", limitHit: null })]);
    expect(await world.queuedNotices()).toHaveLength(1);
  });

  test("8 · staged start: after a login with services and two due runs, the services start first, the runs after the warm-up", async () => {
    await world.writeJob("summary.md", scriptFile("Summary", "echo summary", "schedule:\n  daily: { at: 7:00 }\n"));
    await world.writeJob("report.md", scriptFile("Report", "echo report", "schedule:\n  daily: { at: 7:00 }\n"));
    const before = world.startScheduler(clock("2026-11-18T06:30:00"));
    await world.ready(before);
    await until(world, "2026-11-18T06:32:00");
    await before.kill();
    await world.logOut();
    await world.writeJob("api.md", serviceFile("Api", "sleep 600"));
    await world.writeJob("web.md", serviceFile("Web", "sleep 600"));

    const login: SchedulerProcess = world.startScheduler(clock("2026-11-18T07:30:00"));
    await world.ready(login);
    await expect.poll(() => world.history(), { timeout: 20_000 }).toHaveLength(2);
    expect((await world.history()).map((record) => [record.job, record.trigger, record.state]).sort()).toEqual([
      ["report", "caught-up", "done"],
      ["summary", "caught-up", "done"],
    ]);
    const log = login.output();
    const settled = log.indexOf("warm-up: the services are up");
    expect(log.indexOf("service api: starting")).toBeLessThan(log.indexOf("service web: starting"));
    expect(log.indexOf("service web: up")).toBeLessThan(settled);
    expect(log.search(/run report \S+: started \(caught-up\)/)).toBeGreaterThan(log.indexOf("warm-up: over"));
    const warmUpOver = warmUpEnd(logBefore(login, /run \S+ \S+: started \(caught-up\)/));
    for (const record of await world.history()) expect(record.startedAt ?? 0).toBeGreaterThanOrEqual(warmUpOver);
  });
});
