// Agent runs on the run lifecycle's stand-ins (`runs-fixture.ts`): the launch — the roster, the mode,
// the launch spec's line in the user's interactive login shell in the job's folder — the turn
// followed and the exit typed, every way such a run ends, the session looked up when the provider
// cannot pre-assign it, why one cannot start, and the run events as `pomade-agents` reads them
// (`../pomade-agents/docs/CONTRACTS.md` "Subscribed events").

process.env.TZ = "Europe/Madrid";

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { NoticeParams } from "pomade-kit/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsError } from "../integrations/agents";
import type { RunFinishedPayload, RunStartedPayload } from "../integrations/runner-api";
import { checkJobs } from "../jobs/check";
import type { JobsSnapshot } from "../jobs/model";
import { recordsFolderOf, runsRecordPath, stateFolderOf } from "../locations";
import { AGENT_EXIT_WAIT_MS, agentArgv, agentEnd, answeredEnd, lookupWindow, pickSession } from "./agent-runs";
import { createHistory, keepOutputLog } from "./history";
import { parseRunRecord, type ActiveRun, type AgentRun, type RunRecord } from "./model";
import { runFinishedPayload, runStartedPayload } from "./run-events";
import { createRuns, fileRunsStore, type Runs } from "./runs";
import { FakeAgents, FakePomade, FakeSessions, FakeTurns, memoryStore, memorySwitch, script } from "./runs-fixture";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const agentFile = (extra = "", body = "Write my morning summary."): string => `---\nkind: agent\nname: Morning summary\nfolder: Projects/x\nagent: claude\n${extra}schedule:\n  daily: { at: 7:00 }\n---\n${body}\n`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Every rule `pomade-agents` reads an agent run's events by; the problems, empty when it passes. */
function contractProblems(started: RunStartedPayload, finished: RunFinishedPayload): string[] {
  const problems: string[] = [];
  const nonEmpty = (name: string, value: unknown): void => {
    if (typeof value !== "string" || value === "") problems.push(`${name} is not a non-empty string`);
  };
  for (const payload of [started, finished]) {
    nonEmpty("job", payload.job);
    nonEmpty("name", payload.name);
    nonEmpty("run", payload.run);
    nonEmpty("agent", payload.agent);
    nonEmpty("mode", payload.mode);
    if (payload.kind !== "agent") problems.push("kind is not agent");
    if (typeof payload.folder !== "string") problems.push("folder is not a string");
    if (payload.project !== null && (typeof payload.project !== "string" || payload.project === "")) problems.push("project is neither null nor non-empty");
    if (typeof payload.trigger !== "string") problems.push("trigger is not a string");
    if (payload.sessionId !== null && (typeof payload.sessionId !== "string" || payload.sessionId === "")) problems.push("sessionId is neither null nor non-empty");
    if (typeof payload.cwd !== "string" || !payload.cwd.startsWith("/")) problems.push("cwd is not absolute");
    if (payload.startedByRunner !== true) problems.push("startedByRunner is not true");
    if (typeof payload.terminal !== "string" || !/^run:[A-Za-z0-9._-]+:\d{8}-\d{6}-[0-9a-f]{6}$/.test(payload.terminal)) problems.push("terminal is not a run's keeper session id");
    if (typeof payload.startedAt !== "string" || !ISO_WITH_ZONE.test(payload.startedAt)) problems.push("startedAt is not ISO 8601 with a zone");
  }
  if (finished.job !== started.job || finished.run !== started.run) problems.push("run.finished names another run");
  for (const [key, value] of Object.entries(started)) {
    if (key !== "sessionId" && JSON.stringify((finished as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)) problems.push(`run.finished does not repeat ${key}`);
  }
  nonEmpty("result", finished.result);
  if (finished.exitCode !== null && !Number.isInteger(finished.exitCode)) problems.push("exitCode is not an integer");
  return problems;
}

describe("agent runs", () => {
  let dir: string;
  let workspace: string;
  let now: Date;
  let files: Record<string, string>;
  let snapshot: JobsSnapshot;
  let sessions: FakeSessions;
  let turns: FakeTurns;
  let agents: FakeAgents;
  let connected: boolean;
  let pomade: FakePomade;
  let started: ActiveRun[];
  let finished: RunRecord[];
  let lines: string[];
  let runs: Runs;
  let store: ReturnType<typeof memoryStore>;
  let notices: NoticeParams[];
  let settings: Settings;

  function load(): void {
    snapshot = checkJobs(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { workspace, projects: [] },
    );
  }

  async function open(): Promise<void> {
    runs = createRuns({
      sessions,
      jobs: () => snapshot,
      settings: () => settings,
      servicesSettled: () => true,
      clock: { now: () => now },
      log: (line) => lines.push(line),
      history: createHistory(recordsFolderOf(dir), stateFolderOf(dir), () => undefined),
      store,
      switchStore: memorySwitch(),
      post: (notice) => notices.push(notice),
      projectPath: () => null,
      agents: () => (connected ? agents : null),
      pomade,
      turns,
      shell: "/bin/zsh",
      pomadeGit: join(dir, "bin", "pomade-git"),
      gitResult: (job, run) => join(dir, "output", job, `${run}.json`),
      keepLog: (job, run) => keepOutputLog(recordsFolderOf(dir), stateFolderOf(dir), job, run),
      serviceAction: () => Promise.reject(new Error("no services here")),
      onStarted: (run) => started.push(structuredClone(run)),
      onFinished: (record) => finished.push(record),
      onChange: () => undefined,
    });
    await runs.load();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pra-"));
    workspace = join(dir, "ws");
    await mkdir(join(workspace, "Projects/x"), { recursive: true });
    now = new Date("2026-11-18T12:00:00");
    files = { "summary.md": agentFile() };
    load();
    sessions = new FakeSessions(() => now.getTime(), dir);
    turns = new FakeTurns();
    store = memoryStore();
    agents = new FakeAgents();
    agents.agents = [
      { id: "claude", name: "Claude", command: "claude", provider: "claude", modes: [{ id: "normal", name: "Normal", args: [] }, { id: "full-autonomy", name: "Full autonomy", args: ["--dangerously-skip-permissions"] }] },
      { id: "claude-pm", name: "claude-pm", command: "claude-pm", provider: "claude", modes: [{ id: "normal", name: "Normal", args: [] }] },
      { id: "codex", name: "Codex", command: "codex", provider: "codex" },
    ];
    connected = true;
    pomade = new FakePomade();
    started = [];
    finished = [];
    lines = [];
    notices = [];
    settings = DEFAULT_SETTINGS;
    await open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runs.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function runNow(): Promise<ActiveRun> {
    const result = await runs.runNow("summary");
    if (!result.ok || !("run" in result)) throw new Error(`not started: ${JSON.stringify(result)}`);
    return result.run;
  }

  it("launches the launch spec's line in the user's interactive login shell, in the job's folder, with a session id Runner made", async () => {
    const run = await runNow();
    expect(agents.launches).toEqual([{ agent: "claude", mode: "normal", sessionId: expect.stringMatching(UUID) as string, prompt: "Write my morning summary." }]);
    const sessionId = agents.launches[0]?.sessionId ?? "";
    const spawn = sessions.spawned[0];
    const cwd = await realpath(join(workspace, "Projects/x"));
    const line = `claude '--session-id' '${sessionId}' 'Write my morning summary.'`;
    expect(spawn?.command).toMatchObject({ title: "Morning summary", argv: ["/bin/zsh", "-l", "-i", "-c", line], cwd, background: true });
    expect(run.agent).toEqual({ agent: "claude", name: "Claude", provider: "claude", mode: "normal", modeName: "Normal", sessionId, cwd, startedAt: new Date(now).toISOString(), exit: "/exit", exitSentAt: null, waiting: null, waitedMs: 0 });
    expect(turns.watched()).toEqual([run.session]);
  });

  it("types the exit command once the turn is done; the agent's exit is done, with its session on run.finished", async () => {
    const run = await runNow();
    const session = run.session ?? "";
    turns.done(session);
    await runs.tick();
    expect(turns.typed).toEqual([{ session, text: "/exit" }]);
    turns.done(session);
    await runs.tick();
    expect(turns.typed).toHaveLength(1);
    sessions.end(session, "exited", 0);
    await runs.tick();
    const record = finished[0];
    expect(record).toMatchObject({ state: "done", reason: null, exitCode: 0, agent: { agent: "claude", sessionId: run.agent?.sessionId, exitSentAt: now.getTime() } });
    expect(turns.watched()).toEqual([]);
    if (record === undefined || started[0] === undefined) throw new Error("no run");
    expect(contractProblems(runStartedPayload(started[0]), runFinishedPayload(record))).toEqual([]);
  });

  it("an agent run's run.started and run.finished name its keeper session as the terminal; a script run's events carry none", async () => {
    const run = await runNow();
    const session = run.session ?? "";
    expect(session).toMatch(/^run:summary:/);
    const [event] = started;
    if (event === undefined) throw new Error("no run.started");
    expect(runStartedPayload(event).terminal).toBe(session);
    sessions.end(session, "exited", 0);
    await runs.tick();
    const record = finished[0];
    if (record === undefined) throw new Error("no run.finished");
    expect(runFinishedPayload(record).terminal).toBe(session);
    expect(runStartedPayload({ ...event, kind: "script", agent: null })).not.toHaveProperty("terminal");
  });

  it("fails a run whose turn ended without an answer: the agent still gets its exit command, its last lines keep its screen", async () => {
    agents.message = null;
    const run = await runNow();
    const session = run.session ?? "";
    const log = sessions.sessions.get(session)?.log ?? "";
    await mkdir(dirname(log), { recursive: true });
    await writeFile(log, "⎿ API Error: Not logged in · Please run /login\n> /exit\nBye.\n");
    turns.done(session);
    await runs.tick();
    expect(turns.typed).toEqual([{ session, text: "/exit" }]);
    expect(agents.asked).toEqual([]);
    sessions.end(session, "exited", 0);
    await runs.tick();
    expect(agents.asked).toEqual([run.agent?.sessionId]);
    const record = finished[0];
    expect(record).toMatchObject({ state: "failed", reason: "the agent's turn ended without an answer", exitCode: 0 });
    expect(record?.lastLines).toContain("⎿ API Error: Not logged in · Please run /login");
    if (record === undefined) throw new Error("no run");
    expect(runFinishedPayload(record)).toMatchObject({ result: "failed" });
  });

  it("records a turn as done when the Agents app cannot say whether the agent answered: not answering, Pomade gone, no session id", async () => {
    agents.message = null;
    const turnDone = async (): Promise<void> => {
      const run = await runNow();
      turns.done(run.session ?? "");
      await runs.tick();
      sessions.end(run.session ?? "", "exited", 0);
    };
    await turnDone();
    agents.fail = new AgentsError("absent", "the Agents app (pomade-agents) is not answering");
    await runs.tick();
    expect(finished.at(-1)).toMatchObject({ state: "done", reason: null });
    expect(lines).toContainEqual(expect.stringContaining("cannot ask whether the agent answered — the Agents app (pomade-agents) is not answering"));
    agents.fail = null;
    await turnDone();
    connected = false;
    await runs.tick();
    expect(finished.at(-1)).toMatchObject({ state: "done", reason: null });
    connected = true;
    files = { "summary.md": agentFile().replace("agent: claude", "agent: codex") };
    load();
    agents.preassigns = false;
    const asked = agents.asked.length;
    await turnDone();
    await runs.tick();
    expect(finished.at(-1)).toMatchObject({ state: "done", reason: null, agent: { sessionId: null } });
    expect(agents.asked).toHaveLength(asked);
    expect(finished).toHaveLength(3);
  });

  it("asks nothing of a run that did not end on its exit command", async () => {
    agents.message = null;
    const run = await runNow();
    sessions.end(run.session ?? "", "exited", 0);
    await runs.tick();
    expect(finished.at(-1)).toMatchObject({ state: "failed", reason: "the agent exited before its turn was done" });
    expect(agents.asked).toEqual([]);
  });

  it("reads an exit before the turn was done, or a crash after the exit command, as failed", async () => {
    let run = await runNow();
    sessions.end(run.session ?? "", "exited", 0);
    await runs.tick();
    expect(finished.at(-1)).toMatchObject({ state: "failed", reason: "the agent exited before its turn was done", exitCode: 0 });
    run = await runNow();
    turns.done(run.session ?? "");
    await runs.tick();
    sessions.end(run.session ?? "", "crashed", 3);
    await runs.tick();
    expect(finished.at(-1)).toMatchObject({ state: "failed", reason: null, exitCode: 3 });
  });

  it("stops an agent that did not end after its exit command: the run is done, its turn was", async () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const run = await runNow();
    turns.done(run.session ?? "");
    await runs.tick();
    clock += AGENT_EXIT_WAIT_MS - 1;
    await runs.tick();
    expect(sessions.stops).toEqual([]);
    clock += 1;
    await runs.tick();
    expect(sessions.stops).toEqual([{ id: run.session, reason: "stopped" }]);
    await runs.tick();
    expect(sessions.stops).toHaveLength(1);
    sessions.end(run.session ?? "", "stopped", null, 2000, "SIGTERM");
    await runs.tick();
    expect(finished[0]).toMatchObject({ state: "done", reason: null });
  });

  it("looks up a session the provider could not pre-assign, by its folder and start time, and puts it on run.finished", async () => {
    files = { "summary.md": agentFile("mode: full-autonomy\n").replace("agent: claude", "agent: codex") };
    load();
    agents.preassigns = false;
    const run = await runNow();
    expect(run.agent).toMatchObject({ sessionId: null, provider: "codex", mode: "full-autonomy", modeName: "Full autonomy" });
    expect(sessions.spawned[0]?.command.argv?.at(-1)).toBe("codex '--dangerously-bypass-approvals-and-sandbox' 'Write my morning summary.'");
    const cwd = run.agent?.cwd ?? "";
    agents.found = [
      { id: "other", provider: "codex", agent: "codex", cwd, startedAt: new Date(now.getTime() - 8_000).toISOString(), lastActiveAt: now.toISOString() },
      { id: "019a-ours", provider: "codex", agent: "codex", cwd, startedAt: new Date(now.getTime() + 400).toISOString(), lastActiveAt: now.toISOString() },
    ];
    turns.done(run.session ?? "");
    await runs.tick();
    expect(runs.active()[0]?.agent?.sessionId).toBe("019a-ours");
    sessions.end(run.session ?? "", "exited", 0);
    await runs.tick();
    const record = finished[0];
    if (record === undefined || started[0] === undefined) throw new Error("no run");
    expect(runStartedPayload(started[0]).sessionId).toBeNull();
    expect(runFinishedPayload(record)).toMatchObject({ sessionId: "019a-ours", result: "done", agent: "codex", mode: "full-autonomy", cwd, startedByRunner: true });
    expect(contractProblems(runStartedPayload(started[0]), runFinishedPayload(record))).toEqual([]);
  });

  it("does not start without Pomade, without the Agents app, without the agent or its mode, or without its folder — and says why", async () => {
    const reason = async (): Promise<string> => {
      const result = await runs.runNow("summary");
      return result.ok ? "started" : result.reason;
    };
    connected = false;
    expect(await reason()).toBe("cannot start — Runner is not connected to Pomade, and an agent run needs it");
    connected = true;
    agents.fail = new AgentsError("absent", "the Agents app (pomade-agents) is not running");
    expect(await reason()).toBe("cannot start — the Agents app (pomade-agents) is not running");
    agents.fail = null;
    files = { "summary.md": agentFile().replace("agent: claude", "agent: claude-editor") };
    load();
    expect(await reason()).toBe('cannot start — the Agents app has no agent "claude-editor"');
    files = { "summary.md": agentFile("mode: full-autonomy\n").replace("agent: claude", "agent: claude-pm") };
    load();
    expect(await reason()).toBe("cannot start — claude-pm has no Full autonomy mode");
    files = { "summary.md": agentFile().replace("folder: Projects/x", "folder: Projects/gone") };
    load();
    expect(await reason()).toBe("cannot start — its folder Projects/gone does not exist");
    expect(finished.map((record) => [record.state, record.startedAt])).toEqual(Array.from({ length: 5 }, () => ["failed", null]));
    expect(sessions.spawned).toEqual([]);
  });

  const minutes = (n: number): void => {
    now = new Date(now.getTime() + n * 60_000);
  };

  /** Let an opening that was settled reach the lane, and the lane run it. */
  async function settled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runs.tick();
  }

  describe("Pomade opened for a run", () => {
    beforeEach(async () => {
      await mkdir(join(workspace, "Projects/x"), { recursive: true });
      files = {
        "summary.md": agentFile(),
        "inbox.md": agentFile().replace("name: Morning summary", "name: Tidy drafts").replace("at: 7:00", "at: 7:01"),
        "backup.md": script("Backup", "schedule:\n  daily: { at: 7:00 }\n").replace("folder: Projects/x", "folder: ."),
      };
      load();
      pomade.isUp = false;
      now = new Date("2026-11-18T06:59:30");
      await runs.tick();
    });

    const kinds = (): string[] => sessions.spawned.map((spawn) => spawn.owner.job);

    it("an agent run due while Pomade is not up waits while Runner opens it; one due meanwhile waits for the same opening; up, they start in their order — a script never waits", async () => {
      minutes(1);
      await runs.tick();
      expect(pomade.opened).toBe(1);
      expect(kinds()).toEqual(["backup"]);
      expect(runs.active().find((run) => run.job === "summary")).toMatchObject({ state: "queued", waits: { kind: "pomade" } });
      expect(lines).toContainEqual(expect.stringMatching(/^run summary \S+: queued · opening Pomade$/));
      minutes(1);
      await runs.tick();
      expect(pomade.opened).toBe(1);
      expect(runs.active().filter((run) => run.kind === "agent").map((run) => [run.job, run.state, run.waits?.kind])).toEqual([
        ["summary", "queued", "pomade"],
        ["inbox", "queued", "pomade"],
      ]);
      expect(finished).toEqual([]);
      pomade.settle(null);
      await settled();
      // The script and the first agent run take the two low-priority slots; the second agent run is
      // next, first come first served.
      expect(kinds()).toEqual(["backup", "summary"]);
      expect(runs.active().find((run) => run.job === "inbox")).toMatchObject({ state: "queued", waits: { kind: "slot", ahead: 1 } });
      sessions.end(sessions.list().find((session) => session.job === "backup")?.id ?? "", "exited", 0);
      await runs.tick();
      expect(kinds()).toEqual(["backup", "summary", "inbox"]);
      expect(pomade.opened).toBe(1);
    });

    it("Run now of an agent job while Pomade is not up queues it behind the opening", async () => {
      const result = await runs.runNow("summary");
      expect(result).toMatchObject({ ok: true, run: { state: "queued", waits: { kind: "pomade" } } });
      expect(pomade.opened).toBe(1);
      pomade.settle(null);
      await settled();
      expect(kinds()).toEqual(["summary"]);
    });

    it("an opening that fails fails every run waiting for it with why; the next one due opens Pomade again", async () => {
      minutes(2);
      await runs.tick();
      expect(pomade.opened).toBe(1);
      pomade.settle("Pomade could not be opened: Pomade did not become ready in time");
      await settled();
      expect(finished.filter((record) => record.kind === "agent").map((record) => [record.job, record.state, record.reason, record.startedAt]).sort()).toEqual([
        ["inbox", "failed", "cannot start — Pomade could not be opened: Pomade did not become ready in time", null],
        ["summary", "failed", "cannot start — Pomade could not be opened: Pomade did not become ready in time", null],
      ]);
      expect(runs.active().filter((run) => run.kind === "agent")).toEqual([]);
      expect(kinds()).toEqual(["backup"]);
      await runs.runNow("summary");
      expect(pomade.opened).toBe(2);
    });

    it("a scheduler restarted while a run waits for Pomade opens it again, and the run starts once it is up", async () => {
      minutes(1);
      await runs.tick();
      await runs.close();
      pomade = new FakePomade();
      pomade.isUp = false;
      await open();
      await runs.tick();
      expect(runs.active().find((run) => run.job === "summary")).toMatchObject({ state: "queued", waits: { kind: "pomade" } });
      expect(pomade.opened).toBe(1);
      pomade.settle(null);
      await settled();
      expect(kinds()).toEqual(["backup", "summary"]);
    });
  });

  describe("the keeper's reach to the keychain", () => {
    const LOST = { status: "unreachable", detail: "exit 50" } as const;

    it("a healthy keeper: one check, no replacement, the run starts; script and git runs are not checked", async () => {
      files = { ...files, "backup.md": script("Backup").replace("folder: Projects/x", "folder: .") };
      load();
      await runs.runNow("backup");
      expect(sessions.checks).toEqual([]);
      await runNow();
      expect(sessions.checks).toEqual([1]);
      expect(sessions.replaced).toEqual([]);
      expect(sessions.spawned.map((spawn) => spawn.owner.job)).toEqual(["backup", "summary"]);
    });

    it("a keeper that fails the check with nothing going is replaced, checked again, and the run starts", async () => {
      sessions.keychain.push(LOST);
      const run = await runNow();
      expect(sessions.replaced).toEqual(["it cannot reach the macOS keychain"]);
      expect(sessions.checks).toEqual([1, 2]);
      expect(run.state).toBe("running");
      expect(sessions.spawned.map((spawn) => spawn.owner.job)).toEqual(["summary"]);
    });

    it("with a run going, the agent run waits queued for a fresh keeper; once the run ends the keeper is replaced and it starts", async () => {
      files = { ...files, "backup.md": script("Backup").replace("folder: Projects/x", "folder: .") };
      load();
      await runs.runNow("backup");
      sessions.keychain.push(LOST);
      const result = await runs.runNow("summary");
      expect(result).toMatchObject({ ok: true, run: { state: "queued", waits: { kind: "keeper" } } });
      expect(lines).toContainEqual(expect.stringMatching(/^run summary \S+: queued · a fresh keeper, after the runs going$/));
      expect(sessions.replaced).toEqual([]);
      // Ticks while the run goes check nothing more.
      await runs.tick();
      expect(sessions.checks).toEqual([1]);
      expect(runs.active().find((run) => run.job === "summary")).toMatchObject({ state: "queued", waits: { kind: "keeper" } });

      sessions.keychain.push(LOST);
      sessions.end(sessions.latest("backup"), "exited", 0);
      await runs.tick();
      expect(sessions.replaced).toEqual(["it cannot reach the macOS keychain"]);
      expect(sessions.checks).toEqual([1, 1, 2]);
      expect(runs.active().find((run) => run.job === "summary")).toMatchObject({ state: "running" });
      expect(finished.map((record) => [record.job, record.state])).toEqual([["backup", "done"]]);
    });

    it("a keeper replaced meanwhile — it crashed — is checked afresh: no second replacement", async () => {
      files = { ...files, "backup.md": script("Backup").replace("folder: Projects/x", "folder: .") };
      load();
      await runs.runNow("backup");
      sessions.keychain.push(LOST);
      await runs.runNow("summary");
      sessions.link = { state: "connected", version: "v1", pid: 7 };
      await runs.tick();
      expect(sessions.checks).toEqual([1, 7]);
      expect(sessions.replaced).toEqual([]);
      expect(runs.active().find((run) => run.job === "summary")).toMatchObject({ state: "running" });
    });

    it("a fresh keeper that fails the check too fails the run, with why; a check that could not run holds nothing back", async () => {
      sessions.keychain.push(LOST, LOST);
      expect(await runs.runNow("summary")).toEqual({ ok: false, reason: "cannot start — the keeper cannot reach the macOS keychain, so the agent would have no login" });
      expect(sessions.checks).toEqual([1, 2]);
      expect(finished.map((record) => [record.state, record.reason, record.startedAt])).toEqual([["failed", "cannot start — the keeper cannot reach the macOS keychain, so the agent would have no login", null]]);
      expect(sessions.spawned).toEqual([]);

      sessions.keychain.push({ status: "unknown", detail: "it did not end within 5 s" });
      await runNow();
      expect(sessions.replaced).toHaveLength(1);
      expect(sessions.spawned.map((spawn) => spawn.owner.job)).toEqual(["summary"]);
    });
  });

  it("waits for you at a permission prompt — a Needs-you item and one notice that opens it at the prompt — and goes on once answered", async () => {
    const run = await runNow();
    const session = run.session ?? "";
    minutes(2);
    turns.waits(session, "permission");
    await runs.tick();
    const waitingSince = now.getTime();
    expect(runs.active()[0]?.agent?.waiting).toEqual({ prompt: "permission", since: waitingSince });
    expect(runs.needsYou()).toEqual([{ id: `waiting:summary:${run.run}`, kind: "waiting", job: "summary", name: "Morning summary", project: null, run: run.run, prompt: "permission", at: waitingSince, detail: "waiting for approval" }]);
    expect(notices).toEqual([
      {
        title: "Morning summary needs your approval",
        body: "The agent waits at a permission prompt. Open it to answer; the time limit is paused meanwhile.",
        action: { kind: "openApp", route: `prompt/summary/${run.run}` },
      },
    ]);
    // The same prompt read again — a resync, a restart — is the same wait: no second notice.
    turns.waits(session, "permission");
    await runs.tick();
    expect(notices).toHaveLength(1);
    minutes(5);
    turns.waits(session, null);
    await runs.tick();
    expect(runs.active()[0]?.agent).toMatchObject({ waiting: null, waitedMs: 5 * 60_000 });
    expect(runs.needsYou()).toEqual([]);
    expect(turns.typed).toEqual([]);
    turns.done(session);
    await runs.tick();
    expect(turns.typed).toEqual([{ session, text: "/exit" }]);
    sessions.end(session, "exited", 0);
    await runs.tick();
    expect(finished[0]).toMatchObject({ state: "done", agent: { waiting: null, waitedMs: 5 * 60_000 } });
  });

  it("pauses the time limit while it waits for you", async () => {
    files = { "summary.md": agentFile("time-limit: 10m\n") };
    load();
    const run = await runNow();
    const session = run.session ?? "";
    minutes(4);
    turns.waits(session, "permission");
    await runs.tick();
    minutes(30);
    await runs.tick();
    expect(sessions.stops).toEqual([]);
    turns.waits(session, null);
    await runs.tick();
    minutes(5);
    await runs.tick();
    expect(sessions.stops).toEqual([]);
    minutes(1);
    await runs.tick();
    expect(sessions.stops).toEqual([{ id: session, reason: "time-limit" }]);
  });

  it("keeps a trust prompt that follows a permission prompt as one wait, and a run that ends at a prompt keeps how long it waited", async () => {
    const run = await runNow();
    const session = run.session ?? "";
    turns.waits(session, "trust");
    await runs.tick();
    const since = now.getTime();
    minutes(1);
    turns.waits(session, "permission");
    await runs.tick();
    expect(runs.active()[0]?.agent?.waiting).toEqual({ prompt: "permission", since });
    expect(notices).toHaveLength(1);
    minutes(2);
    sessions.end(session, "stopped-by-you", 130, 180_000, "SIGINT");
    await runs.tick();
    expect(finished[0]).toMatchObject({ state: "stopped-by-you", agent: { waiting: null, waitedMs: 3 * 60_000 } });
    expect(runs.needsYou()).toEqual([]);
  });

  it("frees its low-priority slot while it waits, and goes on past the cap once answered", async () => {
    settings = { ...DEFAULT_SETTINGS, maxLowPriorityRuns: 1 };
    files = { ...files, "other.md": agentFile().replace("name: Morning summary", "name: Other") };
    load();
    const run = await runNow();
    const other = await runs.runNow("other");
    expect(other.ok && "run" in other && other.run.state).toBe("queued");
    turns.waits(run.session ?? "", "permission");
    await runs.tick();
    expect(runs.active().map((candidate) => [candidate.job, candidate.state])).toEqual([
      ["summary", "running"],
      ["other", "running"],
    ]);
    turns.waits(run.session ?? "", null);
    await runs.tick();
    expect(runs.active().filter((candidate) => candidate.state === "running")).toHaveLength(2);
  });

  it("still waits for you after a restart, with no second notice", async () => {
    const run = await runNow();
    turns.waits(run.session ?? "", "permission");
    await runs.tick();
    await runs.close();
    turns = new FakeTurns();
    await open();
    await runs.tick();
    expect(turns.watched()).toEqual([run.session]);
    turns.waits(run.session ?? "", "permission");
    await runs.tick();
    expect(runs.needsYou().map((item) => item.kind)).toEqual(["waiting"]);
    expect(notices).toHaveLength(1);
  });

  it("reads a run going and a record of an older build, with no wait fields, as ones that never waited", async () => {
    const run = await runNow();
    const { waiting: _waiting, waitedMs: _waitedMs, ...older } = run.agent ?? ({} as AgentRun);
    const records = recordsFolderOf(dir);
    await mkdir(dirname(runsRecordPath(records)), { recursive: true });
    await writeFile(runsRecordPath(records), JSON.stringify({ active: [{ ...run, agent: older }], last: {} }));
    const [going] = (await fileRunsStore(records, stateFolderOf(dir), () => undefined).load()).active;
    expect(going?.agent).toEqual({ ...older, waiting: null, waitedMs: 0 });
    const record = parseRunRecord({ ...run, state: "done", action: null, reason: null, endedAt: 1, durationMs: 1, exitCode: 0, signal: null, lastLines: [], git: null, agent: older });
    expect(record?.agent).toEqual({ ...older, waiting: null, waitedMs: 0 });
  });

  it("follows a running agent run's turns again after a restart", async () => {
    const run = await runNow();
    await runs.close();
    turns = new FakeTurns();
    await open();
    expect(runs.active()).toHaveLength(1);
    await runs.tick();
    expect(turns.watched()).toEqual([run.session]);
  });
});

