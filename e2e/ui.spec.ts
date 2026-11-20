// The UI in pomade-kit's fake host — the built page in an iframe, as Pomade hosts it — and on its
// own in a browser. `RUNNER_SHOTS=<dir>` saves a screenshot of every state.

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

/** With `RUNNER_SHOTS`, save the page as `<name>.png`. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe("the side panel", () => {
  test.use({ viewport: { width: 240, height: 640 } });

  test("shows the no-jobs state, and Open Runner opens the Runner tab", async ({ page }) => {
    await page.goto(harness({ surface: "panel" }));
    const panel = app(page).getByTestId("panel-empty");
    await expect(panel.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await expect(panel).toContainText("A service is a command Runner keeps running: it starts at login, restarts on a crash and outlives Pomade");
    await expect(panel.getByTestId("active-runs")).toHaveText("Nothing is running.");
    await expect(app(page).locator("html")).toHaveAttribute("data-surface", "panel");
    await shoot(page, "panel");

    await panel.getByRole("button", { name: "Open Runner" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: "" }]);
    await expect(app(page).getByTestId("open-runner-error")).toHaveCount(0);
  });
});

test.describe("the Runner tab", () => {
  test.use({ viewport: { width: 1040, height: 700 } });

  test("shows the no-jobs state in the shell, and the version in Settings", async ({ page }) => {
    await page.goto(harness());
    const tab = app(page).getByTestId("tab-empty");
    await expect(tab.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
    await expect(tab).toContainText("A job is something Runner does without you.");
    await expect(app(page).getByTestId("nav-jobs")).toHaveText("Jobs0");
    await expect(app(page).locator("html")).toHaveAttribute("data-surface", "tab");
    await shoot(page, "tab");
    await app(page).getByTestId("nav-settings").click();
    await expect(app(page).getByTestId("tab-settings").getByTestId("version")).toHaveText(`Runner ${manifest.version}`);
  });

  test("the header's views: Jobs · History · Services · Settings, the current one marked; each opens its route", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "alpha/coda-web.md", VALID);
    await writeJob(page, "weekly-report.md", BROKEN);
    const nav = app(page).getByRole("navigation", { name: "Runner views" });
    await expect(nav.getByRole("button")).toHaveText(["Jobs2", "History", "Services1", "Settings"]);
    const current = nav.locator('[aria-current="page"]');
    await expect(current).toHaveText("Jobs2");
    for (const view of ["history", "services", "settings", "jobs"] as const) {
      await app(page).getByTestId(`nav-${view}`).click();
      await expect(app(page).getByTestId(`tab-${view}`)).toBeVisible();
      await expect(current).toHaveAttribute("data-testid", `nav-${view}`);
    }
    expect(await page.evaluate(() => window.fakeHost.openedTabs)).toEqual([]);
  });

  test("the services route opens the Services view: each service with its project, folder, command and state", async ({ page }) => {
    await page.goto(harness({ route: "services" }));
    await expect(app(page).getByTestId("services-empty")).toContainText("A service is a command Runner keeps running");
    await expect(app(page).getByTestId("nav-services")).toHaveAttribute("aria-current", "page");
    await writeJob(page, "alpha/coda-web.md", VALID);
    const row = app(page).getByTestId("service-row");
    await expect(row).toHaveText(/Coda web\s*Alpha · Projects\/alpha · \.\/start\.sh\s*Running/);
    await shoot(page, "tab-services");
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

  test("the panel: the switch on top, Needs you · Running now · Next up, each collapsing, Open Runner at the bottom — no jobs list", async ({ page }) => {
    await page.setViewportSize({ width: 240, height: 640 });
    await page.goto(harness({ surface: "panel" }));
    await expect(app(page).getByTestId("panel-empty")).toBeVisible();
    await writeJob(page, "alpha/coda-web.md", VALID);
    await writeJob(page, "weekly-report.md", BROKEN);
    const panel = app(page).getByTestId("panel-jobs");
    await expect(panel.getByTestId("switch")).toBeVisible();
    await expect(panel.getByRole("region")).toHaveText([/^Needs you0Nothing needs you\.$/, /^Running now0Nothing is running\.$/, /^Next upNothing is scheduled\.$/]);
    await expect(panel.getByTestId("job-row")).toHaveCount(0);
    await expect(panel.getByTestId("job-invalid")).toHaveCount(0);
    const open = panel.getByRole("button", { name: "Open Runner" });
    await expect(open).toBeInViewport();
    expect((await open.boundingBox())?.y).toBeGreaterThan(590);
    await shoot(page, "panel-jobs");

    for (const [section, content] of [
      ["needs-you", "needs-you"],
      ["running", "active-runs"],
      ["next-up", "next-up"],
    ] as const) {
      const head = panel.getByTestId(`section-${section}-head`);
      await expect(head).toHaveAttribute("aria-expanded", "true");
      await head.click();
      await expect(head).toHaveAttribute("aria-expanded", "false");
      await expect(panel.getByTestId(content)).toBeHidden();
      await head.click();
      await expect(panel.getByTestId(content)).toBeVisible();
    }
    await panel.getByTestId("section-running-head").click();
    await shoot(page, "panel-collapsed");
  });

  test("a git job's row says its operation and repos — one the workspace lacks, so — with Run now; its route marks it", async ({ page }) => {
    const GIT = "---\nkind: git\nname: Knowledge twice daily\ngit: { operation: commit-push, repos: [Knowledge, Notes] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n";
    await page.goto(harness({ route: "jobs/knowledge" }));
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "alpha/coda-web.md", VALID);
    await writeJob(page, "knowledge.md", GIT);
    const row = app(page).locator('[data-testid="job-row"][data-job="knowledge"]');
    await expect(row.getByTestId("job-git")).toHaveText("Commit & push · Knowledge, Notes (not in this workspace)");
    await expect(row.getByTestId("job-runs")).toHaveText("daily at 13:00 and 20:00 · never ran");
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(app(page).locator('[data-testid="job-row"][data-job="alpha/coda-web"]')).not.toHaveAttribute("aria-current", /.*/);
    await shoot(page, "tab-jobs-git");
    await row.getByRole("button", { name: "Run now" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([{ method: "jobs.run", params: { job: "knowledge" } }]);
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
    cause: null,
    dueAt: at(13, 0),
    state: "failed",
    action: null,
    reason: null,
    startedAt: at(13, 0),
    endedAt: at(13, 0) + 3000,
    durationMs: 3000,
    exitCode: 2,
    signal: null,
    log: "/ud/output/backup/r.log",
    lastLines: ["copying", "rsync: connection refused"],
    git: null,
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
    const needsCount = app(page).getByTestId("section-needs-you-head-count");
    await expect(needsCount).toHaveText("2");
    await expect(needsCount).toHaveCSS("background-color", "rgb(209, 73, 91)");
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
    await page.keyboard.press("Escape");
    await app(page).getByTestId("nav-jobs").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    await expect(app(page).getByTestId("job-runs")).toHaveText(/daily at 13:00 · next .* · last failed · exit 2/);
  });

  test("a run's card is a dialog over History: focus moves in and stays in; Esc, the close button or a click outside closes it", async ({ page }) => {
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [failed]);
    const dialog = app(page).getByRole("dialog", { name: "Backup" });
    await expect(dialog.getByTestId("run-result")).toHaveText("failed · exit 2");
    await expect(app(page).getByTestId("history-row")).toHaveCount(1);
    await expect(app(page).getByTestId("nav-history")).toHaveAttribute("aria-current", "page");
    const close = dialog.getByRole("button", { name: "Close (Esc)" });
    await expect(dialog).toBeFocused();
    await shoot(page, "tab-run-dialog");
    // Tab goes through the card's buttons and wraps from the last to the first and back, never leaving it.
    const buttons = dialog.getByRole("button");
    const count = await buttons.count();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    for (let i = 1; i < count; i++) await page.keyboard.press("Tab");
    await expect(buttons.last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(buttons.last()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(app(page).getByTestId("tab-history")).toBeVisible();

    await app(page).getByTestId("history-row").click();
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await app(page).getByTestId("history-row").click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(10, 690);
    await expect(dialog).toHaveCount(0);
    await expect(app(page).getByTestId("history-row")).toBeFocused();
  });

  test("a git run's card has a line per repo — a failed repo red — and Run now", async ({ page }) => {
    const steps = [
      { step: "commit" as const, outcome: "done" as const, detail: "committed a1b2c3d (2 files)" },
      { step: "pull" as const, outcome: "done" as const, detail: "up to date with origin/main" },
      { step: "push" as const, outcome: "done" as const, detail: "pushed 1 commit to origin/main" },
    ];
    const reason = "Their changes conflict with yours in notes.md. Nothing was changed — the repository is exactly as before, and nothing was pushed.";
    const git: RunRecord = {
      ...failed,
      job: "knowledge",
      name: "Knowledge twice daily",
      kind: "git",
      exitCode: 1,
      reason: `Pomade: ${reason}`,
      lastLines: [],
      git: {
        op: "commit-push",
        job: "Knowledge twice daily",
        at: new Date(at(13, 0)).toISOString(),
        results: [
          { repo: "Knowledge", path: "/fake/workspace/Knowledge", op: "commit-push", status: "done", reason: null, steps, commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
          { repo: "coda-helper", path: "/fake/workspace/Projects/coda-helper", op: "commit-push", status: "skipped", reason: "agent working", steps: [], commit: null },
          { repo: "Pomade", path: "/fake/workspace/Projects/Pomade", op: "commit-push", status: "failed", reason, steps: [], commit: null },
        ],
      },
    };
    await page.goto(harness({ route: `run/knowledge/${RUN}` }));
    await setRuns(page, [git]);
    const card = app(page).getByTestId("run-card");
    await expect(card.getByTestId("run-result")).toHaveText(`failed · Pomade: ${reason}`);
    await expect(card.getByTestId("run-git-repo")).toHaveText(["Knowledge · committed a1b2c3d · pulled · pushed", "coda-helper · skipped · agent working", `Pomade · failed · ${reason}`]);
    await expect(card.locator('[data-testid="run-git-repo"][data-status="failed"]')).toHaveCSS("color", await card.getByTestId("run-result").evaluate((element) => getComputedStyle(element).color));
    await expect(card.getByTestId("run-last-lines")).toHaveCount(0);
    await shoot(page, "tab-run-git");
    await card.getByRole("button", { name: "Run now" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toContainEqual({ method: "jobs.run", params: { job: "knowledge" } });
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
    cause: null,
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

    const stopped: RunRecord = { ...base, state: "failed", action: null, reason: "stopped: ran over 45 min", endedAt: at(7, 45), durationMs: 45 * 60_000, exitCode: null, signal: "SIGTERM", lastLines: ["still summarizing"], git: null };
    await page.evaluate((h) => window.setRuns({ report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null } }, history: h }), [stopped]);
    await expect(card.getByTestId("run-result")).toHaveText("failed · stopped: ran over 45 min");
    const red = await card.getByTestId("run-result").evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger-text)";
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

  test("help: the (i) shows its text and example on hover and on keyboard focus; a status's help on hover", async ({ page }) => {
    await page.setViewportSize({ width: 1040, height: 700 });
    await open(page, { route: "settings" });
    const tip = app(page).getByRole("tooltip");
    const help = app(page).getByTestId("help-s.heavy");
    await expect(tip).toHaveCount(0);
    await help.hover();
    await expect(tip).toHaveText('How many low-priority runs may go at once. The rest wait as "queued · N ahead".Example: 2 — three due at once → two run, one queues.');
    await expect(help).toHaveAttribute("aria-describedby", "runner-tip");
    const box = await tip.boundingBox();
    const at = await help.boundingBox();
    // Above the (i), or below it when there is no room above; never over it.
    expect(box !== null && at !== null && (box.y + box.height <= at.y || box.y >= at.y + at.height)).toBe(true);
    await shoot(page, "tab-help");
    await page.mouse.move(1000, 600);
    await expect(tip).toHaveCount(0);

    await app(page).getByLabel("Low-priority runs at once").focus();
    // Save, then (Default is disabled: the value is the default) the next setting's (i).
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(app(page).getByTestId("help-s.warm")).toBeFocused();
    await expect(tip).toHaveText(/^The pause after login or wake before caught-up runs and hooks start\. Services start first\.Example: 2 min/);
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);

    await page.setViewportSize({ width: 240, height: 900 });
    await open(page, { surface: "panel" });
    await app(page).getByTestId("switch-pause-all").hover();
    await expect(tip).toHaveText("Holds every scheduled job, hook and chain. Services keep running.Example: a demo — nothing starts until you switch back.");
    const inside = await tip.boundingBox();
    expect(inside !== null && inside.x >= 0 && inside.x + inside.width <= 240).toBe(true);
    await shoot(page, "panel-help");
  });
});

