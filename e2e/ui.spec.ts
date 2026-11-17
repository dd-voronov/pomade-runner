// The UI in pomade-kit's fake host — the built page in an iframe, as Pomade hosts it — and on its
// own in a browser. `RUNNER_SHOTS=<dir>` saves a screenshot of every state in both colour schemes.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type FrameLocator, type Page } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import type { ActiveRun, NeedsYouItem, RunRecord, RunsReport } from "../src/scheduler/model";
import { clockTime } from "../src/scheduler/model";
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

test.describe("runs", () => {
  const SCRIPT = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
  const RUN = "20261117-120000-abcdef";
  const at = (hours: number, minutes: number): number => new Date(2026, 10, 17, hours, minutes).getTime();
  const failed: RunRecord = {
    job: "backup",
    name: "Backup",
    kind: "script",
    project: null,
    folder: "",
    run: RUN,
    trigger: "scheduled",
    dueAt: at(13, 0),
    state: "failed",
    reason: null,
    startedAt: at(13, 0),
    endedAt: at(13, 0) + 3000,
    durationMs: 3000,
    exitCode: 2,
    signal: null,
    log: "/ud/output/backup/r.log",
    lastLines: ["copying", "rsync: connection refused"],
  };
  const item: NeedsYouItem = { id: "run-failed:backup", kind: "run-failed", job: "backup", name: "Backup", project: null, run: RUN, at: failed.endedAt, count: 2, detail: "exit 2" };
  const report = (now: number): RunsReport => ({
    active: [],
    nextUp: [{ job: "backup", name: "Backup", project: null, at: now + 40 * 60_000 + 30_000 }],
    jobs: [{ job: "backup", next: now + 40 * 60_000, finished: false, last: failed }],
    needsYou: [item, { id: "service-failed:web", kind: "service-failed", job: "web", name: "Web", project: null, at: at(12, 0), detail: "crashed 5 times within a minute" }],
    switch: { position: "running", since: null },
  });

  async function setRuns(page: Page, history: RunRecord[]): Promise<void> {
    await page.waitForFunction(() => typeof window.setRuns === "function");
    const now = await page.evaluate(() => Date.now());
    await page.evaluate(([r, h]) => window.setRuns({ report: r, history: h, output: "\x1b[32mcopying\x1b[0m\r\nrsync: connection refused\r\n" }), [report(now), history] as const);
  }

  test("the panel shows Needs you with each item's actions, and Next up", async ({ page }) => {
    await page.setViewportSize({ width: 240, height: 640 });
    await page.goto(harness({ surface: "panel" }));
    await expect(app(page).getByTestId("panel-empty")).toBeVisible();
    await writeJob(page, "backup.md", SCRIPT);
    await expect(app(page).getByTestId("panel-jobs")).toBeVisible();
    await expect(app(page).getByTestId("needs-you")).toContainText("Nothing needs you.");
    await expect(app(page).getByTestId("next-up")).toContainText("Nothing is scheduled.");
    await setRuns(page, [failed]);
    const items = app(page).getByTestId("needs-you-item");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText("Failed: exit 2 · 2×");
    await expect(items.last()).toContainText("Gave up: crashed 5 times within a minute");
    await expect(app(page).getByTestId("next-up-item")).toHaveText(/in 4[01] min\s*Backup/);
    await expect(app(page).getByTestId("job-runs")).toContainText("daily at 13:00 · next");
    await expect(app(page).getByTestId("job-runs")).toContainText("last failed · exit 2");
    await shoot(page, "panel-runs");

    await items.first().getByRole("button", { name: "Open" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: `run/backup/${RUN}` }]);
    await items.first().getByRole("button", { name: "Run now" }).click();
    await items.last().getByRole("button", { name: "Start" }).click();
    await items.first().getByRole("button", { name: "Dismiss" }).click();
    await expect(items).toHaveCount(1);
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "jobs.run", params: { job: "backup" } },
      { method: "services.start", params: { job: "web" } },
      { method: "needsYou.dismiss", params: { id: "run-failed:backup" } },
    ]);
  });

  test("a job row runs a script now, disables and enables it", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "backup.md", SCRIPT);
    const row = app(page).getByTestId("job-row");
    await row.getByRole("button", { name: "Run now" }).click();
    await row.getByRole("button", { name: "Disable" }).click();
    await writeJob(page, "backup.md", SCRIPT.replace("folder: .\n", "folder: .\nenabled: false\n"));
    await row.getByRole("button", { name: "Enable" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "jobs.run", params: { job: "backup" } },
      { method: "jobs.setEnabled", params: { job: "backup", enabled: false } },
      { method: "jobs.setEnabled", params: { job: "backup", enabled: true } },
    ]);
    await expect(row.getByTestId("job-runs")).toContainText("disabled · never ran");
  });

  test("History lists the runs; a row opens the result card: red, the exit code and the last lines; View output shows the whole output", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "backup.md", SCRIPT);
    await setRuns(page, [failed, { ...failed, run: "20261117-110000-abcdef", state: "done", exitCode: 0, lastLines: [], endedAt: at(12, 0) }]);
    await app(page).getByTestId("nav-history").click();
    const rows = app(page).getByTestId("history-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Backup");
    await expect(rows.first()).toContainText("failed · exit 2");
    await expect(rows.first()).toContainText("3 s");
    await shoot(page, "tab-history");

    await rows.first().click();
    const card = app(page).getByTestId("run-card");
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(card.getByTestId("run-result")).toHaveText("failed · exit 2");
    await expect(card.getByTestId("run-exit")).toHaveText("Exit code 2");
    await expect(card.getByTestId("run-last-lines")).toHaveText("copying\nrsync: connection refused");
    // Opening it resolves its Needs-you item.
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toContainEqual({ method: "needsYou.dismiss", params: { id: "run-failed:backup" } });
    await shoot(page, "tab-run-failed");

    await card.getByRole("button", { name: "View output" }).click();
    await expect(app(page).getByTestId("run-output-text")).toHaveText("copying\nrsync: connection refused\n");
    await app(page).getByRole("button", { name: "Back to the result" }).click();
    await expect(card).toBeVisible();
    await app(page).getByTestId("nav-jobs").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
  });

  test("the tab opens at a run's route, as a notice's click opens it", async ({ page }) => {
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [failed]);
    await expect(app(page).getByTestId("run-card").getByTestId("run-result")).toHaveText("failed · exit 2");
    await page.evaluate((route) => window.mounted.navigate(route), "history");
    await expect(app(page).getByTestId("history-row")).toHaveCount(1);
    await page.evaluate((route) => window.mounted.navigate(route), "run/backup/20000101-000000-000000");
    await expect(app(page).getByTestId("run-missing")).toHaveText("This run is not in the history any more.");
  });
});

