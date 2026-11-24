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
import { drawn } from "./support/frames";
import { blankSchedule, type ScheduleValues } from "../src/ui/form/schedule";
import { newForm, setFolder, setValue, switchKind, wouldBe } from "../src/ui/form/state";
import { runningSession, sessionInfo, sessionsReport, expectNothingLeft, stopKeeper } from "./support/keeper";
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
    await expectNothingLeft(tmp);
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

  /** The switch's position as the scheduler holds it; `null` when it does not answer. */
  async function position(): Promise<string | null> {
    const answer = await callScheduler(schedulerSocket(), "switch", { position: null });
    return answer.status === "ok" ? answer.value.position : null;
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
    const frame = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const card = frame.getByTestId("run-card");
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(frame.getByTestId("run-dialog")).toHaveAttribute("data-tone", "danger");
    await expect(frame.getByTestId("run-result")).toHaveText("Failed");
    await expect(card.getByTestId("run-exit")).toHaveText("3");
    await expect(card.getByTestId("run-last-lines")).toHaveText("working\nboom");
    await shoot(page, "pomade-run-card");
    // Opening the result resolved the item: the badge goes.
    await expect(badge()).toHaveCount(0);
    expect(await runnerNotices()).toEqual(["Fail failed"]);
  });

  test("a failed run is a card in the panel's Needs you, counted by the badge; Open shows its red result card, which clears the card and the badge", async () => {
    const running = scheduler ?? (await startTheScheduler());
    expect((await command("run", "fail")).code).toBe(0);
    await expect.poll(async () => (await history("fail")).length).toBe(2);
    await expect(badge()).toHaveText("1");
    // The Notices panel is open since the test before: the Runner icon brings Runner's back.
    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
    const item = panel().locator('[data-testid="needs-you-item"][data-kind="run-failed"]');
    await expect(item).toHaveCount(1);
    await expect(item.getByRole("button", { name: "Fail" })).toBeVisible();
    await expect(item.getByTestId("needs-you-words")).toHaveText("Failed: exit 3");
    await expect(panel().getByTestId("section-needs-you-head-count")).toHaveText("1");
    await shoot(page, "pomade-panel-needs-you");

    const card = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`).getByTestId("run-card");
    await drawn(page);
    await item.getByRole("button", { name: "Open", exact: true }).click();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`).getByTestId("run-result")).toHaveText("Failed");
    await expect(card.getByTestId("run-exit")).toHaveText("3");
    await expect(badge()).toHaveCount(0);
    await expect(item).toHaveCount(0);
    await expect(panel().getByTestId("section-needs-you-head-count")).toHaveText("0");
    expect(running.output()).toContain("needs you: fail failed");
  });

  /** Runner's keyed tabs in the Workspace scope — a run's output tab — as Pomade's tab strip keeps them. */
  function outputTabs(): Promise<{ id: string; key: string; tabKind: string; route: string }[]> {
    return page.evaluate((project) => {
      const stores = (window as unknown as { __pomadeStores: { useTabsStore: { getState(): { tabsByProject: Record<string, { id: string; kind: string; appId?: string; key?: string; tabKind?: string; route?: string }[] | undefined> } } } }).__pomadeStores;
      return (stores.useTabsStore.getState().tabsByProject[project] ?? [])
        .filter((tab) => tab.kind === "app" && tab.key !== undefined)
        .map((tab) => ({ id: tab.id, key: tab.key ?? "", tabKind: tab.tabKind ?? "", route: tab.route ?? "" }));
    }, WORKSPACE_PROJECT_ID);
  }

  test("T-008 · View output opens the run's own output tab beside the Runner tab, titled “Fail · output”; its Copy puts the log on the system clipboard", async () => {
    const [latest] = await history("fail");
    const run = latest?.run ?? "";
    const dialog = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`).getByTestId("run-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "View output" }).click();
    await expect.poll(() => outputTabs()).toEqual([{ id: expect.any(String) as unknown as string, key: `out:fail:${run}`, tabKind: "output", route: `output/fail/${run}` }]);
    const [tab] = await outputTabs();
    const id = tab?.id ?? "";
    await expect(page.getByTestId(`tab-title-${id}`)).toHaveText("Fail · output");
    const output = page.frameLocator(`[data-testid="app-pane-${id}"] iframe`);
    await expect(output.getByTestId("run-output-text")).toHaveText("working\nboom");
    await expect(output.getByTestId("run-output-badge")).toContainText("Captured log · today");
    await shoot(page, "pomade-output-tab");

    // The Owner's clipboard is put back after.
    const before = await app?.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await drawn(page);
      await output.getByTestId("run-output-copy").click();
      await expect(output.getByTestId("toast")).toHaveText("RunnerCopied the log");
      expect(await app?.evaluate(({ clipboard }) => clipboard.readText())).toBe("working\nboom\n");
    } finally {
      await app?.evaluate(({ clipboard }, text) => clipboard.writeText(text), before ?? "");
    }
    // Closed, so the specs after find the one Runner tab frame.
    await page.getByTestId(`close-${id}`).click();
    await expect.poll(() => outputTabs()).toEqual([]);
  });

  test("T-008 · a card closed in the Runner tab is recorded, so the same notice clicked again opens it again", async () => {
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const dialog = tab.getByTestId("run-dialog");
    const notice = async (): Promise<void> => {
      await runnerNotices();
      await page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"]').first().click();
    };
    await notice();
    await expect(dialog).toBeVisible();
    await drawn(page);
    await dialog.getByRole("button", { name: "Close (Esc)" }).click();
    await expect(dialog).toHaveCount(0);
    await notice();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("run-result")).toHaveText("Failed");
  });

  // A closed terminal (its keeper gone) ends it: `read` then fails at once, where a second without
  // input takes a second (bash 3.2 gives both status 1, so the clock tells them apart).
  const TICKER = 'i=0; while :; do i=$((i+1)); echo "tick $i"; t=$SECONDS; if read -t 1 line; then echo "got: $line"; elif [ $SECONDS -eq $t ]; then exit 0; fi; done';

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
      await drawn(page);
      await row.click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
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
      await expect(tab.getByTestId("toast").last()).toHaveText(/^RunnerRow script (started|queued) · trigger “manual”$/);
      await expect.poll(() => history("row-script")).toEqual([expect.objectContaining({ state: "done", exitCode: 0, trigger: "manual" }) as RunRecord]);
      await expect(row.getByTestId("job-status")).toHaveText("done");
      await expect(row.getByTestId("job-last-sub")).toHaveText(/^today \d+:\d\d · \d+s · manual$/);
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

  test("a script made in the job form on a near schedule runs; pomade-runner check accepts the file the form writes for every schedule shape", async () => {
    test.setTimeout(150_000);
    scheduler ??= await startTheScheduler();
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
      await runner.tabs.openApp({ route: "new", projectId: WORKSPACE_PROJECT_ID });
      await tab.getByTestId("kind-script").click();
      const form = tab.getByTestId("form-script");
      await form.getByRole("textbox", { name: "Name", exact: true }).fill("Form tick");
      await form.getByRole("textbox", { name: "Command", exact: true }).fill("echo form-tick");
      await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
      await form.getByTestId("schedule-shape").getByRole("button", { name: "Every…" }).click();
      await form.getByRole("textbox", { name: "Interval" }).fill("1");
      await expect(form.getByTestId("schedule-in-words")).toHaveText("Runs every minute");
      await shoot(page, "pomade-form-script");
      await tab.getByTestId("form-save").click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerCreated Apps/pomade-runner/jobs/form-tick.md");
      expect(await readFile(join(jobs, "form-tick.md"), "utf8")).toBe("---\nkind: script\nname: Form tick\nfolder: .\nenabled: true\ncommand: echo form-tick\nschedule:\n  every: { minutes: 1 }\n---\n");
      // Within the next minute the scheduler runs it, on schedule.
      await expect.poll(() => history("form-tick"), { timeout: 100_000 }).toEqual([expect.objectContaining({ state: "done", trigger: "scheduled" }) as RunRecord]);
      // Off again: it runs no more in the rest of the run.
      await writeFile(join(jobs, "form-tick.md"), (await readFile(join(jobs, "form-tick.md"), "utf8")).replace("enabled: true", "enabled: false"));
    } finally {
      runner.close();
    }

    // Every shape, as the form writes it (its own writer, `wouldBe`), checked by the built command.
    const base = setFolder(setValue(setValue(switchKind(newForm("service"), "script"), "name", "Shape"), "command", "./shape.sh"), ".", []);
    const shapes: Record<string, Partial<ScheduleValues>> = {
      once: { shape: "once", onceDate: "2027-01-05", onceTime: "23:00" },
      every: { shape: "every", every: "30", within: true, from: "9:00", to: "19:00", filter: "weekdays" },
      "every-hours": { shape: "every", every: "2", unit: "hours", filter: "weekends" },
      daily: { shape: "daily", times: ["13:00", "20:00"], filter: "weekdays" },
      weekly: { shape: "weekly", days: ["mon", "sat"], times: ["7:00"] },
      monthly: { shape: "monthly", monthDays: [15, "last", { nth: 1, weekday: "mon" }, { nth: "last", weekday: "fri" }], times: ["9:00", "18:00"] },
    };
    // Disabled: checked, never run.
    const paths: string[] = [];
    for (const [slug, schedule] of Object.entries(shapes)) {
      const state = setValue(setValue(setValue(base, "name", `Shape ${slug}`), "enabled", false), "schedule", { ...blankSchedule(), ...schedule });
      const path = join(jobs, `shape-${slug}.md`);
      await writeFile(path, wouldBe(state, { workspace: folders.workspace, projectsChecked: false, jobs: [] }, []).text);
      paths.push(path);
    }
    const checked = await command("check", ...paths);
    expect(checked).toEqual({ code: 0, stdout: "6 job files: no problems.\n", stderr: "" });
  });

  test("T-009 policies: a script made in the form with a missed-run policy and a 1-minute time limit — both in its file, the limit enforced by the scheduler", async () => {
    test.setTimeout(150_000);
    const running = scheduler ?? (await startTheScheduler());
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const file = join(folders.workspace, "Apps/pomade-runner/jobs/form-limit.md");
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
      await runner.tabs.openApp({ route: "new", projectId: WORKSPACE_PROJECT_ID });
      await tab.getByTestId("kind-script").click();
      const form = tab.getByTestId("form-script");
      await form.getByRole("textbox", { name: "Name", exact: true }).fill("Form limit");
      await form.getByRole("textbox", { name: "Command", exact: true }).fill("echo limited; sleep 300");
      await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
      // A schedule that never fires during the test; Run now starts it.
      await form.getByTestId("schedule-shape").getByRole("button", { name: "Once" }).click();
      await form.getByRole("textbox", { name: "Or say it in words" }).fill("2037-01-05 23:00");
      const policies = form.getByTestId("form-policies");
      await policies.getByRole("button", { name: "Change" }).click();
      await policies.getByRole("group", { name: "If a run is missed" }).getByRole("button", { name: "Wait for me" }).click();
      await policies.getByRole("textbox", { name: "Time limit" }).fill("1m");
      await shoot(page, "pomade-form-policies");
      await tab.getByTestId("form-save").click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerCreated Apps/pomade-runner/jobs/form-limit.md");
      expect(await readFile(file, "utf8")).toBe("---\nkind: script\nname: Form limit\nfolder: .\nenabled: true\ncommand: echo limited; sleep 300\nschedule:\n  once: 2037-01-05 23:00\nmissed: wait-for-me\ntime-limit: 1m\n---\n");
      expect(await command("check", file)).toEqual({ code: 0, stdout: "1 job file: no problems.\n", stderr: "" });
      await expect.poll(async () => (await command("list")).stdout).toContain("Form limit");
      // The scheduler took the file as the form wrote it: the limit stops a run of it.
      expect((await command("run", "form-limit")).code).toBe(0);
      await expect.poll(async () => (await history("form-limit")).map((record) => [record.state, record.trigger, record.reason?.includes("1 min")]), { timeout: 110_000 }).toEqual([["failed", "manual", true]]);
      expect(running.output()).toMatch(/run form-limit \S+: ran over its time limit of 1 min; stopping it\n/);
    } finally {
      runner.close();
    }
  });

  test("a running script is a Running now row in the panel; a click opens its terminal, with the run's output", async () => {
    scheduler ??= await startTheScheduler();
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/slow.md"), scriptFile("Slow", "echo slow-start; sleep 600"));
    await expect.poll(async () => (await command("list")).stdout).toContain("Slow");
    expect((await command("run", "slow")).code).toBe(0);
    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
    const row = panel().getByTestId("active-run").filter({ hasText: "Slow" });
    await expect(row).toHaveAttribute("data-state", "running");
    await expect(row).toContainText("running");
    await shoot(page, "pomade-panel-running-run");
    await drawn(page);
    await row.click();
    await expect.poll(() => attachedTabIds()).toHaveLength(1);
    const [id = ""] = await attachedTabIds();
    await expect(page.getByTestId(`tab-title-${id}`)).toHaveText("Slow · Runner");
    await expect.poll(() => buffer(id)).toContain("slow-start");
    await page.getByTestId(`close-${id}`).click();
    await expect.poll(() => attachedTabIds()).toHaveLength(0);
    // Closing the tab only detaches: the run goes on.
    await expect(row).toHaveAttribute("data-state", "running");
  });

  test("T-034 · a script that sleeps: Run now on its row adds Open terminal and Stop run; Open terminal opens the run's tab; Stop run ends it as stopped by you, History says so, and both icons leave the row", async () => {
    const running = scheduler ?? (await startTheScheduler());
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    await mkdir(join(folders.workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/row-stop.md"), scriptFile("Row stop", "echo row-stop-start; sleep 600"));
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
      const row = tab.locator('[data-testid="job-row"][data-job="row-stop"]');
      const icons = () => row.locator("button:not([role])").evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")));
      await expect(row).toBeVisible({ timeout: 5000 });
      expect(await icons()).toEqual(["Run now", "Edit", "Delete"]);
      const edit = row.getByRole("button", { name: "Edit" });
      const left = await edit.evaluate((b) => b.getBoundingClientRect().left);
      await row.getByRole("button", { name: "Run now" }).click();
      await expect.poll(icons).toEqual(["Open terminal", "Stop run", "Run now", "Edit", "Delete"]);
      expect(await edit.evaluate((b) => b.getBoundingClientRect().left)).toBe(left);
      await shoot(page, "pomade-jobs-row-running");

      await row.getByRole("button", { name: "Open terminal" }).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
      const [id = ""] = await attachedTabIds();
      await expect(page.getByTestId(`tab-title-${id}`)).toHaveText("Row stop · Runner");
      await expect.poll(() => buffer(id)).toContain("row-stop-start");
      await page.getByTestId(`close-${id}`).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(0);
      await expect(row.getByTestId("job-status")).toHaveText("running");

      await row.getByRole("button", { name: "Stop run" }).click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerRow stop stopped by you");
      await expect.poll(() => history("row-stop")).toEqual([expect.objectContaining({ state: "stopped-by-you", trigger: "manual" }) as RunRecord]);
      await expect.poll(icons).toEqual(["Run now", "Edit", "Delete"]);
      expect(await edit.evaluate((b) => b.getBoundingClientRect().left)).toBe(left);
      await expect(row.getByTestId("job-status")).toHaveText("stopped by you");
      expect(running.output()).not.toContain("row-stop: error");
    } finally {
      runner.close();
    }
  });

  test("T-009 · a setting stepped in Settings reaches settings.yaml, comments kept, and applies with no restart; the read-only rows follow the Mac", async () => {
    const running = scheduler ?? (await startTheScheduler());
    const file = join(folders.workspace, "Apps/pomade-runner/settings.yaml");
    await mkdir(join(folders.workspace, "Apps/pomade-runner"), { recursive: true });
    await writeFile(file, "# mine\nhistory-days: 30  # a month\n");
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "settings", projectId: WORKSPACE_PROJECT_ID });
      const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
      await expect(tab.getByTestId("setting-history-days-stepper-value")).toHaveText("30");
      await drawn(page);
      await tab.getByTestId("setting-history-days-stepper-more").click();
      await expect.poll(() => readFile(file, "utf8")).toBe("# mine\nhistory-days: 31  # a month\n");
      await expect.poll(() => running.output()).toContain("history 31 days");
      await tab.getByTestId("setting-warm-up-stepper-less").click();
      await expect.poll(() => readFile(file, "utf8")).toBe("# mine\nhistory-days: 31  # a month\nwarm-up: 1m\n");
      await expect.poll(() => running.output()).toContain("warm-up 1 min");
      await expect(tab.getByTestId("setting-warm-up-stepper-value")).toHaveText("1");
      expect((await command("check", file)).stdout).toMatch(/^0 job files and \S*settings\.yaml: no problems\.\n$/);

      // The Mac: no native notifications yet; the scheduler put its build's skill into the default
      // skills folder at its start.
      await expect(tab.getByTestId("notifications-status")).toHaveText("Not available yet");
      await expect(tab.getByTestId("skill-status")).toHaveText("In place");
      await expect(tab.getByTestId("setting-skill")).toContainText("Knowledge/_skills/apps/pomade-runner-jobs/SKILL.md");
      expect(await readFile(join(folders.workspace, "Knowledge/_skills/apps/pomade-runner-jobs/SKILL.md"), "utf8")).toBe(
        await readFile(join(DIST, "skills/pomade-runner-jobs/SKILL.md"), "utf8"),
      );
      await expect(tab.getByTestId("setting-skills-folder-input")).toHaveValue("Knowledge/_skills/apps/");
      await shoot(page, "pomade-settings");
    } finally {
      runner.close();
    }
  });

  test("T-009 · Settings' Show in Files shows the jobs folder in Pomade's Files panel, selected", async () => {
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "settings", projectId: WORKSPACE_PROJECT_ID });
      const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
      const button = tab.getByTestId("setting-jobs-folder").getByRole("button", { name: "Show in Files" });
      await expect(button).toBeVisible();
      await drawn(page);
      await button.click();
      await expect(page.getByTestId("side-panel-files")).toBeVisible();
      const jobs = page.getByTestId("tree-node-Apps/pomade-runner/jobs");
      await expect(jobs).toHaveAttribute("data-selected", "true");
      await expect(jobs).toBeInViewport();
      await shoot(page, "pomade-settings-show-in-files");
    } finally {
      runner.close();
    }
  });

  test("T-009 · the panel's switch holds scheduled runs while it is on Pause all, and Running lets them go", async () => {
    test.setTimeout(150_000);
    const running = scheduler ?? (await startTheScheduler());
    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
    await drawn(page);
    const press = async (name: string, expected: string): Promise<void> => {
      await panel().getByTestId(name).click();
      await expect.poll(() => position()).toBe(expected);
    };
    await press("switch-pause-all", "pause-all");
    await expect(panel().getByTestId("switch")).toHaveAttribute("data-position", "pause-all");
    await expect(panel().getByTestId("switch-note")).toHaveText("Every scheduled job is held. Services keep running.");
    await shoot(page, "pomade-switch-all");

    await mkdir(join(folders.workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/held-tick.md"), "---\nkind: script\nname: Held tick\nfolder: .\ncommand: echo held-tick\nschedule:\n  every: { minutes: 1 }\n---\n");
    await expect.poll(() => running.output()).toContain("job files, 0 invalid\n");
    const created = Date.now();
    // A whole minute passes, so the schedule fires at least once: nothing starts.
    await expect.poll(() => Date.now() - created, { timeout: 90_000, intervals: [1000] }).toBeGreaterThan(65_000);
    expect(await history("held-tick")).toEqual([]);

    await press("switch-running", "running");
    await expect(panel().getByTestId("switch")).toHaveAttribute("data-position", "running");
    await expect(panel().getByTestId("switch-note")).toHaveCount(0);
    // The held occurrence comes due on release: it runs.
    await expect.poll(() => history("held-tick"), { timeout: 70_000 }).toEqual(expect.arrayContaining([expect.objectContaining({ state: "done" }) as RunRecord]));
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/held-tick.md"), "---\nkind: script\nname: Held tick\nfolder: .\ncommand: echo held-tick\nenabled: false\nschedule:\n  every: { minutes: 1 }\n---\n");
  });

  /** New job → Script in the Runner tab, its name, command and folder typed, its trigger When
   *  something happens; the tab's frame. */
  async function newHookScript(runner: HostClient, name: string, command: string): Promise<ReturnType<Page["frameLocator"]>> {
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
    await runner.tabs.openApp({ route: "new", projectId: WORKSPACE_PROJECT_ID });
    await tab.getByTestId("kind-script").click();
    const form = tab.getByTestId("form-script");
    await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await form.getByRole("textbox", { name: "Command", exact: true }).fill(command);
    await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
    await form.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    return tab;
  }

  test("T-010 · a chain made in the job form fires as a hand-written one does: its parent's run starts it; History says chain: after Parent, and its card opens the parent's run", async () => {
    scheduler ??= await startTheScheduler();
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "parent.md"), scriptFile("Parent", "echo parent"));
    await expect.poll(async () => (await command("list")).stdout).toContain("Parent");
    const runner = await connectAsRunner();
    try {
      const tab = await newHookScript(runner, "Follower", 'echo "after $POMADE_PARENT_JOB $POMADE_PARENT_RESULT"');
      await tab.getByTestId("hook-event").selectOption({ label: "Another job finished" });
      await tab.getByTestId("chain-job").selectOption({ label: "Parent" });
      await expect(tab.getByTestId("hook-words")).toHaveText("Runs after Parent is doneA chain. History will show “chain: after Parent”.");
      await shoot(page, "pomade-form-chain");
      await tab.getByTestId("form-save").click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerCreated Apps/pomade-runner/jobs/follower.md");
      const file = join(jobs, "follower.md");
      expect(await readFile(file, "utf8")).toBe('---\nkind: script\nname: Follower\nfolder: .\nenabled: true\ncommand: echo "after $POMADE_PARENT_JOB $POMADE_PARENT_RESULT"\nafter: { job: parent, result: done }\n---\n');
      expect(await command("check", file)).toEqual({ code: 0, stdout: "1 job file: no problems.\n", stderr: "" });
      await expect.poll(async () => (await command("list")).stdout).toContain("Follower");

      expect((await command("run", "parent")).code).toBe(0);
      await expect.poll(() => history("follower"), { timeout: 15_000 }).toEqual([
        expect.objectContaining({ state: "done", trigger: "chain", cause: expect.objectContaining({ kind: "chain", job: "parent", name: "Parent", result: "done" }) as unknown, lastLines: ["after parent done"] }) as RunRecord,
      ]);

      await runner.tabs.openApp({ route: "history", projectId: WORKSPACE_PROJECT_ID });
      const row = tab.locator('[data-testid="history-row"][data-job="follower"]');
      await expect(row.getByTestId("history-trigger")).toHaveText("chain: after Parent");
      const dialog = tab.getByTestId("run-dialog");
      await drawn(page);
      await row.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("run-trigger")).toHaveText("chain");
      await shoot(page, "pomade-chain-card");
      await dialog.getByRole("button", { name: "Open Parent's run" }).click();
      await expect(dialog.getByTestId("run-trigger")).toHaveText("manual");
      await expect(dialog.getByTestId("run-last-lines")).toHaveText("parent");
    } finally {
      runner.close();
    }
  });

  test("T-010 · the loop guard pauses a chained job fired more than 10 times in 10 min; Resume in the panel's Needs you clears its card — which has no Dismiss — and the chain fires it again", async () => {
    test.setTimeout(150_000);
    const running = scheduler ?? (await startTheScheduler());
    // Follower fired once in the test before: ten more firings run it, the eleventh pauses it.
    for (let firing = 2; firing <= 10; firing++) {
      expect((await command("run", "parent")).code).toBe(0);
      await expect.poll(async () => (await history("follower")).length, { timeout: 15_000 }).toBe(firing);
    }
    expect((await command("run", "parent")).code).toBe(0);
    await expect.poll(async () => (await history("parent")).length, { timeout: 15_000 }).toBe(11);
    await expect.poll(() => running.output(), { timeout: 15_000 }).toContain("job follower: fired more than 10 times in 10 min by hooks or chains — looks like a loop; paused until Resume\n");
    expect(await history("follower")).toHaveLength(10);

    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
    const item = panel().locator('[data-testid="needs-you-item"][data-kind="loop-paused"]');
    await expect(item.getByRole("button", { name: "Follower" })).toBeVisible();
    await expect(item.getByTestId("needs-you-words")).toHaveText("Paused: triggered 10× in 10 min.");
    await expect(item.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
    await shoot(page, "pomade-panel-loop-paused");
    await drawn(page);
    await item.getByRole("button", { name: "Resume" }).click();
    await expect(item).toHaveCount(0);
    expect((await command("runs")).stdout).not.toContain("needs you: Follower");
    expect(running.output()).toContain("job follower: Resume — hooks and chains fire it again\n");

    expect((await command("run", "parent")).code).toBe(0);
    await expect.poll(async () => (await history("follower")).length, { timeout: 15_000 }).toBe(11);
  });

  test("T-010 · a login hook made in the job form runs at the next Mac login, as a hand-written one does", async () => {
    test.setTimeout(120_000);
    scheduler ??= await startTheScheduler();
    await mkdir(join(folders.workspace, "Apps/pomade-runner"), { recursive: true });
    await writeFile(join(folders.workspace, "Apps/pomade-runner/settings.yaml"), "warm-up: 0m\n");
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    const runner = await connectAsRunner();
    try {
      const tab = await newHookScript(runner, "Form mount", 'echo "mounted $POMADE_TRIGGER"');
      await expect(tab.getByTestId("hook-event")).toHaveValue("login");
      await expect(tab.getByTestId("hook-words")).toHaveText("Runs at Mac loginOnce per login, once the services are up.");
      await shoot(page, "pomade-form-login");
      await tab.getByTestId("form-save").click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerCreated Apps/pomade-runner/jobs/form-mount.md");
    } finally {
      runner.close();
    }
    expect(await readFile(join(jobs, "form-mount.md"), "utf8")).toBe('---\nkind: script\nname: Form mount\nfolder: .\nenabled: true\ncommand: echo "mounted $POMADE_TRIGGER"\nhook: { event: login }\n---\n');
    await expect.poll(async () => (await command("list")).stdout).toContain("Form mount");
    expect(await history("form-mount")).toEqual([]);

    // A login: macOS ends the keeper with the user's processes; the login item starts the scheduler.
    pids.push(...(await sessionsReport(schedulerSocket())).sessions.map((session) => session.info.pid ?? 0));
    await scheduler.kill();
    await stopKeeper(keeperSocket, pids.splice(0));
    const next = await startTheScheduler();
    await expect.poll(() => next.output()).toContain("login: no keeper was running");
    await expect.poll(() => history("form-mount"), { timeout: 30_000 }).toEqual([
      expect.objectContaining({ state: "done", trigger: "hook", cause: { kind: "hook", event: "login", context: {} }, lastLines: ["mounted hook"] }) as RunRecord,
    ]);
    expect((await command("history", "form-mount")).stdout).toMatch(/^form-mount {2}Form mount {2}hook: Mac login {2}done, /);
  });
});
