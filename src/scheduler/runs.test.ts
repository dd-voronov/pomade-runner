// The run lifecycle on a clock the tests set, against sessions that stand in for the keeper and a
// real history on a temp folder: schedules firing, each overlap policy, Run now, every way a run
// ends, its environment, a scheduler restart, and what the UI reads — without waiting. Missed runs,
// the queue, the switch, the warm-up, time limits and long-run warnings are in `load.test.ts`,
// on the same stand-ins (`runs-fixture.ts`).

process.env.TZ = "Europe/Madrid";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExitReason, NoticeParams } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import type { JobsSnapshot } from "../jobs/model";
import { createHistory, type History } from "./history";
import type { ActiveRun, RunRecord } from "./model";
import { createRuns, fileRunsStore, runEnv, type Runs } from "./runs";
import { FakeSessions, memoryStore, memorySwitch, script } from "./runs-fixture";
import { DEFAULT_SETTINGS } from "./settings";
import { ON_TIME_MS } from "./triggers";

const WS = "/ws";

describe("runs", () => {
  let dir: string;
  let now: Date;
  let files: Record<string, string>;
  let snapshot: JobsSnapshot;
  let sessions: FakeSessions;
  let store: ReturnType<typeof memoryStore>;
  let switchStore: ReturnType<typeof memorySwitch>;
  let notices: NoticeParams[];
  let history: History;
  let lines: string[];
  let started: ActiveRun[];
  let finished: RunRecord[];
  let changes: number;
  let runs: Runs;
  let randoms: number;

  function load(): void {
    snapshot = checkJobs(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { workspace: WS, projects: [{ id: "p1", name: "One", root: "Projects/one" }] },
    );
  }

  async function open(): Promise<Runs> {
    const created = createRuns({
      sessions,
      jobs: () => snapshot,
      settings: () => DEFAULT_SETTINGS,
      servicesSettled: () => true,
      clock: { now: () => now },
      log: (line) => lines.push(line),
      history,
      store,
      switchStore,
      post: (notice) => notices.push(notice),
      projectPath: (project) => (project === "p1" ? "/ws/Projects/one" : null),
      onStarted: (run) => started.push(structuredClone(run)),
      onFinished: (record) => finished.push(record),
      onChange: () => changes++,
      random: () => (++randoms).toString(16).padStart(6, "0"),
    });
    await created.load();
    runs = created;
    return created;
  }

  /** A scheduler started for the first time at a local time. */
  async function fresh(local: string): Promise<void> {
    await runs.close();
    store.saved.lookedAt = null;
    now = new Date(local);
    await open();
  }

  /** Set the clock to a local time on Madrid's clock and tick. */
  async function at(local: string): Promise<void> {
    now = new Date(local);
    await runs.tick();
  }

  /** Tick every minute from now to `local`. */
  async function minutes(local: string): Promise<void> {
    const end = new Date(local).getTime();
    while (now.getTime() < end) {
      now = new Date(Math.min(end, now.getTime() + 60_000));
      await runs.tick();
    }
  }

  async function page(): Promise<RunRecord[]> {
    return (await history.page({ job: null, before: null, limit: 200 })).records;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prr-"));
    now = new Date("2026-11-18T12:00:00");
    files = { "backup.md": script("Backup") };
    load();
    sessions = new FakeSessions(() => now.getTime(), dir);
    store = memoryStore();
    switchStore = memorySwitch();
    notices = [];
    history = createHistory(join(dir, "state"), () => undefined);
    lines = [];
    started = [];
    finished = [];
    changes = 0;
    randoms = 0;
    await open();
  });

  afterEach(async () => {
    await runs.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("schedules", () => {
    it("a daily 13:00 runs at 13:00 as a keeper session in its folder, and lands in History with its output when it ends", async () => {
      await at("2026-11-18T12:59:59");
      expect(sessions.spawned).toEqual([]);
      await at("2026-11-18T13:00:00");
      expect(sessions.spawned).toEqual([
        {
          owner: { kind: "run", job: "backup", run: "20261118-120000-000001" },
          command: {
            title: "Backup",
            command: "./backup.sh",
            cwd: "/ws/Projects/x",
            env: { POMADE_JOB: "backup", POMADE_RUN_ID: "20261118-120000-000001", POMADE_TRIGGER: "scheduled" },
            background: true,
          },
        },
      ]);
      const id = "run:backup:20261118-120000-000001";
      expect(runs.active()).toEqual([
        {
          job: "backup",
          name: "Backup",
          kind: "script",
          project: null,
          folder: "Projects/x",
          run: "20261118-120000-000001",
          trigger: "scheduled",
          dueAt: now.getTime(),
          state: "running",
          lowPriority: true,
          runAt: null,
          deadline: null,
          waits: null,
          startedAt: now.getTime(),
          session: id,
          log: join(dir, "20261118-120000-000001.log"),
          limitHit: null,
          warnedAt: null,
          warningDismissed: false,
        },
      ]);
      expect(started).toHaveLength(1);
      expect(store.saved.active).toHaveLength(1);

      await writeFile(join(dir, "20261118-120000-000001.log"), "\x1b[32mcopying\x1b[0m\r\nbacked up 3 files\r\n");
      sessions.end(id, "exited", 0, 2500);
      await at("2026-11-18T13:00:03");
      const record: RunRecord = {
        job: "backup",
        name: "Backup",
        kind: "script",
        project: null,
        folder: "Projects/x",
        run: "20261118-120000-000001",
        trigger: "scheduled",
        dueAt: Date.parse("2026-11-18T12:00:00.000Z"),
        state: "done",
        reason: null,
        startedAt: Date.parse("2026-11-18T12:00:00.000Z"),
        endedAt: Date.parse("2026-11-18T12:00:02.500Z"),
        durationMs: 2500,
        exitCode: 0,
        signal: null,
        log: join(dir, "20261118-120000-000001.log"),
        lastLines: ["copying", "backed up 3 files"],
      };
      expect(await page()).toEqual([record]);
      expect(finished).toEqual([record]);
      expect(runs.active()).toEqual([]);
      expect(sessions.forgotten).toEqual([id]);
      // The last look that fired something, written at once.
      expect(store.saved).toEqual({ active: [], last: { backup: record }, lookedAt: Date.parse("2026-11-18T12:00:00.000Z"), held: {} });
      expect(lines).toContain("run backup 20261118-120000-000001: done — exit 0");
      // The next day, again.
      await minutes("2026-11-19T13:00:00");
      expect(sessions.spawned).toHaveLength(2);
    });

    it("every 30 min, 9:00–19:00, weekdays only: runs on a Wednesday at 9:00, 9:30…, never on a Saturday", async () => {
      files = { "check.md": script("Check", "schedule:\n  every: { minutes: 30, from: 9:00, to: 19:00 }\n  only: weekdays\noverlap: parallel\nlow-priority: false\nmissed: skip\n") };
      load();
      await at("2026-11-18T08:00:00");
      await minutes("2026-11-18T10:00:00");
      expect(sessions.spawned.map((spawn) => spawn.owner.run.slice(9, 13))).toEqual(["0800", "0830", "0900"]);
      await at("2026-11-21T08:00:00");
      await minutes("2026-11-21T20:00:00");
      expect(sessions.spawned).toHaveLength(3);
    });

    it("once at runs once, then shows as finished", async () => {
      files = { "tonight.md": script("Tonight", "schedule:\n  once: 2026-11-18 23:00\n") };
      load();
      expect(runs.jobRuns()).toEqual([{ job: "tonight", next: Date.parse("2026-11-18T22:00:00.000Z"), finished: false, last: null }]);
      expect(runs.nextUp()).toEqual([{ job: "tonight", name: "Tonight", project: null, at: Date.parse("2026-11-18T22:00:00.000Z") }]);
      await at("2026-11-18T22:59:00");
      await minutes("2026-11-18T23:05:00");
      expect(sessions.spawned).toHaveLength(1);
      sessions.end(sessions.latest("tonight"), "exited", 0);
      await minutes("2026-11-19T23:05:00");
      expect(sessions.spawned).toHaveLength(1);
      expect(runs.jobRuns()).toEqual([{ job: "tonight", next: null, finished: true, last: expect.objectContaining({ state: "done" }) as RunRecord }]);
      expect(runs.nextUp()).toEqual([]);
    });

    it("nothing before the scheduler's first start is due; an occurrence seen too late is missed, and goes to its policy", async () => {
      await fresh("2026-11-18T13:00:30");
      await runs.tick();
      expect(sessions.spawned).toEqual([]);
      files = { "backup.md": script("Backup", "schedule:\n  daily: { at: [13:30, 14:00] }\nmissed: skip\n") };
      load();
      await at("2026-11-18T13:20:00");
      now = new Date(Date.parse("2026-11-18T14:00:00") + ON_TIME_MS + 1000);
      await runs.tick();
      expect(sessions.spawned).toEqual([]);
      expect(lines).toContain("job backup: missed Wed 13:30, Wed 14:00 — missed · skipped");
      expect(await page()).toEqual([expect.objectContaining({ job: "backup", state: "missed", reason: "skipped", trigger: "scheduled", dueAt: Date.parse("2026-11-18T13:00:00.000Z"), startedAt: null })]);
    });

    it("waits for the keeper: nothing is due while it is not followed, and a short outage only delays the run", async () => {
      sessions.following = false;
      await at("2026-11-18T13:00:00");
      await at("2026-11-18T13:01:00");
      expect(sessions.spawned).toEqual([]);
      sessions.following = true;
      await at("2026-11-18T13:02:00");
      expect(sessions.spawned).toHaveLength(1);
    });

    it("never fires a disabled job, an invalid one, a service, or a script on a hook", async () => {
      files = {
        "off.md": script("Off", "schedule:\n  daily: { at: 13:00 }\nenabled: false\n"),
        "bad.md": script("Bad", "schedule:\n  daily: { at: 25:00 }\n"),
        "hooked.md": script("Hooked", "hook: { event: login }\n"),
        "web.md": "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n",
      };
      load();
      await at("2026-11-18T12:59:00");
      await minutes("2026-11-18T13:05:00");
      expect(sessions.spawned).toEqual([]);
      expect(runs.nextUp()).toEqual([]);
      expect(runs.jobRuns().map((info) => [info.job, info.next, info.finished])).toEqual([
        ["hooked", null, false],
        ["off", null, false],
      ]);
    });

    it("lists the next runs soonest first", async () => {
      files = { "a.md": script("A", "schedule:\n  daily: { at: 18:00 }\n"), "b.md": script("B", "schedule:\n  daily: { at: 14:00 }\n"), "c.md": script("C") };
      load();
      await at("2026-11-18T13:30:00");
      expect(runs.nextUp().map((next) => [next.job, new Date(next.at).getHours()])).toEqual([
        ["b", 14],
        ["a", 18],
        ["c", 13],
      ]);
    });
  });

  describe("how a run ends", () => {
    async function oneRun(): Promise<string> {
      await at("2026-11-18T12:59:59");
      await at("2026-11-18T13:00:00");
      return sessions.latest("backup");
    }

    it("exit ≠ 0 is failed, with its code; a signal is failed with the signal", async () => {
      const id = await oneRun();
      sessions.end(id, "crashed", 3);
      await at("2026-11-18T13:00:05");
      expect(finished.at(-1)).toMatchObject({ state: "failed", exitCode: 3, reason: null, lastLines: [] });
      await minutes("2026-11-19T13:00:00");
      sessions.end(sessions.latest("backup"), "crashed", null, 10, "SIGKILL");
      await at("2026-11-19T13:00:05");
      expect(finished.at(-1)).toMatchObject({ state: "failed", exitCode: null, signal: "SIGKILL" });
    });

    it("Ctrl+C or Stop in its tab is stopped by you; a keeper crash, a stop by Runner or a time limit are failed with the reason", async () => {
      const cases: [ExitReason, string, string | null][] = [
        ["stopped-by-you", "stopped-by-you", null],
        ["lost-in-keeper-crash", "failed", "lost in a keeper crash"],
        ["stopped", "failed", "stopped by Runner"],
        ["time-limit", "failed", "stopped: time limit"],
      ];
      for (const [reason, state, why] of cases) {
        await runs.runNow("backup");
        sessions.end(sessions.latest("backup"), reason, 130);
        await runs.tick();
        expect(finished.at(-1)).toMatchObject({ state, reason: why, trigger: "manual" });
      }
    });

    it("a session that is gone from the keeper ends the run as failed", async () => {
      const id = await oneRun();
      sessions.sessions.delete(id);
      await at("2026-11-18T13:00:05");
      expect(finished.at(-1)).toMatchObject({ state: "failed", reason: "its session is gone", durationMs: null, endedAt: now.getTime(), log: join(dir, `${id.slice(-22)}.log`) });
    });

    it("a start the keeper refuses is a failed run that never started", async () => {
      sessions.refuse = "no such folder: /ws/Projects/x";
      await oneRun().catch(() => undefined);
      expect(runs.active()).toEqual([]);
      expect(finished).toEqual([expect.objectContaining({ state: "failed", reason: "cannot start — no such folder: /ws/Projects/x", startedAt: null, durationMs: null, log: null })]);
      expect(started).toEqual([]);
    });

    it("forgets an ended run session no run claims", async () => {
      await sessions.spawn({ kind: "run", job: "stray", run: "20261118-110000-abcdef" }, { title: "Stray", command: "x", cwd: "/", background: false });
      await runs.tick();
      expect(sessions.forgotten).toEqual([]);
      sessions.end("run:stray:20261118-110000-abcdef", "exited", 0);
      await runs.tick();
      expect(sessions.forgotten).toEqual(["run:stray:20261118-110000-abcdef"]);
      expect(finished).toEqual([]);
    });
  });

  describe("overlap", () => {
    it("skip (the default): a run due while one goes is recorded skipped · previous run still going", async () => {
      files = { "check.md": script("Check", "schedule:\n  every: { minutes: 1 }\n") };
      load();
      await fresh("2026-11-18T12:59:30");
      await at("2026-11-18T13:00:00");
      await at("2026-11-18T13:01:00");
      expect(sessions.spawned).toHaveLength(1);
      expect(finished).toEqual([expect.objectContaining({ state: "skipped", reason: "previous run still going", startedAt: null, run: "20261118-120100-000002" })]);
      expect(lines).toContain("run check 20261118-120100-000002: skipped — previous run still going");
      expect(runs.jobRuns()[0]?.last).toMatchObject({ state: "skipped" });
    });

    it("parallel: another run starts beside it, as far as the low-priority slots go", async () => {
      files = { "check.md": script("Check", "schedule:\n  every: { minutes: 1 }\noverlap: parallel\nlow-priority: false\n") };
      load();
      await fresh("2026-11-18T12:59:30");
      await minutes("2026-11-18T13:02:00");
      expect(sessions.spawned).toHaveLength(3);
      expect(runs.active().map((run) => run.state)).toEqual(["running", "running", "running"]);
      files = { "low.md": script("Low", "schedule:\n  every: { minutes: 1 }\noverlap: parallel\n") };
      load();
      await minutes("2026-11-18T13:05:00");
      expect(runs.active().filter((run) => run.job === "low").map((run) => [run.state, run.waits])).toEqual([
        ["running", null],
        ["running", null],
        ["queued", { kind: "slot", ahead: 1 }],
      ]);
    });

    it("queue: one run waits and starts when the run going ends; a further one is skipped", async () => {
      files = { "check.md": script("Check", "schedule:\n  every: { minutes: 1 }\noverlap: queue\n") };
      load();
      await fresh("2026-11-18T12:59:30");
      await at("2026-11-18T13:00:00");
      await at("2026-11-18T13:01:00");
      expect(runs.active().map((run) => [run.run, run.state, run.session])).toEqual([
        ["20261118-120000-000001", "running", "run:check:20261118-120000-000001"],
        ["20261118-120100-000002", "queued", null],
      ]);
      expect(lines).toContain("run check 20261118-120100-000002: queued · after the previous run");
      await at("2026-11-18T13:02:00");
      expect(finished).toEqual([expect.objectContaining({ state: "skipped", reason: "a run is already queued" })]);
      sessions.end(sessions.latest("check"), "exited", 0);
      await at("2026-11-18T13:02:30");
      expect(runs.active().map((run) => [run.run, run.state])).toEqual([["20261118-120100-000002", "running"]]);
      expect(sessions.spawned.map((spawn) => spawn.owner.run)).toEqual(["20261118-120000-000001", "20261118-120100-000002"]);
      expect(started.map((run) => run.dueAt)).toEqual([Date.parse("2026-11-18T12:00:00.000Z"), Date.parse("2026-11-18T12:01:00.000Z")]);
    });

    it("a queued run whose job was disabled or removed meanwhile is skipped when its turn comes", async () => {
      files = { "check.md": script("Check", "schedule:\n  every: { minutes: 1 }\noverlap: queue\n") };
      load();
      await fresh("2026-11-18T12:59:30");
      await minutes("2026-11-18T13:01:00");
      files = { "check.md": script("Check", "schedule:\n  every: { minutes: 1 }\noverlap: queue\nenabled: false\n") };
      load();
      sessions.end(sessions.latest("check"), "exited", 0);
      await at("2026-11-18T13:01:10");
      expect(finished.map((record) => [record.state, record.reason])).toEqual([
        ["done", null],
        ["skipped", "its job is disabled"],
      ]);
    });
  });

  describe("Run now", () => {
    it("runs a script now (trigger manual), by id or name, as the job's overlap allows", async () => {
      now = new Date("2026-11-18T10:00:00");
      const result = await runs.runNow("BACKUP");
      expect(result).toMatchObject({ ok: true, run: { job: "backup", trigger: "manual", state: "running", dueAt: now.getTime() } });
      expect(sessions.spawned[0]?.command.env).toMatchObject({ POMADE_TRIGGER: "manual" });
      expect(await runs.runNow("backup")).toEqual({ ok: false, reason: '"Backup" is running, and its overlap is skip' });
      expect(lines).toContain("job backup: Run now");
    });

    it("queues behind the run going with overlap queue, once", async () => {
      files = { "q.md": script("Q", "schedule:\n  daily: { at: 13:00 }\noverlap: queue\n") };
      load();
      await runs.runNow("q");
      expect(await runs.runNow("q")).toMatchObject({ ok: true, run: { state: "queued" } });
      expect(await runs.runNow("q")).toEqual({ ok: false, reason: '"Q" has a run queued already' });
    });

    it("refuses what it cannot run, and says why", async () => {
      files = {
        "off.md": script("Off", "enabled: false\nschedule:\n  daily: { at: 13:00 }\n"),
        "bad.md": "---\nkind: script\n---\n",
        "agent.md": "---\nkind: agent\nname: Agent\nfolder: .\nagent: claude\nschedule:\n  daily: { at: 7:00 }\n---\nHi\n",
        "backup.md": script("Backup"),
      };
      load();
      expect(await runs.runNow("nope")).toEqual({ ok: false, reason: 'no job "nope"' });
      expect(await runs.runNow("off")).toEqual({ ok: false, reason: '"Off" is disabled in its file; enable it first' });
      expect(await runs.runNow("bad")).toMatchObject({ ok: false, reason: expect.stringContaining('the job "bad" is invalid') as string });
      expect(await runs.runNow("agent")).toEqual({ ok: false, reason: '"Agent" is an agent job; Run now runs scripts and services' });
      sessions.following = false;
      expect(await runs.runNow("backup")).toEqual({ ok: false, reason: "the keeper is not connected" });
      sessions.following = true;
      sessions.refuse = "no such folder: /ws/Projects/x";
      expect(await runs.runNow("backup")).toEqual({ ok: false, reason: "cannot start — no such folder: /ws/Projects/x" });
      expect(sessions.spawned).toEqual([]);
    });
  });

  describe("records", () => {
    it("a restarted scheduler picks up the runs going and the ends that came while it was down, writing each record once", async () => {
      await at("2026-11-18T12:59:59");
      await at("2026-11-18T13:00:00");
      const id = sessions.latest("backup");
      await runs.close();
      sessions.end(id, "exited", 0);
      await open();
      expect(runs.active().map((run) => run.session)).toEqual([id]);
      await runs.tick();
      expect(await page()).toHaveLength(1);

      // A record already written by a scheduler that died before it updated its records.
      const done = store.saved.last.backup;
      if (done === undefined) throw new Error("no record");
      await runs.runNow("backup");
      const second = sessions.latest("backup");
      const before = structuredClone(store.saved);
      sessions.end(second, "exited", 0);
      await runs.tick();
      store.saved = before;
      await open();
      await runs.tick();
      expect((await page()).map((record) => record.run)).toEqual([second.slice(-22), done.run]);
      expect(runs.active()).toEqual([]);
    });

    it("finds a run going, the latest, or one in the history", async () => {
      await at("2026-11-18T12:59:59");
      await at("2026-11-18T13:00:00");
      const going = runs.active()[0];
      expect(await runs.find("backup", going?.run ?? "")).toEqual(going);
      sessions.end(sessions.latest("backup"), "exited", 0);
      await runs.tick();
      await runs.runNow("backup");
      sessions.end(sessions.latest("backup"), "crashed", 1);
      await runs.tick();
      expect(await runs.find("backup", going?.run ?? "")).toMatchObject({ state: "done" });
      expect(await runs.find("backup", "20000101-000000-000000")).toBeNull();
      expect(runs.logsInUse()).toEqual(new Set());
    });

    it("keeps its records in runs.json, and starts empty from a missing or broken file", async () => {
      const file = fileRunsStore(join(dir, "state"), (line) => lines.push(line));
      expect(await file.load()).toEqual({ active: [], last: {}, lookedAt: null, held: {} });
      store.saved = { active: [], last: {}, lookedAt: null, held: {} };
      await at("2026-11-18T12:59:59");
      await at("2026-11-18T13:00:00");
      file.save(store.saved);
      await file.flush();
      expect(await file.load()).toEqual(store.saved);
      await writeFile(join(dir, "state/runs.json"), "{ not json");
      expect(await file.load()).toEqual({ active: [], last: {}, lookedAt: null, held: {} });
      expect(lines.at(-1)).toContain("is not readable JSON");
      await writeFile(join(dir, "state/runs.json"), JSON.stringify({ active: [{ job: 1 }], last: { a: { nope: true } }, lookedAt: "soon", held: { a: "x" } }));
      expect(await file.load()).toEqual({ active: [], last: {}, lookedAt: null, held: {} });
      // A run going as an older build kept it: what it lacks gets its default.
      const { lowPriority: _priority, runAt: _at, deadline: _deadline, waits: _waits, limitHit: _limit, warnedAt: _warned, warningDismissed: _dismissed, ...older } = store.saved.active[0] ?? ({} as ActiveRun);
      await writeFile(join(dir, "state/runs.json"), JSON.stringify({ active: [older], last: {} }));
      expect((await file.load()).active).toEqual(store.saved.active);
    });

    it("tells of every change", async () => {
      await at("2026-11-18T12:59:59");
      const before = changes;
      await at("2026-11-18T13:00:00");
      expect(changes).toBeGreaterThan(before);
    });
  });

  it("gives a run its context in the environment: the job, run, trigger, and its project", () => {
    files = { "one/web.md": "---\nkind: script\nname: Web\nproject: p1\nfolder: Projects/one\ncommand: ./x\nhook: { event: login }\n---\n" };
    load();
    const entry = snapshot.jobs[0];
    if (entry?.valid !== true) throw new Error("invalid");
    expect(runEnv(entry.job, "r1", "manual", "/ws/Projects/one")).toEqual({ POMADE_JOB: "one/web", POMADE_RUN_ID: "r1", POMADE_TRIGGER: "manual", POMADE_PROJECT: "p1", POMADE_PROJECT_PATH: "/ws/Projects/one" });
    expect(runEnv(entry.job, "r1", "manual", null)).toEqual({ POMADE_JOB: "one/web", POMADE_RUN_ID: "r1", POMADE_TRIGGER: "manual", POMADE_PROJECT: "p1" });
  });

  it("runs a project job with its project's path", async () => {
    files = { "one/web.md": "---\nkind: script\nname: Web\nproject: p1\nfolder: Projects/one\ncommand: ./x\nhook: { event: login }\nlow-priority: false\n---\n" };
    load();
    await runs.runNow("web");
    expect(sessions.spawned[0]?.command).toMatchObject({ background: false, env: { POMADE_PROJECT: "p1", POMADE_PROJECT_PATH: "/ws/Projects/one" } });
  });
});
