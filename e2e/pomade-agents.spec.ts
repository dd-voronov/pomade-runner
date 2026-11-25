// Agent runs with a real Pomade: the Pomade checkout's built app (`POMADE_REPO`) in test mode on a
// temp workspace, user data and home, with the built `dist/` and the fixture Agents app
// (`fixtures/agents-app/`) dev-linked, and the scripted fake agent CLI (`fixtures/fake-agent.mjs`)
// as the roster's Claude and Codex. The scheduler is started the way the login item starts it
// (`pomade.spec.ts`). A run starts the agent in the job's folder through the launch spec, its turn
// completes, Runner types `/exit`, and the run is done with its session; Full autonomy passes the
// agent's autonomy argument; an agent that ends before its turn is done fails, and so does one
// whose turn ends without an answer (an API error) — noticed, a Needs-you item, its screen on the
// card; a Codex run's session
// is found by folder and start time; the fixture app hears `run.started` and `run.finished` with the
// session and the started-by-Runner flag; the done card shows the last message, and Open session
// resumes it in a Pomade agent tab. An agent that asks for permission waits for you — a notice, a
// Needs-you card, the badge — and its notice, card and Running now row open its terminal tab at the
// prompt; answered there, the run is done; a prompt that comes while the scheduler is down is read
// from the session's screen when it is back. An agent stopped at a screen before it starts working
// (the fake's login screen) waits for you once its time to start is up — its time limit paused —
// and goes on once a choice is made there; one stopped at it never started a session, as its card
// says. Claude's Bypass Permissions consent (the real screen) waits for you at once, in its own
// words, in Full autonomy too; accepted there the run goes on, "No, exit" ends the run and the wait. A keeper that cannot reach the macOS keychain — the
// check's command a script that fails as many times as the test says — is replaced before an agent
// run, after the runs going, its services started again with no crash counted; a fresh keeper that
// fails it too fails the run. An agent whose turn ends with background work going keeps its run
// running — History, Running now and its card say it waits for that work — until its further turn
// ends without it, or its time limit; its exit command answered by the background-work question is
// declined with Escape, and an agent stopped at that question fails. Runner types the exit command
// only at the agent's empty prompt: a question form or a dialog no rule names after the agent
// worked waits for you, each in its own words; in Full autonomy Runner answers the question form
// with the highlighted option and the card says so; an agent that works again after the exit
// command is followed to its real last turn. `RUNNER_SHOTS=<dir>` saves
// screenshots of the form, the rows and the cards.

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { connectSocket } from "pomade-kit/node";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import manifest from "../app/manifest.json" with { type: "json" };
import { STRIP_ICON } from "../src/app";
import { DISMISS_METHOD, RUN_STOP_METHOD, runRoute } from "../src/integrations/runner-api";
import { callScheduler } from "../src/scheduler/control/client";
import type { ActiveRun, RunRecord } from "../src/scheduler/model";
import { AGENTS_APP, fakeAgents, type FakeAgents } from "./support/agents";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { drawn } from "./support/frames";
import { alive, expectNothingLeft, keeperAt, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { serviceFile } from "./support/runner";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const SHOTS = process.env.RUNNER_SHOTS;
/** How long an agent has to start working in the T-040 and T-052 tests: the scheduler's 20 s, shortened. */
const NOT_STARTED_MS = 3000;
const STRIP_KEY = `app-${manifest.id}-${STRIP_ICON}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An agent job file, run with Run now; its schedule keeps it from running on its own. */
const agentJob = (name: string, agent: string, prompt: string, extra = ""): string =>
  `---\nkind: agent\nname: ${name}\nfolder: Projects/notes\nagent: ${agent}\n${extra}schedule:\n  once: 2099-01-01 7:00\n---\n${prompt}\n`;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe("agent runs in Pomade", () => {
  test.describe.configure({ mode: "serial" });

  const pomade = pomadeCheckout();
  let tmp: string;
  let user: string;
  let folders: PomadeFolders;
  let agents: FakeAgents;
  let app: ElectronApplication | null = null;
  let page: Page;
  let scheduler: SchedulerProcess | null = null;
  let keeperSocket: string;
  let notes: string;
  const socket = (): string => join(folders.userData, "app-state", manifest.id, "scheduler.sock");

  test.beforeAll(async () => {
    tmp = await tempDir();
    user = join(tmp, "user");
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    await mkdir(join(folders.workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await mkdir(join(folders.workspace, "Projects/notes"), { recursive: true });
    notes = await realpath(join(folders.workspace, "Projects/notes"));
    agents = await fakeAgents(user, join(tmp, "bin"));
    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: `${DIST};${AGENTS_APP}`, HOME: user }) });
    page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await startScheduler();
  });

  /** The scheduler, started the way the login item starts it, connected to Pomade. */
  async function startScheduler(extra: Record<string, string> = {}): Promise<SchedulerProcess> {
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    const started = startSchedulerProcess(
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
        ...extra,
      }),
    );
    scheduler = started;
    await expect.poll(() => started.output()).toContain("connected to Pomade");
    return started;
  }

  test.afterAll(async () => {
    await scheduler?.kill();
    await app?.close();
    await stopKeeper(keeperSocket);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  });

  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(socket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  /** Run a job now with `pomade-runner run`, and wait for its record. */
  async function runToEnd(job: string, count = 1): Promise<RunRecord> {
    const ran = await run(join(folders.home, "bin", "pomade-runner"), ["run", job], { env: cleanEnv({ HOME: user }), cwd: tmp });
    expect(ran.stderr).toBe("");
    await expect.poll(async () => (await history(job)).length, { timeout: 30_000 }).toBe(count);
    const [record] = await history(job);
    if (record === undefined) throw new Error("no record");
    return record;
  }

  /** A connection to Pomade as `app`. */
  async function connectAs(app: string): Promise<HostClient> {
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    const result = await connectSocket({ socketPath: host.socket, appId: app, keyFile: join(folders.userData, "app-keys", app), role: "backend" });
    if (result.status !== "connected") throw new Error(`${app}'s connection to Pomade: ${result.status}`);
    return result.host;
  }

  /** Runner's tab at `route`, in the Workspace. */
  async function openRunnerTab(route: string): Promise<void> {
    const runner = await connectAs(manifest.id);
    try {
      await runner.tabs.openApp({ route, projectId: WORKSPACE_PROJECT_ID });
    } finally {
      runner.close();
    }
    await drawn(page);
  }

  const tab = (): ReturnType<Page["frameLocator"]> => page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
  const panel = (): ReturnType<Page["frameLocator"]> => page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);

  /** The run going of `job`, as `runs` reports it. */
  async function going(job: string): Promise<ActiveRun | undefined> {
    const result = await callScheduler(socket(), "runs", null);
    return result.status === "ok" ? result.value.active.find((candidate) => candidate.job === job) : undefined;
  }

  /** The Needs-you items, by kind. */
  async function needsYou(): Promise<string[]> {
    const result = await callScheduler(socket(), "runs", null);
    return result.status === "ok" ? result.value.needsYou.map((item) => item.id) : [];
  }

  /** Runner's notices in Pomade's Notices panel, newest first. */
  async function runnerNotices(): Promise<string[]> {
    if (!(await page.getByTestId("notices-panel").isVisible())) await page.getByTestId("strip-notices").click();
    return page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"] [data-testid="notice-row-title"]').allTextContents();
  }

  function attachedTabIds(): Promise<string[]> {
    return page.evaluate((project) => {
      const stores = (window as unknown as { __pomadeStores: { useTabsStore: { getState(): { tabsByProject: Record<string, { id: string; kind: string }[] | undefined> } } } }).__pomadeStores;
      return (stores.useTabsStore.getState().tabsByProject[project] ?? []).filter((tab) => tab.kind === "attached").map((tab) => tab.id);
    }, WORKSPACE_PROJECT_ID);
  }

  /** An attached tab's whole terminal buffer as text. */
  function buffer(id: string): Promise<string> {
    return page.evaluate((tab) => (window as unknown as { __pomadeAttachedBuffer?: Record<string, () => string> }).__pomadeAttachedBuffer?.[tab]?.() ?? "", id);
  }

  /** The one attached tab open, at the prompt and in front; its id. */
  async function atThePrompt(): Promise<string> {
    await expect.poll(() => attachedTabIds()).toHaveLength(1);
    const [id = ""] = await attachedTabIds();
    await expect.poll(() => buffer(id)).toContain("Do you want to proceed?");
    await expect(page.getByTestId(`attached-xterm-${id}`)).toBeVisible();
    return id;
  }

  async function closeTab(id: string): Promise<void> {
    await page.getByTestId(`close-${id}`).click();
    await expect.poll(() => attachedTabIds()).toHaveLength(0);
  }

  test("3 · a run starts the agent in its folder, its turn completes, Runner types /exit, and the run is done with its session", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/summary.md"), agentJob("Morning summary", "claude", "Write my morning summary."));
    const record = await runToEnd("summary");
    expect(record).toMatchObject({ kind: "agent", state: "done", exitCode: 0, reason: null, agent: { agent: "claude", name: "Claude", mode: "normal", modeName: "Normal", cwd: notes } });
    const sessionId = record.agent?.sessionId ?? "";
    expect(sessionId).toMatch(UUID);
    expect(record.lastLines.join("\n")).toContain("Bye.");
    const session = await agents.session(sessionId);
    expect(session).toMatchObject({ cwd: notes, prompt: "Write my morning summary.", lastMessage: "**Done.** Write my morning summary." });
    expect(session.args).toEqual(["--session-id", sessionId, "Write my morning summary."]);
    // It worked at once: it never waited for you.
    expect(record.agent).toMatchObject({ worked: true, waitedMs: 0 });
  });

  test("5 · run.started and run.finished reach a subscriber with the session, the agent, the started-by-Runner flag and the run's terminal", async () => {
    const [record] = await history("summary");
    await expect.poll(async () => (await agents.events()).filter((e) => e.payload.run === record?.run).map((e) => e.event)).toEqual(["run.started", "run.finished"]);
    const [started, finished] = (await agents.events()).filter((e) => e.payload.run === record?.run);
    const fields = { job: "summary", name: "Morning summary", kind: "agent", folder: "Projects/notes", project: null, sessionId: record?.agent?.sessionId, agent: "claude", mode: "normal", cwd: notes, startedByRunner: true, startedAt: record?.agent?.startedAt, terminal: `run:summary:${record?.run ?? ""}` };
    expect(started?.payload).toMatchObject({ ...fields, trigger: "manual" });
    expect(finished?.payload).toMatchObject({ ...fields, trigger: "manual", result: "done", exitCode: 0 });
    expect(Date.parse(started?.payload.startedAt ?? "")).toBeLessThanOrEqual(Date.parse((await agents.session(record?.agent?.sessionId ?? "")).startedAt));
  });

  test("4 · Full autonomy passes the agent's autonomy argument", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/weekly.md"), agentJob("Weekly review", "claude", "Weekly maintenance.", "mode: full-autonomy\n"));
    const record = await runToEnd("weekly");
    expect(record).toMatchObject({ state: "done", agent: { mode: "full-autonomy", modeName: "Full autonomy" } });
    expect((await agents.session(record.agent?.sessionId ?? "")).args[0]).toBe("--dangerously-skip-permissions");
  });

  test("an agent that ends before its turn is done fails, and says so", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/early.md"), agentJob("Early", "claude", "Leave at once [exit-early]"));
    const record = await runToEnd("early");
    expect(record).toMatchObject({ state: "failed", reason: "the agent exited before its turn was done", exitCode: 0 });
  });

  test("a Codex run's session, which it cannot pre-assign, is found by folder and start time and is on run.finished", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/codex.md"), agentJob("Codex check", "codex", "Check the notes."));
    const record = await runToEnd("codex");
    expect(record).toMatchObject({ state: "done", agent: { provider: "codex" } });
    const sessionId = record.agent?.sessionId ?? "";
    expect(sessionId).toMatch(/^019a/);
    expect(await agents.session(sessionId)).toMatchObject({ args: ["Check the notes."], cwd: notes });
    const events = (await agents.events()).filter((e) => e.payload.run === record.run);
    expect(events.map((e) => [e.event, e.payload.sessionId])).toEqual([
      ["run.started", null],
      ["run.finished", sessionId],
    ]);
  });

  test("2 · the agent asks for permission: the run waits for you with a notice, a Needs-you card and the badge; the notice, the card and the row open its tab at the prompt; answering it continues the run to done", async () => {
    // The early agent's failure is a Needs-you item of its own: dismissed, so the badge counts this run alone.
    const runner = await connectAs(manifest.id);
    try {
      await runner.apps.call(manifest.id, DISMISS_METHOD, { id: "run-failed:early" });
    } finally {
      runner.close();
    }
    expect(await needsYou()).toEqual([]);
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/tidy-drafts.md"), agentJob("Tidy drafts", "claude", "Tidy the drafts. [ask]", "time-limit: 30m\n"));
    expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "tidy-drafts"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
    await expect.poll(async () => (await going("tidy-drafts"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("permission");
    const waiting = await going("tidy-drafts");
    const id = `waiting:tidy-drafts:${waiting?.run ?? ""}`;
    expect(await needsYou()).toEqual([id]);
    await expect.poll(() => runnerNotices()).toContain("Tidy drafts needs your approval");
    await expect(page.getByTestId(`strip-badge-${STRIP_KEY}`)).toHaveText("1");
    await shoot(page, "pomade-waiting-notice");

    // The notice opens the run's terminal tab at the prompt.
    await page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"]').filter({ hasText: "Tidy drafts needs your approval" }).click();
    await closeTab(await atThePrompt());

    // Needs you's card: amber, "Open at the prompt".
    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
    await drawn(page);
    const card = panel().locator('[data-testid="needs-you-item"][data-kind="waiting"]');
    await expect(card).toContainText("Tidy drafts");
    await expect(card.getByTestId("needs-you-words")).toHaveText("Waiting for approval at a permission prompt.");
    const row = panel().getByTestId("active-run").filter({ hasText: "Tidy drafts" });
    await expect(row).toContainText("waiting for you");
    await shoot(page, "pomade-waiting-panel");
    await card.getByRole("button", { name: "Open at the prompt" }).click();
    await closeTab(await atThePrompt());

    // Running now's row opens it too; answering there goes on.
    await row.click();
    const tabId = await atThePrompt();
    await shoot(page, "pomade-waiting-tab");
    await page.getByTestId(`attached-xterm-${tabId}`).click();
    await page.keyboard.press("1");
    await expect.poll(() => needsYou()).toEqual([]);
    await expect(page.getByTestId(`strip-badge-${STRIP_KEY}`)).toHaveCount(0);
    await expect.poll(async () => (await history("tidy-drafts")).length, { timeout: 30_000 }).toBe(1);
    const [record] = await history("tidy-drafts");
    expect(record).toMatchObject({ state: "done", agent: { waiting: null } });
    expect(record?.agent?.waitedMs).toBeGreaterThan(0);
    await expect.poll(() => buffer(tabId)).toContain("Moved 14 notes.");
    await closeTab(tabId);
  });

  test("a prompt that comes while the scheduler is down is read from the session's screen once it is back — it waits for you — and answered, the run is done", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/late.md"), agentJob("Late ask", "codex", "Tidy later. [ask-late]"));
    expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "late"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
    await expect.poll(async () => (await going("late"))?.state, { timeout: 15_000 }).toBe("running");
    await scheduler?.kill();
    // The prompt comes 5 s into the turn, with no scheduler to see it.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const back = await startScheduler();
    await expect.poll(async () => (await going("late"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("permission");
    expect(back.output()).toContain("the agent waits at a permission prompt");
    await expect.poll(() => runnerNotices()).toContain("Late ask needs your approval");
    const runner = await connectAs(manifest.id);
    try {
      await runner.tabs.openAttached({ session: { app: manifest.id, session: (await going("late"))?.session ?? "" } });
    } finally {
      runner.close();
    }
    await expect.poll(() => attachedTabIds()).toHaveLength(1);
    const [tabId = ""] = await attachedTabIds();
    await expect.poll(() => buffer(tabId)).toContain("Press enter to confirm or esc to cancel");
    await page.getByTestId(`attached-xterm-${tabId}`).click();
    await page.keyboard.press("1");
    await expect.poll(async () => (await history("late")).length, { timeout: 30_000 }).toBe(1);
    expect((await history("late"))[0]).toMatchObject({ state: "done", agent: { provider: "codex", waiting: null } });
    await closeTab(tabId);
  });

  // The scheduler of the other tests gives an agent the production time to start working: under
  // load the fake agent's login shell and Node can take seconds to start, and a shortened grace would
  // make a run that started late wait for you. These tests — an agent that never starts working, and
  // a consent that outlasts that time — start it again with the grace shortened.
  test.describe("T-040 · T-052 · an agent's time to start working, shortened", () => {
    test.beforeAll(async () => {
      await scheduler?.kill();
      await startScheduler({ POMADE_RUNNER_NOT_STARTED_MS: String(NOT_STARTED_MS) });
    });

    test.afterAll(async () => {
      await scheduler?.kill();
      await startScheduler();
    });

    test("T-040 · an agent stopped at a screen before it starts working waits for you: a notice, a Needs-you card, the badge, its time limit paused; accepted in its terminal, the run goes on to done", async () => {
      expect(await needsYou()).toEqual([]);
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/consent.md"), agentJob("Weekly digest", "claude", "Sum up the week. [stuck]", "time-limit: 1m\n"));
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "consent"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("consent"))?.state, { timeout: 15_000 }).toBe("running");
      expect((await going("consent"))?.agent?.waiting).toBeNull();
      await expect.poll(async () => (await going("consent"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("not-started");
      const waiting = await going("consent");
      expect(await needsYou()).toEqual([`waiting:consent:${waiting?.run ?? ""}`]);
      await expect.poll(() => runnerNotices()).toContain("Weekly digest has not started");
      await expect(page.getByTestId(`strip-badge-${STRIP_KEY}`)).toHaveText("1");

      // Its card while it waits.
      await openRunnerTab(runRoute("consent", waiting?.run ?? ""));
      await expect(tab().getByTestId("run-result")).toHaveText("Waiting for you");
      await expect(tab().getByTestId("run-waits")).toContainText("The agent has not started working");
      await expect(tab().getByTestId("run-prompt")).toContainText("Select login method");
      await shoot(page, "pomade-not-started-card");

      // Needs you's card: amber, "Open at the prompt", which opens its terminal at the screen.
      await page.getByTestId(`strip-${STRIP_KEY}`).click();
      await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
      await drawn(page);
      const card = panel().locator('[data-testid="needs-you-item"][data-kind="waiting"]');
      await expect(card).toContainText("Weekly digest");
      await expect(card.getByTestId("needs-you-words")).toHaveText("Has not started — look at its terminal.");
      // Away from the strip, whose tooltip — it follows the focus — would cover the card.
      await page.mouse.move(1000, 600);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await shoot(page, "pomade-not-started-panel");
      await card.getByRole("button", { name: "Open at the prompt" }).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
      const [tabId = ""] = await attachedTabIds();
      await expect.poll(() => buffer(tabId)).toContain("Select login method");
      await shoot(page, "pomade-not-started-tab");

      // A login method picked, the agent starts working: the wait ends and the run is done.
      await page.getByTestId(`attached-xterm-${tabId}`).click();
      await page.keyboard.press("2");
      await expect.poll(() => needsYou()).toEqual([]);
      await expect.poll(async () => (await history("consent")).length, { timeout: 30_000 }).toBe(1);
      const [record] = await history("consent");
      expect(record).toMatchObject({ state: "done", agent: { worked: true, waiting: null } });
      expect(record?.agent?.waitedMs).toBeGreaterThan(0);
      await expect.poll(() => buffer(tabId)).toContain("Done.");
      await closeTab(tabId);
    });

    test("T-040 · a run stopped at that screen never started a session: its card says so, with no Open session — and its time limit did not stop it while it waited", async () => {
      test.setTimeout(120_000);
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "consent"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("consent"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("not-started");
      const waiting = await going("consent");
      // Past its time limit of 1 minute, it still waits.
      await new Promise((resolve) => setTimeout(resolve, 62_000));
      expect(await going("consent")).toMatchObject({ state: "running", limitHit: null, agent: { waiting: { prompt: "not-started" } } });
      const runner = await connectAs(manifest.id);
      try {
        await runner.apps.call(manifest.id, RUN_STOP_METHOD, { job: "consent", run: waiting?.run ?? "" });
      } finally {
        runner.close();
      }
      await expect.poll(async () => (await history("consent")).length, { timeout: 30_000 }).toBe(2);
      const [record] = await history("consent");
      expect(record).toMatchObject({ run: waiting?.run, state: "stopped-by-you", limitHit: null, agent: { worked: false, waiting: null } });
      expect(await needsYou()).toEqual([]);
      await openRunnerTab(runRoute("consent", record?.run ?? ""));
      const dialog = tab().getByTestId("run-dialog");
      await expect(dialog.getByTestId("run-agent-note")).toHaveText("The agent never started a session.");
      await expect(dialog.getByRole("button", { name: "Open session" })).toHaveCount(0);
      await expect(dialog).not.toContainText("cannot be read");
      await expect(dialog.getByRole("button", { name: "Run again" })).toBeVisible();
      await shoot(page, "pomade-never-started-card");
    });

    test("T-052 · an agent at Claude's Bypass Permissions consent waits for you at once in Full autonomy, in its own words — notice, Needs you, card — Runner never answers it; accepted in its terminal, the run goes on to done", async () => {
      expect(await needsYou()).toEqual([]);
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/bypass.md"), agentJob("Nightly cleanup", "claude", "Clean up the notes. [consent]", "mode: full-autonomy\n"));
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "bypass"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("bypass"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("consent");
      const waiting = await going("bypass");
      // At once: well inside the agent's time to start.
      expect((waiting?.agent?.waiting?.since ?? Infinity) - (waiting?.startedAt ?? 0)).toBeLessThan(NOT_STARTED_MS);
      expect(await needsYou()).toEqual([`waiting:bypass:${waiting?.run ?? ""}`]);
      await expect.poll(() => runnerNotices()).toContain("Nightly cleanup needs your consent");

      await openRunnerTab(runRoute("bypass", waiting?.run ?? ""));
      await expect(tab().getByTestId("run-result")).toHaveText("Waiting for you");
      await expect(tab().getByTestId("run-waits")).toHaveText('Claude asks you to accept its Bypass Permissions mode — Full autonomy — for this agent profile, once. Pick "Yes, I accept" in its terminal and the run goes on; "No, exit" ends it.');
      await expect(tab().getByTestId("run-prompt")).toContainText("Yes, I accept");
      await shoot(page, "pomade-consent-card");

      await page.getByTestId(`strip-${STRIP_KEY}`).click();
      await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
      await drawn(page);
      const card = panel().locator('[data-testid="needs-you-item"][data-kind="waiting"]');
      await expect(card).toContainText("Nightly cleanup");
      await expect(card.getByTestId("needs-you-words")).toHaveText("Waiting for you to accept Full autonomy for its agent profile.");
      await page.mouse.move(1000, 600);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await shoot(page, "pomade-consent-panel");
      // Past the agent's time to start, it still waits at the consent: no not-started wait takes over.
      await new Promise((resolve) => setTimeout(resolve, NOT_STARTED_MS + 1000));
      expect(await going("bypass")).toMatchObject({ state: "running", agent: { worked: false, waiting: { prompt: "consent" } } });

      await card.getByRole("button", { name: "Open at the prompt" }).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
      const [tabId = ""] = await attachedTabIds();
      await expect.poll(() => buffer(tabId)).toContain("Enter to confirm · Esc to cancel");
      await shoot(page, "pomade-consent-tab");
      await page.getByTestId(`attached-xterm-${tabId}`).click();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect.poll(() => needsYou()).toEqual([]);
      await expect.poll(async () => (await history("bypass")).length, { timeout: 30_000 }).toBe(1);
      expect((await history("bypass"))[0]).toMatchObject({ state: "done", agent: { mode: "full-autonomy", worked: true, waiting: null, answered: [] } });
      await closeTab(tabId);
    });

    test("T-052 · \"No, exit\" at the consent ends the run and its wait: the screen stays as drawn, the agent's exit is the run's end", async () => {
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "bypass"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("bypass"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("consent");
      const waiting = await going("bypass");
      await openRunnerTab(runRoute("bypass", waiting?.run ?? ""));
      await tab().getByRole("button", { name: "Open at the prompt" }).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
      const [tabId = ""] = await attachedTabIds();
      await expect.poll(() => buffer(tabId)).toContain("Enter to confirm · Esc to cancel");
      // Enter on the highlighted "No, exit".
      await page.getByTestId(`attached-xterm-${tabId}`).click();
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await history("bypass")).length, { timeout: 30_000 }).toBe(2);
      const [record] = await history("bypass");
      expect(record).toMatchObject({ run: waiting?.run, state: "failed", agent: { worked: false, waiting: null } });
      // The wait is gone; the failure's own item is cleared by its card, open in the Runner tab.
      await expect.poll(() => needsYou()).toEqual([]);
      await closeTab(tabId);
    });
  });

  test("3 · the done card shows the agent's last message; Open session resumes the session in a Pomade agent tab", async () => {
    const [record] = await history("summary");
    await openRunnerTab(runRoute("summary", record?.run ?? ""));
    const dialog = tab().getByTestId("run-dialog");
    await expect(tab().getByTestId("run-result")).toHaveText("Done");
    await expect(dialog.getByTestId("run-agent-message")).toContainText("Done. Write my morning summary.");
    await expect(dialog.getByTestId("run-agent")).toContainText("Claude · Normal");
    await shoot(page, "pomade-agent-card");
    await dialog.getByRole("button", { name: "Open session" }).click();
    const agentsApp = await connectAs("pomade-agents");
    try {
      await expect.poll(async () => (await agentsApp.agentTabs.list()).map((t) => [t.agentId, t.cwd]), { timeout: 15_000 }).toContainEqual(["claude", notes]);
    } finally {
      agentsApp.close();
    }
    await expect(page.locator(".xterm-rows").filter({ hasText: `resumed session ${record?.agent?.sessionId ?? ""}` })).toBeVisible({ timeout: 15_000 });
    await shoot(page, "pomade-agent-resumed");
  });

  test("T-037 · a turn that ends without an answer — an API error — still gets /exit, and the run fails with why: a notice, a Needs-you item, the agent's screen on its card", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/unanswered.md"), agentJob("Unanswered", "claude", "Write the digest. [no-answer]"));
    const record = await runToEnd("unanswered");
    expect(record).toMatchObject({ state: "failed", reason: "the agent's turn ended without an answer", exitCode: 0 });
    expect(record.agent?.exitSentAt).toEqual(expect.any(Number));
    expect(record.lastLines.join("\n")).toContain("Not logged in · Please run /login");
    expect(record.lastLines.join("\n")).toContain("Bye.");
    expect((await agents.session(record.agent?.sessionId ?? "")).lastMessage).toBeNull();
    await expect.poll(() => needsYou()).toContain("run-failed:unanswered");
    await expect.poll(() => runnerNotices()).toContain("Unanswered failed");
    // The notice says the agent's error, not its goodbye to /exit.
    const notice = page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"]').filter({ hasText: "Unanswered failed" });
    await expect(notice).toContainText("the agent's turn ended without an answer · ⎿ API Error: Not logged in · Please run /login");
    await expect(notice).not.toContainText("Bye.");
    await openRunnerTab(runRoute("unanswered", record.run));
    const dialog = tab().getByTestId("run-dialog");
    await expect(tab().getByTestId("run-result")).toHaveText("Failed");
    await expect(dialog.getByTestId("run-why")).toHaveText("The agent's turn ended without an answer");
    await expect(dialog.getByTestId("run-last-lines")).toContainText("Not logged in · Please run /login");
    await expect(dialog.getByTestId("run-agent-note")).toHaveCount(0);
    await shoot(page, "pomade-agent-no-answer");
  });

  test.describe("T-044 · an agent whose turn ends with background work going", () => {
    /** The scheduler's lines about `run` of `job`, without their time. */
    const said = (job: string, run: string): string[] =>
      (scheduler?.output() ?? "")
        .split("\n")
        .map((line) => line.replace(/^\S+ /, ""))
        .filter((line) => line.startsWith(`run ${job} ${run}: `));
    const exits = (job: string, run: string): number => said(job, run).filter((line) => line.endsWith("typing /exit")).length;
    /** The Needs-you items of runs waiting for you; earlier tests' failures aside. */
    const waits = async (): Promise<string[]> => (await needsYou()).filter((id) => id.startsWith("waiting:"));

    test("1 · the run stays running through the background work, then its further turn ends it: done, one exit command, typed after the last turn", async () => {
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/hello-later.md"), agentJob("Hello later", "claude", "Say hello, wait 3 seconds, say it again. [background]"));
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "hello-later"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("hello-later"))?.agent?.background, { timeout: 15_000 }).toBe("idle");
      const waiting = await going("hello-later");
      expect(waiting).toMatchObject({ state: "running", agent: { exitSentAt: null, waiting: null } });
      expect(await waits()).toEqual([]);
      await expect.poll(async () => (await history("hello-later")).length, { timeout: 30_000 }).toBe(1);
      const [record] = await history("hello-later");
      expect(record).toMatchObject({ run: waiting?.run, state: "done", reason: null, exitCode: 0, agent: { background: null } });
      expect((await agents.session(record?.agent?.sessionId ?? "")).lastMessage).toBe("**Done.** After the background work: Say hello, wait 3 seconds, say it again. [background]");
      const lines = said("hello-later", record?.run ?? "");
      expect(exits("hello-later", record?.run ?? "")).toBe(1);
      expect(lines.findIndex((line) => line.endsWith("the agent works again"))).toBeLessThan(lines.findIndex((line) => line.endsWith("typing /exit")));
      expect(await waits()).toEqual([]);
    });

    test("2 · under a time limit shorter than the background work: stopped: time limit; meanwhile its row, Running now and its card say it waits for the background work", async () => {
      test.setTimeout(150_000);
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/hello-limited.md"), agentJob("Hello limited", "claude", "Say hello, wait 2 minutes, say it again. [background-long]", "time-limit: 1m\n"));
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "hello-limited"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("hello-limited"))?.agent?.background, { timeout: 15_000 }).toBe("idle");
      const waiting = await going("hello-limited");
      const words = "running · waiting for the agent's background work";

      // History's row and the run's card.
      await openRunnerTab("history");
      const historyRow = tab().getByTestId("history-row").filter({ hasText: "Hello limited" });
      await expect(historyRow.getByTestId("history-result")).toHaveText(words);
      await page.mouse.move(1000, 600);
      await shoot(page, "T-044-history-row");
      await openRunnerTab("jobs");
      await expect(tab().locator('[data-testid="job-row"][data-job="hello-limited"]')).toContainText(words);
      await page.mouse.move(1000, 600);
      await shoot(page, "T-044-jobs-row");
      await openRunnerTab(runRoute("hello-limited", waiting?.run ?? ""));
      await expect(tab().getByTestId("run-result")).toHaveText("Running");
      await expect(tab().getByTestId("run-background")).toHaveText(
        "The agent’s turn is over, but work it started in the background still goes. Runner waits for that work: the agent goes on once it ends, and the run is done when the agent is. The time limit keeps counting.",
      );
      await shoot(page, "T-044-card");

      // The panel's Running now.
      await page.getByTestId(`strip-${STRIP_KEY}`).click();
      await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
      await drawn(page);
      const row = panel().getByTestId("active-run").filter({ hasText: "Hello limited" });
      await expect(row).toContainText("Hello limited");
      await expect(row).toContainText("running");
      await expect(row).toContainText("waiting for the agent's background work");
      expect(await waits()).toEqual([]);
      await page.mouse.move(1000, 600);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await shoot(page, "T-044-panel-row");
      await page.getByTestId(`strip-${STRIP_KEY}`).click();

      await expect.poll(async () => (await history("hello-limited")).length, { timeout: 90_000 }).toBe(1);
      const [record] = await history("hello-limited");
      expect(record).toMatchObject({ run: waiting?.run, state: "failed", reason: "stopped: time limit, 1 min", limitHit: 1, agent: { exitSentAt: null } });
      expect(exits("hello-limited", record?.run ?? "")).toBe(0);
    });

    test("3 · an exit command answered by the background-work question: Escape, the run stays running — no wait for you — and the agent's later turn ends it: done", async () => {
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/hello-hidden.md"), agentJob("Hello hidden", "claude", "Say hello after the sub-agent. [background-hidden]"));
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "hello-hidden"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("hello-hidden"))?.agent?.background, { timeout: 15_000 }).toBe("idle");
      const waiting = await going("hello-hidden");
      expect(waiting).toMatchObject({ state: "running", agent: { exitSentAt: null, waiting: null } });
      expect(said("hello-hidden", waiting?.run ?? "")).toContain(`run hello-hidden ${waiting?.run ?? ""}: the agent answered /exit with its background-work question; declining it (Escape)`);
      expect(await waits()).toEqual([]);
      await expect.poll(async () => (await history("hello-hidden")).length, { timeout: 30_000 }).toBe(1);
      const [record] = await history("hello-hidden");
      expect(record).toMatchObject({ run: waiting?.run, state: "done", reason: null, exitCode: 0 });
      expect(exits("hello-hidden", record?.run ?? "")).toBe(2);
      expect(record?.lastLines.join("\n")).toContain("Bye.");
      expect(await runnerNotices()).not.toContain("Hello hidden needs your approval");
    });

    test("3 · stopped at the background-work question after the exit wait: failed, the agent still had background work", async () => {
      test.setTimeout(90_000);
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/hello-stuck.md"), agentJob("Hello stuck", "claude", "Say hello after the sub-agent. [background-hidden] [esc-ignored]"));
      const record = await runToEnd("hello-stuck");
      expect(record).toMatchObject({ state: "failed", reason: "the agent still had background work when Runner ended it", agent: { background: "asked" } });
      expect(said("hello-stuck", record.run)).toContain(`run hello-stuck ${record.run}: the agent did not end after /exit, its background-work question still up; stopping its session`);
      await expect.poll(() => needsYou()).toContain("run-failed:hello-stuck");
    });
  });

  test.describe("T-045 · Runner types the exit command only at the agent's empty prompt", () => {
    /** The scheduler's lines about `run` of `job`, without their time. */
    const said = (job: string, run: string): string[] =>
      (scheduler?.output() ?? "")
        .split("\n")
        .map((line) => line.replace(/^\S+ /, ""))
        .filter((line) => line.startsWith(`run ${job} ${run}: `));
    const exits = (job: string, run: string): number => said(job, run).filter((line) => line.endsWith("typing /exit")).length;
    /** The Needs-you items of runs waiting for you; earlier tests' failures aside. */
    const waits = async (): Promise<string[]> => (await needsYou()).filter((id) => id.startsWith("waiting:"));

    /** Answer the wait of `job` in its terminal tab, opened from its Needs-you card: `keys` there. */
    async function answerInTab(job: string, words: string, shot: string, keys: string[]): Promise<void> {
      await page.getByTestId(`strip-${STRIP_KEY}`).click();
      await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
      await drawn(page);
      const card = panel().locator('[data-testid="needs-you-item"][data-kind="waiting"]');
      await expect(card.getByTestId("needs-you-words")).toHaveText(words);
      await page.mouse.move(1000, 600);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await shoot(page, `${shot}-panel`);
      await card.getByRole("button", { name: "Open at the prompt" }).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
      const [tabId = ""] = await attachedTabIds();
      await expect(page.getByTestId(`attached-xterm-${tabId}`)).toBeVisible();
      await shoot(page, `${shot}-tab`);
      await page.getByTestId(`attached-xterm-${tabId}`).click();
      for (const key of keys) await page.keyboard.press(key);
      await expect.poll(() => waits()).toEqual([]);
      await expect.poll(async () => (await history(job)).length, { timeout: 30_000 }).toBe(1);
      await closeTab(tabId);
    }

    test("1 · a question form after the agent worked: no exit command — the run waits for you, worded as a question — and answered, the agent works and the run is done", async () => {
      expect(await waits()).toEqual([]);
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/ask-format.md"), agentJob("Ask format", "claude", "Pick the notes' format. [question]", "time-limit: 30m\n"));
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "ask-format"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("ask-format"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("question");
      const waiting = await going("ask-format");
      // Past the half second idle took to type the exit command into the form, nothing is typed.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await going("ask-format")).toMatchObject({ state: "running", agent: { exitSentAt: null, waiting: { prompt: "question" } } });
      expect(exits("ask-format", waiting?.run ?? "")).toBe(0);
      expect(await waits()).toEqual([`waiting:ask-format:${waiting?.run ?? ""}`]);
      await expect.poll(() => runnerNotices()).toContain("Ask format asks you a question");
      await openRunnerTab(runRoute("ask-format", waiting?.run ?? ""));
      await expect(tab().getByTestId("run-result")).toHaveText("Waiting for you");
      await expect(tab().getByTestId("run-waits")).toHaveText("The agent asks you a question and waits for you to pick an option.");
      await shoot(page, "T-045-question-card");
      // The person moves the highlight to Plain text and picks it.
      await answerInTab("ask-format", "Waiting for your answer to its question.", "T-045-question", ["ArrowDown", "Enter"]);
      const [record] = await history("ask-format");
      expect(record).toMatchObject({ run: waiting?.run, state: "done", reason: null, exitCode: 0, agent: { waiting: null, answered: [], workedOn: false } });
      expect((await agents.session(record?.agent?.sessionId ?? "")).lastMessage).toBe("**Done.** Picked Plain text: Pick the notes' format. [question]");
      expect(exits("ask-format", record?.run ?? "")).toBe(1);
    });

    test("2 · a dialog no rule names after the agent worked: the same wait, worded as a screen Runner does not know", async () => {
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/plan.md"), agentJob("Plan tidy", "claude", "Plan the tidy-up. [unknown-dialog]", "time-limit: 30m\n"));
      expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", "plan"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("plan"))?.agent?.waiting?.prompt, { timeout: 15_000 }).toBe("unknown");
      const waiting = await going("plan");
      expect(exits("plan", waiting?.run ?? "")).toBe(0);
      await expect.poll(() => runnerNotices()).toContain("Plan tidy waits at a screen Runner does not know");
      await openRunnerTab(runRoute("plan", waiting?.run ?? ""));
      await expect(tab().getByTestId("run-waits")).toHaveText("The agent stopped at a screen Runner does not know and waits for you. Look at its terminal.");
      await shoot(page, "T-045-unknown-card");
      await answerInTab("plan", "Waiting at a screen Runner does not know.", "T-045-unknown", ["Enter"]);
      const [record] = await history("plan");
      expect(record).toMatchObject({ state: "done", exitCode: 0 });
      expect((await agents.session(record?.agent?.sessionId ?? "")).lastMessage).toBe("**Done.** After the plan: Plan the tidy-up. [unknown-dialog]");
    });

    test("5 · in Full autonomy Runner answers the question form with the highlighted option — no wait — and the card says what it answered", async () => {
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/ask-auto.md"), agentJob("Ask auto", "claude", "Pick the notes' format. [question]", "mode: full-autonomy\n"));
      const record = await runToEnd("ask-auto");
      expect(record).toMatchObject({ state: "done", exitCode: 0, agent: { mode: "full-autonomy", waitedMs: 0, answered: ["Markdown (Recommended)"] } });
      expect((await agents.session(record.agent?.sessionId ?? "")).lastMessage).toBe("**Done.** Picked Markdown (Recommended): Pick the notes' format. [question]");
      expect(said("ask-auto", record.run)).toContain(`run ask-auto ${record.run}: the agent asks a question; Runner answered: Markdown (Recommended)`);
      expect(await runnerNotices()).not.toContain("Ask auto asks you a question");
      await openRunnerTab(runRoute("ask-auto", record.run));
      const dialog = tab().getByTestId("run-dialog");
      await expect(dialog.getByTestId("run-answered")).toHaveText("Runner answered: Markdown (Recommended)");
      await shoot(page, "T-045-answered-card");
    });

    test("3 · an agent that works again after the exit command is not stopped after the exit wait: done after its real last turn", async () => {
      test.setTimeout(90_000);
      await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/once-more.md"), agentJob("Once more", "claude", "Tidy the notes. [works-again]"));
      const record = await runToEnd("once-more");
      expect(record).toMatchObject({ state: "done", reason: null, exitCode: 0, signal: null });
      expect((await agents.session(record.agent?.sessionId ?? "")).lastMessage).toBe("**Done.** After the exit command: Tidy the notes. [works-again]");
      expect(exits("once-more", record.run)).toBe(2);
      expect(said("once-more", record.run)).toContain(`run once-more ${record.run}: the agent works on after /exit; following its turn`);
      expect(said("once-more", record.run).some((line) => line.includes("stopping its session"))).toBe(false);
      expect(record.durationMs).toBeGreaterThan(18_000);
    });
  });

  test.describe("T-038 · the keeper's reach to the macOS keychain", () => {
    /** The check fails this many more times; every check adds a line to `checks`. */
    let fails: string;
    let checks: string;
    let schedulerSince = 0;
    const jobs = (): string => join(folders.workspace, "Apps/pomade-runner/jobs");
    /** The scheduler's output since this group's scheduler started. */
    const output = (): string => scheduler?.output().slice(schedulerSince) ?? "";
    const checksRun = async (): Promise<number> => (await readFile(checks, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").length;

    async function ticker(): Promise<{ pid: number | null; startedAt: number } | undefined> {
      const result = await callScheduler(socket(), "sessions", null);
      return result.status === "ok" ? result.value.sessions.find((session) => session.id === "svc:ticker" && session.info.state === "running")?.info : undefined;
    }

    async function tickerService(): Promise<{ restarts: number; lastCrashAt: number | null } | undefined> {
      const result = await callScheduler(socket(), "services", null);
      return result.status === "ok" ? result.value.services.find((service) => service.job === "ticker") : undefined;
    }

    test.beforeAll(async () => {
      fails = join(tmp, "keychain-fails");
      checks = join(tmp, "keychain-checks");
      await writeFile(fails, "0\n");
      const check = `echo check >> '${checks}'; n=$(cat '${fails}'); if [ "$n" -gt 0 ]; then echo $((n - 1)) > '${fails}'; echo 'SecKeychainCopySearchList: One or more parameters passed to a function were not valid' >&2; exit 50; fi`;
      await scheduler?.kill();
      schedulerSince = 0;
      await startScheduler({ POMADE_RUNNER_KEYCHAIN_CHECK: check });
      await writeFile(join(jobs(), "ticker.md"), serviceFile("Ticker", "exec sleep 600"));
      await expect.poll(() => ticker(), { timeout: 15_000 }).toBeDefined();
      await writeFile(join(jobs(), "keychain.md"), agentJob("Keychain digest", "claude", "Write the keychain digest."));
    });

    test("a healthy keeper: one check, no replacement, the run starts", async () => {
      const keeper = await keeperAt(keeperSocket);
      const before = { runs: (await history("keychain")).length, checks: await checksRun() };
      const record = await runToEnd("keychain", before.runs + 1);
      expect(record).toMatchObject({ state: "done" });
      expect(await checksRun()).toBe(before.checks + 1);
      expect(output()).not.toContain("keychain check failed");
      expect(output()).not.toContain("keeper: replacing");
      expect(await keeperAt(keeperSocket)).toEqual(keeper);
    });

    test("1 · a keeper whose check fails, nothing running: it is replaced, the services come back with no crash counted, and the run starts", async () => {
      const old = await keeperAt(keeperSocket);
      const service = await ticker();
      await writeFile(fails, "1\n");
      const before = { runs: (await history("keychain")).length, checks: await checksRun() };
      const record = await runToEnd("keychain", before.runs + 1);
      expect(record).toMatchObject({ state: "done" });
      expect(await checksRun()).toBe(before.checks + 2);
      const pid = old?.pid ?? 0;
      expect(output()).toMatch(new RegExp(`keeper: the keychain check failed in keeper pid ${pid}, started \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.000Z — exit 50\n`));
      expect(output()).toMatch(new RegExp(`keeper: replacing pid ${pid}, started \\S+ — it cannot reach the macOS keychain\n`));
      const fresh = await keeperAt(keeperSocket);
      expect(fresh?.pid).not.toBe(pid);
      expect(alive(pid)).toBe(false);
      expect(output()).toContain(`keeper: replaced pid ${pid} with pid ${fresh?.pid ?? ""}, started `);
      expect(output()).toContain("session svc:ticker: ended: lost-in-keeper-crash");
      await expect.poll(async () => (await ticker())?.pid, { timeout: 15_000 }).not.toBe(service?.pid);
      expect(await tickerService()).toMatchObject({ restarts: 0, lastCrashAt: null });
    });

    test("2 · with a script run going, the agent run waits queued for a fresh keeper; once the script ends, the keeper is replaced and the run starts", async () => {
      const gate = join(tmp, "keychain-gate");
      await writeFile(join(jobs(), "slow.md"), `---\nkind: script\nname: Slow\nfolder: .\ncommand: "while [ ! -f '${gate}' ]; do sleep 0.1; done"\nschedule:\n  once: 2099-01-01 7:00\n---\n`);
      const cli = join(folders.home, "bin", "pomade-runner");
      expect((await run(cli, ["run", "slow"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("slow"))?.state, { timeout: 15_000 }).toBe("running");
      const old = await keeperAt(keeperSocket);
      // The check fails when the run is due, and again once the script has ended.
      await writeFile(fails, "2\n");
      const before = { runs: (await history("keychain")).length, checks: await checksRun() };
      expect((await run(cli, ["run", "keychain"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stderr).toBe("");
      await expect.poll(async () => (await going("keychain"))?.waits, { timeout: 15_000 }).toEqual({ kind: "keeper" });
      expect(output()).toMatch(/run keychain \S+: queued · a fresh keeper, after the runs going\n/);
      expect((await run(cli, ["runs"], { env: cleanEnv({ HOME: user }), cwd: tmp })).stdout).toContain("queued · a fresh keeper, after the runs going");
      expect(output()).not.toContain(`keeper: replacing pid ${old?.pid ?? ""}`);
      expect(await keeperAt(keeperSocket)).toEqual(old);

      await writeFile(gate, "");
      await expect.poll(async () => (await history("keychain")).length, { timeout: 30_000 }).toBe(before.runs + 1);
      expect((await history("slow"))[0]).toMatchObject({ state: "done" });
      expect((await history("keychain"))[0]).toMatchObject({ state: "done" });
      expect(output()).toContain(`keeper: replacing pid ${old?.pid ?? ""}`);
      expect((await keeperAt(keeperSocket))?.pid).not.toBe(old?.pid);
      expect(await checksRun()).toBe(before.checks + 3);
      expect(await tickerService()).toMatchObject({ restarts: 0, lastCrashAt: null });
    });

    test("3 · a check that fails in the fresh keeper too: the run fails with why", async () => {
      await writeFile(fails, "2\n");
      const before = (await history("keychain")).length;
      const ran = await run(join(folders.home, "bin", "pomade-runner"), ["run", "keychain"], { env: cleanEnv({ HOME: user }), cwd: tmp });
      expect(ran.stderr).toContain("cannot start — the keeper cannot reach the macOS keychain, so the agent would have no login");
      await expect.poll(async () => (await history("keychain")).length, { timeout: 30_000 }).toBe(before + 1);
      const [record] = await history("keychain");
      expect(record).toMatchObject({ state: "failed", startedAt: null, reason: "cannot start — the keeper cannot reach the macOS keychain, so the agent would have no login" });
      expect(await readFile(fails, "utf8")).toBe("0\n");
    });
  });
});
