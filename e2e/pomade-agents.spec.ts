// Agent runs with a real Pomade: the Pomade checkout's built app (`POMADE_REPO`) in test mode on a
// temp workspace, user data and home, with the built `dist/` and the fixture Agents app
// (`fixtures/agents-app/`) dev-linked, and the scripted fake agent CLI (`fixtures/fake-agent.mjs`)
// as the roster's Claude and Codex. The scheduler is started the way the login item starts it
// (`pomade.spec.ts`). A run starts the agent in the job's folder through the launch spec, its turn
// completes, Runner types `/exit`, and the run is done with its session; Full autonomy passes the
// agent's autonomy argument; an agent that ends before its turn is done fails; a Codex run's session
// is found by folder and start time; the fixture app hears `run.started` and `run.finished` with the
// session and the started-by-Runner flag; the done card shows the last message, and Open session
// resumes it in a Pomade agent tab. `RUNNER_SHOTS=<dir>` saves screenshots of the form, the row and
// the cards.

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { connectSocket } from "pomade-kit/node";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import manifest from "../app/manifest.json" with { type: "json" };
import { runRoute } from "../src/integrations/runner-api";
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { AGENTS_APP, fakeAgents, type FakeAgents } from "./support/agents";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { drawn } from "./support/frames";
import { expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const SHOTS = process.env.RUNNER_SHOTS;
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
      }),
    );
    scheduler = started;
    await expect.poll(() => started.output()).toContain("connected to Pomade");
  });

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
  });

  test("5 · run.started and run.finished reach a subscriber with the session, the agent and the started-by-Runner flag", async () => {
    const [record] = await history("summary");
    await expect.poll(async () => (await agents.events()).filter((e) => e.payload.run === record?.run).map((e) => e.event)).toEqual(["run.started", "run.finished"]);
    const [started, finished] = (await agents.events()).filter((e) => e.payload.run === record?.run);
    const fields = { job: "summary", name: "Morning summary", kind: "agent", folder: "Projects/notes", project: null, sessionId: record?.agent?.sessionId, agent: "claude", mode: "normal", cwd: notes, startedByRunner: true, startedAt: record?.agent?.startedAt };
    expect(started?.payload).toMatchObject({ ...fields, trigger: "manual" });
    expect(finished?.payload).toMatchObject({ ...fields, trigger: "manual", result: "done", exitCode: 0 });
    expect(Date.parse(started?.payload.startedAt ?? "")).toBeLessThanOrEqual(Date.parse((await agents.session(record?.agent?.sessionId ?? "")).startedAt));
  });

  test("4 · Full autonomy passes the agent's autonomy argument", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/weekly.md"), agentJob("Librarian weekly", "claude", "Weekly maintenance.", "mode: full-autonomy\n"));
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
});