test.describe("hooks and chains", () => {
  test.use({ viewport: { width: 1040, height: 700 } });
  const at = (hours: number, minutes: number): number => new Date(2026, 10, 18, hours, minutes).getTime();
  const pull: RunRecord = {
    job: "pull",
    name: "Pull",
    kind: "script",
    project: null,
    folder: "",
    run: "20261118-120000-aaaaaa",
    trigger: "scheduled",
    cause: null,
    dueAt: at(13, 0),
    state: "done",
    action: null,
    reason: null,
    startedAt: at(13, 0),
    endedAt: at(13, 0) + 2000,
    durationMs: 2000,
    exitCode: 0,
    signal: null,
    log: "/ud/output/pull/a.log",
    lastLines: ["Already up to date."],
    git: null,
  };
  const cause = { kind: "chain" as const, job: "pull", name: "Pull", run: pull.run, result: "done" as const };
  const tests: RunRecord = { ...pull, job: "tests", name: "Tests", run: "20261118-120002-bbbbbb", trigger: "chain", cause, dueAt: pull.endedAt, startedAt: pull.endedAt, endedAt: pull.endedAt + 5000, lastLines: ["12 passed"] };
  const web: RunRecord = { ...pull, job: "web", name: "Web", kind: "service", run: "20261118-120002-cccccc", trigger: "chain", cause, dueAt: pull.endedAt, action: "restart", startedAt: null, durationMs: null, exitCode: null, log: null, lastLines: [], endedAt: pull.endedAt + 1000 };
  const mount: RunRecord = { ...pull, job: "mount", name: "Mount", run: "20261118-070000-dddddd", trigger: "hook", cause: { kind: "hook", event: "login", context: {} }, dueAt: at(8, 0), startedAt: at(8, 2), endedAt: at(8, 2) + 1000 };
  const paused: NeedsYouItem = { id: "loop-paused:lint", kind: "loop-paused", job: "lint", name: "Lint", project: null, at: at(14, 0), detail: "triggered 10× in 10 min — looks like a loop" };
  const quiet: RunsReport = { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null } };

  test("History says what started each run — chain: after Pull, hook: Mac login — and a service's chain action; a chain run's card opens the run it followed", async ({ page }) => {
    await page.goto(harness({ route: "history" }));
    await page.waitForFunction(() => typeof window.setRuns === "function");
    await page.evaluate((h) => window.setRuns({ report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null } }, history: h }), [tests, web, pull, mount]);
    const rows = app(page).getByTestId("history-row");
    await expect(rows).toHaveCount(4);
    await expect(app(page).getByTestId("history-trigger")).toHaveText(["chain: after Pull", "chain: after Pull", "scheduled", "hook: Mac login"]);
    await expect(rows.nth(1)).toContainText("restarted");
    await shoot(page, "tab-history-chains");

    await rows.first().click();
    const card = app(page).getByTestId("run-card");
    await expect(card.getByTestId("run-trigger")).toContainText("chain: after Pull · due");
    await card.getByRole("button", { name: "Open Pull's run" }).click();
    await expect(card.getByTestId("run-trigger")).toContainText("scheduled · due");
    await expect(card.getByRole("button", { name: "Open Pull's run" })).toHaveCount(0);
    await expect(card.getByTestId("run-last-lines")).toHaveText("Already up to date.");
  });

  test("a job the loop guard paused is in Needs you, with Resume", async ({ page }) => {
    await page.setViewportSize({ width: 240, height: 640 });
    await page.goto(harness({ surface: "panel" }));
    // The stand-in scheduler watches the jobs folder by the time it can set a service's state.
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await writeJob(page, "lint.md", "---\nkind: script\nname: Lint\nfolder: .\ncommand: ./lint.sh\nhook: { event: project-created }\n---\n");
    await expect(app(page).getByTestId("panel-jobs")).toBeVisible();
    await page.evaluate((r) => window.setRuns({ report: r, history: [] }), { ...quiet, needsYou: [paused] });
    const item = app(page).locator('[data-testid="needs-you-item"][data-kind="loop-paused"]');
    await expect(item.getByTestId("needs-you-words")).toHaveText("Paused: triggered 10× in 10 min — looks like a loop");
    await shoot(page, "panel-loop-paused");
    await item.getByRole("button", { name: "Resume" }).click();
    await expect(item).toHaveCount(0);
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([{ method: "jobs.resume", params: { job: "lint" } }]);
  });

  test("job rows say each hook and chain in words; a service says what its chain does", async ({ page }) => {
    await page.goto(harness());
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await writeJob(page, "pull.md", "---\nkind: script\nname: Pull\nfolder: .\ncommand: ./pull.sh\nschedule:\n  daily: { at: 13:00 }\n---\n");
    await writeJob(page, "tests.md", "---\nkind: script\nname: Tests\nfolder: .\ncommand: ./test.sh\nafter: { job: pull, result: any }\n---\n");
    await writeJob(page, "mount.md", "---\nkind: script\nname: Mount\nfolder: .\ncommand: ./mount.sh\nhook: { event: login }\n---\n");
    await writeJob(page, "web.md", "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\nafter: { job: pull }\n---\n");
    const runs = app(page).getByTestId("job-runs");
    await expect(runs).toHaveCount(3);
    await expect(runs).toContainText(["at Mac login", "daily at 13:00", "after pull finishes"]);
    await expect(app(page).getByTestId("service-chain")).toHaveText("always on, from login; restarts after pull is done");
    await shoot(page, "tab-jobs-chains");
  });
});
