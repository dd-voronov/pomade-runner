// The UI in pomade-kit's fake host — the built page in an iframe, as Pomade hosts it — and on its
// own in a browser. `RUNNER_SHOTS=<dir>` saves a screenshot of every state in both colour schemes.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type FrameLocator, type Page } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { clockTime } from "../src/ui/serviceWords";
import { APP_PORT, HARNESS_PORT } from "./support/ports";

const APP = `http://localhost:${APP_PORT}/`;
const SHOTS = process.env.RUNNER_SHOTS;

function harness(query: Record<string, string> = {}): string {
  return `http://localhost:${HARNESS_PORT}/harness.html?${new URLSearchParams({ app: APP, ...query }).toString()}`;
}

function app(page: Page): FrameLocator {
  return page.frameLocator("iframe");
}

/** With `RUNNER_SHOTS`, save the page as `<name>-light.png` and `<name>-dark.png`. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: join(SHOTS, `${name}-${colorScheme}.png`) });
  }
}

test.describe("the side panel", () => {
  test.use({ viewport: { width: 240, height: 640 } });

  test("shows the no-jobs state, and Open Runner opens the Runner tab", async ({ page }) => {
    await page.goto(harness({ surface: "panel" }));
    const panel = app(page).getByTestId("panel-empty");
    await expect(panel.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await expect(panel).toContainText("Services and runs show here once Runner has jobs.");
    await expect(app(page).locator("html")).toHaveAttribute("data-surface", "panel");
    await shoot(page, "panel");

    await panel.getByRole("button", { name: "Open Runner" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: "" }]);
    await expect(app(page).getByTestId("open-runner-error")).toHaveCount(0);
  });
});

test.describe("the Runner tab", () => {
  test.use({ viewport: { width: 1040, height: 700 } });

  test("shows the no-jobs state and the version", async ({ page }) => {
    await page.goto(harness());
    const tab = app(page).getByTestId("tab-empty");
    await expect(tab.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await expect(tab).toContainText("Runner keeps services up");
    await expect(tab.getByTestId("version")).toHaveText(`Runner ${manifest.version}`);
    await expect(app(page).locator("html")).toHaveAttribute("data-surface", "tab");
    await shoot(page, "tab");
  });

  test("says so when Pomade speaks another Host API version", async ({ page }) => {
    await page.goto(harness({ hostApi: "1" }));
    const rejected = app(page).getByTestId("rejected");
    await expect(rejected.getByRole("heading", { name: "Runner needs an update" })).toBeVisible();
    await expect(rejected).toContainText("Update Runner: run ./install in its repo.");
    await shoot(page, "rejected");
  });
});

const VALID = "---\nkind: service\nname: Coda web\nproject: alpha\nfolder: Projects/alpha\ncommand: ./start.sh\n---\n";
const BROKEN = "---\nkind: script\nname: Weekly report\nfolder: .\ncommand: ./report.sh\nschedule:\n  weekly: { days: [fri], at: 25:00 }\n---\n";

/** Write a job file into the fake workspace, as an agent or the user would. */
async function writeJob(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(([p, t]) => window.fakeHost.writeFile(`Apps/pomade-runner/jobs/${p}`, t), [path, text] as const);
}

test.describe("the jobs list", () => {
  test.use({ viewport: { width: 1040, height: 700 } });

  test("a valid file appears within a second, a broken one shows its error, Open file opens it", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();

    await writeJob(page, "alpha/coda-web.md", VALID);
    const row = app(page).getByTestId("job-row");
    await expect(row).toHaveText(/Coda web\s*Service · Alpha/, { timeout: 1000 });

    await writeJob(page, "weekly-report.md", BROKEN);
    const invalid = app(page).getByTestId("job-invalid");
    await expect(invalid).toContainText('Invalid: line 7: schedule.weekly.at — "25:00" is not a time. Fix: write a time like 7:00 or 13:30 (H:MM, 24-hour).', { timeout: 1000 });
    await expect(app(page).getByTestId("tab-jobs")).toContainText("2 jobs · 1 invalid");
    await shoot(page, "tab-jobs");

    await invalid.getByRole("button", { name: "Open file" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: "Apps/pomade-runner/jobs/weekly-report.md" }]);

    await page.evaluate(() => window.fakeHost.deleteFile("Apps/pomade-runner/jobs/alpha/coda-web.md"));
    await expect(row).toHaveCount(0, { timeout: 1000 });
  });

  test("a service's row says where it stands: its state, restarts and last crash", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "alpha/coda-web.md", VALID);
    const state = app(page).getByTestId("service-state");
    await expect(state).toHaveText("Running");
    const crash = new Date(2026, 10, 17, 14, 2).getTime();
    await page.evaluate((at) => window.setServiceStatus("alpha/coda-web", { restarts: 3, lastCrashAt: at }), crash);
    await expect(state).toHaveText(`Running · restarted 3× · last crash ${clockTime(crash)}`);
    await shoot(page, "tab-service-restarted");
    await page.evaluate((at) => window.setServiceStatus("alpha/coda-web", { state: "failed", restarts: 4, lastCrashAt: at }), crash);
    await expect(state).toHaveText(`Failed: crashed 5 times in a minute · restarted 4× · last crash ${clockTime(crash)}`);
    await shoot(page, "tab-service-failed");
  });

  test("the panel lists the jobs above Open Runner", async ({ page }) => {
    await page.setViewportSize({ width: 240, height: 640 });
    await page.goto(harness({ surface: "panel" }));
    await expect(app(page).getByTestId("panel-empty")).toBeVisible();
    await writeJob(page, "alpha/coda-web.md", VALID);
    await writeJob(page, "weekly-report.md", BROKEN);
    const panel = app(page).getByTestId("panel-jobs");
    await expect(panel.getByTestId("job-row")).toContainText("Coda web");
    await expect(panel.getByTestId("job-invalid")).toContainText("Invalid: line 7: schedule.weekly.at");
    await expect(panel.getByRole("button", { name: "Open Runner" })).toBeVisible();
    await shoot(page, "panel-jobs");
  });

  test("says so when the scheduler does not answer", async ({ page }) => {
    await page.goto(harness({ scheduler: "none" }));
    const problem = app(page).getByTestId("tab-problem");
    await expect(problem.getByRole("heading", { name: "Runner's scheduler is not running" })).toBeVisible();
    await expect(problem.getByTestId("version")).toBeVisible();
    await shoot(page, "tab-no-scheduler");
  });
});

test.describe("outside Pomade", () => {
  test.use({ viewport: { width: 1040, height: 700 } });

  test("shows the no-host state", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(APP);
    const state = page.getByTestId("no-host");
    await expect(state.getByRole("heading", { name: "No Pomade host" })).toBeVisible();
    await expect(state).toContainText("Open it from the Runner icon on Pomade's left strip.");
    await expect(page.getByTestId("tab-empty")).toHaveCount(0);
    expect(errors).toEqual([]);
    await shoot(page, "no-host");
  });
});

test("the build serves its manifest and icon next to the page", async ({ request }) => {
  const served = await request.get(`${APP}manifest.json`);
  expect(await served.json()).toEqual(manifest);
  const icon = await request.get(`${APP}${manifest.icon}`);
  expect(icon.ok()).toBe(true);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
});
