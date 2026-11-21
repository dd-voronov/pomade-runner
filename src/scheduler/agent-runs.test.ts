// Agent runs on the run lifecycle's stand-ins (`runs-fixture.ts`): the launch — the roster, the mode,
// the launch spec's line in the user's interactive login shell in the job's folder — the turn
// followed and the exit typed, every way such a run ends, the session looked up when the provider
// cannot pre-assign it, why one cannot start, and the run events as `pomade-agents` reads them
// (`../pomade-agents/docs/CONTRACTS.md` "Subscribed events").

process.env.TZ = "Europe/Madrid";

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsError } from "../integrations/agents";
import type { RunFinishedPayload, RunStartedPayload } from "../integrations/runner-api";
import { checkJobs } from "../jobs/check";
import type { JobsSnapshot } from "../jobs/model";
import { recordsFolderOf, stateFolderOf } from "../locations";
import { AGENT_EXIT_WAIT_MS, agentArgv, agentEnd, lookupWindow, pickSession } from "./agent-runs";
import { createHistory, keepOutputLog } from "./history";
import type { ActiveRun, AgentRun, RunRecord } from "./model";
import { runFinishedPayload, runStartedPayload } from "./run-events";
import { createRuns, type Runs } from "./runs";
import { FakeAgents, FakeSessions, FakeTurns, memoryStore, memorySwitch } from "./runs-fixture";
import { DEFAULT_SETTINGS } from "./settings";

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
  let started: ActiveRun[];
  let finished: RunRecord[];
  let lines: string[];
  let runs: Runs;
  let store: ReturnType<typeof memoryStore>;

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
      settings: () => DEFAULT_SETTINGS,
      servicesSettled: () => true,
      clock: { now: () => now },
      log: (line) => lines.push(line),
      history: createHistory(recordsFolderOf(dir), stateFolderOf(dir), () => undefined),
      store,
      switchStore: memorySwitch(),
      post: () => undefined,
      projectPath: () => null,
      agents: () => (connected ? agents : null),
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
    started = [];
    finished = [];
    lines = [];
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
    expect(run.agent).toEqual({ agent: "claude", name: "Claude", provider: "claude", mode: "normal", modeName: "Normal", sessionId, cwd, startedAt: new Date(now).toISOString(), exit: "/exit", exitSentAt: null });
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
    expect(await reason()).toBe("cannot start — Pomade is not running, and an agent run needs it");
    connected = true;
    agents.fail = new AgentsError("absent", "the Agents app (pomade-agents) is not running");
    expect(await reason()).toBe("cannot start — the Agents app (pomade-agents) is not running");
    agents.fail = null;
    files = { "summary.md": agentFile().replace("agent: claude", "agent: claude-libra") };
    load();
    expect(await reason()).toBe('cannot start — the Agents app has no agent "claude-libra"');
    files = { "summary.md": agentFile("mode: full-autonomy\n").replace("agent: claude", "agent: claude-pm") };
    load();
    expect(await reason()).toBe("cannot start — claude-pm has no Full autonomy mode");
    files = { "summary.md": agentFile().replace("folder: Projects/x", "folder: Projects/gone") };
    load();
    expect(await reason()).toBe("cannot start — its folder Projects/gone does not exist");
    expect(finished.map((record) => [record.state, record.startedAt])).toEqual(Array.from({ length: 5 }, () => ["failed", null]));
    expect(sessions.spawned).toEqual([]);
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
  const agent: AgentRun = { agent: "claude", name: "Claude", provider: "claude", mode: "normal", modeName: "Normal", sessionId: "s1", cwd: "/ws", startedAt: "2026-11-18T11:00:00.000Z", exit: "/exit", exitSentAt: null };
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

  it("looks around the start, and picks the session that started nearest it", () => {
    expect(lookupWindow("2026-11-18T11:00:00.000Z", new Date("2026-11-18T11:00:30.000Z"))).toEqual({ startedFrom: "2026-11-18T10:59:50.000Z", startedTo: "2026-11-18T11:00:40.000Z" });
    const found = (id: string, startedAt: string) => ({ id, provider: "codex", agent: "codex", cwd: "/ws", startedAt, lastActiveAt: startedAt });
    expect(pickSession([found("a", "2026-11-18T10:59:55.000Z"), found("b", "2026-11-18T11:00:01.000Z"), found("c", "garbage")], "2026-11-18T11:00:00.000Z")?.id).toBe("b");
    expect(pickSession([], "2026-11-18T11:00:00.000Z")).toBeNull();
  });
});