test.describe("missed runs and load", () => {
  const SCRIPT = "---\nkind: script\nname: Summary\nfolder: .\ncommand: ./summary.sh\nschedule:\n  daily: { at: 7:00 }\n---\n";
  const at = (hours: number, minutes: number): number => new Date(2026, 10, 18, hours, minutes).getTime();
  const base: ActiveRun = {
    job: "summary",
    name: "Summary",
    kind: "script",
    project: null,
    folder: "",
    run: "20261118-060000-abcdef",
    trigger: "scheduled",
    dueAt: at(7, 0),
    state: "running",
    lowPriority: true,
    runAt: null,
    deadline: null,
    waits: null,
    startedAt: at(7, 0),
    session: "run:summary:20261118-060000-abcdef",
    log: "/ud/output/summary/r.log",
    limitHit: null,
    warnedAt: null,
    warningDismissed: false,
  };
  const weekly: ActiveRun = { ...base, job: "weekly", name: "Weekly", run: "20261122-020000-aaaaaa", dueAt: new Date(2026, 10, 22, 3, 0).getTime(), state: "missed-waiting", startedAt: null, session: null, log: null };
  const missed: NeedsYouItem = { id: "missed:weekly", kind: "missed", job: "weekly", name: "Weekly", project: null, run: weekly.run, at: weekly.dueAt, detail: "missed Sun 03:00" };
  const longRun: NeedsYouItem = { id: `long-run:summary:${base.run}`, kind: "long-run", job: "summary", name: "Summary", project: null, run: base.run, at: at(10, 0), startedAt: at(7, 0), detail: "running 3 h — still expected?" };
  const report: RunsReport = {
    active: [
      base,
      { ...base, job: "lint", name: "Lint", run: "20261118-060000-bbbbbb", state: "queued", startedAt: null, session: null, log: null, waits: { kind: "slot", ahead: 1 } },
      { ...base, job: "late", name: "Late", run: "20261118-060000-cccccc", trigger: "caught-up", state: "queued", startedAt: null, session: null, log: null, waits: { kind: "warm-up", until: at(8, 32) } },
      weekly,
    ],
    nextUp: [],
    jobs: [],
    needsYou: [longRun, missed],
    switch: { position: "running", since: null },
  };

  async function open(page: Page, query: Record<string, string> = {}): Promise<void> {
    await page.goto(harness(query));
    // The stand-in scheduler watches the jobs folder by the time it can set a service's state.
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await writeJob(page, "summary.md", SCRIPT);
    await page.evaluate((r) => window.setRuns({ report: r, history: [] }), report);
    if (query.surface === "panel") await expect(app(page).getByTestId("panel-jobs")).toBeVisible();
  }

  test.use({ viewport: { width: 240, height: 900 } });

  test("the panel's switch: Running · Pause low-priority · Pause all", async ({ page }) => {
    await open(page, { surface: "panel" });
    const control = app(page).getByTestId("switch");
    await expect(control).toHaveAttribute("data-position", "running");
    await expect(control.getByRole("button", { name: "Running" })).toHaveAttribute("aria-pressed", "true");
    await shoot(page, "panel-load");
    await control.getByRole("button", { name: "Pause low-priority" }).click();
    await expect(control).toHaveAttribute("data-position", "pause-low");
    await expect(app(page).getByTestId("switch-note")).toHaveText("Low-priority runs are held. Services keep running; held runs follow their missed-run policy on resume.");
    await control.getByRole("button", { name: "Pause all" }).click();
    await expect(app(page).getByTestId("switch-note")).toContainText("Every scheduled run is held.");
    await shoot(page, "panel-paused");
    await control.getByRole("button", { name: "Running" }).click();
    await expect(app(page).getByTestId("switch-note")).toHaveCount(0);
    expect((await page.evaluate(() => window.runnerCalls)).map((call) => call.params)).toEqual([{ position: "pause-low" }, { position: "pause-all" }, { position: "running" }]);
  });

  test("a missed run waits for you: Run now · Run at… · Skip", async ({ page }) => {
    await open(page, { surface: "panel" });
    const item = app(page).locator('[data-testid="needs-you-item"][data-kind="missed"]');
    await expect(item.getByTestId("needs-you-words")).toHaveText("Missed Sun 03:00 — it waits for you to pick a time.");
    await item.getByRole("button", { name: "Run at…" }).click();
    await item.getByRole("textbox", { name: "Run at" }).fill("23:00");
    await shoot(page, "panel-missed");
    await item.getByRole("button", { name: "Set" }).click();
    await item.getByRole("button", { name: "Run now" }).click();
    await item.getByRole("button", { name: "Skip" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "runs.missed", params: { job: "weekly", choice: "run-at", at: "23:00" } },
      { method: "runs.missed", params: { job: "weekly", choice: "run-now" } },
      { method: "runs.missed", params: { job: "weekly", choice: "skip" } },
    ]);
  });

  test("a long run asks whether it is still expected: Open · Stop · Dismiss", async ({ page }) => {
    await open(page, { surface: "panel" });
    const item = app(page).locator('[data-testid="needs-you-item"][data-kind="long-run"]');
    await expect(item.getByTestId("needs-you-words")).toHaveText("Has been running 3 h — still expected?");
    await item.getByRole("button", { name: "Open" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: base.session }, title: "Summary" }]);
    await item.getByRole("button", { name: "Stop" }).click();
    await item.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "runs.stop", params: { job: "summary", run: base.run } },
      { method: "needsYou.dismiss", params: { id: longRun.id } },
    ]);
  });

  test("Running now shows what each queued run waits for, in the panel and above History", async ({ page }) => {
    await open(page, { surface: "panel" });
    const rows = app(page).getByTestId("active-run");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("running");
    await expect(rows.nth(1)).toContainText("Lint");
    await expect(rows.nth(1)).toContainText("queued · 1 ahead");
    await expect(rows.nth(2)).toContainText("queued · warm-up until 08:32");
    await rows.nth(1).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: "run/lint/20261118-060000-bbbbbb" }]);

    await page.setViewportSize({ width: 1040, height: 700 });
    await open(page, { route: "history" });
    await expect(app(page).getByTestId("active-runs").getByTestId("active-run")).toHaveCount(3);
    await expect(app(page).getByTestId("active-runs")).toContainText("queued · 1 ahead");
    await shoot(page, "tab-history-queued");
  });

  test("a missed run's card offers its choices; a running run's card, Stop; a run stopped at its time limit is red", async ({ page }) => {
    await page.setViewportSize({ width: 1040, height: 700 });
    await open(page, { route: `run/weekly/${weekly.run}` });
    const card = app(page).getByTestId("run-card");
    await expect(card).toHaveAttribute("data-state", "missed-waiting");
    await expect(card.getByTestId("run-result")).toHaveText("missed · waiting for you");
    await expect(card.getByRole("button", { name: "Run at…" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Run now" })).toHaveCount(1);
    await shoot(page, "tab-run-missed");
    await page.evaluate((route) => window.mounted.navigate(route), `run/summary/${base.run}`);
    await card.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([{ method: "runs.stop", params: { job: "summary", run: base.run } }]);

    const stopped: RunRecord = { ...base, state: "failed", reason: "stopped: ran over 45 min", endedAt: at(7, 45), durationMs: 45 * 60_000, exitCode: null, signal: "SIGTERM", lastLines: ["still summarizing"] };
    await page.evaluate((h) => window.setRuns({ report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null } }, history: h }), [stopped]);
    await expect(card.getByTestId("run-result")).toHaveText("failed · stopped: ran over 45 min");
    const red = await card.getByTestId("run-result").evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).color === danger;
    });
    expect(red).toBe(true);
    await shoot(page, "tab-run-time-limit");
  });

  test("the Settings view shows the settings and writes one field at a time", async ({ page }) => {
    await page.setViewportSize({ width: 1040, height: 700 });
    await open(page, { route: "settings" });
    const view = app(page).getByTestId("settings");
    await expect(view).toContainText("Apps/pomade-runner/settings.yaml — no file yet: every setting is its default");
    await expect(view.getByLabel("Low-priority runs at once")).toHaveValue("2");
    await expect(view.getByLabel("Warm-up after login or wake")).toHaveValue("2m");
    await expect(view.getByLabel("Long-run warning after")).toHaveValue("3h");
    await expect(view.getByLabel("Keep history (days)")).toHaveValue("30");
    await shoot(page, "tab-settings");

    await page.evaluate(() => window.setSettings("max-low-priority-runs: 3\nwarm-up: soon\n"));
    await expect(view.getByLabel("Low-priority runs at once")).toHaveValue("3");
    await expect(view.getByTestId("settings-error")).toHaveText('Line 2: warm-up — "soon" is not a duration. Fix: write minutes or hours from 0m to 1h, e.g. warm-up: 2m.');
    await view.getByLabel("Long-run warning after").fill("1h30m");
    await view.getByTestId("setting-long-run-warning").getByRole("button", { name: "Save" }).click();
    await view.getByTestId("setting-max-low-priority-runs").getByRole("button", { name: "Default (2)" }).click();
    await view.getByLabel("Keep history (days)").fill("a week");
    await view.getByTestId("setting-history-days").getByRole("button", { name: "Save" }).click();
    await expect(view.getByTestId("setting-history-days").getByRole("alert")).toHaveText("write a whole number, e.g. 30");
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "settings.set", params: { field: "long-run-warning", value: 90 } },
      { method: "settings.set", params: { field: "max-low-priority-runs", value: null } },
    ]);
    await app(page).getByTestId("nav-jobs").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
  });
});
