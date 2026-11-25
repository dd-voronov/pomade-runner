// Hooks, chains and the loop guard in the run lifecycle, on a clock the tests set, against the
// stand-in keeper (`runs-fixture.ts`) and a real history on a temp folder: what fires a chain and
// what does not, fan-out, parent links in the runs, records and environment, chains through the
// queue and the switch, a chain's action on a service, the Mac login hook after the warm-up — a
// login is a start that found no keeper running — an event through `hook()`, and the loop guard's
// pause, its persistence and Resume.

process.env.TZ = "Europe/Madrid";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExitReason, NoticeParams } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import { recordsFolderOf, stateFolderOf } from "../locations";
import type { JobsSnapshot, ServiceAction } from "../jobs/model";
import type { ChainActionOutcome } from "../keeper/model";
import { createHistory, type History } from "./history";
import type { HookFiring } from "./hooks";
import { runTriggerWords, runWords, type ActiveRun, type RunRecord } from "./model";
import { createRuns, LOOP_WORDS, type Runs } from "./runs";
import { FakeLogins, FakeSessions, FakeTurns, memoryStore, memorySwitch, script } from "./runs-fixture";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const ms = (local: string): number => new Date(local).getTime();
const inert = "hook: { event: project-created }\n";
/** Not low-priority: chained runs left going hold no slot the next run would wait for. */
const free = "low-priority: false\n";
const service = (name: string, extra: string): string => `---\nkind: service\nname: ${name}\nfolder: .\ncommand: ./web.sh\n${extra}---\n`;

