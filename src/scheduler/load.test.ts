// Missed runs and load on a clock the tests set, against the stand-in keeper (`runs-fixture.ts`)
// and a real history on a temp folder: sleep and wake, power-off, DST, clock jumps, each missed-run
// policy and its edges, the staged start's warm-up, the queue and its slots, the switch and resume,
// time limits and long-run warnings — without waiting.

process.env.TZ = "Europe/Madrid";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NoticeParams } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import { recordsFolderOf, stateFolderOf } from "../locations";
import type { JobsSnapshot } from "../jobs/model";
import { createHistory, type History } from "./history";
import { heldRowWords, runTriggerWords, runWords, type ActiveRun, type RunRecord } from "./model";
import { ALIVE_EVERY_MS, createRuns, WAKE_GAP_MS, type Runs } from "./runs";
import { FakeSessions, FakeTurns, memoryStore, memorySwitch, script } from "./runs-fixture";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const ms = (local: string): number => new Date(local).getTime();

describe("missed runs and load", () => {
  let dir: string;
  let now: Date;
  let files: Record<string, string>;
  let snapshot: JobsSnapshot;
  let sessions: FakeSessions;
  let store: ReturnType<typeof memoryStore>;
  let switchStore: ReturnType<typeof memorySwitch>;
  let history: History;
  let settings: Settings;
  let settled: boolean;
  let lines: string[];
  let notices: NoticeParams[];
  let finished: RunRecord[];
  let runs: Runs;
  let randoms: number;

  function load(): void {
    snapshot = checkJobs(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { workspace: "/ws", projects: [] },
    );
  }

  async function open(): Promise<void> {
    runs = createRuns({
      sessions,
      jobs: () => snapshot,
      settings: () => settings,
      servicesSettled: () => settled,
      clock: { now: () => now },
      log: (line) => lines.push(line),
      history,
      store,
      switchStore,
      projectPath: () => null,
      agents: () => null,
      pomade: { up: () => false, open: () => Promise.resolve("Pomade could not be opened: not in this test") },
      turns: new FakeTurns(),
      shell: "/bin/sh",
      pomadeGit: "/nowhere/bin/pomade-git",
      gitResult: (job, run) => `/nowhere/output/${job}/${run}.json`,
      keepLog: () => Promise.resolve(null),
      serviceAction: () => Promise.reject(new Error("no services here")),
      post: (notice) => notices.push(notice),
      onStarted: () => undefined,
      onFinished: (record) => finished.push(record),
      onChange: () => undefined,
      random: () => (++randoms).toString(16).padStart(6, "0"),
    });
    await runs.load();
  }

  /** The scheduler stops — the Mac is off — and starts again at a local time. */
  async function restart(local: string): Promise<void> {
    await runs.close();
    now = new Date(local);
    await open();
    await runs.tick();
  }

  /** Set the clock to a local time and tick. */
  async function at(local: string): Promise<void> {
    now = new Date(local);
    await runs.tick();
  }

  /** Tick every `stepMs` from now to a local time: the Mac awake. */
  async function awake(local: string, stepMs = 1000): Promise<void> {
    const end = ms(local);
    while (now.getTime() < end) {
      now = new Date(Math.min(end, now.getTime() + stepMs));
      await runs.tick();
    }
  }

  const spawned = (): string[] => sessions.spawned.map((spawn) => `${spawn.owner.job} ${spawn.command.env?.POMADE_TRIGGER ?? ""}`);
  const records = async (): Promise<RunRecord[]> => (await history.page({ job: null, before: null, limit: 200 })).records;
  const going = (job: string): ActiveRun[] => runs.active().filter((run) => run.job === job);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prl-"));
    now = new Date("2026-11-18T06:00:00");
    files = { "summary.md": script("Summary", "schedule:\n  daily: { at: 7:00 }\n") };
    load();
    sessions = new FakeSessions(() => now.getTime(), dir);
    store = memoryStore();
    switchStore = memorySwitch();
    history = createHistory(recordsFolderOf(dir), stateFolderOf(dir), () => undefined);
    settings = { ...DEFAULT_SETTINGS };
    settled = true;
    lines = [];
    notices = [];
    finished = [];
    randoms = 0;
    await open();
    await awake("2026-11-18T06:03:00");
  });

  afterEach(async () => {
    await runs.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("sleep and wake", () => {
    it("asleep across 7:00, awake at 8:30: one caught-up run after the 2-minute warm-up", async () => {
      await awake("2026-11-18T06:50:00", 60_000);
      await at("2026-11-18T08:30:00");
      expect(lines).toContain("wake: 1 h 40 min since the previous tick; caught-up and hook runs wait for the warm-up");
      expect(lines).toContain("job summary: missed Wed 07:00 — one caught-up run, worth it until Thu 07:00");
      expect(going("summary").map((run) => [run.state, run.trigger, run.waits])).toEqual([["queued", "caught-up", { kind: "warm-up", until: ms("2026-11-18T08:32:00") }]]);
      await awake("2026-11-18T08:31:59");
      expect(sessions.spawned).toEqual([]);
      await awake("2026-11-18T08:32:00");
      expect(spawned()).toEqual(["summary caught-up"]);
      expect(going("summary")[0]).toMatchObject({ state: "running", dueAt: ms("2026-11-18T07:00:00"), startedAt: ms("2026-11-18T08:32:00") });
      sessions.end(sessions.latest("summary"), "exited", 0);
      await awake("2026-11-18T09:00:00");
      expect(spawned()).toEqual(["summary caught-up"]);
      expect(finished).toEqual([expect.objectContaining({ trigger: "caught-up", state: "done" })]);
    });

    it("awake at 15:00 with worth-until 12:00: missed · skipped", async () => {
      files = { "summary.md": script("Summary", "schedule:\n  daily: { at: 7:00 }\nworth-until: 12:00\n") };
      load();
      await at("2026-11-18T15:00:00");
      await awake("2026-11-18T15:05:00");
      expect(sessions.spawned).toEqual([]);
      expect(await records()).toEqual([expect.objectContaining({ job: "summary", state: "missed", reason: "skipped · past 12:00", trigger: "scheduled", dueAt: ms("2026-11-18T07:00:00") })]);
    });

    it("a caught-up run still in its warm-up when worth-until passes is missed · skipped", async () => {
      files = { "summary.md": script("Summary", "schedule:\n  daily: { at: 7:00 }\nworth-until: 8:31\n") };
      load();
      await at("2026-11-18T08:30:00");
      expect(going("summary")).toHaveLength(1);
      await awake("2026-11-18T08:33:00");
      expect(sessions.spawned).toEqual([]);
      expect(await records()).toEqual([expect.objectContaining({ state: "missed", reason: "skipped · past 8:31" })]);
    });

    it("a wake within 5 minutes of a run still runs it on time, at once", async () => {
      await awake("2026-11-18T06:58:00", 60_000);
      await at("2026-11-18T07:04:00");
      expect(spawned()).toEqual(["summary scheduled"]);
    });

    it("many missed runs make one caught-up run", async () => {
      files = { "check.md": script("Check", "schedule:\n  every: { minutes: 15 }\n") };
      load();
      await at("2026-11-18T14:10:00");
      expect(lines).toContain("job check: missed 32 runs, 06:15–14:00 — one caught-up run, worth it until Wed 14:15");
      await awake("2026-11-18T14:12:30");
      expect(spawned()).toEqual(["check caught-up"]);
      // The caught-up run stands for every run missed while the Mac slept, and its record says so.
      const missed = { count: 32, first: ms("2026-11-18T06:15:00"), last: ms("2026-11-18T14:00:00") };
      expect(going("check")[0]).toMatchObject({ trigger: "caught-up", dueAt: missed.last, missed });
      sessions.end(sessions.latest("check"), "exited", 0);
      await awake("2026-11-18T14:12:32");
      const record = (await records()).find((one) => one.job === "check");
      expect(record).toMatchObject({ state: "done", trigger: "caught-up", missed });
      expect(record === undefined ? null : runTriggerWords(record)).toBe("missed 32 runs, 06:15–14:00 · caught up once");
    });

    it("an on-time run covers a caught-up run still waiting for the warm-up", async () => {
      files = { "hourly.md": script("Hourly", "schedule:\n  every: { hours: 1 }\n") };
      load();
      await awake("2026-11-18T06:50:00", 60_000);
      await at("2026-11-18T08:58:00");
      expect(going("hourly").map((run) => [run.trigger, run.dueAt])).toEqual([["caught-up", ms("2026-11-18T08:00:00")]]);
      await awake("2026-11-18T09:00:00");
      expect(spawned()).toEqual(["hourly scheduled"]);
      expect(await records()).toEqual([expect.objectContaining({ trigger: "caught-up", state: "missed", reason: "skipped · the 09:00 run covers it" })]);
    });

    it("a clock moved ahead is a wake; a clock set back is a fresh start with nothing due", async () => {
      await at("2026-11-18T09:00:00");
      expect(lines.filter((line) => line.startsWith("wake:"))).toHaveLength(1);
      expect(going("summary")).toHaveLength(1);
      await awake("2026-11-18T09:02:00");
      sessions.end(sessions.latest("summary"), "exited", 0);
      await at("2026-11-18T06:30:00");
      await awake("2026-11-18T06:59:00", 60_000);
      expect(sessions.spawned).toHaveLength(1);
      await awake("2026-11-18T07:00:00");
      expect(spawned()).toEqual(["summary caught-up", "summary scheduled"]);
    });

    it("ticks closer than WAKE_GAP_MS are no wake", async () => {
      await awake("2026-11-18T06:30:00", WAKE_GAP_MS);
      expect(lines.filter((line) => line.startsWith("wake:"))).toEqual([]);
    });

    it("the warm-up starts once the services are up", async () => {
      await awake("2026-11-18T06:50:00", 60_000);
      settled = false;
      await at("2026-11-18T08:30:00");
      await awake("2026-11-18T08:35:00", 10_000);
      expect(going("summary")[0]?.waits).toEqual({ kind: "warm-up", until: null });
      settled = true;
      await awake("2026-11-18T08:35:10", 10_000);
      expect(going("summary")[0]?.waits).toEqual({ kind: "warm-up", until: ms("2026-11-18T08:37:10") });
      await awake("2026-11-18T08:37:10", 10_000);
      expect(spawned()).toEqual(["summary caught-up"]);
    });

    it("the warm-up is a setting", async () => {
      settings = { ...settings, warmUpMinutes: 0 };
      await at("2026-11-18T08:30:00");
      expect(spawned()).toEqual(["summary caught-up"]);
    });
  });

  describe("after power-off", () => {
    it("the scheduler stopped across two slots: one caught-up run, not two, after the warm-up", async () => {
      files = { "twice.md": script("Twice", "schedule:\n  daily: { at: [7:00, 8:00] }\n") };
      load();
      await restart("2026-11-18T09:00:00");
      expect(lines).toContain("job twice: missed 2 runs, 07:00–08:00 — one caught-up run, worth it until Thu 07:00");
      await awake("2026-11-18T09:01:59");
      expect(sessions.spawned).toEqual([]);
      await awake("2026-11-18T09:02:00");
      expect(spawned()).toEqual(["twice caught-up"]);
      expect(going("twice")[0]?.dueAt).toBe(ms("2026-11-18T08:00:00"));
      sessions.end(sessions.latest("twice"), "exited", 0);
      // Off for days: still one.
      await restart("2026-11-20T09:00:00");
      expect(lines).toContain("job twice: missed 4 runs, Thu 07:00–Fri 08:00 — one caught-up run, worth it until Sat 07:00");
      await awake("2026-11-20T09:02:00");
      expect(spawned()).toEqual(["twice caught-up", "twice caught-up"]);
    });

    it("knows its last alive time within ALIVE_EVERY_MS, and at once after it fired or missed something", async () => {
      await awake("2026-11-18T06:10:00");
      expect(store.saved.lookedAt).toBeGreaterThan(ms("2026-11-18T06:10:00") - ALIVE_EVERY_MS - 1000);
      await awake("2026-11-18T07:00:00");
      expect(store.saved.lookedAt).toBe(ms("2026-11-18T07:00:00"));
    });

    it("never runs twice what fired before the stop", async () => {
      await awake("2026-11-18T07:00:30");
      expect(sessions.spawned).toHaveLength(1);
      await restart("2026-11-18T07:00:40");
      await awake("2026-11-18T07:10:00");
      expect(sessions.spawned).toHaveLength(1);
    });

    it("follows DST: across spring-forward the skipped 2:30 is 3:30, missed once", async () => {
      files = { "dst.md": script("Dst", "schedule:\n  daily: { at: 2:30 }\nmissed: skip\n") };
      load();
      await restart("2027-03-27T23:00:00");
      await restart("2027-03-28T09:00:00");
      const [latest, before] = await records();
      expect(latest).toMatchObject({ job: "dst", state: "missed", reason: "skipped", dueAt: ms("2027-03-28T03:30:00") });
      expect(before).toMatchObject({ job: "dst", state: "missed", dueAt: ms("2027-03-27T02:30:00") });
      expect(await records()).toHaveLength(2);
    });
  });

  describe("wait for me", () => {
    beforeEach(() => {
      files = { "weekly.md": script("Weekly", "schedule:\n  weekly: { days: [sun], at: 3:00 }\nmissed: wait-for-me\n") };
      load();
    });

    async function missedSunday(): Promise<ActiveRun> {
      await restart("2026-11-23T09:00:00");
      const [run] = going("weekly");
      if (run === undefined) throw new Error("no waiting run");
      return run;
    }

    it("a missed run waits for you: a Needs-you item and a notice, once; never starts on its own", async () => {
      const run = await missedSunday();
      expect(run).toMatchObject({ state: "missed-waiting", trigger: "scheduled", dueAt: ms("2026-11-22T03:00:00") });
      expect(runs.needsYou()).toEqual([{ id: "missed:weekly", kind: "missed", job: "weekly", name: "Weekly", project: null, run: run.run, at: ms("2026-11-22T03:00:00"), missed: { count: 1, first: ms("2026-11-22T03:00:00"), last: ms("2026-11-22T03:00:00") }, detail: "missed Sun 03:00" }]);
      expect(notices).toEqual([{ title: "Weekly · missed Sun 03:00", body: "It waits for you: Run now, Run at… or Skip.", action: { kind: "openApp", route: `run/weekly/${run.run}` } }]);
      await awake("2026-11-23T09:30:00", 10_000);
      expect(sessions.spawned).toEqual([]);
      // Missed again a week later: still one item, at the latest time, noticed once.
      await restart("2026-11-30T09:00:00");
      expect(runs.needsYou()).toEqual([expect.objectContaining({ id: "missed:weekly", run: run.run, at: ms("2026-11-29T03:00:00") })]);
      expect(notices).toHaveLength(1);
    });

    it("Run at… 23:00 runs it at 23:00, through the queue; it shows in Next up", async () => {
      const run = await missedSunday();
      expect(await runs.missed("weekly", { kind: "run-at", at: "23:00" })).toEqual({ ok: true, at: ms("2026-11-23T23:00:00"), runs: 1 });
      expect(runs.needsYou()).toEqual([]);
      expect(going("weekly")).toEqual([expect.objectContaining({ run: run.run, state: "queued", trigger: "caught-up", runAt: ms("2026-11-23T23:00:00"), waits: { kind: "time", at: ms("2026-11-23T23:00:00") } })]);
      expect(runs.nextUp()[0]).toEqual({ job: "weekly", name: "Weekly", project: null, at: ms("2026-11-23T23:00:00"), held: false });
      await awake("2026-11-23T22:59:00", 60_000);
      await awake("2026-11-23T22:59:59");
      expect(sessions.spawned).toEqual([]);
      await awake("2026-11-23T23:00:00");
      expect(spawned()).toEqual(["weekly caught-up"]);
    });

    it("Skip records missed · skipped by you and clears the item", async () => {
      const run = await missedSunday();
      expect(await runs.missed("Weekly", { kind: "skip" })).toEqual({ ok: true, at: null, runs: 0 });
      expect(runs.needsYou()).toEqual([]);
      expect(runs.active()).toEqual([]);
      expect(finished).toEqual([expect.objectContaining({ run: run.run, state: "missed", reason: "skipped by you" })]);
      expect(await runs.missed("weekly", { kind: "skip" })).toEqual({ ok: false, reason: 'no missed run of "weekly" waits for you' });
    });

    it("Run now runs it now, as a run of yours; refused while a run of the job goes with overlap skip", async () => {
      await missedSunday();
      await runs.runNow("weekly");
      expect(await runs.missed("weekly", { kind: "run-now" })).toEqual({ ok: false, reason: '"Weekly" is running, and its overlap is skip' });
      expect(runs.needsYou()).toHaveLength(1);
      sessions.end(sessions.latest("weekly"), "exited", 0);
      await runs.tick();
      expect(await runs.missed("weekly", { kind: "run-now" })).toEqual({ ok: true, at: now.getTime(), runs: 1 });
      expect(spawned()).toEqual(["weekly manual", "weekly manual"]);
      expect(runs.needsYou()).toEqual([]);
    });

    it("a missed run whose job is disabled or gone waits no longer", async () => {
      await missedSunday();
      files = { "weekly.md": script("Weekly", "schedule:\n  weekly: { days: [sun], at: 3:00 }\nmissed: wait-for-me\nenabled: false\n") };
      load();
      await runs.tick();
      expect(runs.needsYou()).toEqual([]);
      expect(finished).toEqual([expect.objectContaining({ state: "missed", reason: "skipped · its job is disabled" })]);
    });

    it("Run at… says why a time will not do", async () => {
      await missedSunday();
      expect(await runs.missed("weekly", { kind: "run-at", at: "soonish" })).toEqual({ ok: false, reason: '"soonish" is not a time — write e.g. 23:00, tomorrow 9:00 or +2h' });
      expect(await runs.missed("weekly", { kind: "run-at", at: "2026-11-23 08:00" })).toEqual({ ok: false, reason: "2026-11-23 08:00 has passed — pick a later time" });
      expect(runs.needsYou()).toHaveLength(1);
    });
  });

  describe("run all (T-026)", () => {
    const DAILY = "schedule:\n  daily: { at: 7:00 }\n";

    beforeEach(() => {
      // A restart with the keeper alive: no login, no warm-up — the runs go as the queue lets them.
      sessions.loggedIn = false;
    });

    /** A job off across the 7:00 of Nov 18, 19 and 20: three missed runs, decided by its policy. */
    async function missedThree(extra = "missed: wait-for-me\n"): Promise<void> {
      files = { "daily.md": script("Daily", `${DAILY}${extra}`) };
      load();
      await restart("2026-11-20T09:00:00");
    }

    /** End the running run of `daily` as the keeper says, and tick. */
    async function end(reason: "exited" | "crashed" | "stopped-by-you" = "exited", code: number | null = 0): Promise<void> {
      sessions.end(sessions.latest("daily"), reason, code);
      now = new Date(now.getTime() + 5_000);
      await runs.tick();
    }

    const dailyRecords = async (): Promise<RunRecord[]> => (await records()).filter((record) => record.job === "daily").reverse();
    const three = { count: 3, first: ms("2026-11-18T07:00:00"), last: ms("2026-11-20T07:00:00") };

    it("Run all 3 runs the job three times, one after another — whatever its overlap — each a History row, caught up n of 3; a failed one goes on to the next", async () => {
      await missedThree("missed: wait-for-me\noverlap: parallel\n");
      expect(runs.needsYou()).toEqual([expect.objectContaining({ kind: "missed", missed: three })]);
      expect(notices).toEqual([expect.objectContaining({ title: "Daily · missed 3 runs, Wed 07:00–Fri 07:00", body: "It waits for you: Run once, Run all 3, Run at… or Skip." })]);
      expect(await runs.missed("Daily", { kind: "run-all" })).toEqual({ ok: true, at: now.getTime(), runs: 3 });
      expect(runs.needsYou()).toEqual([]);
      for (const n of [1, 2, 3]) {
        // One run of the series at a time: the one running, nothing queued beside it.
        expect(going("daily")).toEqual([expect.objectContaining({ state: "running", trigger: "caught-up", missed: three, series: { n, of: 3 } })]);
        expect(spawned()).toHaveLength(n);
        await end(n === 2 ? "crashed" : "exited", n === 2 ? 1 : 0);
      }
      expect(going("daily")).toEqual([]);
      expect(spawned()).toEqual(["daily caught-up", "daily caught-up", "daily caught-up"]);
      const rows = await dailyRecords();
      expect(rows.map((record) => [record.state, record.trigger, record.series])).toEqual([
        ["done", "caught-up", { n: 1, of: 3 }],
        ["failed", "caught-up", { n: 2, of: 3 }],
        ["done", "caught-up", { n: 3, of: 3 }],
      ]);
      // One after another: each started once the one before it ended.
      for (const [index, after] of rows.entries()) if (index > 0) expect(after.startedAt ?? 0).toBeGreaterThanOrEqual(rows[index - 1]?.endedAt ?? Infinity);
      expect(rows.map((record) => runTriggerWords(record))).toEqual(["caught up 1 of 3", "caught up 2 of 3", "caught up 3 of 3"]);
    });

    it("Run once runs one, as a run of yours, and clears the card; the other missed runs are not run", async () => {
      await missedThree();
      expect(await runs.missed("daily", { kind: "run-now" })).toEqual({ ok: true, at: now.getTime(), runs: 1 });
      expect(runs.needsYou()).toEqual([]);
      await end();
      expect(spawned()).toEqual(["daily manual"]);
      expect(going("daily")).toEqual([]);
    });

    it("stopping one of them by hand drops the rest, with a record that says so", async () => {
      files = { "daily.md": script("Daily", `${DAILY}missed: wait-for-me\n`) };
      load();
      await restart("2026-11-21T09:00:00");
      expect(await runs.missed("daily", { kind: "run-all" })).toMatchObject({ ok: true, runs: 4 });
      await end();
      await end("stopped-by-you", null);
      await awake(new Date(now.getTime() + 60_000).toISOString(), 10_000);
      expect(spawned()).toHaveLength(2);
      expect(going("daily")).toEqual([]);
      const rows = await dailyRecords();
      expect(rows.map((record) => runWords(record))).toEqual(["done", "stopped by you", "skipped · 2 dropped: you stopped run 2 of 4"]);
      expect(rows[2]).toMatchObject({ trigger: "caught-up", series: null, missed: null, startedAt: null });
    });

    it("a job disabled meanwhile: the next run is skipped, and drops the rest", async () => {
      await missedThree();
      await runs.missed("daily", { kind: "run-all" });
      files = { "daily.md": script("Daily", `${DAILY}missed: wait-for-me\nenabled: false\n`) };
      load();
      await end();
      expect((await dailyRecords()).map((record) => runWords(record))).toEqual(["done", "skipped · its job is disabled", "skipped · 1 dropped: run 2 of 3 did not start"]);
      expect(going("daily")).toEqual([]);
    });

    it("a job deleted meanwhile: the rest are dropped once the running one ends", async () => {
      await missedThree();
      await runs.missed("daily", { kind: "run-all" });
      files = {};
      load();
      await end();
      expect((await dailyRecords()).map((record) => runWords(record))).toEqual(["done", "skipped · 2 dropped: its job file is gone or invalid"]);
      expect(going("daily")).toEqual([]);
    });

    it("the series lives in runs.json: a scheduler restarted mid-series records the run that ended while it was down, once, and goes on", async () => {
      await missedThree();
      await runs.missed("daily", { kind: "run-all" });
      await runs.close();
      sessions.end(sessions.latest("daily"), "exited", 0);
      await restart("2026-11-20T09:05:00");
      expect(going("daily")).toEqual([expect.objectContaining({ state: "running", series: { n: 2, of: 3 } })]);
      await end();
      await end();
      expect((await dailyRecords()).map((record) => record.series)).toEqual([{ n: 1, of: 3 }, { n: 2, of: 3 }, { n: 3, of: 3 }]);
      expect(spawned()).toHaveLength(3);
    });

    it("a scheduler that dies after writing a stopped run's record and the drop's, before runs.json, writes neither again", async () => {
      await missedThree();
      await runs.missed("daily", { kind: "run-all" });
      const before = structuredClone(store.saved);
      sessions.end(sessions.latest("daily"), "stopped-by-you", null);
      // It dies before it forgets the ended session, too.
      const ended = new Map(sessions.sessions);
      now = new Date(now.getTime() + 5_000);
      await runs.tick();
      expect((await dailyRecords()).map((record) => record.state)).toEqual(["stopped-by-you", "skipped"]);
      await runs.close();
      store.saved = before;
      for (const [id, session] of ended) sessions.sessions.set(id, session);
      now = new Date("2026-11-20T09:05:00");
      await open();
      await runs.tick();
      expect((await dailyRecords()).map((record) => runWords(record))).toEqual(["stopped by you", "skipped · 2 dropped: you stopped run 1 of 3"]);
      expect(going("daily")).toEqual([]);
    });

    it("the switch holds the next run of a series; back to Running it goes on, still the person's Run all", async () => {
      await missedThree();
      await runs.missed("daily", { kind: "run-all" });
      await runs.setSwitch("pause-low");
      await end();
      expect(going("daily")).toEqual([expect.objectContaining({ state: "queued", series: { n: 2, of: 3 }, waits: { kind: "switch", position: "pause-low" } })]);
      await awake(new Date(now.getTime() + 10 * 60_000).toISOString(), 30_000);
      expect(going("daily")).toEqual([expect.objectContaining({ state: "queued", series: { n: 2, of: 3 } })]);
      await runs.setSwitch("running");
      expect(going("daily")).toEqual([expect.objectContaining({ state: "running", series: { n: 2, of: 3 } })]);
      expect(runs.needsYou()).toEqual([]);
    });

    it("an on-time run does not cover a run of the series", async () => {
      await missedThree("missed: wait-for-me\noverlap: parallel\n");
      await runs.missed("daily", { kind: "run-all" });
      await awake("2026-11-21T07:00:30", 3_600_000);
      expect(going("daily")).toEqual([expect.objectContaining({ trigger: "caught-up", series: { n: 1, of: 3 } }), expect.objectContaining({ trigger: "scheduled" })]);
    });

    it("no policy makes a series on its own: run on wake catches up once; Run the other 2 runs the rest, one after another, once", async () => {
      await missedThree("");
      expect(spawned()).toEqual(["daily caught-up"]);
      await end();
      const [caught] = await dailyRecords();
      expect(caught).toMatchObject({ trigger: "caught-up", missed: three, series: null });
      expect(await runs.missed("daily", { kind: "run-others", run: caught?.run ?? "" })).toEqual({ ok: true, at: now.getTime(), runs: 2 });
      expect(going("daily")).toEqual([expect.objectContaining({ state: "running", series: { n: 2, of: 3 }, missed: three })]);
      expect(await runs.missed("daily", { kind: "run-others", run: caught?.run ?? "" })).toMatchObject({ ok: false });
      await end();
      await end();
      expect((await dailyRecords()).map((record) => runTriggerWords(record))).toEqual(["missed 3 runs, Wed 07:00–Fri 07:00 · caught up once", "caught up 2 of 3", "caught up 3 of 3"]);
      // The caught-up run is no longer the job's latest: nothing more to run.
      expect(await runs.missed("daily", { kind: "run-others", run: caught?.run ?? "" })).toMatchObject({ ok: false });
      expect(await runs.missed("daily", { kind: "run-all" })).toEqual({ ok: false, reason: 'no missed run of "daily" waits for you' });
    });

    it("Run all with no missed run waiting runs the other runs of the job's latest caught-up run — what pomade-runner missed <job> run-all does", async () => {
      await missedThree("");
      await end();
      expect(await runs.missed("daily", { kind: "run-all" })).toMatchObject({ ok: true, runs: 2 });
      expect(going("daily")).toEqual([expect.objectContaining({ series: { n: 2, of: 3 } })]);
    });
  });

  describe("the queue", () => {
    beforeEach(async () => {
      files = { "a.md": script("A"), "b.md": script("B"), "c.md": script("C"), "git.md": script("Git", "schedule:\n  daily: { at: 13:00 }\nlow-priority: false\n") };
      load();
      await restart("2026-11-18T12:59:58");
      await awake("2026-11-18T13:00:00");
    });

    it("three low-priority jobs due at once: two run, one is queued · 1 ahead; a job that is not low-priority runs beside them", async () => {
      expect(runs.active().map((run) => [run.job, run.state, run.waits])).toEqual([
        ["a", "running", null],
        ["b", "running", null],
        ["c", "queued", { kind: "slot", ahead: 1 }],
        ["git", "running", null],
      ]);
      expect(sessions.spawned.find((spawn) => spawn.owner.job === "git")?.command.background).toBe(false);
      expect(lines).toContain("run c 20261118-120000-000003: queued · 1 ahead");
      sessions.end(sessions.latest("a"), "exited", 0);
      await awake("2026-11-18T13:00:01");
      expect(going("c")[0]).toMatchObject({ state: "running", waits: null });
    });

    it("Run now waits for a slot too", async () => {
      expect(await runs.runNow("A")).toEqual({ ok: false, reason: '"A" is running, and its overlap is skip' });
      files = { ...files, "d.md": script("D", "hook: { event: login }\n") };
      load();
      expect(await runs.runNow("d")).toMatchObject({ ok: true, run: { state: "queued", waits: { kind: "slot", ahead: 2 } } });
    });

    it("the number of slots is a setting, applied at the next tick", async () => {
      settings = { ...settings, maxLowPriorityRuns: 3 };
      await awake("2026-11-18T13:00:01");
      expect(going("c")[0]?.state).toBe("running");
    });
  });

  describe("the switch", () => {
    beforeEach(async () => {
      files = { "summary.md": script("Summary", "schedule:\n  daily: { at: 13:00 }\n"), "git.md": script("Git", "schedule:\n  daily: { at: 13:00 }\nlow-priority: false\nmissed: skip\n") };
      load();
      await restart("2026-11-18T12:00:00");
    });

    it("Pause low-priority holds the low-priority job; another runs; resume within 5 minutes catches the held one up — a run the switch held is missed", async () => {
      expect(await runs.setSwitch("pause-low")).toEqual({ position: "pause-low", since: now.getTime() });
      expect(switchStore.saved.position).toBe("pause-low");
      // Next up holds the low-priority job's runs only.
      expect(runs.nextUp().slice(0, 2).map((next) => [next.job, next.held])).toEqual([
        ["git", false],
        ["summary", true],
      ]);
      await awake("2026-11-18T13:02:00");
      expect(spawned()).toEqual(["git scheduled"]);
      await runs.setSwitch("running");
      await awake("2026-11-18T13:02:01");
      expect(spawned()).toEqual(["git scheduled", "summary caught-up"]);
      // One run missed reads as it always has.
      expect(going("summary")[0]).toMatchObject({ trigger: "caught-up", missed: { count: 1, first: ms("2026-11-18T13:00:00"), last: ms("2026-11-18T13:00:00") } });
      expect(runTriggerWords(going("summary")[0] ?? { trigger: "manual", cause: null })).toBe("caught up");
    });

    describe("counted", () => {
      beforeEach(async () => {
        files = {
          "low.md": script("Low", "schedule:\n  every: { minutes: 2 }\n"),
          "high.md": script("High", "schedule:\n  every: { minutes: 2 }\nlow-priority: false\n"),
          "wait.md": script("Wait", "schedule:\n  every: { minutes: 2 }\nmissed: wait-for-me\n"),
          "skip.md": script("Skip", "schedule:\n  every: { minutes: 2 }\nmissed: skip\n"),
          "byhand.md": script("By hand", ""),
        };
        load();
        // A first start at 17:39: nothing before it is due.
        await runs.close();
        store = memoryStore();
        now = new Date("2026-11-18T17:39:00");
        await open();
        await runs.tick();
        sessions.spawned.length = 0;
      });

      const held = (): Record<string, boolean> => Object.fromEntries(runs.jobRuns().map((info) => [info.job, info.held]));

      it("Pause low-priority: Jobs says which jobs are held, the held runs count up, no Needs-you item comes", async () => {
        expect(held()).toEqual({ byhand: false, high: false, low: false, skip: false, wait: false });
        await runs.setSwitch("pause-low");
        expect(held()).toEqual({ byhand: false, high: false, low: true, skip: true, wait: true });
        expect(runs.heldRuns()).toBe(0);
        await awake("2026-11-18T17:40:30");
        // Three low-priority jobs each held their 17:40 run; High ran it.
        expect(runs.heldRuns()).toBe(3);
        expect(spawned()).toEqual(["high scheduled"]);
        await awake("2026-11-18T17:44:30");
        expect(runs.heldRuns()).toBe(9);
        // A sleep while held changes nothing but the count.
        await at("2026-11-18T17:50:30");
        expect(runs.heldRuns()).toBe(18);
        expect(runs.needsYou()).toEqual([]);
        expect(notices).toEqual([]);
        expect((await records()).filter((record) => record.job !== "high")).toEqual([]);
        await runs.setSwitch("pause-all");
        expect(held()).toEqual({ byhand: false, high: true, low: true, skip: true, wait: true });
        await runs.setSwitch("running");
        expect(held()).toEqual({ byhand: false, high: false, low: false, skip: false, wait: false });
        expect(runs.heldRuns()).toBe(0);
      });

      it("back to Running after three marks: one caught-up run whose record says \"missed 3 runs\"; skip and wait for me count too", async () => {
        await runs.setSwitch("pause-low");
        await awake("2026-11-18T17:45:00", 10_000);
        expect(runs.heldRuns()).toBe(9);
        await runs.setSwitch("running");
        await awake("2026-11-18T17:45:01");
        const three = { count: 3, first: ms("2026-11-18T17:40:00"), last: ms("2026-11-18T17:44:00") };
        expect(spawned().filter((one) => !one.startsWith("high"))).toEqual(["low caught-up"]);
        sessions.end(sessions.latest("low"), "exited", 0);
        await awake("2026-11-18T17:45:03");
        const all = await records();
        const low = all.find((record) => record.job === "low");
        expect(low).toMatchObject({ state: "done", trigger: "caught-up", dueAt: three.last, missed: three });
        expect(low === undefined ? null : runTriggerWords(low)).toBe("missed 3 runs, 17:40–17:44 · caught up once");
        const skip = all.find((record) => record.job === "skip");
        expect(skip).toMatchObject({ state: "missed", reason: "skipped", missed: three });
        expect(skip === undefined ? null : runWords(skip)).toBe("missed 3 runs, 17:40–17:44 · skipped");
        // The wait-for-me job waits for you once the switch lets it go, counting all three.
        const wait = going("wait")[0];
        expect(wait).toMatchObject({ state: "missed-waiting", dueAt: three.last, missed: three });
        expect(wait === undefined ? null : runWords(wait)).toBe("missed 3 runs, 17:40–17:44 · waiting for you");
        expect(runs.needsYou()).toEqual([expect.objectContaining({ id: "missed:wait", detail: "missed 3 runs, 17:40–17:44" })]);
        expect(notices.map((notice) => notice.title)).toEqual(["Wait · missed 3 runs, 17:40–17:44"]);
        // A later miss adds to the run that waits.
        await at("2026-11-18T17:56:00");
        expect(going("wait")[0]?.missed).toEqual({ count: 8, first: three.first, last: ms("2026-11-18T17:54:00") });
        // Skip: the record keeps the count.
        expect((await runs.missed("wait", { kind: "skip" })).ok).toBe(true);
        expect((await records()).find((record) => record.job === "wait")).toMatchObject({ state: "missed", reason: "skipped by you", missed: { count: 8 } });
      });

      it("each held job is one held row, counting up to the note's count, kept over a restart, and gone on release when its record lands", async () => {
        const row = (job: string, count: number, last: string): object => ({ state: "held", job, name: job.charAt(0).toUpperCase() + job.slice(1), kind: "script", project: null, folder: "Projects/x", missed: { count, first: ms("2026-11-18T17:40:00"), last: ms(last) } });
        await runs.setSwitch("pause-low");
        expect(runs.heldRows()).toEqual([]);
        await awake("2026-11-18T17:42:30", 10_000);
        expect(runs.heldRows()).toEqual([row("low", 2, "2026-11-18T17:42:00"), row("skip", 2, "2026-11-18T17:42:00"), row("wait", 2, "2026-11-18T17:42:00")]);
        expect(heldRowWords(runs.heldRows()[0]?.missed ?? { count: 0, first: 0, last: 0 })).toBe("held · 2 runs so far, 17:40–17:42");
        expect(runs.heldRows().reduce((sum, one) => sum + one.missed.count, 0)).toBe(runs.heldRuns());
        // A restart reads the same rows from the records: nothing about them lives only in memory.
        await runs.close();
        await open();
        await awake("2026-11-18T17:44:30");
        expect(runs.heldRows()).toEqual([row("low", 3, "2026-11-18T17:44:00"), row("skip", 3, "2026-11-18T17:44:00"), row("wait", 3, "2026-11-18T17:44:00")]);
        expect(runs.needsYou()).toEqual([]);
        expect(notices).toEqual([]);
        // Released: no held row is left; each job's record (or its waiting run) stands for the span.
        await runs.setSwitch("running");
        expect(runs.heldRows()).toEqual([]);
        await awake("2026-11-18T17:44:31");
        expect(runs.heldRows()).toEqual([]);
        const three = { count: 3, first: ms("2026-11-18T17:40:00"), last: ms("2026-11-18T17:44:00") };
        expect((await records()).find((record) => record.job === "skip")).toMatchObject({ state: "missed", missed: three });
        expect(going("wait")[0]).toMatchObject({ state: "missed-waiting", missed: three });
        // Run all 3 on the waiting job: three runs, each "caught up N of 3", and no missed record of the span.
        expect(await runs.missed("wait", { kind: "run-all" })).toEqual({ ok: true, at: expect.any(Number) as number, runs: 3 });
        for (let n = 1; n <= 3; n++) {
          await awake(new Date(now.getTime() + 2_000).toISOString());
          expect(going("wait")).toEqual([expect.objectContaining({ state: "running", series: { n, of: 3 } })]);
          sessions.end(sessions.latest("wait"), "exited", 0);
          await awake(new Date(now.getTime() + 2_000).toISOString());
        }
        const wait = (await records()).filter((record) => record.job === "wait").reverse();
        expect(wait.map((record) => [record.state, runTriggerWords(record)])).toEqual([
          ["done", "caught up 1 of 3"],
          ["done", "caught up 2 of 3"],
          ["done", "caught up 3 of 3"],
        ]);
      });

      it("a caught-up run still queued takes in what the switch holds after it", async () => {
        settings = { ...settings, maxLowPriorityRuns: 1 };
        files = { ...files, "low.md": script("Low", "schedule:\n  every: { minutes: 2 }\nworth-until: 23:00\n"), "busy.md": script("Busy", "hook: { event: login }\n") };
        load();
        // Busy holds the one slot.
        expect((await runs.runNow("busy")).ok).toBe(true);
        await awake("2026-11-18T17:39:01");
        await runs.setSwitch("pause-low");
        await awake("2026-11-18T17:44:30", 10_000);
        await runs.setSwitch("running");
        await awake("2026-11-18T17:44:31");
        expect(going("low")).toEqual([expect.objectContaining({ state: "queued", trigger: "caught-up", waits: { kind: "slot", ahead: 1 }, missed: { count: 3, first: ms("2026-11-18T17:40:00"), last: ms("2026-11-18T17:44:00") } })]);
        // Held again while it waits, then let go: what was held adds to it.
        await runs.setSwitch("pause-low");
        await awake("2026-11-18T17:48:30", 10_000);
        await runs.setSwitch("running");
        await awake("2026-11-18T17:48:31");
        expect(going("low")).toEqual([expect.objectContaining({ trigger: "caught-up", missed: { count: 5, first: ms("2026-11-18T17:40:00"), last: ms("2026-11-18T17:48:00") } })]);
        expect(lines).toContain("job low: a caught-up run is queued already; it stands for 5 missed runs");
      });
    });

    it("Pause all holds everything scheduled, but not Run now; on resume the held runs follow their missed-run policy", async () => {
      await runs.setSwitch("pause-all");
      await awake("2026-11-18T13:30:00", 10_000);
      expect(sessions.spawned).toEqual([]);
      // Next up still lists their runs, each held.
      expect(runs.nextUp().map((next) => [next.job, next.held])).toEqual([
        ["git", true],
        ["summary", true],
        ["git", true],
        ["summary", true],
        ["git", true],
      ]);
      expect((await runs.runNow("summary")).ok).toBe(true);
      sessions.end(sessions.latest("summary"), "exited", 0);
      await awake("2026-11-18T13:30:01");
      await runs.setSwitch("running");
      await awake("2026-11-18T13:30:02");
      // Summary (run on wake, worth it until its next run) catches up; Git (skip) is recorded missed.
      expect(spawned()).toEqual(["summary manual", "summary caught-up"]);
      expect((await records()).find((record) => record.job === "git")).toMatchObject({ state: "missed", reason: "skipped", dueAt: ms("2026-11-18T13:00:00") });
    });

    it("a queued run the switch held follows its policy when released late", async () => {
      settings = { ...settings, maxLowPriorityRuns: 1 };
      files = { ...files, "other.md": script("Other", "schedule:\n  daily: { at: 13:00 }\nmissed: skip\n") };
      load();
      await awake("2026-11-18T13:00:00");
      expect(runs.active().map((run) => [run.job, run.state])).toEqual([
        ["git", "running"],
        ["other", "running"],
        ["summary", "queued"],
      ]);
      await runs.setSwitch("pause-low");
      sessions.end(sessions.latest("other"), "exited", 0);
      await awake("2026-11-18T13:20:00", 10_000);
      expect(going("summary")[0]?.waits).toEqual({ kind: "switch", position: "pause-low" });
      await runs.setSwitch("running");
      expect(lines).toContain(`run summary ${going("summary")[0]?.run ?? ""}: held by the switch — one caught-up run, worth it until Thu 13:00`);
      expect(going("summary")[0]).toMatchObject({ trigger: "caught-up", state: "running" });
    });

    it("survives a restart", async () => {
      await runs.setSwitch("pause-all");
      await restart("2026-11-18T12:30:00");
      expect(runs.switch().position).toBe("pause-all");
      expect(lines).toContain("switch: Pause all");
    });
  });

  describe("time limit", () => {
    it("stops a run past its job's time limit, once: failed, stopped: time limit, 1 min", async () => {
      files = { "long.md": script("Long", "schedule:\n  daily: { at: 7:00 }\ntime-limit: 1m\n") };
      load();
      await awake("2026-11-18T07:00:59");
      expect(sessions.stops).toEqual([]);
      await awake("2026-11-18T07:01:00");
      const id = sessions.latest("long");
      expect(sessions.stops).toEqual([{ id, reason: "time-limit" }]);
      expect(lines).toContain(`run long ${id.slice(-22)}: ran over its time limit of 1 min; stopping it`);
      await awake("2026-11-18T07:01:02");
      expect(sessions.stops).toHaveLength(1);
      sessions.end(id, "time-limit", null, 61_000, "SIGTERM");
      await awake("2026-11-18T07:01:03");
      expect(finished).toEqual([expect.objectContaining({ job: "long", state: "failed", reason: "stopped: time limit, 1 min", limitHit: 1, signal: "SIGTERM" })]);
      expect(runWords(finished[0] as RunRecord)).toBe("stopped: time limit, 1 min");
    });

    it("no time limit by default", async () => {
      await awake("2026-11-18T07:00:00");
      await awake("2026-11-18T09:00:00", 60_000);
      expect(sessions.stops).toEqual([]);
    });
  });

  describe("long-run warning", () => {
    beforeEach(() => {
      settings = { ...settings, longRunWarningMinutes: 1 };
    });

    it("at the threshold, a Needs-you item and one notice; the run keeps going", async () => {
      await awake("2026-11-18T07:00:59");
      expect(runs.needsYou()).toEqual([]);
      await awake("2026-11-18T07:01:00");
      const run = going("summary")[0];
      expect(runs.needsYou()).toEqual([
        { id: `long-run:summary:${run?.run ?? ""}`, kind: "long-run", job: "summary", name: "Summary", project: null, run: run?.run, at: ms("2026-11-18T07:01:00"), startedAt: ms("2026-11-18T07:00:00"), detail: "running 1 min — still expected?" },
      ]);
      expect(notices).toEqual([expect.objectContaining({ title: "Summary has been running 1 min — still expected?", action: { kind: "openApp", route: `run/summary/${run?.run ?? ""}` } })]);
      await awake("2026-11-18T09:00:00", 60_000);
      expect(sessions.stops).toEqual([]);
      expect(going("summary")[0]?.state).toBe("running");
      expect(notices).toHaveLength(1);
      await restart("2026-11-18T09:00:01");
      expect(notices).toHaveLength(1);
      expect(runs.needsYou()).toHaveLength(1);
    });

    it("Dismiss clears it for good; Stop stops the run as stopped by you", async () => {
      await awake("2026-11-18T07:01:00");
      const run = going("summary")[0]?.run ?? "";
      expect(runs.dismissWarning("summary", run)).toBe(true);
      expect(runs.dismissWarning("summary", run)).toBe(false);
      expect(runs.needsYou()).toEqual([]);
      await awake("2026-11-18T08:00:00", 60_000);
      expect(runs.needsYou()).toEqual([]);
      expect(await runs.stop("summary", run)).toEqual({ ok: true });
      expect(sessions.stops).toEqual([{ id: `run:summary:${run}`, reason: "stopped-by-you" }]);
      sessions.end(`run:summary:${run}`, "stopped-by-you", null, 3_600_000, "SIGTERM");
      await runs.tick();
      expect(finished).toEqual([expect.objectContaining({ state: "stopped-by-you" })]);
      expect(await runs.stop("summary", run)).toEqual({ ok: false, reason: `run ${run} of "summary" is not running` });
    });
  });
});