describe("agent run rules", () => {
  const agent: AgentRun = { agent: "claude", name: "Claude", provider: "claude", mode: "normal", modeName: "Normal", sessionId: "s1", cwd: "/ws", startedAt: "2026-11-18T11:00:00.000Z", exit: "/exit", exitSentAt: null, waiting: null, waitedMs: 0 };
  const end = { state: "done" as const, reason: null, exitCode: 0, signal: null, limitHit: null };

  it("runs the line in the shell, interactive and login", () => {
    expect(agentArgv("/bin/zsh", "claude 'hi'")).toEqual(["/bin/zsh", "-l", "-i", "-c", "claude 'hi'"]);
  });

  it("reads an end by whether the exit command was typed", () => {
    expect(agentEnd(end, agent, "exited")).toEqual({ ...end, state: "failed", reason: "the agent exited before its turn was done" });
    expect(agentEnd(end, { ...agent, exitSentAt: 1 }, "exited")).toEqual(end);
    expect(agentEnd({ ...end, state: "failed", reason: "stopped by Runner" }, { ...agent, exitSentAt: 1 }, "stopped")).toEqual(end);
    const crashed = { ...end, state: "failed" as const, exitCode: 2 };
    expect(agentEnd(crashed, { ...agent, exitSentAt: 1 }, "crashed")).toEqual(crashed);
    const byYou = { ...end, state: "stopped-by-you" as const };
    expect(agentEnd(byYou, { ...agent, exitSentAt: 1 }, "stopped-by-you")).toEqual(byYou);
    const limit = { ...end, state: "failed" as const, reason: "stopped: time limit, 45 min", limitHit: 45 };
    expect(agentEnd(limit, agent, "time-limit")).toEqual(limit);
    const gone = { ...end, state: "failed" as const, reason: "its session is gone", exitCode: null };
    expect(agentEnd(gone, { ...agent, exitSentAt: 1 }, null)).toEqual(gone);
  });

  it("fails a done run whose agent never answered; an unknown answer or any other end stays as it was", () => {
    expect(answeredEnd(end, "none")).toEqual({ ...end, state: "failed", reason: "the agent's turn ended without an answer" });
    expect(answeredEnd(end, "answered")).toEqual(end);
    expect(answeredEnd(end, "unknown")).toEqual(end);
    const crashed = { ...end, state: "failed" as const, exitCode: 2 };
    expect(answeredEnd(crashed, "none")).toEqual(crashed);
    const byYou = { ...end, state: "stopped-by-you" as const };
    expect(answeredEnd(byYou, "none")).toEqual(byYou);
  });

  it("looks around the start, and picks the session that started nearest it", () => {
    expect(lookupWindow("2026-11-18T11:00:00.000Z", new Date("2026-11-18T11:00:30.000Z"))).toEqual({ startedFrom: "2026-11-18T10:59:50.000Z", startedTo: "2026-11-18T11:00:40.000Z" });
    const found = (id: string, startedAt: string) => ({ id, provider: "codex", agent: "codex", cwd: "/ws", startedAt, lastActiveAt: startedAt });
    expect(pickSession([found("a", "2026-11-18T10:59:55.000Z"), found("b", "2026-11-18T11:00:01.000Z"), found("c", "garbage")], "2026-11-18T11:00:00.000Z")?.id).toBe("b");
    expect(pickSession([], "2026-11-18T11:00:00.000Z")).toBeNull();
  });
});