describe("hooks and chains", () => {
  let dir: string;
  let now: Date;
  let files: Record<string, string>;
  let snapshot: JobsSnapshot;
  let sessions: FakeSessions;
  let logins: FakeLogins;
  let store: ReturnType<typeof memoryStore>;
  let switchStore: ReturnType<typeof memorySwitch>;
  let history: History;
  let settings: Settings;
  let settled: boolean;
  let lines: string[];
  let notices: NoticeParams[];
  let finished: RunRecord[];
  let actions: { job: string; action: ServiceAction; why: string }[];
  let outcome: () => Promise<ChainActionOutcome>;
  let runs: Runs;
  let randoms: number;

  function load(): void {
    snapshot = checkJobs(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { workspace: "/ws", projects: [{ id: "p1", name: "One", root: "Projects/one" }] },
    );
    expect(snapshot.jobs.filter((entry) => !entry.valid)).toEqual([]);
  }

  async function open(): Promise<void> {
    runs = createRuns({
      sessions,
      jobs: () => snapshot,
      settings: () => settings,
      servicesSettled: () => settled,
      consoleLogin: logins.current,
      logins,
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
      post: (notice) => notices.push(notice),
      serviceAction: (job, action, why) => {
        actions.push({ job, action, why });
        return outcome();
      },
      onStarted: () => undefined,
      onFinished: (record) => finished.push(record),
      onChange: () => undefined,
      random: () => (++randoms).toString(16).padStart(6, "0"),
    });
    await runs.load();
  }

  /** The scheduler stops and starts again — a login — at a local time. */
  async function restart(local: string): Promise<void> {
    await runs.close();
    now = new Date(local);
    await open();
    await runs.tick();
  }

  async function at(local: string): Promise<void> {
    now = new Date(local);
    await runs.tick();
  }

  /** Tick every `stepMs` from now to a local time. */
  async function awake(local: string, stepMs = 1000): Promise<void> {
    const end = ms(local);
    while (now.getTime() < end) {
      now = new Date(Math.min(end, now.getTime() + stepMs));
      await runs.tick();
    }
  }

  /** A second later: the latest run of `job` ends as the keeper says; the tick records it. */
  async function end(job: string, reason: ExitReason = "exited", code: number | null = reason === "exited" ? 0 : 1): Promise<void> {
    sessions.end(sessions.latest(job), reason, code);
    await at(new Date(now.getTime() + 1000).toISOString());
  }

  /** Run `job` now and end it as the keeper says. */
  async function runAndEnd(job: string, reason: ExitReason = "exited", code?: number | null): Promise<void> {
    expect(await runs.runNow(job)).toMatchObject({ ok: true });
    await end(job, reason, code);
  }

  const spawned = (): string[] => sessions.spawned.map((spawn) => `${spawn.owner.job} ${spawn.command.env?.POMADE_TRIGGER ?? ""}`);
  const envOf = (job: string): Record<string, string> | undefined => [...sessions.spawned].reverse().find((spawn) => spawn.owner.job === job)?.command.env;
  const records = async (job?: string): Promise<RunRecord[]> => (await history.page({ job: job ?? null, before: null, limit: 200 })).records;
  const going = (job: string): ActiveRun[] => runs.active().filter((run) => run.job === job);
  /** The jobs chains fired: their runs going and their records, by id. */
  const chained = async (): Promise<string[]> => [...new Set([...runs.active(), ...(await records())].filter((run) => run.trigger === "chain").map((run) => run.job))].sort();
  const fire = (firing: Partial<HookFiring> & Pick<HookFiring, "event">): Promise<void> => runs.hook({ project: null, agent: null, status: null, context: {}, ...firing });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prh-"));
    now = new Date("2026-11-18T12:00:00");
    files = {
      "pull.md": script("Pull", inert + free),
      "on-done.md": script("On done", `after: { job: pull }\n${free}`),
      "on-fail.md": script("On fail", `after: { job: pull, result: failed }\n${free}`),
      "on-any.md": script("On any", `after: { job: pull, result: any }\n${free}`),
    };
    load();
    sessions = new FakeSessions(() => now.getTime(), dir);
    logins = new FakeLogins();
    store = memoryStore();
    switchStore = memorySwitch();
    history = createHistory(recordsFolderOf(dir), stateFolderOf(dir), () => undefined);
    settings = { ...DEFAULT_SETTINGS };
    settled = true;
    lines = [];
    notices = [];
    finished = [];
    actions = [];
    outcome = () => Promise.resolve({ result: "done", session: 1, ended: 0 });
    randoms = 0;
    await open();
    // Past the staged start's warm-up.
    await awake("2026-11-18T12:03:00", 60_000);
  });

  afterEach(async () => {
    await runs.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("chains", () => {
    it("a run done fires the jobs after it on done and on any, not on failed; each chained run links its parent", async () => {
      await runAndEnd("pull");
      expect(spawned()).toEqual(["pull manual", "on-any chain", "on-done chain"]);
      const [parent] = await records("pull");
      const cause = { kind: "chain", job: "pull", name: "Pull", run: parent?.run, result: "done" };
      expect(going("on-done")).toEqual([expect.objectContaining({ state: "running", trigger: "chain", cause, dueAt: now.getTime() }) as ActiveRun]);
      expect(envOf("on-done")).toMatchObject({ POMADE_TRIGGER: "chain", POMADE_PARENT_JOB: "pull", POMADE_PARENT_RUN_ID: parent?.run, POMADE_PARENT_RESULT: "done" });
      await end("on-done");
      const [chained] = await records("on-done");
      expect(chained).toMatchObject({ state: "done", trigger: "chain", cause, event: null });
      expect(chained === undefined ? "" : runTriggerWords(chained)).toBe("chain: after Pull");
      expect(lines).toContain(`run on-done ${chained?.run ?? ""}: started (chain)`);
    });

    it("a failure fires the jobs after it on failed and on any, not on done", async () => {
      await runAndEnd("pull", "crashed", 3);
      expect(spawned()).toEqual(["pull manual", "on-any chain", "on-fail chain"]);
      expect(envOf("on-fail")).toMatchObject({ POMADE_PARENT_RESULT: "failed" });
    });

    it.each<[string, () => Promise<void>]>([
      ["exit code", () => runAndEnd("pull", "crashed", 1)],
      ["a signal", () => runAndEnd("pull", "crashed", null)],
      ["the time limit", () => runAndEnd("pull", "time-limit", null)],
      ["stopped by Runner", () => runAndEnd("pull", "stopped", null)],
      ["lost in a keeper crash", () => runAndEnd("pull", "lost-in-keeper-crash", null)],
      [
        "its session gone",
        async () => {
          await runs.runNow("pull");
          sessions.sessions.delete(sessions.latest("pull"));
          await at("2026-11-18T12:03:01");
        },
      ],
      [
        "a start the keeper refused",
        async () => {
          sessions.refuse = "no such folder";
          await runs.runNow("pull");
          sessions.refuse = null;
          await at("2026-11-18T12:03:01");
        },
      ],
    ])("every failure is a failure: %s", async (_what, failure) => {
      await failure();
      expect((await records("pull"))[0]?.state).toBe("failed");
      expect(await chained()).toEqual(["on-any", "on-fail"]);
    });

    it("a run stopped by you, skipped or missed fires nothing", async () => {
      files = { ...files, "pull.md": script("Pull", `schedule:\n  every: { minutes: 1 }\nmissed: skip\n${free}`) };
      load();
      await runs.runNow("pull");
      // Its schedule's run while the manual one goes: skipped · previous run still going.
      await at("2026-11-18T12:04:00");
      await end("pull", "stopped-by-you", null);
      // The scheduler down across 12:05–12:09: missed · skipped; 12:10 runs on time and goes on.
      await runs.close();
      now = new Date("2026-11-18T12:10:30");
      await open();
      await runs.tick();
      expect((await records("pull")).map((record) => record.state).sort()).toEqual(["missed", "skipped", "stopped-by-you"]);
      expect(await chained()).toEqual([]);
    });

    it("fans out: every enabled follower fires, in id order; disabled ones do not", async () => {
      files = { ...files, "b-off.md": script("B off", "after: { job: pull }\nenabled: false\n"), "a-also.md": script("A also", "after: { job: pull, result: done }\n") };
      load();
      await runAndEnd("pull");
      expect(runs.active().map((run) => [run.job, run.trigger])).toEqual([
        ["a-also", "chain"],
        ["on-any", "chain"],
        ["on-done", "chain"],
      ]);
    });

    it("chains of chains: each run links the one before it", async () => {
      files = { "a.md": script("A", inert), "b.md": script("B", "after: { job: a }\n"), "c.md": script("C", "after: { job: b, result: any }\n") };
      load();
      await runAndEnd("a");
      await end("b", "crashed", 2);
      await end("c");
      const [b] = await records("b");
      expect(await records("c")).toEqual([expect.objectContaining({ trigger: "chain", cause: { kind: "chain", job: "b", name: "B", run: b?.run, result: "failed" } }) as RunRecord]);
    });

    it("a chain run goes through the queue: the warm-up does not hold it, the switch does — it runs late on release, under its overlap", async () => {
      await restart("2026-11-18T13:00:00");
      await runAndEnd("pull");
      // Within the warm-up after a start: the chain runs at once.
      expect(going("on-done")).toEqual([expect.objectContaining({ state: "running" }) as ActiveRun]);
      await end("on-done");
      await end("on-any");
      await runs.setSwitch("pause-all");
      expect(await runs.runNow("pull")).toMatchObject({ ok: true, run: { state: "running" } });
      await end("pull");
      expect(going("on-done")).toEqual([expect.objectContaining({ state: "queued", trigger: "chain", waits: { kind: "switch", position: "pause-all" } }) as ActiveRun]);
      await awake("2026-11-18T13:30:00", 60_000);
      await runs.setSwitch("running");
      expect(going("on-done")).toEqual([expect.objectContaining({ state: "running", trigger: "chain" }) as ActiveRun]);
      // While it runs, the next chain run is skipped: overlap skip.
      await runAndEnd("pull");
      expect((await records("on-done"))[0]).toMatchObject({ state: "skipped", reason: "previous run still going", trigger: "chain" });
    });

    it("a run that ended while the scheduler was down fires its chains once, on the next start", async () => {
      await runs.runNow("pull");
      await runs.close();
      sessions.end(sessions.latest("pull"), "exited", 0);
      now = new Date("2026-11-18T12:10:00");
      await open();
      await runs.tick();
      expect(spawned()).toEqual(["pull manual", "on-any chain", "on-done chain"]);
      await restart("2026-11-18T12:20:00");
      expect(spawned()).toHaveLength(3);
    });

    it("a parent written already by a scheduler that died before it saved fires nothing again", async () => {
      await runs.runNow("pull");
      sessions.end(sessions.latest("pull"), "exited", 0);
      const going = structuredClone(store.saved);
      await at("2026-11-18T12:03:01");
      expect(spawned()).toHaveLength(3);
      // The scheduler died after the record landed in the history and before runs.json said so.
      store.saved = going;
      await restart("2026-11-18T12:10:00");
      expect(spawned()).toHaveLength(3);
      expect(await records("pull")).toHaveLength(1);
    });
  });

  describe("a chain on a service", () => {
    beforeEach(async () => {
      files = { ...files, "web.md": service("Web", "after: { job: pull }\n"), "api.md": service("Api", "after: { job: pull, result: failed, action: stop }\n") };
      load();
    });

    it("performs its action through the supervisor and records it in the history: chain: after Pull, restarted", async () => {
      await runAndEnd("pull");
      expect(actions).toEqual([{ job: "web", action: "restart", why: "chain: after Pull" }]);
      await runs.tick();
      const [record] = await records("web");
      const [parent] = await records("pull");
      expect(record).toMatchObject({ kind: "service", trigger: "chain", event: { what: "restarted", cause: "chain", session: 1, ended: [0] }, state: "done", reason: null, startedAt: null, cause: { kind: "chain", job: "pull", run: parent?.run, result: "done" } });
      expect(record === undefined ? [] : [runWords(record), runTriggerWords(record)]).toEqual(["restarted", "chain: after Pull"]);
      expect(finished.map((done) => done.job)).toContain("web");
      expect(lines).toContain("service web: restart (chain: after Pull) — done");
      expect(runs.active()).toEqual([expect.objectContaining({ job: "on-any" }) as ActiveRun, expect.objectContaining({ job: "on-done" }) as ActiveRun]);
    });

    it("records a skipped or failed action with its reason, and an action that throws as failed", async () => {
      outcome = () => Promise.resolve({ result: "skipped", reason: "it is not running" });
      await runAndEnd("pull");
      outcome = () => Promise.resolve({ result: "failed", reason: "no such folder" });
      await runAndEnd("pull", "crashed");
      outcome = () => Promise.reject(new Error("keeper gone"));
      await runAndEnd("pull");
      await runs.tick();
      expect((await records()).filter((record) => record.kind === "service").map((record) => [record.job, record.event?.what, runWords(record)])).toEqual([
        ["web", "restarted", "restart failed · keeper gone"],
        ["api", "stopped", "stop failed · no such folder"],
        ["web", "restarted", "restart skipped · it is not running"],
      ]);
    });

    it("a slow action holds no other work, and close waits until it is recorded", async () => {
      const answers: ((outcome: ChainActionOutcome) => void)[] = [];
      outcome = () => new Promise((resolve) => answers.push(resolve));
      await runAndEnd("pull");
      expect(await runs.runNow("pull")).toMatchObject({ ok: true });
      await end("pull");
      expect(await records("web")).toEqual([]);
      expect(answers).toHaveLength(2);
      const closing = runs.close();
      for (const answer of answers) answer({ result: "done", session: null, ended: null });
      await closing;
      expect(await records("web")).toHaveLength(2);
    });
  });

  describe("the Mac login hook", () => {
    beforeEach(async () => {
      files = { ...files, "mount.md": script("Mount", "hook: { event: login }\n"), "mount-off.md": script("Mount off", "hook: { event: login }\nenabled: false\n") };
      load();
      await restart("2026-11-18T13:00:00");
    });

    it("runs once per scheduler start, after the warm-up, through the queue: trigger hook", async () => {
      expect(going("mount")).toEqual([expect.objectContaining({ state: "queued", trigger: "hook", cause: { kind: "hook", event: "login", context: {} }, waits: { kind: "warm-up", until: ms("2026-11-18T13:02:00") } }) as ActiveRun]);
      expect(lines).toContain("hook login: fires mount");
      await awake("2026-11-18T13:01:59");
      expect(spawned()).toEqual([]);
      await awake("2026-11-18T13:02:00");
      expect(spawned()).toEqual(["mount hook"]);
      expect(envOf("mount")).toMatchObject({ POMADE_JOB: "mount", POMADE_TRIGGER: "hook" });
      await end("mount");
      await awake("2026-11-18T14:00:00", 60_000);
      expect(spawned()).toEqual(["mount hook"]);
      const [record] = await records("mount");
      expect(record === undefined ? "" : runTriggerWords(record)).toBe("hook: Mac login");
      // The next start is the next login.
      await restart("2026-11-18T15:00:00");
      await awake("2026-11-18T15:02:00");
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
    });

    /** The login run of the start before goes and ends. */
    async function settle(): Promise<void> {
      await awake("2026-11-18T13:02:00");
      await end("mount");
      expect(going("mount")).toEqual([]);
    }

    it("waits for the services' staged start, then the warm-up", async () => {
      await settle();
      settled = false;
      await restart("2026-11-18T14:00:00");
      expect(going("mount")[0]?.waits).toEqual({ kind: "warm-up", until: null });
      await awake("2026-11-18T14:05:00", 60_000);
      expect(spawned()).toEqual(["mount hook"]);
      settled = true;
      await awake("2026-11-18T14:07:00");
      expect(going("mount")[0]?.waits).toEqual({ kind: "warm-up", until: ms("2026-11-18T14:07:01") });
      await awake("2026-11-18T14:07:01");
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
    });

    it("fires once the keeper is followed, never while it is not", async () => {
      await settle();
      sessions.following = false;
      await restart("2026-11-18T14:00:00");
      await awake("2026-11-18T14:05:00", 60_000);
      expect(going("mount")).toEqual([]);
      sessions.following = true;
      await awake("2026-11-18T14:08:00", 60_000);
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
    });

    it("a start at the same console login — an update, a crash-restart of the scheduler — is no login: no login hooks, and caught-up runs need no warm-up", async () => {
      await settle();
      files = { ...files, "report.md": script("Report", `schedule:\n  daily: { at: 13:30 }\n${free}`) };
      load();
      logins.loggedIn = false;
      await restart("2026-11-18T14:00:00");
      expect(lines).toContain(`start: the same console login (${logins.recorded ?? ""}) — no login: no warm-up, no login hooks`);
      expect(going("mount")).toEqual([]);
      // Down across 13:30: one caught-up run, at once.
      expect(going("report")).toEqual([expect.objectContaining({ state: "running", trigger: "caught-up" }) as ActiveRun]);
      await awake("2026-11-18T14:10:00", 60_000);
      expect(spawned()).toEqual(["mount hook", "report caught-up"]);
    });

    it("a start at a new console login is a login although the keeper outlived the log-out: the login hooks fire once, after the warm-up, and the login is kept", async () => {
      await settle();
      sessions.keeperStarted = false;
      await restart("2026-11-18T14:00:00");
      expect(lines).toContain("login: a new console login (console 3) — the staged start begins; the login hooks run after the warm-up");
      expect(going("mount")[0]?.waits).toEqual({ kind: "warm-up", until: ms("2026-11-18T14:02:00") });
      expect(logins.recorded).toBe("console 3");
      await awake("2026-11-18T14:02:00");
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
      await end("mount");
      // A crash-restart within that login.
      logins.loggedIn = false;
      await restart("2026-11-18T14:30:00");
      await awake("2026-11-18T14:40:00", 60_000);
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
    });

    it("a start at the same console login is no login although the scheduler had to start the keeper", async () => {
      await settle();
      logins.loggedIn = false;
      await restart("2026-11-18T14:00:00");
      expect(lines.at(-1)).toMatch(/^start: the same console login \(console 2\) — no login/);
      await awake("2026-11-18T14:10:00", 60_000);
      expect(spawned()).toEqual(["mount hook"]);
    });

    it("with no console login kept — the first start after the update to Runner that keeps one — a start that finds the keeper running is no login, and keeps the console login", async () => {
      await settle();
      logins.recorded = null;
      sessions.keeperStarted = false;
      await restart("2026-11-18T14:00:00");
      expect(lines).toContain("start: no console login acted on yet, and the keeper was running — no login: no warm-up, no login hooks");
      expect(logins.recorded).toBe("console 3");
      await awake("2026-11-18T14:10:00", 60_000);
      expect(spawned()).toEqual(["mount hook"]);
      // The next console login is a login.
      await restart("2026-11-18T15:00:00");
      await awake("2026-11-18T15:02:00");
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
    });

    it("a console login that cannot be told leaves it to the keeper, and keeps the one acted on", async () => {
      await settle();
      logins.current = () => Promise.resolve({ status: "unknown", why: "no loginwindow of this user runs" });
      sessions.keeperStarted = false;
      await restart("2026-11-18T14:00:00");
      expect(lines).toContain("start: the console login cannot be told (no loginwindow of this user runs), and the keeper was running — no login: no warm-up, no login hooks");
      sessions.keeperStarted = true;
      await restart("2026-11-18T15:00:00");
      expect(lines).toContain("login: the console login cannot be told (no loginwindow of this user runs), and no keeper was running — the staged start begins; the login hooks run after the warm-up");
      await awake("2026-11-18T15:02:00");
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
      expect(logins.recorded).toBe("console 2");
    });

    it("decides only once the keeper is followed, and once per start", async () => {
      await settle();
      const decided = (): number => lines.filter((line) => line.startsWith("login:")).length;
      const before = decided();
      sessions.following = false;
      await restart("2026-11-18T14:00:00");
      expect(decided()).toBe(before);
      sessions.following = true;
      await at("2026-11-18T14:00:01");
      expect(decided()).toBe(before + 1);
      await awake("2026-11-18T14:10:00", 60_000);
      expect(decided()).toBe(before + 1);
      expect(spawned()).toEqual(["mount hook", "mount hook"]);
    });

    it("a login run still queued at the next start is not doubled: its overlap skips the new one", async () => {
      await restart("2026-11-18T14:00:00");
      expect(going("mount")).toHaveLength(1);
      expect((await records("mount"))[0]).toMatchObject({ state: "skipped", reason: "previous run still going", trigger: "hook" });
    });
  });

  describe("an event through hook()", () => {
    beforeEach(() => {
      files = {
        "first-p1.md": script("First p1", "hook: { event: project-first-open, project: p1 }\n"),
        "first-any.md": script("First any", "hook: { event: project-first-open }\n"),
        "status.md": script("Status", "hook: { event: session-status, status: done }\n"),
      };
      load();
    });

    it("fires the jobs it matches, with its context in their environment", async () => {
      await fire({ event: "project-first-open", project: "p1", context: { POMADE_PROJECT: "p1", POMADE_PROJECT_PATH: "/ws/Projects/one" } });
      expect(spawned()).toEqual(["first-any hook", "first-p1 hook"]);
      expect(envOf("first-any")).toMatchObject({ POMADE_TRIGGER: "hook", POMADE_PROJECT: "p1", POMADE_PROJECT_PATH: "/ws/Projects/one" });
      expect(going("first-p1")[0]?.cause).toEqual({ kind: "hook", event: "project-first-open", context: { POMADE_PROJECT: "p1", POMADE_PROJECT_PATH: "/ws/Projects/one" } });
      await fire({ event: "session-status", status: "on-hold" });
      await fire({ event: "pomade-started" });
      expect(spawned()).toHaveLength(2);
    });

    it("its runs wait for the warm-up after a start, and are queued while the keeper is not followed", async () => {
      await restart("2026-11-18T13:00:00");
      await fire({ event: "session-status", status: "done" });
      expect(going("status")[0]).toMatchObject({ state: "queued", waits: { kind: "warm-up" } });
      await awake("2026-11-18T13:02:00");
      expect(spawned()).toEqual(["status hook"]);
      await end("status");
      sessions.following = false;
      await fire({ event: "session-status", status: "done" });
      expect(going("status")[0]).toMatchObject({ state: "queued" });
      expect(spawned()).toHaveLength(1);
      sessions.following = true;
      await runs.tick();
      expect(spawned()).toHaveLength(2);
    });
  });

  describe("the loop guard", () => {
    beforeEach(() => {
      files = { ...files, "status.md": script("Status", "hook: { event: session-status, status: done }\noverlap: parallel\nlow-priority: false\n") };
      load();
    });

    const fireTimes = async (count: number, stepMs = 10_000): Promise<void> => {
      for (let i = 0; i < count; i++) {
        await fire({ event: "session-status", status: "done" });
        now = new Date(now.getTime() + stepMs);
      }
    };

    it("a hook firing a job 11 times in 10 min pauses it: the 11th does not run; a Needs-you item and one notice", async () => {
      await fireTimes(10);
      expect(spawned().filter((line) => line.startsWith("status"))).toHaveLength(10);
      expect(runs.needsYou()).toEqual([]);
      await fireTimes(1);
      expect(spawned().filter((line) => line.startsWith("status"))).toHaveLength(10);
      const paused = { id: "loop-paused:status", kind: "loop-paused", job: "status", name: "Status", project: null, at: ms("2026-11-18T12:04:40"), detail: LOOP_WORDS };
      expect(runs.needsYou()).toEqual([paused]);
      expect(LOOP_WORDS).toBe("triggered 10× in 10 min — looks like a loop");
      expect(notices).toEqual([expect.objectContaining({ title: "Status paused: triggered 10× in 10 min — looks like a loop", action: { kind: "openApp", route: "" } })]);
      expect(lines).toContain("job status: fired more than 10 times in 10 min by hooks or chains — looks like a loop; paused until Resume");
      await fireTimes(5);
      expect(spawned().filter((line) => line.startsWith("status"))).toHaveLength(10);
      expect(notices).toHaveLength(1);
      expect(lines).toContain("job status: paused by the loop guard; hook: session status changed does not fire it");
    });

    it("firings spread wider than the window never pause", async () => {
      await fireTimes(40, 61_000);
      expect(spawned().filter((line) => line.startsWith("status"))).toHaveLength(40);
      expect(runs.needsYou()).toEqual([]);
    });

    it("chains count too: a parent run 11 times fires its follower 10 times, then pauses it", async () => {
      files = { "pull.md": script("Pull", inert), "after.md": script("After", "after: { job: pull }\noverlap: parallel\nlow-priority: false\n") };
      load();
      for (let i = 0; i < 11; i++) await runAndEnd("pull");
      expect(spawned().filter((line) => line.startsWith("after"))).toHaveLength(10);
      expect(runs.needsYou().map((item) => item.id)).toEqual(["loop-paused:after"]);
      // Run now is the person's: it runs the paused job and does not count.
      expect(await runs.runNow("after")).toMatchObject({ ok: true });
      expect(runs.needsYou().map((item) => item.id)).toEqual(["loop-paused:after"]);
    });

    it("a service fired by chains is guarded too", async () => {
      files = { "pull.md": script("Pull", inert), "web.md": service("Web", "after: { job: pull }\n") };
      load();
      for (let i = 0; i < 12; i++) await runAndEnd("pull");
      expect(actions).toHaveLength(10);
      expect(runs.needsYou().map((item) => item.id)).toEqual(["loop-paused:web"]);
    });

    it("the pause and the count survive a restart; Resume lifts the pause with a fresh count", async () => {
      await fireTimes(9);
      expect(store.saved.guard.fired.status).toHaveLength(9);
      await restart("2026-11-18T12:05:00");
      await fireTimes(2);
      expect(store.saved.guard.paused.status).toMatchObject({ name: "Status" });
      await restart("2026-11-18T12:30:00");
      expect(runs.needsYou().map((item) => item.id)).toEqual(["loop-paused:status"]);
      await awake("2026-11-18T12:33:00", 60_000);
      const before = sessions.spawned.length;
      await fireTimes(1);
      expect(sessions.spawned).toHaveLength(before);

      expect(await runs.resume("Status")).toEqual({ ok: true, job: "status", name: "Status" });
      expect(runs.needsYou()).toEqual([]);
      expect(store.saved.guard).toEqual({ fired: {}, paused: {} });
      expect(lines).toContain("job status: Resume — hooks and chains fire it again");
      await fireTimes(10);
      expect(sessions.spawned).toHaveLength(before + 10);
      await fireTimes(1);
      expect(sessions.spawned).toHaveLength(before + 10);
      expect(await runs.resume("status")).toEqual({ ok: true, job: "status", name: "Status" });
      expect(await runs.resume("status")).toEqual({ ok: false, reason: '"status" is not paused' });
      expect(await runs.resume("nobody")).toEqual({ ok: false, reason: '"nobody" is not paused' });
    });

    it("a paused job's item hides while its file is gone, and comes back with it, still paused", async () => {
      await fireTimes(11);
      const all = files;
      files = { "pull.md": all["pull.md"] ?? "" };
      load();
      expect(runs.needsYou()).toEqual([]);
      files = all;
      load();
      expect(runs.needsYou().map((item) => item.id)).toEqual(["loop-paused:status"]);
    });
  });
});
