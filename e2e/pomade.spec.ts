// Runner hosted by a real Pomade: the Pomade checkout's built app (`POMADE_REPO`), in test mode on
// a temp workspace, user data and home, with the built `dist/` dev-linked for the run
// (`POMADE_DEV_APPS`). A test Pomade installs no login items, so the scheduler is started here the
// way the login item would start it: the same entry, Pomade's runtime, the environment HOST-API §2
// "Backends" names; it finds the workspace through the pointer the test Pomade writes in its home.
// `RUNNER_SHOTS=<dir>` saves screenshots of the panel and the tab.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { STRIP_ICON } from "../src/app";
import { callScheduler } from "../src/scheduler/control/client";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
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

  /** `pomade-runner`, through the shim Pomade wrote into its command folder. */
  function command(...args: string[]) {
    return run(join(folders.home, "bin", "pomade-runner"), args, { env: cleanEnv(), cwd: tmp });
  }

  test.beforeAll(async () => {
    tmp = await tempDir();
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    await mkdir(join(folders.workspace, "Projects"), { recursive: true });
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
    await removeDir(tmp);
  });

  const VALID = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
  const BROKEN = VALID.replace("13:00", "25:00");
  const ERROR = 'schedule.daily.at — "25:00" is not a time. Fix: write a time like 7:00 or 13:30 (H:MM, 24-hour).';

  function panel() {
    return page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);
  }

  /** The scheduler, started the way the login item starts it: Pomade's runtime, the backend environment. */
  async function startTheScheduler(): Promise<SchedulerProcess> {
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
        POMADE_KEEPER_SOCKET: join(folders.userData, "run", "keepers", `${manifest.id}.sock`),
        POMADE_HOME: folders.home,
      }),
    );
    scheduler = started;
    await expect.poll(() => started.output()).toContain("connected to Pomade");
    return started;
  }

  test("the Runner icon is on the strip and fills the side panel; with no scheduler yet, the panel says so", async () => {
    const icon = page.getByTestId(`strip-${STRIP_KEY}`);
    await expect(icon).toBeVisible();
    await expect.poll(() => icon.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

    await icon.click();
    await expect(panel().getByRole("heading", { name: "Runner's scheduler is not running" })).toBeVisible();
    await expect(panel().locator("html")).toHaveAttribute("data-surface", "panel");
  });

  test("once the scheduler connects, the panel shows the no-jobs state", async () => {
    await startTheScheduler();
    await expect(panel().getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await shoot(page, "pomade-panel");
  });

  test("a job file written to disk shows in the panel within a second; a broken one shows its error, as pomade-runner check prints it", async () => {
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "backup.md"), VALID);
    await expect(panel().getByTestId("job-row")).toContainText("Backup", { timeout: 1000 });

    await writeFile(join(jobs, "backup.md"), BROKEN);
    await expect(panel().getByTestId("job-invalid")).toContainText(`Invalid: line 7: ${ERROR}`, { timeout: 1000 });
    await shoot(page, "pomade-panel-jobs");

    const check = await command("check");
    expect(check.code).toBe(1);
    expect(check.stdout).toContain(`Apps/pomade-runner/jobs/backup.md:7: ${ERROR}\n`);
    expect(check.stdout).not.toContain("not checked");
    expect(await command("projects")).toEqual({ code: 0, stdout: "Pomade has no projects.\n", stderr: "" });

    await writeFile(join(jobs, "backup.md"), VALID);
    await expect(panel().getByTestId("job-row")).toContainText("Backup", { timeout: 1000 });
  });

  test("Open Runner opens the Runner tab with the jobs", async () => {
    await panel().getByRole("button", { name: "Open Runner" }).click();
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    await expect(tab.getByTestId("tab-jobs").getByTestId("job-row")).toContainText("Backup");
    await expect(tab.getByTestId("version")).toHaveText(`Runner ${VERSION}`);
    await expect(panel().getByTestId("open-runner-error")).toHaveCount(0);
    await shoot(page, "pomade-tab");
  });

  test("pomade-runner is in Pomade's command folder and answers --version", async () => {
    const version = await command("--version");
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(new RegExp(`^pomade-runner ${VERSION}\\nscheduler: running — ${VERSION}, pid \\d+, since \\S+Z, connected to Pomade\\n$`));
    expect(await command("frobnicate")).toMatchObject({ code: 2, stdout: "" });
  });

  test("the scheduler outlives Pomade", async () => {
    const running = scheduler ?? (await startTheScheduler());
    await app?.close();
    app = null;
    await expect.poll(() => running.output()).toContain("Pomade went away; reconnecting");
    const socketPath = join(folders.userData, "app-state", manifest.id, "scheduler.sock");
    expect(await callScheduler(socketPath, "status")).toMatchObject({ status: "ok", value: { pid: running.child.pid, pomade: "disconnected" } });

    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
  });
});
