// Runner hosted by a real Pomade: the Pomade checkout's built app (`POMADE_REPO`), in test mode on
// a temp workspace, user data and home, with the built `dist/` dev-linked for the run
// (`POMADE_DEV_APPS`). A test Pomade installs no login items, so the scheduler is started here the
// way the login item would start it: the same entry, Pomade's runtime, the environment HOST-API §2
// "Backends" names. `RUNNER_SHOTS=<dir>` saves screenshots of the panel and the tab.

import { mkdir, readFile } from "node:fs/promises";
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

  test("the Runner icon is on the strip and fills the side panel with the no-jobs state", async () => {
    const icon = page.getByTestId(`strip-${STRIP_KEY}`);
    await expect(icon).toBeVisible();
    await expect.poll(() => icon.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

    await icon.click();
    const panel = page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);
    await expect(panel.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await expect(panel.locator("html")).toHaveAttribute("data-surface", "panel");
    await shoot(page, "pomade-panel");
  });

  test("Open Runner opens the Runner tab with the no-jobs state", async () => {
    const panel = page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);
    await panel.getByRole("button", { name: "Open Runner" }).click();
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    await expect(tab.getByTestId("tab-empty").getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await expect(tab.getByTestId("version")).toHaveText(`Runner ${VERSION}`);
    await expect(panel.getByTestId("open-runner-error")).toHaveCount(0);
    await shoot(page, "pomade-tab");
  });

  test("pomade-runner is in Pomade's command folder and answers --version", async () => {
    await expect.poll(() => command("--version").catch(() => null)).toEqual({ code: 0, stdout: `pomade-runner ${VERSION}\nscheduler: not running\n`, stderr: "" });
    expect(await command("frobnicate")).toMatchObject({ code: 2, stdout: "" });
  });

  test("the scheduler, started as the login item starts it, connects to Pomade and outlives it", async () => {
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    const keyFile = join(folders.userData, "app-keys", manifest.id);
    scheduler = startSchedulerProcess(
      pomade.runtime,
      join(DIST, manifest.backend.entry),
      cleanEnv({
        ELECTRON_RUN_AS_NODE: "1",
        POMADE_APP_ID: manifest.id,
        POMADE_APP_KEY_FILE: keyFile,
        POMADE_CLIENT: "backend",
        POMADE_SOCKET: host.socket,
        POMADE_KEEPER_SOCKET: join(folders.userData, "run", "keepers", `${manifest.id}.sock`),
        POMADE_HOME: folders.home,
      }),
    );
    const running = scheduler;
    await expect.poll(() => running.output()).toContain("connected to Pomade");

    const version = await command("--version");
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(
      new RegExp(`^pomade-runner ${VERSION}\\nscheduler: running — ${VERSION}, pid ${running.child.pid}, since \\S+Z, connected to Pomade\\n$`),
    );

    await app?.close();
    app = null;
    await expect.poll(() => running.output()).toContain("Pomade went away; reconnecting");
    const socketPath = join(folders.userData, "app-state", manifest.id, "scheduler.sock");
    expect(await callScheduler(socketPath, "status")).toMatchObject({ status: "ok", value: { pid: running.child.pid, pomade: "disconnected" } });

    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
  });
});
