// Runner hosted by a real Pomade: the Pomade checkout's built app (`POMADE_REPO`), in test mode on
// a temp workspace, user data and home, with the built `dist/` dev-linked for the run
// (`POMADE_DEV_APPS`). A test Pomade installs no login items, so the scheduler is started here the
// way the login item would start it: the same entry, Pomade's runtime, the environment HOST-API §2
// "Backends" names; it finds the workspace through the pointer the test Pomade writes in its home.
// Its keeper runs on Pomade's runtime too; Pomade's attached tabs attach to it directly. Teardown
// stops the keeper with its sessions. `RUNNER_SHOTS=<dir>` saves screenshots of the panel, the tab
// and an attached tab.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { connectSocket } from "pomade-kit/node";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import manifest from "../app/manifest.json" with { type: "json" };
import { STRIP_ICON } from "../src/app";
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { runningSession, sessionInfo, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const VERSION = manifest.version;
const SHOTS = process.env.RUNNER_SHOTS;
const STRIP_KEY = `app-${manifest.id}-${STRIP_ICON}`;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe("Runner in Pomade", () => {
  test.describe.configure({ mode: "serial" });

  const pomade = pomadeCheckout();
  let tmp: string;
  let folders: PomadeFolders;
  let app: ElectronApplication | null = null;
  let page: Page;
  let scheduler: SchedulerProcess | null = null;
  let keeperSocket: string;
  /** Processes the keeper ran: killed in teardown should one outlive its keeper. */
  const pids: number[] = [];

  /** `pomade-runner`, through the shim Pomade wrote into its command folder. */
  function command(...args: string[]) {
    return run(join(folders.home, "bin", "pomade-runner"), args, { env: cleanEnv(), cwd: tmp });
  }

  test.beforeAll(async () => {
    tmp = await tempDir();
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    await mkdir(join(folders.workspace, "Projects"), { recursive: true });
    await mkdir(join(tmp, "user"));
    app = await electron.launch({
      executablePath: pomade.runtime,
      args: [pomade.main],
      env: pomadeEnv(folders, { POMADE_DEV_APPS: DIST }),
    });
    page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
  });

  test.afterAll(async () => {
    await scheduler?.kill();
    await app?.close();
    await stopKeeper(keeperSocket, pids);
    await removeDir(tmp);
  });

  const VALID = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
  const BROKEN = VALID.replace("13:00", "25:00");
  const ERROR = 'schedule.daily.at — "25:00" is not a time. Fix: write a time like 7:00 or 13:30 (H:MM, 24-hour).';

  function panel() {
    return page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);
  }

  /** The scheduler, started the way the login item starts it: Pomade's runtime, the backend
   *  environment; it connects to Pomade unless `pomade: false` says Pomade is closed. */
  async function startTheScheduler(options: { pomade: boolean } = { pomade: true }): Promise<SchedulerProcess> {
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
        // Sessions run `/bin/sh` as the login shell in a temp home: no user profile is read.
        HOME: join(tmp, "user"),
        SHELL: "/bin/sh",
      }),
    );
    scheduler = started;
    if (options.pomade) await expect.poll(() => started.output()).toContain("connected to Pomade");
    return started;
  }

  test("the Runner icon is on the strip and fills the side panel; with no scheduler yet, the panel says so", async () => {
    const icon = page.getByTestId(`strip-${STRIP_KEY}`);
    await expect(icon).toBeVisible();
    // Pomade draws the icon from its URL — tinted as a mask when the SVG is monochrome, else as an image.
    const drawn = icon.locator("[data-app-icon]");
    await expect(drawn).toBeVisible();
    const url = await drawn.evaluate((el) => (el instanceof HTMLImageElement ? el.src : (el as HTMLElement).dataset.iconUrl ?? ""));
    const loads = (src: string): Promise<boolean> =>
      new Promise((done) => {
        const image = new Image();
        image.onload = () => done(image.naturalWidth > 0);
        image.onerror = () => done(false);
        image.src = src;
      });
    expect(await page.evaluate(loads, url)).toBe(true);

    await icon.click();
    await expect(panel().getByRole("heading", { name: "Runner's scheduler is not running" })).toBeVisible();
    await expect(panel().locator("html")).toHaveAttribute("data-surface", "panel");
  });

  test("once the scheduler connects, the panel shows the no-jobs state", async () => {
    await startTheScheduler();
    await expect(panel().getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await shoot(page, "pomade-panel");
  });

  test("a job file written to disk turns the panel's no-jobs state into its sections within a second", async () => {
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "backup.md"), VALID);
    await expect(panel().getByTestId("panel-jobs").getByRole("region", { name: "Next up" })).toBeVisible({ timeout: 1000 });
    await shoot(page, "pomade-panel-jobs");
  });

  test("Open Runner opens the Runner tab with the jobs; a broken file shows its error within a second, as pomade-runner check prints it; Settings shows the version", async () => {
    await panel().getByRole("button", { name: "Open Runner" }).click();
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    await expect(tab.getByTestId("tab-jobs").getByTestId("job-row")).toContainText("Backup");
    await expect(panel().getByTestId("open-runner-error")).toHaveCount(0);
    await shoot(page, "pomade-tab");

    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await writeFile(join(jobs, "backup.md"), BROKEN);
    await expect(tab.getByTestId("job-invalid")).toContainText(`Invalid: line 7: ${ERROR}`, { timeout: 1000 });
    const check = await command("check");
    expect(check.code).toBe(1);
    expect(check.stdout).toContain(`Apps/pomade-runner/jobs/backup.md:7: ${ERROR}\n`);
    expect(check.stdout).not.toContain("not checked");
    expect(await command("projects")).toEqual({ code: 0, stdout: "Pomade has no projects.\n", stderr: "" });
    await writeFile(join(jobs, "backup.md"), VALID);
    await expect(tab.getByTestId("job-row")).toContainText("Backup", { timeout: 1000 });

    await tab.getByTestId("nav-settings").click();
    await expect(tab.getByTestId("version")).toHaveText(`Runner ${VERSION}`);
    await tab.getByTestId("nav-jobs").click();
  });

  test("pomade-runner is in Pomade's command folder and answers --version", async () => {
    const version = await command("--version");
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(new RegExp(`^pomade-runner ${VERSION}\\nscheduler: running — ${VERSION}, pid \\d+, since \\S+Z, connected to Pomade\\n$`));
    expect(await command("frobnicate")).toMatchObject({ code: 2, stdout: "" });
  });

  /** A script job file, run on demand. */
  const scriptFile = (name: string, command: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\nhook: { event: project-created }\n---\n`;

  /** The runs of `job` the scheduler recorded, newest first. */
  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(schedulerSocket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  /** Runner's notices in Pomade's Notices panel, newest first. */
  async function runnerNotices(): Promise<string[]> {
    if (!(await page.getByTestId("notices-panel").isVisible())) await page.getByTestId("strip-notices").click();
    return page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"] [data-testid="notice-row-title"]').allTextContents();
  }

  const badge = (): Locator => page.getByTestId(`strip-badge-${STRIP_KEY}`);

  test("a failing script makes one notice and the Runner badge; a click opens the red result card with the exit code and the last lines, which resolves it; a success with on-failure makes no notice", async () => {
    const running = scheduler ?? (await startTheScheduler());
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await writeFile(join(jobs, "fine.md"), scriptFile("Fine", "echo fine"));
    await writeFile(join(jobs, "fail.md"), scriptFile("Fail", "echo working; echo boom >&2; exit 3"));
    await expect.poll(() => running.output()).toContain("jobs: 3 job files, 0 invalid\n");

    expect((await command("run", "fine")).code).toBe(0);
    await expect.poll(() => history("fine")).toEqual([expect.objectContaining({ state: "done" }) as RunRecord]);
    expect((await command("run", "fail")).code).toBe(0);
    await expect.poll(() => history("fail")).toEqual([expect.objectContaining({ state: "failed", exitCode: 3 }) as RunRecord]);
    await expect.poll(() => runnerNotices()).toEqual(["Fail failed"]);
    await expect(badge()).toHaveText("1");
    await expect(badge()).toHaveAttribute("data-urgent", "true");
    await shoot(page, "pomade-notice");

    await page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"]').click();
    const card = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`).getByTestId("run-card");
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(card.getByTestId("run-result")).toHaveText("failed · exit 3");
    await expect(card.getByTestId("run-exit")).toHaveText("Exit code 3");
    await expect(card.getByTestId("run-last-lines")).toHaveText("working\nboom");
    await shoot(page, "pomade-run-card");
    // Opening the result resolved the item: the badge goes.
    await expect(badge()).toHaveCount(0);
    expect(await runnerNotices()).toEqual(["Fail failed"]);
  });

  const TICKER = 'i=0; while :; do i=$((i+1)); echo "tick $i"; if read -t 1 line; then echo "got: $line"; fi; done';

  function schedulerSocket(): string {
    return join(folders.userData, "app-state", manifest.id, "scheduler.sock");
  }

  /** A connection to Pomade as Runner's backend — what opens Runner's attached tabs here. */
  async function connectAsRunner(): Promise<HostClient> {
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    const result = await connectSocket({ socketPath: host.socket, appId: manifest.id, keyFile: join(folders.userData, "app-keys", manifest.id), role: "backend" });
    if (result.status !== "connected") throw new Error(`Runner's connection to Pomade: ${result.status}`);
    return result.host;
  }

  /** The attached tabs in the Workspace scope, by id. */
  function attachedTabIds(): Promise<string[]> {
    return page.evaluate((project) => {
      const stores = (window as unknown as { __pomadeStores: { useTabsStore: { getState(): { tabsByProject: Record<string, { id: string; kind: string }[] | undefined> } } } }).__pomadeStores;
      return (stores.useTabsStore.getState().tabsByProject[project] ?? []).filter((tab) => tab.kind === "attached").map((tab) => tab.id);
    }, WORKSPACE_PROJECT_ID);
  }

  /** Open the session's attached tab; its id. */
  async function openTab(runner: HostClient, session: string): Promise<string> {
    await runner.tabs.openAttached({ session: { app: manifest.id, session } });
    await expect.poll(() => attachedTabIds()).toHaveLength(1);
    const [id] = await attachedTabIds();
    return id ?? "";
  }

  /** An attached tab's whole terminal buffer as text. */
  function buffer(id: string): Promise<string> {
    return page.evaluate((tab) => (window as unknown as { __pomadeAttachedBuffer?: Record<string, () => string> }).__pomadeAttachedBuffer?.[tab]?.() ?? "", id);
  }

  async function lastTick(id: string): Promise<number> {
    return Math.max(0, ...[...(await buffer(id)).matchAll(/tick (\d+)/g)].map((m) => Number(m[1])));
  }

  test("a service's session opens as an attached tab: earlier and live output, Restart from its header, closing leaves it running, Ctrl+C stops it as stopped by you", async () => {
    const running = scheduler ?? (await startTheScheduler());
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/ticker.md"), `---\nkind: service\nname: Ticker\nfolder: .\ncommand: ${JSON.stringify(TICKER)}\n---\n`);
    // The scheduler loads the new file within a second, and starts the service.
    await expect.poll(() => running.output()).toContain("jobs: 4 job files, 0 invalid\n");
    const started = await runningSession(schedulerSocket(), "svc:ticker");
    pids.push(started.info.pid ?? 0);
    await expect.poll(() => readFile(started.log ?? "", "utf8").catch(() => "")).toContain("tick 2");
    const runner = await connectAsRunner();

    try {
      const id = await openTab(runner, "svc:ticker");
      await expect(page.getByTestId(`tab-title-${id}`)).toHaveText("Ticker · Runner");
      await expect(page.getByTestId(`attached-status-${id}`)).toHaveText("Running");
      // The earlier output, then the live output.
      await expect.poll(() => buffer(id)).toContain("tick 1");
      const seen = await lastTick(id);
      expect(seen).toBeGreaterThanOrEqual(2);
      await expect.poll(() => lastTick(id)).toBeGreaterThan(seen);
      await page.getByTestId(`attached-xterm-${id}`).click();
      await page.keyboard.type("before restart");
      await page.keyboard.press("Enter");
      await expect.poll(() => buffer(id)).toContain("got: before restart");
      await shoot(page, "pomade-attached");

      // Restart from the header: the same id, a new process; the tab shows the new session.
      await page.getByTestId(`attached-${id}`).getByTestId("attached-action-restart").click();
      await expect.poll(() => running.output()).toContain("session svc:ticker: Restart from its tab\n");
      await expect.poll(() => running.output()).toContain("service ticker: Restart\n");
      await expect.poll(() => running.output()).toContain("session svc:ticker: ended: stopped");
      await expect.poll(async () => (await sessionInfo(schedulerSocket(), "svc:ticker"))?.pid).not.toBe(started.info.pid);
      const restarted = await sessionInfo(schedulerSocket(), "svc:ticker");
      pids.push(restarted?.pid ?? 0);
      expect(restarted).toMatchObject({ state: "running" });
      await expect.poll(() => buffer(id)).not.toContain("got: before restart");
      await expect.poll(() => buffer(id)).toContain("tick 1");
      await expect(page.getByTestId(`attached-status-${id}`)).toHaveText("Running");

      // Closing the tab only detaches.
      await page.getByTestId(`close-${id}`).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(0);
      await expect.poll(async () => (await sessionInfo(schedulerSocket(), "svc:ticker"))?.clients).toBe(0);
      expect(await sessionInfo(schedulerSocket(), "svc:ticker")).toMatchObject({ state: "running", pid: restarted?.pid });

      // Ctrl+C typed in a tab ends it as stopped by you.
      const again = await openTab(runner, "svc:ticker");
      await expect.poll(() => buffer(again)).toContain("tick");
      await page.getByTestId(`attached-xterm-${again}`).click();
      await page.keyboard.press("Control+C");
      await expect(page.getByTestId(`attached-status-${again}`)).toHaveText("Stopped by you");
      await expect.poll(() => running.output()).toContain("session svc:ticker: ended: stopped-by-you — code 130, SIGINT\n");
      expect((await command("sessions")).stdout).toContain("svc:ticker  job ticker  ended: stopped-by-you — code 130, SIGINT, at ");
      await expect.poll(async () => (await command("services")).stdout).toContain("ticker  Ticker  stopped by you\n");
      await page.getByTestId(`close-${again}`).click();
    } finally {
      runner.close();
    }
  });

  test("a stopped service's tab keeps its last output with Start; Start and Stop from its header; a Running now row opens its tab, and closing it leaves the service running", async () => {
    const running = scheduler ?? (await startTheScheduler());
    const runner = await connectAsRunner();
    const services = async (): Promise<string> => (await command("services")).stdout;
    try {
      // Stopped by you in the test before: its tab shows its last output, and Start.
      const id = await openTab(runner, "svc:ticker");
      const pane = page.getByTestId(`attached-${id}`);
      await expect(page.getByTestId(`attached-status-${id}`)).toHaveText("Stopped by you");
      await expect.poll(() => buffer(id)).toContain("tick");
      await expect(pane.getByTestId("attached-action-start")).toHaveText("Start");
      await expect(pane.getByTestId("attached-action-restart")).toHaveCount(0);
      await expect(pane.getByTestId("attached-stop")).toHaveCount(0);
      await shoot(page, "pomade-attached-stopped");

      await pane.getByTestId("attached-action-start").click();
      await expect.poll(() => running.output()).toContain("session svc:ticker: Start from its tab\n");
      await expect(page.getByTestId(`attached-status-${id}`)).toHaveText("Running");
      pids.push((await sessionInfo(schedulerSocket(), "svc:ticker"))?.pid ?? 0);
      await expect(pane.getByTestId("attached-action-restart")).toBeVisible();
      await expect(pane.getByTestId("attached-stop")).toBeVisible();
      await expect(pane.getByTestId("attached-action-start")).toHaveCount(0);
      await page.getByTestId(`close-${id}`).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(0);

      // Running now's row opens the service's tab; closing it leaves the service running.
      // The Notices panel is open since the failing script's test: the Runner icon brings Runner's back.
      await page.getByTestId(`strip-${STRIP_KEY}`).click();
      await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
      const row = panel().getByTestId("running-service").filter({ hasText: "Ticker" });
      await expect(row).toContainText("workspace · ws");
      // A panel frame just shown again may still be re-handshaking with Pomade, which drops a call
      // made across the handshake unanswered: click again until the tab opens.
      await expect(async () => {
        await row.click();
        expect(await attachedTabIds()).toHaveLength(1);
      }).toPass({ intervals: [500, 1000] });
      const [fromRow = ""] = await attachedTabIds();
      await expect(page.getByTestId(`tab-title-${fromRow}`)).toHaveText("Ticker · Runner");
      await expect(page.getByTestId(`attached-status-${fromRow}`)).toHaveText("Running");
      await shoot(page, "pomade-running-now-tab");
      await page.getByTestId(`close-${fromRow}`).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(0);
      expect(await sessionInfo(schedulerSocket(), "svc:ticker")).toMatchObject({ state: "running" });
      await expect.poll(services).toMatch(/\nticker {2}Ticker {2}(starting|running)/);

      // Stop from the header stops it as stopped by you; Start comes back.
      await row.click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
      const [again = ""] = await attachedTabIds();
      await page.getByTestId(`attached-${again}`).getByTestId("attached-stop").click();
      await expect(page.getByTestId(`attached-status-${again}`)).toHaveText("Stopped by you");
      await expect.poll(() => running.output()).toContain("session svc:ticker: ended: stopped-by-you");
      await expect.poll(services).toContain("ticker  Ticker  stopped by you\n");
      await expect(page.getByTestId(`attached-${again}`).getByTestId("attached-action-start")).toBeVisible();
      await expect(row).toHaveCount(0);
      await page.getByTestId(`close-${again}`).click();
    } finally {
      runner.close();
    }
  });

  test("the scheduler and the services' sessions outlive Pomade; a restarted scheduler lists them with their jobs", async () => {
    const running = scheduler ?? (await startTheScheduler());
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/stay.md"), `---\nkind: service\nname: Stay\nfolder: .\ncommand: ${JSON.stringify(TICKER)}\n---\n`);
    await expect.poll(() => running.output()).toContain("jobs: 5 job files, 0 invalid\n");
    const stay = await runningSession(schedulerSocket(), "svc:stay");
    pids.push(stay.info.pid ?? 0);

    await app?.close();
    app = null;
    await expect.poll(() => running.output()).toContain("Pomade went away; reconnecting");
    expect(await callScheduler(schedulerSocket(), "status", null)).toMatchObject({ status: "ok", value: { pid: running.child.pid, pomade: "disconnected" } });
    const ticks = (await readFile(stay.log ?? "", "utf8")).length;
    await expect.poll(async () => (await readFile(stay.log ?? "", "utf8")).length).toBeGreaterThan(ticks);

    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
    const restarted = await startTheScheduler({ pomade: false });
    await expect.poll(() => restarted.output()).toContain("keeper: connected");
    expect(await sessionInfo(schedulerSocket(), "svc:stay")).toMatchObject({ state: "running", pid: stay.info.pid, startedAt: stay.info.startedAt });
    expect((await command("sessions")).stdout).toContain(`svc:stay  job stay  running, pid ${stay.info.pid ?? ""}, `);
    // Stopped by you stays stopped across the restart; the running service is not restarted.
    await expect.poll(async () => (await command("services")).stdout).toMatch(/\nstay {2}Stay {2}running, pid \d+[^\n]*\nticker {2}Ticker {2}stopped by you\n$/);
    expect(restarted.output()).not.toMatch(/service \S+: (starting|restarted)/);
  });

  test("with Pomade closed, a script that fails queues its notice; on the next launch Pomade shows it, and the badge", async () => {
    expect(app).toBeNull();
    const running = scheduler ?? (await startTheScheduler({ pomade: false }));
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/late.md"), scriptFile("Late", "echo late >&2; exit 4"));
    await expect.poll(() => running.output()).toContain("jobs: 6 job files, 0 invalid\n");
    expect((await command("run", "late")).code).toBe(0);
    await expect.poll(() => history("late")).toEqual([expect.objectContaining({ state: "failed", exitCode: 4 }) as RunRecord]);
    await expect.poll(() => running.output()).toContain('notice "Late failed": queued for Pomade\'s next launch\n');

    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: DIST }) });
    page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect.poll(() => runnerNotices()).toEqual(["Late failed"]);
    await expect.poll(() => running.output()).toContain("connected to Pomade");
    await expect(badge()).toHaveText("1");
  });

  test("a service made in the job form appears and starts; edited, its file keeps its comments and body; deleted while running, it is stopped and its file is gone", async () => {
    const running = scheduler ?? (await startTheScheduler());
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const file = join(folders.workspace, "Apps/pomade-runner/jobs/form-web.md");
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "new", projectId: WORKSPACE_PROJECT_ID });
      const form = tab.getByTestId("form-service");
      await form.getByRole("textbox", { name: "Name", exact: true }).fill("Form web");
      await form.getByRole("textbox", { name: "Command", exact: true }).fill(TICKER);
      await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
      await expect(tab.getByTestId("form-path")).toHaveText("Apps/pomade-runner/jobs/form-web.md");
      await shoot(page, "pomade-form-new");
      await tab.getByTestId("form-save").click();
      await expect(tab.getByTestId("toast")).toHaveText("RunnerCreated Apps/pomade-runner/jobs/form-web.md · started");
      await expect(tab.getByTestId("tab-jobs").getByTestId("job-row").filter({ hasText: "Form web" })).toBeVisible();
      const started = await runningSession(schedulerSocket(), "svc:form-web");
      pids.push(started.info.pid ?? 0);
      const created = await readFile(file, "utf8");
      expect(created).toBe(`---\nkind: service\nname: Form web\nfolder: .\nenabled: true\ncommand: ${JSON.stringify(TICKER)}\n---\n`);

      // A comment and notes, written by hand; the form changes only the name.
      const hand = created.replace("kind: service\n", "kind: service # made in the form\n") + "Notes kept.\n";
      await writeFile(file, hand);
      await runner.tabs.openApp({ route: "edit/form-web", projectId: WORKSPACE_PROJECT_ID });
      await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Form web");
      await form.getByRole("textbox", { name: "Name", exact: true }).fill("Form site");
      await tab.getByTestId("form-save").click();
      await expect(tab.getByTestId("tab-jobs").getByTestId("job-row").filter({ hasText: "Form site" })).toBeVisible();
      expect(await readFile(file, "utf8")).toBe(hand.replace("name: Form web", "name: Form site"));

      // Delete while it runs: Runner stops it, waits for its end, then removes the file.
      await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
      await runner.tabs.openApp({ route: "edit/form-web", projectId: WORKSPACE_PROJECT_ID });
      await tab.getByTestId("form-delete").click();
      const confirm = tab.getByTestId("delete-confirm");
      await expect(confirm).toContainText("The service is running: Runner stops it first, then removes the file.");
      await shoot(page, "pomade-form-delete");
      await confirm.getByRole("button", { name: "Delete job" }).click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerDeleted Apps/pomade-runner/jobs/form-web.md · stopped first", { timeout: 15_000 });
      await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
      expect(running.output()).toContain("service form-web: Stop\n");
      expect(running.output()).toContain("job form-web: deleted, its service stopped first\n");
      expect((await sessionInfo(schedulerSocket(), "svc:form-web"))?.state).not.toBe("running");
      await expect(tab.getByTestId("tab-jobs").getByTestId("job-row").filter({ hasText: "Form site" })).toHaveCount(0);
    } finally {
      runner.close();
    }
  });

  test("a script job is disabled, run and deleted from its row in the Jobs view, and the file on disk matches after each step", async () => {
    const running = scheduler ?? (await startTheScheduler());
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const file = join(folders.workspace, "Apps/pomade-runner/jobs/row-script.md");
    const hand = scriptFile("Row script", "echo row-ok").replace("kind: script\n", "kind: script # by hand\n") + "Notes kept.\n";
    await writeFile(file, hand);
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
      const row = tab.locator('[data-testid="job-row"][data-job="row-script"]');
      await expect(row).toBeVisible({ timeout: 5000 });
      await expect(row.getByTestId("job-trigger")).toHaveText("when a project is created");
      await expect(row.getByTestId("job-status")).toHaveText("never ran");
      await expect(row.getByTestId("job-next")).toHaveText("on event");
      await shoot(page, "pomade-jobs-row");

      // Disable: the file says so, its comment and notes stay, the row dims.
      await row.getByRole("switch").click();
      await expect.poll(() => readFile(file, "utf8")).toMatch(/^enabled: false$/m);
      const disabled = await readFile(file, "utf8");
      expect(disabled).toContain("kind: script # by hand\n");
      expect(disabled.endsWith("Notes kept.\n")).toBe(true);
      expect(disabled.replace("enabled: false\n", "")).toBe(hand);
      await expect(row.getByTestId("job-next")).toHaveText("disabled");
      // A disabled job does not run, and the row says why.
      await row.getByRole("button", { name: "Run now" }).click();
      await expect(tab.getByTestId("toast").last()).toHaveText('RunnerCould not run Row script: "Row script" is disabled in its file; enable it first');
      expect(await history("row-script")).toEqual([]);

      // Enable and run: the run lands in History and the row's last result says done.
      await row.getByRole("switch").click();
      await expect.poll(() => readFile(file, "utf8")).not.toMatch(/^enabled: false$/m);
      expect(await readFile(file, "utf8")).toContain("Notes kept.\n");
      await expect(row.getByTestId("job-next")).toHaveText("on event");
      await row.getByRole("button", { name: "Run now" }).click();
      await expect(tab.getByTestId("toast").last()).toHaveText(/^RunnerRow script (started|queued)$/);
      await expect.poll(() => history("row-script")).toEqual([expect.objectContaining({ state: "done", exitCode: 0, trigger: "manual" }) as RunRecord]);
      await expect(row.getByTestId("job-status")).toHaveText("done");
      await expect(row.getByTestId("job-last-sub")).toHaveText(/^today \d+:\d\d · \d+s$/);
      await shoot(page, "pomade-jobs-row-done");

      // Delete: the confirm names the file, Cancel keeps it, Delete job removes it.
      await row.getByRole("button", { name: "Delete" }).click();
      const confirm = tab.getByTestId("delete-confirm");
      await expect(confirm.getByTestId("delete-path")).toHaveText("Apps/pomade-runner/jobs/row-script.md");
      await expect(confirm).toContainText("This can't be undone.");
      await confirm.getByRole("button", { name: "Cancel" }).click();
      expect(await readFile(file, "utf8")).toContain("Notes kept.\n");
      await row.getByRole("button", { name: "Delete" }).click();
      await confirm.getByRole("button", { name: "Delete job" }).click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerDeleted Apps/pomade-runner/jobs/row-script.md", { timeout: 15_000 });
      await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
      await expect(row).toHaveCount(0);
      expect(running.output()).toContain("job row-script: deleted\n");
    } finally {
      runner.close();
    }
  });
});
