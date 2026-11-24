// Runner against the real Agents app (opt-in: skipped unless `AGENTS_APP_DIST` names a built
// `pomade-agents` `dist/`). The Pomade checkout's built app (`POMADE_REPO`) in test mode on a temp
// workspace, user data and home, with the built `dist/` and the real Agents app dev-linked; Pomade
// runs with the temp home, so the Agents app's backend reads only the temp `~/.claude`, `~/.codex`
// and `~/.zshrc` (it takes its home from `HOME`, which Pomade passes on). Its Claude profile's
// command is the scripted fake agent CLI (`fixtures/fake-agent.mjs`): no real agent CLI ever runs.
// Through the real broker: `roster.list` and `roster.launchSpec` pass Runner's checks and an agent
// run launches from the real launch spec; `sessions.liveIn` lists the run while it goes (Runner's
// `run.started` accepted); `sessions.find` and `sessions.lastMessage` answer in the shapes Runner
// reads; the app's B for the run (`run.finished` accepted) passes Runner's check and fires nothing;
// `sessions.setStatus` to Done makes the app's C fire a Runner hook job on the session's transcript;
// a click on a run's row in the Agents panel's Live now opens the run's terminal tab (Runner's
// `run.started` names the run's keeper session as its `terminal`).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { connectSocket } from "pomade-kit/node";
import { checkLiveIn, checkRosterList, type JsonValue } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import manifest from "../app/manifest.json" with { type: "json" };
import { AgentsError, agentsOf, checkFoundSessions, checkLastMessage, isLaunchSpec } from "../src/integrations/agents";
import { callScheduler } from "../src/scheduler/control/client";
import { runTriggerWords, type RunRecord } from "../src/scheduler/model";
import { fakeAgents } from "./support/agents";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const REAL = process.env.AGENTS_APP_DIST;
const NOTES = "proj-notes";
const STRIP_KEY = "app-pomade-agents-agents";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.describe("Runner with the real Agents app", () => {
  // eslint-disable-next-line playwright/no-skipped-test -- opt-in: the normal gate has no real Agents app build to run against
  test.skip(REAL === undefined, "AGENTS_APP_DIST names no built Agents app");
  test.describe.configure({ mode: "serial" });

  let tmp: string;
  let user: string;
  let folders: PomadeFolders;
  let jobs: string;
  let notes: string;
  let fakeClaude: string;
  let app: ElectronApplication | null = null;
  let scheduler: SchedulerProcess | null = null;
  let keeperSocket: string;
  let runner: HostClient | null = null;
  let sessionId = "";
  const socket = (): string => join(folders.userData, "app-state", manifest.id, "scheduler.sock");

  test.beforeAll(async () => {
    const pomade = pomadeCheckout();
    tmp = await tempDir();
    user = join(tmp, "user");
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await mkdir(join(folders.workspace, "Projects/notes"), { recursive: true });
    notes = await realpath(join(folders.workspace, "Projects/notes"));
    const fake = await fakeAgents(user, join(tmp, "bin"));
    fakeClaude = fake.roster[0]?.command ?? "";
    // The real app's Claude profile, written before its first sight: its command is the fake CLI.
    await mkdir(join(folders.workspace, "Apps/pomade-agents/agents/claude"), { recursive: true });
    await writeFile(
      join(folders.workspace, "Apps/pomade-agents/agents/claude/agent.yaml"),
      `id: claude\nprovider: claude\nkind: builtin\nconfigDir: ~/.claude\ncommand: ${fakeClaude}\ntags: []\nhidden: false\nmodes:\n  normal:\n    enabled: true\n  full-autonomy:\n    enabled: true\n`,
    );
    await mkdir(join(user, ".claude/projects"), { recursive: true });
    await writeFile(join(folders.workspace, "Apps/pomade-runner/settings.yaml"), "warm-up: 0m\n");
    await writeFile(join(jobs, "nightly.md"), `---\nkind: agent\nname: Nightly\nfolder: Projects/notes\nagent: claude\nschedule:\n  once: 2099-01-01 7:00\n---\nTidy the notes. [slow]\n`);
    await writeFile(join(jobs, "watched.md"), `---\nkind: agent\nname: Watched\nfolder: Projects/notes\nagent: claude\nschedule:\n  once: 2099-01-01 7:00\n---\nTidy the notes. [long]\n`);
    await writeFile(join(jobs, "analyzer.md"), `---\nkind: script\nname: Session Analyzer\nfolder: .\ncommand: 'echo "analyzing $POMADE_SESSION_ID in $POMADE_PROJECT"; cat "$POMADE_SESSION_TRANSCRIPT"'\nhook: { event: session-status, status: done }\nlow-priority: false\n---\n`);
    await writeFile(join(jobs, "lint.md"), `---\nkind: script\nname: Lint after session\nfolder: .\ncommand: echo lint\nhook: { event: session-finished }\nlow-priority: false\n---\n`);
    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: `${DIST};${resolve(REAL ?? "")}`, HOME: user }) });
    const page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.evaluate(
      ([id, path]) => {
        const state = (window as unknown as { __pomadeStores: { useWorkspaceStore: { getState(): Record<string, (...args: unknown[]) => void> } } }).__pomadeStores.useWorkspaceStore.getState();
        state.addProject?.({ id, name: "Notes", rootPath: path, visibleAgents: ["*"], order: 0 });
      },
      [NOTES, "Projects/notes"] as const,
    );
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    scheduler = startSchedulerProcess(
      pomade.runtime,
      join(DIST, manifest.backend.entry),
      cleanEnv({
        ELECTRON_RUN_AS_NODE: "1",
        POMADE_APP_ID: manifest.id,
        POMADE_APP_KEY_FILE: join(folders.userData, "app-keys", manifest.id),
        POMADE_CLIENT: "backend",
        POMADE_SOCKET: host.socket,
        POMADE_KEEPER_SOCKET: keeperSocket,
        POMADE_HOME: folders.home,
        POMADE_RUNNER_TICK_MS: "50",
        HOME: user,
        SHELL: "/bin/sh",
      }),
    );
    const started = scheduler;
    await expect.poll(() => started.output()).toContain("connected to Pomade");
    const connected = await connectSocket({ socketPath: host.socket, appId: manifest.id, keyFile: join(folders.userData, "app-keys", manifest.id), role: "backend" });
    if (connected.status !== "connected") throw new Error(`Runner's connection to Pomade: ${connected.status}`);
    runner = connected.host;
  });

  test.afterAll(async () => {
    runner?.close();
    await scheduler?.kill();
    await app?.close();
    await stopKeeper(keeperSocket);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  });

  /** A raw call to the real app, as Runner's broker client makes it. */
  const call = (method: string, params: JsonValue): Promise<unknown> => {
    if (runner === null) throw new Error("not connected");
    return runner.apps.call("pomade-agents", method, params, { timeoutMs: 5_000 });
  };

  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(socket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  test("roster.list and roster.launchSpec pass Runner's checks; the backend reads only the temp home", async () => {
    // The backend is up once it answers.
    await expect.poll(() => call("roster.list", {}).then(() => "answers", (err: unknown) => String(err)), { timeout: 30_000 }).toBe("answers");
    const roster = checkRosterList(await call("roster.list", {}));
    expect(roster).toMatchObject({ ok: true, agents: expect.arrayContaining([expect.objectContaining({ id: "claude", command: fakeClaude, provider: "claude", configDir: join(user, ".claude") })]) });
    expect(await agentsOf(runner as HostClient).roster()).toEqual((roster as { agents: unknown[] }).agents);
    const id = randomUUID();
    const spec = await call("roster.launchSpec", { agent: "claude", mode: "normal", sessionId: id, prompt: "Say hi" });
    expect(isLaunchSpec(spec)).toBe(true);
    expect(spec).toMatchObject({ command: fakeClaude, args: ["--session-id", id, "Say hi"], sessionId: id, exit: "/exit" });
    const info = (await call("app.info", null)) as { workspace: string | null };
    expect(info.workspace).toBe(folders.workspace);
  });

  test("an agent run launches from the real launch spec; sessions.liveIn lists it while it goes; find and lastMessage answer in Runner's shapes; the app's B passes Runner's check and fires nothing", async () => {
    const ran = await run(join(folders.home, "bin", "pomade-runner"), ["run", "nightly"], { env: cleanEnv({ HOME: user }), cwd: tmp });
    expect(ran.stderr).toBe("");
    // While it goes: the real app heard Runner's run.started.
    await expect
      .poll(async () => {
        const live = checkLiveIn(await call("sessions.liveIn", { folder: notes }));
        return live.ok ? live.result.sessions.filter((session) => session.source === "run").map((session) => ({ agent: session.agent, job: session.job })) : "malformed";
      }, { timeout: 20_000 })
      .toEqual([{ agent: "claude", job: "Nightly" }]);
    await expect.poll(async () => (await history("nightly")).length, { timeout: 30_000 }).toBe(1);
    const [record] = await history("nightly");
    expect(record).toMatchObject({ state: "done", agent: { agent: "claude", mode: "normal", cwd: notes } });
    sessionId = record?.agent?.sessionId ?? "";
    expect(sessionId).toMatch(UUID);
    // Its end: no run live any more.
    await expect.poll(async () => checkLiveIn(await call("sessions.liveIn", { folder: notes }))).toMatchObject({ ok: true, result: { live: false, sessions: [] } });

    // The session, found by folder and start time, and its last answer.
    const startedAt = record?.agent?.startedAt ?? new Date().toISOString();
    const window = { cwd: notes, startedFrom: new Date(Date.parse(startedAt) - 60_000).toISOString(), startedTo: new Date(Date.parse(startedAt) + 60_000).toISOString() };
    await expect.poll(async () => checkFoundSessions(await call("sessions.find", window))?.map((found) => found.id), { timeout: 15_000 }).toEqual([sessionId]);
    expect(await agentsOf(runner as HostClient).findSessions({ ...window, agent: "claude" })).toMatchObject([{ id: sessionId, provider: "claude-code", agent: "claude", cwd: notes }]);
    const last = await call("sessions.lastMessage", { id: sessionId });
    expect(checkLastMessage(last)).toMatchObject({ text: "**Done.** Tidy the notes. [slow]" });
    // An id it does not know is `not-found`.
    await expect(agentsOf(runner as HostClient).lastMessage("no-such-session")).rejects.toMatchObject({ code: "not-found" } satisfies Partial<AgentsError>);

    // B for the run: Runner's check takes it, the loop guard drops it.
    await expect.poll(() => scheduler?.output() ?? "", { timeout: 15_000 }).toContain(`agent session ${sessionId} (claude) finished: run-finished, started by Runner (Nightly)`);
    expect(scheduler?.output()).not.toContain("ignored a pomade-agents:session.closed");
    expect(await history("lint")).toEqual([]);
  });

  test("sessions.setStatus to Done: the app's C runs the Session Analyzer on the session's transcript", async () => {
    expect(sessionId).not.toBe("");
    await expect
      .poll(
        async () => {
          try {
            await call("sessions.setStatus", { ids: [sessionId], status: "done" });
            return "set";
          } catch (err) {
            return String(err);
          }
        },
        { timeout: 20_000 },
      )
      .toBe("set");
    await expect.poll(async () => (await history("analyzer")).length, { timeout: 30_000 }).toBe(1);
    const [record] = await history("analyzer");
    expect(record && runTriggerWords(record)).toBe("hook: session marked Done");
    expect(record?.lastLines.join("\n")).toContain(`analyzing ${sessionId} in ${NOTES}`);
    expect(record?.lastLines.join("\n")).toContain('"text":"**Done.** Tidy the notes. [slow]"');
    expect(scheduler?.output()).not.toContain("ignored a pomade-agents:session.statusChanged");
  });

  test("a click on the run's row in Live now opens the run's terminal tab, attached to its keeper session", async () => {
    const page = await (app as ElectronApplication).firstWindow();
    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    const panel = page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);
    const ran = await run(join(folders.home, "bin", "pomade-runner"), ["run", "watched"], { env: cleanEnv({ HOME: user }), cwd: tmp });
    expect(ran.stderr).toBe("");
    const row = panel.getByTestId("live-row").filter({ hasText: "Watched" });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await row.click();
    const title = page.locator('[data-testid^="attached-title-"]').filter({ hasText: "Watched" });
    await expect(title).toHaveCount(1);
    const id = ((await title.getAttribute("data-testid")) ?? "").slice("attached-title-".length);
    await expect(page.getByTestId(`attached-${id}`)).toHaveAttribute("data-state", "attached");
    await expect(page.getByTestId(`attached-${id}`)).toHaveAttribute("data-session-state", "running");
    await expect.poll(async () => (await history("watched")).length, { timeout: 40_000 }).toBe(1);
    await expect(page.getByTestId(`attached-${id}`)).toHaveAttribute("data-session-state", "exited", { timeout: 15_000 });
  });
});
