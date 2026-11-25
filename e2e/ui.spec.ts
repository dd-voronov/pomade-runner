// The UI in pomade-kit's fake host — the built page in an iframe, as Pomade hosts it — and on its
// own in a browser. `RUNNER_SHOTS=<dir>` saves a screenshot of every state.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Browser, type FrameLocator, type Locator, type Page } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import type { ServiceStatus } from "../src/keeper/model";
import { chainEvent, type ActiveRun, type HeldRun, type NeedsYouItem, type RunRecord, type RunsReport, type ServiceEvent } from "../src/scheduler/model";
import { HELP } from "../src/ui/help";
import { APP_PORT, HARNESS_PORT } from "./support/ports";

const APP = `http://localhost:${APP_PORT}/`;
const SHOTS = process.env.RUNNER_SHOTS;

function harness(query: Record<string, string> = {}): string {
  return `http://localhost:${HARNESS_PORT}/harness.html?${new URLSearchParams({ app: APP, ...query }).toString()}`;
}

function app(page: Page): FrameLocator {
  return page.frameLocator('iframe[data-frame="main"]');
}

/** The frame of the keyed tab `key` the app opened (a run's output tab). */
function outputTab(page: Page, key: string): FrameLocator {
  return page.frameLocator(`iframe[data-frame="${key}"]`);
}

/** Stand in for the clipboard in every frame: `writeText` keeps what it is given in
 *  `window.copied`, and refuses with `window.refuseCopy` while that is set. The fake host's frames
 *  are not allowed the clipboard as Pomade's are (`allow="clipboard-write"`); `pomade.spec.ts`
 *  copies through the real one. */
async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.copied = [];
    window.refuseCopy = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          if (window.refuseCopy !== null) return Promise.reject(new DOMException(window.refuseCopy, "NotAllowedError"));
          window.copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
}

/** What the frame of the keyed tab `key` wrote to the stand-in clipboard (`stubClipboard`). */
function copied(page: Page, key: string): Promise<string[]> {
  return page.locator(`iframe[data-frame="${key}"]`).contentFrame().locator("html").evaluate(() => window.copied);
}

/** Whether a row's cell shows in the strip just past the table's content edge — the left and the right: none must, however far the table is scrolled sideways. */
async function rowPastEdge(table: Locator): Promise<boolean> {
  return table.evaluate((el) => {
    const parent = el.parentElement!;
    const box = parent.getBoundingClientRect();
    const style = getComputedStyle(parent);
    const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const first = el.querySelector("[data-testid$=row]")!.getBoundingClientRect();
    const y = first.top + first.height / 2;
    const rowAt = (x: number): boolean => el.ownerDocument.elementsFromPoint(x, y).some((hit) => hit.closest("[data-testid$=row]") !== null);
    return rowAt(left - 1) || rowAt(right + 1);
  });
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
    await expect(panel).toContainText("A service is a command Runner keeps running and restarts on a crash — from Mac startup, or only while Pomade is running — like a project's web server.");
    await expect(panel.getByTestId("active-runs")).toHaveText("Nothing is running.");
    await expect(app(page).locator("html")).toHaveAttribute("data-surface", "panel");
    await shoot(page, "panel");

    await panel.getByRole("button", { name: "Open Runner" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: "" }]);
    await expect(app(page).getByTestId("open-runner-error")).toHaveCount(0);
  });

  test("the no-jobs card's New job opens the Runner tab at the job form", async ({ page }) => {
    await page.goto(harness({ surface: "panel" }));
    await app(page).getByTestId("panel-new-job").click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: "new" }]);
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
    await writeJob(page, "alpha/dev-server.md", VALID);
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
    await expect(app(page).getByTestId("services-empty-new-job")).toHaveText("New job");
    await expect(app(page).getByTestId("nav-services")).toHaveAttribute("aria-current", "page");
    await writeJob(page, "alpha/dev-server.md", VALID);
    const row = app(page).getByTestId("service-row");
    await expect(row).toHaveText(/Dev server\s*Alpha · Projects\/alpha\s*\.\/start\.sh\s*running · up 0s\s*no crashes/);
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

const VALID = "---\nkind: service\nname: Dev server\nproject: alpha\nfolder: Projects/alpha\ncommand: ./start.sh\n---\n";
const BROKEN = "---\nkind: script\nname: Weekly report\nfolder: .\ncommand: ./report.sh\nschedule:\n  weekly: { days: [fri], at: 25:00 }\n---\n";

/** Write a job file into the fake workspace, as an agent or the user would. */
async function writeJob(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(([p, t]) => window.fakeHost.writeFile(`Apps/pomade-runner/jobs/${p}`, t), [path, text] as const);
}

/** A service's session in the keeper: running since `ago` ms, or ended at `endedAt`, stopped by you. */
const serviceSession = (job: string, ago: number, endedAt: number | null = null) => ({
  id: `svc:${job.replace("/", ".")}`,
  job,
  kind: "service" as const,
  run: null,
  log: null,
  info: {
    id: `svc:${job.replace("/", ".")}`,
    title: job,
    command: "",
    cwd: "/fake/workspace",
    pid: endedAt === null ? 7 : null,
    startedAt: Date.now() - ago,
    cols: 80,
    rows: 24,
    state: endedAt === null ? ("running" as const) : ("exited" as const),
    exit: endedAt === null ? null : { code: 130, signal: null, reason: "stopped-by-you" as const, at: endedAt },
    clients: 0,
    actions: [],
  },
});

test.describe("the jobs list", () => {
  test.use({ viewport: { width: 1040, height: 700 } });

  test("a valid file appears within a second, a broken one shows its error, Open file opens it", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();

    await writeJob(page, "alpha/dev-server.md", VALID);
    const row = app(page).getByTestId("job-row");
    await expect(row).toContainText("Dev server", { timeout: 1000 });
    await expect(app(page).getByTestId("job-group")).toHaveText(["Alphajobs/alpha/1"]);

    await writeJob(page, "weekly-report.md", BROKEN);
    const invalid = app(page).getByTestId("job-invalid");
    await expect(invalid).toContainText('Invalid: line 7: schedule.weekly.at — "25:00" is not a time. Fix: write a time like 7:00 or 13:30 (H:MM, 24-hour).', { timeout: 1000 });
    await expect(app(page).getByTestId("tab-jobs")).toContainText("2 jobs · 1 invalid");
    await shoot(page, "tab-jobs");

    await invalid.getByRole("button", { name: "Open file" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: "Apps/pomade-runner/jobs/weekly-report.md" }]);

    await page.evaluate(() => window.fakeHost.deleteFile("Apps/pomade-runner/jobs/alpha/dev-server.md"));
    await expect(row).toHaveCount(0, { timeout: 1000 });
  });

  test("a service's row says where it stands: its state, restarts and last crash", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "alpha/dev-server.md", VALID);
    const state = app(page).getByTestId("job-status");
    const sub = app(page).getByTestId("job-last-sub");
    await expect(state).toHaveText(/^running · up \d+s$/);
    await expect(sub).toHaveText("no crashes");
    const crash = new Date(2026, 10, 17, 14, 2).getTime();
    await page.evaluate((at) => window.setServiceStatus("alpha/dev-server", { restarts: 3, lastCrashAt: at }), crash);
    await expect(sub).toHaveText("restarted 3× · last crash 14:02");
    await expect(sub).toHaveAttribute("data-help", "st.restarted");
    await shoot(page, "tab-service-restarted");
    await page.evaluate((at) => window.setServiceStatus("alpha/dev-server", { state: "failed", restarts: 4, lastCrashAt: at }), crash);
    await expect(state).toHaveText("failed · gave up");
    await expect(state).toHaveAttribute("data-help", "st.svcfailed");
    await expect(sub).toContainText("crashed 5× in 1 min");
    await shoot(page, "tab-service-failed");
  });

  test("the panel: the switch on top, Needs you · Running now · Next up, each collapsing, Open Runner at the bottom — no jobs list", async ({ page }) => {
    await page.setViewportSize({ width: 240, height: 640 });
    await page.goto(harness({ surface: "panel" }));
    await expect(app(page).getByTestId("panel-empty")).toBeVisible();
    await writeJob(page, "alpha/dev-server.md", VALID);
    await writeJob(page, "weekly-report.md", BROKEN);
    const panel = app(page).getByTestId("panel-jobs");
    await expect(panel.getByTestId("switch")).toBeVisible();
    await expect(panel.getByRole("region")).toHaveText([/^Needs you0Nothing needs you\.$/, /^Running now1Dev serverup 0sAlpha · Projects\/alpha$/, /^Next upNothing is scheduled\.$/]);
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
    const GIT = "---\nkind: git\nname: Commit notes\ngit: { operation: commit-push, repos: [notes, Journal] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n";
    await page.goto(harness({ route: "jobs/notes" }));
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "alpha/dev-server.md", VALID);
    await writeJob(page, "notes.md", GIT);
    const row = app(page).locator('[data-testid="job-row"][data-job="notes"]');
    const trigger = row.getByTestId("job-trigger");
    await expect(trigger).toHaveText("daily at 13:00 and 20:00 · Journal is not in this workspace");
    await expect(trigger).toHaveAttribute("data-tip", "Daily at 13:00 and 20:00 · Commit & push · notes, Journal (not in this workspace)");
    await expect(row.getByTestId("job-status")).toHaveText("never ran");
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(app(page).locator('[data-testid="job-row"][data-job="alpha/dev-server"]')).not.toHaveAttribute("aria-current", /.*/);
    await shoot(page, "tab-jobs-git");
    await row.getByRole("button", { name: "Run now" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([{ method: "jobs.run", params: { job: "notes" } }]);
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
    agent: null,
    missed: null,
    series: null,
    state: "failed",
    event: null,
    reason: null,
    startedAt: at(13, 0),
    endedAt: at(13, 0) + 3000,
    durationMs: 3000,
    exitCode: 2,
    signal: null,
    log: "/ud/output/backup/r.log",
    lastLines: ["copying", "rsync: connection refused"],
    git: null,
    limitHit: null,
  };
  const item: NeedsYouItem = { id: "run-failed:backup", kind: "run-failed", job: "backup", name: "Backup", project: null, run: RUN, at: failed.endedAt, count: 2, detail: "exit 2" };
  const report = (now: number): RunsReport => ({
    active: [],
    nextUp: [{ job: "backup", name: "Backup", project: null, at: now + 40 * 60_000 + 30_000, held: false }],
    jobs: [{ job: "backup", next: now + 40 * 60_000, finished: false, last: failed, held: false }],
    needsYou: [item, { id: "service-failed:web", kind: "service-failed", job: "web", name: "Web", project: null, at: at(12, 0), detail: "crashed 5 times within a minute", problem: null, session: true }],
    switch: { position: "running", since: null }, heldRuns: 0,
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
    await writeJob(page, "web.md", "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n");
    await expect(app(page).getByTestId("panel-jobs")).toBeVisible();
    await expect(app(page).getByTestId("needs-you")).toContainText("Nothing needs you.");
    await expect(app(page).getByTestId("next-up")).toContainText("Nothing is scheduled.");
    await setRuns(page, [failed]);
    const items = app(page).getByTestId("needs-you-item");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText("Failed: exit 2 · 2×");
    await expect(items.last()).toContainText("Crashed 5× in 1 min — gave up.");
    await expect(app(page).getByTestId("next-up-item")).toHaveText(/in 4[01] min\s*Backup/);
    const needsCount = app(page).getByTestId("section-needs-you-head-count");
    await expect(needsCount).toHaveText("2");
    await expect(needsCount).toHaveCSS("background-color", "rgb(209, 73, 91)");
    await shoot(page, "panel-runs");

    await items.first().getByRole("button", { name: "Open" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: `run/backup/${RUN}` }]);
    await items.first().getByRole("button", { name: "Run now" }).click();
    await expect(app(page).getByTestId("toast")).toHaveText("RunnerBackup started");
    await items.last().getByRole("button", { name: "Start" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerWeb started");
    await items.first().getByRole("button", { name: "Dismiss" }).click();
    await expect(items).toHaveCount(1);
    await expect(needsCount).toHaveText("1");
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
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerBackup started · trigger “manual”");
    const toggle = row.getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await writeJob(page, "backup.md", SCRIPT.replace("folder: .\n", "folder: .\nenabled: false\n"));
    await expect(row.getByTestId("job-next")).toHaveText("disabled");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(row.getByTestId("job-name")).toHaveCSS("color", "rgb(138, 153, 166)");
    await toggle.click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "jobs.run", params: { job: "backup" } },
      { method: "jobs.setEnabled", params: { job: "backup", enabled: false } },
      { method: "jobs.setEnabled", params: { job: "backup", enabled: true } },
    ]);
  });

  test("History lists the runs; a row opens the result card: red, the exit code and the last lines; View output opens the whole output in its own tab", async ({ page }) => {
    await page.goto(harness());
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    await writeJob(page, "backup.md", SCRIPT);
    await setRuns(page, [failed, { ...failed, run: "20261117-110000-abcdef", state: "done", exitCode: 0, lastLines: [], endedAt: at(12, 0) }]);
    await app(page).getByTestId("nav-history").click();
    const rows = app(page).getByTestId("history-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Backup");
    await expect(rows.first()).toContainText("failed · exit 2");
    await expect(rows.first()).toContainText("3s");
    await shoot(page, "tab-history");

    await rows.first().click();
    const card = app(page).getByTestId("run-card");
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(app(page).getByTestId("run-dialog")).toHaveAttribute("data-tone", "danger");
    await expect(app(page).getByTestId("run-result")).toHaveText("Failed");
    await expect(card.getByTestId("run-exit")).toHaveText("2");
    await expect(card.getByTestId("run-last-lines")).toHaveText("copying\nrsync: connection refused");
    // Opening it resolves its Needs-you item.
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toContainEqual({ method: "needsYou.dismiss", params: { id: "run-failed:backup" } });
    await shoot(page, "tab-run-failed");

    // View output: the run's own tab beside the Runner tab — keyed by the run, of the manifest's
    // output kind, titled "<job> · output" — focused; the Runner tab stays at the card.
    await app(page).getByRole("button", { name: "View output" }).click();
    const key = `out:backup:${RUN}`;
    const output = outputTab(page, key);
    await expect(output.getByTestId("run-output-text")).toHaveText("copying\nrsync: connection refused");
    await expect(output.getByTestId("run-output-badge")).toContainText("Captured log ·");
    await expect(output.getByRole("button", { name: "Back to the result" })).toHaveCount(0);
    await expect(page.locator('iframe[data-frame="main"]')).toBeHidden();
    const tabs = (): Promise<{ route: string; key: string | undefined; kind: string | undefined; title: string | undefined }[]> => page.evaluate(() => window.fakeHost.appTabs.map(({ route, key, kind, title }) => ({ route, key, kind, title })));
    expect(await tabs()).toEqual([
      { route: `run/backup/${RUN}` },
      { route: `output/backup/${RUN}`, key, kind: "output", title: "Backup · output" },
    ]);
    await shoot(page, "tab-run-output");
    // A record that came with the workspace from another Mac: its output log is not here.
    await page.evaluate(() => window.setRuns({ output: "", outputMissing: true }));
    await expect(output.getByTestId("run-output-missing")).toHaveText("This run's output is not on this Mac.");
    await expect(output.getByTestId("run-output-copy")).toBeDisabled();
    await shoot(page, "tab-run-output-missing");
    await page.evaluate(() => window.setRuns({ output: "copying\nrsync: connection refused\n", outputMissing: false }));
    // Back in the Runner tab, View output again focuses the run's tab: one tab per run.
    await page.evaluate(() => window.fakeHost.openAppTab());
    await expect(card).toBeVisible();
    await app(page).getByRole("button", { name: "View output" }).click();
    await expect(output.getByTestId("run-output-text")).toBeVisible();
    expect(await tabs()).toHaveLength(2);
    await page.evaluate(() => window.fakeHost.openAppTab());
    await expect(card).toBeVisible();
    await app(page).getByRole("button", { name: "Close (Esc)" }).click();
    await app(page).getByTestId("nav-jobs").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    const row = app(page).getByTestId("job-row");
    await expect(row.getByTestId("job-trigger")).toHaveText("daily at 13:00");
    await expect(row.getByTestId("job-status")).toHaveText("failed · exit 2");
    await expect(row.getByTestId("job-status")).toHaveAttribute("data-help", "st.failed");
    await expect(row.getByTestId("job-next")).toContainText("in 40 min");
    // The last result opens that run's card, over History.
    await row.getByTestId("job-last").click();
    await expect(app(page).getByTestId("run-card")).toBeVisible();
  });

  test("a card closed in the tab tells Pomade where the tab is, so the same notice clicked again reopens the card", async ({ page }) => {
    // Pomade opened the tab at the card, as a run's notice does.
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [failed]);
    const dialog = app(page).getByRole("dialog", { name: "Backup" });
    await expect(dialog.getByTestId("run-result")).toHaveText("Failed");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.fakeHost.appTabs.map((tab) => tab.route))).toEqual(["history"]);
    // The notice again: Pomade navigates the tab back to the card.
    await page.evaluate((route) => window.fakeHost.openAppTab({ route }), `run/backup/${RUN}`);
    await expect(dialog.getByTestId("run-result")).toHaveText("Failed");
    // A view picked in the header is recorded too: a reload opens there.
    await page.keyboard.press("Escape");
    await app(page).getByTestId("nav-services").click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.appTabs.map((tab) => tab.route))).toEqual(["services"]);
  });

  test("the output tab's Copy puts the whole log on the clipboard and says so; a refused copy says why", async ({ page }) => {
    await stubClipboard(page);
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [failed]);
    await app(page).getByRole("dialog", { name: "Backup" }).getByRole("button", { name: "View output" }).click();
    const output = outputTab(page, `out:backup:${RUN}`);
    await expect(output.getByTestId("run-output-text")).toHaveText("copying\nrsync: connection refused");
    await output.getByTestId("run-output-copy").click();
    await expect(output.getByTestId("toast")).toHaveText("RunnerCopied the log");
    expect(await copied(page, `out:backup:${RUN}`)).toEqual(["copying\nrsync: connection refused\n"]);
    await shoot(page, "tab-run-output-copied");
    await page.locator(`iframe[data-frame="out:backup:${RUN}"]`).contentFrame().locator("html").evaluate(() => {
      window.refuseCopy = "Write permission denied.";
    });
    await output.getByTestId("run-output-copy").click();
    await expect(output.getByTestId("toast").last()).toHaveText("RunnerCould not copy the log: Write permission denied.");
  });

  test("T-035 · a failed run's card and its output tab show the colours and bold the program printed, in the palette; Copy gives plain text", async ({ page }) => {
    await stubClipboard(page);
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [{ ...failed, lastLines: ["\x1b[31mboom\x1b[0m", "fine", "\x1b[1mtotal\x1b[0m 1 failed"] }]);
    await page.evaluate(() => window.setRuns({ output: "\x1b]0;title\x07\x1b[31mboom\x1b[0m\r\nfine\r\n\x1b[1mtotal\x1b[0m 1 failed\r\n" }));
    const colour = (locator: Locator): Promise<string> => locator.evaluate((element) => getComputedStyle(element).color);
    const token = (name: string): Promise<string> =>
      app(page)
        .locator("body")
        .evaluate((body, variable) => {
          const probe = document.createElement("span");
          probe.style.color = `var(${variable})`;
          body.append(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        }, name);
    const red = await token("--term-red");

    const lines = app(page).getByRole("dialog", { name: "Backup" }).getByTestId("run-last-lines");
    await expect(lines).toHaveText("boom\nfine\ntotal 1 failed");
    await expect(lines.locator('[data-colour="red"]')).toHaveText("boom");
    expect(await colour(lines.locator('[data-colour="red"]'))).toBe(red);
    expect(await colour(lines)).not.toBe(red);
    expect(await lines.getByText("total", { exact: true }).evaluate((element) => getComputedStyle(element).fontWeight)).toBe("700");
    await shoot(page, "tab-run-failed-colours");

    await app(page).getByRole("dialog", { name: "Backup" }).getByRole("button", { name: "View output" }).click();
    const output = outputTab(page, `out:backup:${RUN}`);
    const text = output.getByTestId("run-output-text");
    await expect(text).toHaveText("boom\nfine\ntotal 1 failed");
    await expect(text.locator('[data-colour="red"]')).toHaveText("boom");
    expect(await colour(text.locator('[data-colour="red"]'))).toBe(red);
    expect(await colour(text)).not.toBe(red);
    expect(await text.getByText("total", { exact: true }).evaluate((element) => getComputedStyle(element).fontWeight)).toBe("700");
    await shoot(page, "tab-run-output-colours");
    await output.getByTestId("run-output-copy").click();
    await expect(output.getByTestId("toast")).toHaveText("RunnerCopied the log");
    expect(await copied(page, `out:backup:${RUN}`)).toEqual(["boom\nfine\ntotal 1 failed\n"]);
  });

  test("an output tab whose run is gone from the history — Runner pruned it, Pomade restored the tab — closes itself", async ({ page }) => {
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [failed]);
    await app(page).getByRole("dialog", { name: "Backup" }).getByRole("button", { name: "View output" }).click();
    await expect(outputTab(page, `out:backup:${RUN}`).getByTestId("run-output-text")).toBeVisible();
    await page.evaluate(() => window.setRuns({ history: [] }));
    await expect.poll(() => page.evaluate(() => window.fakeHost.appTabs.map((tab) => tab.key ?? "runner"))).toEqual(["runner"]);
    await expect(page.locator(`iframe[data-frame="out:backup:${RUN}"]`)).toHaveCount(0);
    await expect(app(page).getByTestId("run-missing")).toHaveText("This run is not in the history any more.");
  });

  test("a run's card is a dialog over History: focus moves in and stays in; Esc, the close button or a click outside closes it", async ({ page }) => {
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [failed]);
    const dialog = app(page).getByRole("dialog", { name: "Backup" });
    await expect(dialog.getByTestId("run-result")).toHaveText("Failed");
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

  test("a git run's card has each repo with its commit and steps — a failed repo's red — and Run again", async ({ page }) => {
    const steps = [
      { step: "commit" as const, outcome: "done" as const, detail: "committed a1b2c3d (2 files)" },
      { step: "pull" as const, outcome: "done" as const, detail: "up to date with origin/main" },
      { step: "push" as const, outcome: "done" as const, detail: "pushed 1 commit to origin/main" },
    ];
    const reason = "Their changes conflict with yours in notes.md. Nothing was changed — the repository is exactly as before, and nothing was pushed.";
    const git: RunRecord = {
      ...failed,
      job: "notes",
      name: "Commit notes",
      kind: "git",
      exitCode: 1,
      reason: `Pomade: ${reason}`,
      lastLines: [],
      git: {
        op: "commit-push",
        job: "Commit notes",
        at: new Date(at(13, 0)).toISOString(),
        results: [
          { repo: "notes", path: "/fake/workspace/notes", op: "commit-push", status: "done", reason: null, steps, commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
          { repo: "blog", path: "/fake/workspace/Projects/blog", op: "commit-push", status: "skipped", reason: "agent working", steps: [], commit: null },
          { repo: "Pomade", path: "/fake/workspace/Projects/Pomade", op: "commit-push", status: "failed", reason, steps: [], commit: null },
        ],
      },
    };
    await page.goto(harness({ route: `run/notes/${RUN}` }));
    await setRuns(page, [git]);
    const card = app(page).getByTestId("run-card");
    await expect(app(page).getByTestId("run-result")).toHaveText("Failed");
    const repos = card.getByTestId("run-git-repo");
    await expect(repos).toHaveCount(3);
    await expect(repos.nth(0)).toHaveAttribute("data-status", "done");
    await expect(repos.nth(0)).toContainText("notesa1b2c3d");
    await expect(repos.nth(0).getByTestId("run-git-step")).toHaveText(["committed a1b2c3d (2 files)", "up to date with origin/main", "pushed 1 commit to origin/main"]);
    await expect(repos.nth(1).getByTestId("run-git-step")).toHaveText(["agent working"]);
    await expect(repos.nth(1).getByTestId("run-git-step")).toHaveAttribute("data-outcome", "skipped");
    const failedStep = repos.nth(2).getByTestId("run-git-step");
    await expect(failedStep).toHaveText(reason);
    await expect(failedStep).toHaveCSS("color", await failedStep.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger-text)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }));
    await expect(card.getByTestId("run-last-lines")).toHaveCount(0);
    await shoot(page, "tab-run-git");
    await app(page).getByRole("button", { name: "Run again" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toContainEqual({ method: "jobs.run", params: { job: "notes" } });
  });

  test("a failed repo on a git run's card has Open in Git while Pomade serves git.reveal: the call names the repo and the project that holds it; a done repo or run has none; an older Pomade, none at all", async ({ page }) => {
    const repo = (name: string, path: string, status: "done" | "failed") => ({
      repo: name,
      path,
      op: "pull" as const,
      status,
      reason: { done: null, failed: `Their changes conflict with yours in ${name}.md.` }[status],
      steps: [{ step: "pull" as const, outcome: status, detail: { done: "got 2 commits from origin/main", failed: "conflict" }[status] }],
      commit: null,
    });
    const git: RunRecord = {
      ...failed,
      job: "pull",
      name: "Pull",
      kind: "git",
      project: "alpha",
      exitCode: 1,
      reason: "blog: conflict",
      lastLines: [],
      git: {
        op: "pull",
        job: "Pull",
        at: new Date(at(13, 0)).toISOString(),
        results: [repo("notes", "/fake/workspace/notes", "done"), repo("blog", "/fake/workspace/Projects/blog", "failed"), repo("notes", "/fake/workspace/notes", "failed"), repo("gone", "/fake/workspace/Projects/gone", "failed")],
      },
    };
    // The job's project, alpha, does not hold blog; blog and zeta do — blog first by id. No project holds notes.
    const projects = JSON.stringify([
      { id: "zeta", name: "Zeta", root: "Projects" },
      { id: "alpha", name: "Alpha", root: "Projects/alpha" },
      { id: "blog", name: "Blog", root: "Projects/blog" },
    ]);
    const query = { route: `run/pull/${RUN}`, projects, repos: "blog=Projects/blog" };
    await page.goto(harness({ ...query, gitReveal: "1" }));
    await setRuns(page, [git]);
    const repos = app(page).getByTestId("run-card").getByTestId("run-git-repo");
    await expect(repos).toHaveCount(4);
    const open = (index: number) => repos.nth(index).getByRole("button", { name: "Open in Git" });
    await expect(open(1)).toBeVisible();
    await expect(open(0)).toHaveCount(0);
    await expect(open(2)).toBeVisible();
    await expect(app(page).getByRole("button", { name: "Open in Git" })).toHaveCount(3);
    // One probe for the UI session, its path empty — not a reveal.
    expect(await page.evaluate(() => [window.gitRevealAsked, window.gitReveals.length])).toEqual([1, 0]);
    await open(1).hover();
    await expect(app(page).getByTestId("tooltip")).toContainText("Opens Pomade's Git panel at this repo");
    await shoot(page, "tab-run-git-open-in-git");
    await open(1).click();
    await expect.poll(() => page.evaluate(() => window.gitReveals)).toEqual([{ path: "/fake/workspace/Projects/blog", projectId: "blog" }]);
    await open(2).click();
    await expect.poll(() => page.evaluate(() => window.gitReveals.at(-1))).toEqual({ path: "/fake/workspace/notes", projectId: "__workspace__" });
    // A repo Pomade does not have: the call says not-found, and the card says so.
    await open(3).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerCould not open gone in Git: Pomade has no such repo or project now");

    // A done run's card: no Open in Git.
    await setRuns(page, [{ ...git, state: "done", reason: null, exitCode: 0, git: { ...git.git!, results: [repo("blog", "/fake/workspace/Projects/blog", "done")] } }]);
    await expect(repos).toHaveCount(1);
    await expect(app(page).getByRole("button", { name: "Open in Git" })).toHaveCount(0);

    // A Pomade without git.reveal (the fake host answers unknown-method): the failed repos have no button.
    await page.goto(harness(query));
    await setRuns(page, [git]);
    await expect(repos).toHaveCount(4);
    await expect.poll(() => page.evaluate(() => window.gitRevealAsked)).toBe(1);
    await expect(app(page).getByTestId("run-result")).toHaveText("Failed");
    await expect(repos.nth(1).getByTestId("run-git-step")).toHaveText("conflict");
    await expect(app(page).getByRole("button", { name: "Open in Git" })).toHaveCount(0);
    await shoot(page, "tab-run-git-no-reveal");
  });

  test("the tab opens at a run's route, as a notice's click opens it", async ({ page }) => {
    await page.goto(harness({ route: `run/backup/${RUN}` }));
    await setRuns(page, [failed]);
    await expect(app(page).getByTestId("run-result")).toHaveText("Failed");
    await expect(app(page).getByTestId("run-card").getByTestId("run-exit")).toHaveText("2");
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
    agent: null,
    missed: null,
    series: null,
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
  const missed: NeedsYouItem = { id: "missed:weekly", kind: "missed", job: "weekly", name: "Weekly", project: null, run: weekly.run, at: weekly.dueAt, missed: null, detail: "missed Sun 03:00" };
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
    switch: { position: "running", since: null }, heldRuns: 0,
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
    await expect(app(page).getByTestId("switch-note")).toHaveText("Low-priority jobs are held. Services keep running.");
    await control.getByRole("button", { name: "Pause all" }).click();
    await expect(app(page).getByTestId("switch-note")).toHaveText("Every scheduled job is held. Services keep running.");
    await shoot(page, "panel-paused");
    await control.getByRole("button", { name: "Running" }).click();
    await expect(app(page).getByTestId("switch-note")).toHaveCount(0);
    expect((await page.evaluate(() => window.runnerCalls)).map((call) => call.params)).toEqual([{ position: "pause-low" }, { position: "pause-all" }, { position: "running" }]);
  });

  test("T-025 · the switch's note counts the runs it has held; a missed run that stands for more than one says how many in Needs you", async ({ page }) => {
    await open(page, { surface: "panel" });
    const note = app(page).getByTestId("switch-note");
    const set = (patch: Partial<RunsReport>) => page.evaluate((r) => window.setRuns({ report: r, history: [] }), { ...report, ...patch });
    await set({ switch: { position: "pause-low", since: 1 }, heldRuns: 0 });
    await expect(note).toHaveText("Low-priority jobs are held. Services keep running.");
    await set({ switch: { position: "pause-low", since: 1 }, heldRuns: 1 });
    await expect(note).toHaveText("Low-priority jobs are held · 1 run so far. Services keep running.");
    await set({ switch: { position: "pause-low", since: 1 }, heldRuns: 4 });
    await expect(note).toHaveText("Low-priority jobs are held · 4 runs so far. Services keep running.");
    await shoot(page, "panel-switch-held-count");
    await set({ switch: { position: "pause-all", since: 1 }, heldRuns: 9 });
    await expect(note).toHaveText("Every scheduled job is held · 9 runs so far. Services keep running.");
    // The note keeps to the panel: one line of words wraps, nothing is cut.
    const fits = await note.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(fits).toBe(true);

    const three = { count: 3, first: new Date(2026, 10, 22, 2, 56).getTime(), last: weekly.dueAt };
    await set({ switch: { position: "pause-low", since: 1 }, heldRuns: 4, active: [{ ...weekly, missed: three }], needsYou: [{ ...missed, missed: three, detail: "missed 3 runs, 02:56–03:00" }] });
    await expect(app(page).locator('[data-testid="needs-you-item"][data-kind="missed"]').getByTestId("needs-you-words")).toHaveText("Missed 3 runs, 02:56–03:00 — it waits for you to pick a time.");
    await shoot(page, "panel-missed-runs");
  });

  test("T-033 · the switch's count opens History on Skipped & missed, where each held job has its row", async ({ page }) => {
    await open(page, { surface: "panel" });
    const lint: HeldRun = { state: "held", job: "lint", name: "Lint", kind: "script", project: null, folder: "", missed: { count: 2, first: at(8, 40), last: at(8, 42) } };
    const backup: HeldRun = { ...lint, job: "backup", name: "Backup", missed: { count: 1, first: at(8, 42), last: at(8, 42) } };
    const holding: RunsReport = { ...report, switch: { position: "pause-low", since: 1 }, heldRuns: 3 };
    await page.evaluate((r) => window.setRuns({ report: r, held: [] }), holding);
    const count = app(page).getByTestId("switch-held-runs");
    await expect(count).toHaveRole("button");
    await expect(count).toHaveText("3 runs so far");
    // A held row never makes a Needs-you card: the panel's are the report's own.
    await expect(app(page).getByTestId("needs-you-item")).toHaveCount(2);
    await shoot(page, "panel-switch-held-link");
    await count.click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: "history/missed" }]);

    // The Runner tab at that route: Skipped & missed is on, a row per held job; the route goes back to History.
    await page.setViewportSize({ width: 1040, height: 700 });
    await page.goto(harness({ route: "history/missed" }));
    await page.waitForFunction(() => typeof window.setRuns === "function");
    await page.evaluate(([r, h]) => window.setRuns({ report: r, held: [...h], history: [] }), [holding, [backup, lint]] as const);
    await expect(app(page).getByTestId("history-filter-missed")).toHaveAttribute("aria-pressed", "true");
    const held = app(page).locator('[data-testid="history-row"][data-state="held"]');
    await expect(held).toHaveCount(2);
    await expect(held.filter({ hasText: "Lint" }).getByTestId("history-result")).toHaveText("held · 2 runs so far, 08:40–08:42");
    await expect(held.filter({ hasText: "Backup" }).getByTestId("history-result")).toHaveText("held · 1 run so far, 08:42");
    await expect(held.first().getByTestId("history-trigger")).toHaveText("scheduled");
    // The chip counts them with the missed run that waits for you; Active does not.
    await expect(app(page).getByTestId("history-filter-missed")).toContainText("3");
    await expect(app(page).getByTestId("history-filter-active")).toContainText("3");
    await expect.poll(() => page.evaluate(() => window.fakeHost.appTabs.map((tab) => tab.route))).toEqual(["history"]);
    await shoot(page, "tab-history-held");
    // The chip changed, then the count clicked again: Skipped & missed is on again.
    await app(page).getByTestId("history-filter-all").click();
    await expect(app(page).getByTestId("history-filter-missed")).toHaveAttribute("aria-pressed", "false");
    await page.evaluate((route) => window.fakeHost.openAppTab({ route }), "history/missed");
    await expect(app(page).getByTestId("history-filter-missed")).toHaveAttribute("aria-pressed", "true");
    // A held row opens its job.
    await held.filter({ hasText: "Lint" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.appTabs.map((tab) => tab.route))).toEqual(["jobs/lint"]);
    // Released: the held rows are gone, the records take their place.
    await page.evaluate(() => window.setRuns({ held: [] }));
    await app(page).getByTestId("nav-history").click();
    await expect(app(page).getByTestId("history-row")).toHaveCount(4);
    await expect(held).toHaveCount(0);
  });

  test("a missed run waits for you: Run now · Run at… · Skip", async ({ page }) => {
    await open(page, { surface: "panel" });
    const item = app(page).locator('[data-testid="needs-you-item"][data-kind="missed"]');
    await expect(item.getByTestId("needs-you-words")).toHaveText("Missed — it waits for you to pick a time.");
    await item.getByRole("button", { name: "Run at…" }).click();
    await item.getByRole("textbox", { name: "Run at" }).fill("23:00");
    await expect(item.getByTestId("run-at-hint")).toHaveText(/^→ (today|tomorrow) 23:00$/);
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

  test("T-026 · a missed run that stands for more than one: Run once · Run all N · Run at… · Skip, wrapped cleanly in the 240 px panel; above 20, Run all asks once more, naming the number", async ({ page }) => {
    await open(page, { surface: "panel" });
    const item = app(page).locator('[data-testid="needs-you-item"][data-kind="missed"]');
    const set = (count: number) => {
      const counted = { count, first: new Date(2026, 10, 22, 2, 56).getTime(), last: weekly.dueAt };
      return page.evaluate((r) => window.setRuns({ report: r, history: [] }), { ...report, active: [{ ...weekly, missed: counted }], needsYou: [{ ...missed, missed: counted, detail: `missed ${count} runs, 02:56–03:00` }] });
    };
    // One missed run: as it always was.
    await expect(item.getByRole("button", { name: "Run now" })).toHaveCount(1);
    await expect(item.getByRole("button", { name: /^Run all/ })).toHaveCount(0);

    await set(3);
    const actions = item.getByRole("button").filter({ hasText: /^(Run once|Run all 3|Run at…|Skip)$/ });
    await expect(actions).toHaveText(["Run once", "Run all 3", "Run at…", "Skip"]);
    // The four buttons wrap to a second row inside the card: none cut, none past its edge, each row starting at the same left.
    // Each button's left, right and top against the card's inner edges (its padding box).
    const placed = await actions.evaluateAll((all) =>
      all.map((button) => {
        const box = button.getBoundingClientRect();
        const card = button.closest('[data-testid="needs-you-item"] > div')?.getBoundingClientRect() ?? new DOMRect();
        return { inside: box.left >= card.left && box.right <= card.right - 8, left: Math.round(box.left), top: Math.round(box.top) };
      }),
    );
    expect(placed.map((box) => box.inside)).toEqual([true, true, true, true]);
    // Two rows — Run once and Run all 3 on the first, Run at… and Skip on the second — each starting at the same left.
    expect(placed.map((box) => box.top === placed[0]?.top)).toEqual([true, true, false, false]);
    expect(placed[2]?.left).toBe(placed[0]?.left);
    await shoot(page, "panel-missed-run-all");

    await item.getByRole("button", { name: "Run all 3" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerWeekly 3 runs queued, one after another");
    await expect(app(page).getByTestId("run-all-confirm")).toHaveCount(0);
    await item.getByRole("button", { name: "Run once" }).click();

    await set(25);
    await item.getByRole("button", { name: "Run all 25" }).click();
    const confirm = app(page).getByTestId("run-all-confirm");
    await expect(confirm.getByRole("heading")).toHaveText("Run 25 runs?");
    await expect(confirm).toContainText("Runner runs Weekly 25 times, one after another, each when the queue lets it. Stopping one of them drops the rest.");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await shoot(page, "panel-run-all-confirm");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await item.getByRole("button", { name: "Run all 25" }).click();
    await confirm.getByRole("button", { name: "Run all 25" }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "runs.missed", params: { job: "weekly", choice: "run-all" } },
      { method: "runs.missed", params: { job: "weekly", choice: "run-now" } },
      // Cancel ran nothing; the confirmed one ran all 25.
      { method: "runs.missed", params: { job: "weekly", choice: "run-all" } },
    ]);
  });

  test("a long run asks whether it is still expected: Open · Stop · Dismiss", async ({ page }) => {
    await open(page, { surface: "panel" });
    const started = await page.evaluate(() => Date.now() - (3 * 60 + 2) * 60_000);
    await page.evaluate((r) => window.setRuns({ report: r, history: [] }), { ...report, needsYou: [{ ...longRun, at: started + 3 * 3_600_000, startedAt: started }, missed] });
    const item = app(page).locator('[data-testid="needs-you-item"][data-kind="long-run"]');
    await expect(item.getByTestId("needs-you-words")).toHaveText("Running 3h — still expected?");
    await item.getByRole("button", { name: "Open" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: base.session }, title: "Summary" }]);
    await item.getByRole("button", { name: "Stop" }).click();
    await item.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "runs.stop", params: { job: "summary", run: base.run } },
      { method: "needsYou.dismiss", params: { id: longRun.id } },
    ]);
  });

  test("Running now shows what each queued run waits for, in the panel and as History's rows", async ({ page }) => {
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
    const history = app(page).getByTestId("history-row");
    await expect(history).toHaveCount(4);
    await expect(app(page).locator('[data-testid="history-row"][data-job="lint"]')).toContainText("queued · 1 ahead");
    await expect(app(page).locator('[data-testid="history-row"][data-job="late"]')).toContainText("queued · warm-up until 08:32");
    await expect(app(page).locator('[data-testid="history-row"][data-job="weekly"]')).toContainText("missed · waiting for you");
    await shoot(page, "tab-history-queued");
  });

  test("a missed run's card offers its choices; a running run's card, Stop; a run stopped at its time limit is red", async ({ page }) => {
    await page.setViewportSize({ width: 1040, height: 700 });
    await open(page, { route: `run/weekly/${weekly.run}` });
    const card = app(page).getByTestId("run-card");
    const dialog = app(page).getByTestId("run-dialog");
    await expect(card).toHaveAttribute("data-state", "missed-waiting");
    await expect(dialog).toHaveAttribute("data-tone", "warning");
    await expect(app(page).getByTestId("run-result")).toHaveText("Missed · waiting for you");
    await expect(dialog.getByRole("button", { name: "Run now" })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Skip" })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Run at…" }).click();
    await expect(dialog.getByRole("textbox", { name: "Run at" })).toHaveValue("tonight 23:00");
    await dialog.getByRole("textbox", { name: "Run at" }).fill("23:00");
    await expect(dialog.getByTestId("run-at-hint")).toContainText("→ ");
    await shoot(page, "tab-run-missed");
    await dialog.getByRole("button", { name: "Set" }).click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate((route) => window.mounted.navigate(route), `run/summary/${base.run}`);
    await expect(app(page).getByTestId("run-result")).toHaveText("Running");
    await dialog.getByRole("button", { name: "Stop run" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "runs.missed", params: { job: "weekly", choice: "run-at", at: "23:00" } },
      { method: "runs.stop", params: { job: "summary", run: base.run } },
    ]);

    const stopped: RunRecord = { ...base, state: "failed", event: null, reason: "stopped: time limit, 45 min", endedAt: at(7, 45), durationMs: 45 * 60_000, exitCode: null, signal: "SIGTERM", lastLines: ["still summarizing"], git: null, limitHit: 45 };
    await page.evaluate((h) => window.setRuns({ report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 }, history: h }), [stopped]);
    // The host still has the tab at this run's route: the card closed in the frame alone.
    await page.evaluate((route) => window.mounted.navigate(route), "history");
    await expect(app(page).locator('[data-testid="history-row"][data-job="summary"]').getByTestId("history-result")).toHaveText("stopped: time limit, 45 min");
    await page.evaluate((route) => window.mounted.navigate(route), `run/summary/${base.run}`);
    await expect(app(page).getByTestId("run-result")).toHaveText("Stopped: time limit");
    await expect(dialog).toHaveAttribute("data-tone", "danger");
    // The job's limit, not an exit code or a reason line; the help explains it.
    await expect(card.getByTestId("run-limit")).toHaveText("Time limit, 45 min — the job’s time limit");
    await expect(card.getByTestId("run-exit")).toHaveCount(0);
    await expect(card.getByTestId("run-why")).toHaveCount(0);
    await expect(card.getByTestId("run-last-lines")).toHaveText("still summarizing");
    await app(page).getByTestId("run-result").hover();
    await expect(app(page).getByTestId("tooltip")).toHaveText("The run hit its job's time limit and was stopped.Example: stopped: time limit, 45 min.");
    await shoot(page, "tab-run-time-limit");
  });

  test("T-026 · a waiting missed run's card offers Run once · Run all N · Run at… · Skip; a caught-up run that stood for more than one, while its job's latest, Run the other N — above 20 after a confirm; History says caught up n of N", async ({ page }) => {
    await page.setViewportSize({ width: 1040, height: 700 });
    const counted = (count: number) => ({ count, first: new Date(2026, 10, 18, 7, 0).getTime(), last: new Date(2026, 10, 20, 7, 0).getTime() });
    const waiting: ActiveRun = { ...weekly, missed: counted(3) };
    await open(page, { route: `run/weekly/${weekly.run}` });
    await page.evaluate((r) => window.setRuns({ report: r, history: [] }), { ...report, active: [waiting], needsYou: [{ ...missed, missed: counted(3), detail: "missed 3 runs" }] });
    const dialog = app(page).getByTestId("run-dialog");
    await expect(app(page).getByTestId("run-card").getByTestId("run-missed-runs")).toHaveText("This job missed 3 runs, Wed 07:00–Fri 07:00.");
    await expect(dialog.getByTestId("dialog-foot").getByRole("button")).toHaveText(["Run once", "Run all 3", "Run at…", "Skip", "Edit job"]);
    await shoot(page, "tab-run-missed-run-all");
    await dialog.getByRole("button", { name: "Run all 3" }).click();
    await expect(dialog).toHaveCount(0);

    // A caught-up run that stood for 3, ended, its job's latest: Run the other 2.
    const caught: RunRecord = { ...base, job: "weekly", name: "Weekly", run: "20261120-090000-cccccc", trigger: "caught-up", missed: counted(3), state: "done", event: null, reason: null, startedAt: at(9, 0), endedAt: at(9, 1), durationMs: 60_000, exitCode: 0, signal: null, lastLines: ["weekly done"], git: null, limitHit: null };
    const latest = (record: RunRecord | null) => ({ job: "weekly", next: null, finished: false, last: record, held: false });
    const show = (records: RunRecord[], last: RunRecord | null, active: ActiveRun[] = []) =>
      page.evaluate((r) => window.setRuns(r), { report: { ...report, active, needsYou: [], jobs: [latest(last)] }, history: records });
    await show([caught], caught);
    await page.evaluate((route) => window.mounted.navigate(route), `run/weekly/${caught.run}`);
    await expect(app(page).getByTestId("run-trigger")).toHaveText("caught up");
    await expect(dialog.getByTestId("run-dialog").or(dialog).getByText("Missed 3 runs, Wed 07:00–Fri 07:00 — caught up once")).toHaveCount(1);
    await expect(dialog.getByTestId("dialog-foot").getByRole("button")).toHaveText(["View output", "Run the other 2", "Run again", "Edit job"]);
    await shoot(page, "tab-run-caught-up-others");
    await dialog.getByRole("button", { name: "Run the other 2" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerWeekly 2 runs queued, one after another");

    // No longer its job's latest, or a Run all of the job going: no Run the other.
    const later: RunRecord = { ...caught, run: "20261120-100000-dddddd", trigger: "scheduled", missed: null };
    await show([later, caught], later);
    await page.evaluate((route) => window.mounted.navigate(route), `run/weekly/${caught.run}`);
    await expect(dialog.getByTestId("dialog-foot").getByRole("button")).toHaveText(["View output", "Run again", "Edit job"]);
    const second: ActiveRun = { ...weekly, run: "20261120-091000-eeeeee", state: "queued", trigger: "caught-up", missed: counted(3), series: { n: 2, of: 3 }, waits: { kind: "slot", ahead: 1 } };
    await show([caught], caught, [second]);
    await expect(dialog.getByTestId("dialog-foot").getByRole("button")).toHaveText(["View output", "Run again", "Edit job"]);

    // Above 20: a confirm that names the number; Cancel runs nothing.
    const many: RunRecord = { ...caught, missed: counted(26) };
    await show([many], many);
    await dialog.getByRole("button", { name: "Run the other 25" }).click();
    const confirm = app(page).getByTestId("run-all-confirm");
    await expect(confirm.getByRole("heading")).toHaveText("Run 25 runs?");
    await expect(confirm.getByRole("button", { name: "Run the other 25" })).toHaveCount(1);
    await shoot(page, "tab-run-all-confirm");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    // Esc closed the confirm alone: the card stays.
    await expect(dialog).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "runs.missed", params: { job: "weekly", choice: "run-all" } },
      { method: "runs.missed", params: { job: "weekly", choice: "run-others", run: caught.run } },
    ]);

    // History: each run of the series a row, caught up n of 3; the rest dropped when one was stopped.
    const ofThree = (n: number, extra: Partial<RunRecord> = {}): RunRecord => ({ ...caught, run: `20261120-09${n}000-ffffff`, series: { n, of: 3 }, startedAt: at(9, n * 2), endedAt: at(9, n * 2 + 1), ...extra });
    const dropped: RunRecord = { ...caught, job: "daily", name: "Daily", run: "20261120-100500-aaaaaa", missed: null, state: "skipped", reason: "2 dropped: you stopped run 2 of 4", dueAt: at(10, 5), startedAt: null, endedAt: at(10, 5), durationMs: null, exitCode: null, lastLines: [] };
    const stopped: RunRecord = { ...caught, job: "daily", name: "Daily", run: "20261120-100400-bbbbbb", missed: counted(4), series: { n: 2, of: 4 }, state: "stopped-by-you", dueAt: at(10, 4), startedAt: at(10, 4), endedAt: at(10, 5), exitCode: null, signal: "SIGINT" };
    const third: ActiveRun = { ...second, run: "20261120-103000-ffffff", dueAt: at(10, 30), series: { n: 3, of: 3 } };
    await show([dropped, stopped, ofThree(2), ofThree(1)], ofThree(2), [third]);
    await page.evaluate((route) => window.mounted.navigate(route), "history");
    const rows = app(page).getByTestId("history-row");
    await expect(rows.getByTestId("history-trigger")).toHaveText([
      "caught up 3 of 3",
      "caught up",
      "caught up 2 of 4",
      "caught up 2 of 3",
      "caught up 1 of 3",
    ]);
    await expect(rows.getByTestId("history-result")).toHaveText(["queued · 1 ahead", "skipped · 2 dropped: you stopped run 2 of 4", "stopped by you", "done", "done"]);
    await shoot(page, "tab-history-run-all");
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

    await help.focus();
    // The stepper's −, its value and its +, then the next setting's (i).
    for (let tab = 0; tab < 4; tab++) await page.keyboard.press("Tab");
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
    agent: null,
    missed: null,
    series: null,
    state: "done",
    event: null,
    reason: null,
    startedAt: at(13, 0),
    endedAt: at(13, 0) + 2000,
    durationMs: 2000,
    exitCode: 0,
    signal: null,
    log: "/ud/output/pull/a.log",
    lastLines: ["Already up to date."],
    git: null,
    limitHit: null,
  };
  const cause = { kind: "chain" as const, job: "pull", name: "Pull", run: pull.run, result: "done" as const };
  const tests: RunRecord = { ...pull, job: "tests", name: "Tests", run: "20261118-120002-bbbbbb", trigger: "chain", cause, dueAt: pull.endedAt, startedAt: pull.endedAt, endedAt: pull.endedAt + 5000, lastLines: ["12 passed"] };
  const web: RunRecord = { ...pull, job: "web", name: "Web", kind: "service", run: "20261118-120002-cccccc", trigger: "chain", cause, dueAt: pull.endedAt, event: chainEvent("restart"), startedAt: null, durationMs: null, exitCode: null, log: null, lastLines: [], endedAt: pull.endedAt + 1000 };
  const mount: RunRecord = { ...pull, job: "mount", name: "Mount", run: "20261118-070000-dddddd", trigger: "hook", cause: { kind: "hook", event: "login", context: {} }, dueAt: at(8, 0), startedAt: at(8, 2), endedAt: at(8, 2) + 1000 };
  const paused: NeedsYouItem = { id: "loop-paused:lint", kind: "loop-paused", job: "lint", name: "Lint", project: null, at: at(14, 0), detail: "triggered 10× in 10 min — looks like a loop" };
  const quiet: RunsReport = { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 };

  test("History says what started each run — chain: after Pull, hook: Mac login — and a service's chain action; a chain run's card opens the run it followed", async ({ page }) => {
    await page.goto(harness({ route: "history" }));
    await page.waitForFunction(() => typeof window.setRuns === "function");
    await page.evaluate((h) => window.setRuns({ report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 }, history: h }), [tests, web, pull, mount]);
    const rows = app(page).getByTestId("history-row");
    await expect(rows).toHaveCount(4);
    await expect(app(page).getByTestId("history-trigger")).toHaveText(["chain", "chain: after Pull", "scheduled", "hook: Mac login"]);
    await expect(app(page).locator('[data-testid="history-row"][data-job="web"]')).toContainText("restarted");
    await shoot(page, "tab-history-chains");

    await app(page).locator('[data-testid="history-row"][data-job="tests"]').click();
    const dialog = app(page).getByTestId("run-dialog");
    await expect(dialog.getByTestId("run-trigger")).toHaveText("chain");
    await expect(dialog).toContainText("After Pull: done");
    await dialog.getByRole("button", { name: "Open Pull's run" }).click();
    await expect(dialog.getByTestId("run-trigger")).toHaveText("scheduled");
    await expect(dialog.getByRole("button", { name: "Open Pull's run" })).toHaveCount(0);
    await expect(dialog.getByTestId("run-last-lines")).toHaveText("Already up to date.");
  });

  test("T-047 · a service's events are History rows: no duration, the cause as trigger; Service events hides them, gave up counts as failed; a card says the cause and the session, with Open terminal or Start", async ({ page }) => {
    await page.goto(harness({ route: "history" }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await page.evaluate((text) => window.fakeHost.writeFile("Apps/pomade-runner/jobs/web.md", text), "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n");
    const live = Date.now() - 60_000;
    const event = (run: string, what: ServiceEvent["what"], cause: ServiceEvent["cause"], more: Partial<ServiceEvent>, rest: Partial<RunRecord> = {}): RunRecord => ({
      ...web,
      run,
      trigger: "manual",
      cause: null,
      dueAt: at(9, Number(run.slice(-2))),
      endedAt: at(9, Number(run.slice(-2))),
      event: { what, cause, detail: null, session: null, ended: [], restarts: 0, ends: [], ...more },
      ...rest,
    });
    const started = event("20261118-090000-ev0010", "started", "you", { session: live });
    const window_ = event("20261118-090000-ev0005", "restarted", "crash", { session: 2, ended: [1], restarts: 4, ends: [{ code: 1, signal: null }, { code: 137, signal: null }] }, { exitCode: 137 });
    const gaveUp = event("20261118-090000-ev0006", "gave-up", "crash", { ended: [2] }, { state: "failed", exitCode: 1 });
    await page.evaluate((runs) => window.setRuns(runs), { report: quiet, history: [started, gaveUp, window_, pull] });
    await page.evaluate((startedAt) => window.setServiceStatus("web", { state: "running", session: { id: "svc:web", job: "web", kind: "service", run: null, log: null, info: { id: "svc:web", title: "Web", command: "./web.sh", cwd: "/fake/workspace", pid: 7, startedAt, cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: [] } } }), live);

    const rows = app(page).getByTestId("history-row");
    await expect(rows).toHaveCount(4);
    await expect(app(page).locator('[data-testid="history-row"][data-event]').getByTestId("history-result")).toHaveText(["started", "gave up after 5 crashes", "restarted 4× · exit 1, 137"]);
    await expect(app(page).locator('[data-testid="history-row"][data-event]').getByTestId("history-trigger")).toHaveText(["you", "crash", "crash"]);
    await expect(app(page).locator('[data-testid="history-row"][data-event]').getByTestId("history-duration")).toHaveText(["", "", ""]);
    await expect(app(page).getByTestId("history-events")).toHaveAttribute("aria-pressed", "true");
    await expect(app(page).getByTestId("history-events")).toContainText("Service events3");
    await expect(app(page).getByTestId("history-filter-failed")).toContainText("1");
    await app(page).getByTestId("history-filter-failed").click();
    await expect(rows).toHaveCount(1);
    await app(page).getByTestId("history-filter-all").click();
    await app(page).getByTestId("history-events").click();
    await expect(rows).toHaveCount(1);
    await expect(app(page).getByTestId("history-filter-failed")).toContainText("0");
    // The chip is the tab's, like This project: it stays off while the person visits Jobs and comes back.
    await app(page).getByTestId("nav-jobs").click();
    await app(page).getByTestId("nav-history").click();
    await expect(app(page).getByTestId("history-events")).toHaveAttribute("aria-pressed", "false");
    await expect(rows).toHaveCount(1);
    await app(page).getByTestId("history-events").click();

    await app(page).locator('[data-event="started"]').click();
    const dialog = app(page).getByTestId("run-dialog");
    await expect(dialog.getByTestId("run-result")).toHaveText("Started");
    await expect(dialog.getByTestId("run-trigger")).toHaveText("by you");
    await expect(dialog.getByTestId("event-cause")).toHaveText("You pressed Start.");
    await expect(dialog.getByTestId("event-session")).toContainText("still going · up 1m");
    await expect(dialog.getByRole("button", { name: "View output" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Open terminal" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([expect.objectContaining({ kind: "attached", session: { app: "pomade-runner", session: "svc:web" }, title: "Web" })]);

    await page.keyboard.press("Escape");
    await app(page).locator('[data-event="gave-up"]').click();
    await expect(dialog.getByTestId("run-result")).toHaveText("Gave up");
    await expect(dialog.getByTestId("run-exit")).toHaveText("1");
    await expect(dialog.getByRole("button", { name: "Start" })).toHaveCount(0);
    await page.evaluate(() => window.setServiceStatus("web", { state: "failed" }));
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toContainEqual({ method: "services.start", params: { job: "web" } });

    await app(page).locator('[data-event="restarted"]').click();
    await expect(dialog.getByTestId("run-result")).toHaveText("Restarted after a crash");
    await expect(dialog.getByTestId("event-session")).toHaveText(/^ended .*9:06 — it crashed; Runner gave up$/);
    await shoot(page, "tab-history-events-card");
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
    await expect(item.getByTestId("needs-you-words")).toHaveText("Paused: triggered 10× in 10 min.");
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
    // By path: Mount, Pull, Tests, Web.
    await expect(app(page).getByTestId("job-trigger")).toHaveText(["at Mac login", "daily at 13:00", "after Pull finishes either way", "always on · starts on Mac startup · restarts after Pull is done"]);
    await expect(app(page).getByTestId("job-next")).toHaveText(["on event", "—", "on event", "always on"]);
    await shoot(page, "tab-jobs-chains");
  });
});

test.describe("the job form", () => {
  test.use({ viewport: { width: 1040, height: 760 } });
  const WEB = "Apps/pomade-runner/jobs/alpha/dev-server.md";
  const HAND = "---\nkind: service # the dev server\nname: Dev server\nproject: alpha\nfolder: Projects/alpha\ncommand: ./start.sh\nready: { port: 5173 } # vite\n---\nNotes for humans.\n";

  async function start(page: Page, query: Record<string, string> = {}): Promise<void> {
    await page.goto(harness(query));
    // The stand-in scheduler watches the jobs folder by the time it can set a service's state.
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
  }

  /** Pomade navigates the tab to `route` (from Jobs first: the host tells the tab only of a change). */
  async function navigate(page: Page, route: string): Promise<void> {
    await page.evaluate((r) => {
      window.mounted.navigate("");
      window.mounted.navigate(r);
    }, route);
  }

  /** The text of a file in the fake workspace; `null` when there is none. */
  function fileText(page: Page, path: string): Promise<string | null> {
    return page.evaluate((p) => {
      try {
        return window.fakeHost.readFile(p);
      } catch {
        return null;
      }
    }, path);
  }

  test("New job opens the form; a service made in it is a job file in its project's sub-folder, and the tab goes back to Jobs with a toast", async ({ page }) => {
    await start(page, { projects: "prototype" });
    await app(page).getByTestId("empty-new-job").click();
    const form = app(page).getByTestId("form-service");
    await expect(app(page).getByTestId("form-title")).toHaveText("Jobs / New job");
    // Every kind is offered, with its help; a new job starts as a service.
    await expect(form.getByTestId("kind-service")).toHaveAttribute("aria-checked", "true");
    for (const kind of ["script", "agent", "git"]) await expect(form.getByTestId(`kind-${kind}`)).toHaveAttribute("aria-checked", "false");

    await form.getByRole("textbox", { name: "Name", exact: true }).fill("Dev server");
    await form.getByRole("textbox", { name: "Command", exact: true }).fill("./start.sh");
    // Choose…: a project's folder fills in the folder and the project.
    await form.getByRole("button", { name: "Choose…" }).click();
    const menu = app(page).getByTestId("folder-menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["workspaceworkspace root", "notesnotes", "PomadeProjects/Pomade", "pomade-kitProjects/pomade-kit", "pomade-runnerProjects/pomade-runner", "AlphaProjects/alpha", "blogProjects/blog", "shopProjects/shop", "Other folder…Pomade's folder picker"]);
    await menu.getByRole("menuitem", { name: /^blog/ }).click();
    await expect(form.getByRole("textbox", { name: "Folder", exact: true })).toHaveValue("Projects/blog");
    const project = form.getByRole("combobox", { name: "Project" });
    await expect(project).toHaveValue("blog");
    // The projects under their groups, after the Workspace.
    await expect(project.locator("optgroup")).toHaveCount(3);
    await expect(project.locator('optgroup[label="Side projects"] option')).toHaveText(["Alpha", "blog", "shop"]);
    // Other folder…: Pomade's folder picker; a folder outside every project keeps the project.
    await page.evaluate(() => {
      window.fakeHost.writeFile("Projects/blog/web/index.html", "");
      window.fakeHost.answerPick("Projects/blog/web");
    });
    await form.getByRole("button", { name: "Choose…" }).click();
    await menu.getByRole("menuitem", { name: /^Other folder/ }).click();
    await expect(form.getByRole("textbox", { name: "Folder", exact: true })).toHaveValue("Projects/blog/web");
    expect(await page.evaluate(() => window.fakeHost.pickRequests)).toEqual([{ kind: "folder", root: "", initial: "Projects/blog" }]);
    await form.getByRole("textbox", { name: "Folder", exact: true }).fill("Projects/blog");

    // Readiness: collapsed to a line until asked for.
    await form.getByRole("button", { name: "Check a port or URL instead" }).click();
    await form.getByRole("button", { name: "A port is open" }).click();
    await form.getByRole("textbox", { name: "Port" }).fill("5173");
    // Policies: one sentence until Change.
    await expect(form.getByTestId("policy-summary")).toHaveText("Normal priority · notifies on failure");
    await form.getByTestId("form-policies").getByRole("button", { name: "Change" }).click();
    await form.getByRole("button", { name: "Always" }).click();
    await expect(form.getByTestId("form-policies")).toContainText("customised");
    await expect(app(page).getByTestId("form-path")).toHaveText("Apps/pomade-runner/jobs/blog/dev-server.md");
    await shoot(page, "tab-form-new");

    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("toast")).toHaveText("RunnerCreated Apps/pomade-runner/jobs/blog/dev-server.md · started");
    await expect(app(page).getByTestId("tab-jobs").getByTestId("job-row")).toContainText("Dev server");
    expect(await fileText(page, "Apps/pomade-runner/jobs/blog/dev-server.md")).toBe(
      "---\nkind: service\nname: Dev server\nproject: blog\nfolder: Projects/blog\nenabled: true\ncommand: ./start.sh\nready: { port: 5173 }\nnotify: always\n---\n",
    );
  });

  test("a new job opened from a project starts in it: its project and folder are that project's", async ({ page }) => {
    await start(page, { route: "new/alpha" });
    const form = app(page).getByTestId("job-form");
    await expect(form.getByRole("textbox", { name: "Folder", exact: true })).toHaveValue("Projects/alpha");
    await expect(form.getByRole("combobox", { name: "Project", exact: true })).toHaveValue("alpha");
    await expect(app(page).getByTestId("form-path")).toContainText("Apps/pomade-runner/jobs/alpha/");
  });

  test("validation: Save shows the checker's words on each field, the count in the Save bar, and focuses the first; a filled-in field's error shows at once", async ({ page }) => {
    await start(page);
    await writeJob(page, "alpha/dev-server.md", VALID);
    await app(page).getByTestId("new-job").click();
    const form = app(page).getByTestId("form-service");
    // A new job's form opens with the cursor in Name, as the prototype's does.
    await expect(form.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
    // Nothing is wrong before a Save: an empty field is not an error yet.
    await expect(form.getByRole("alert")).toHaveCount(0);
    await app(page).getByTestId("form-save").click();
    await expect(form.getByRole("alert")).toHaveText([
      "name — is empty. Fix: write it, e.g. name: Dev server.",
      "command — is empty. Fix: write it, e.g. command: ./start.sh.",
      "folder — is empty. Fix: write it, e.g. folder: Projects/blog.",
    ]);
    await expect(app(page).getByTestId("form-error-count")).toHaveText("3 things to fix before saving");
    await expect(form.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
    await shoot(page, "tab-form-errors");

    // The checker's cross-file checks: a name another job has.
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("dev SERVER");
    await expect(form.getByRole("alert").first()).toHaveText("name — dev SERVER is also the name of Apps/pomade-runner/jobs/alpha/dev-server.md. Fix: give each job its own name — History, notices and `pomade-runner run` tell jobs apart by name.");
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("Docs");
    await form.getByRole("textbox", { name: "Command", exact: true }).fill("npm run docs");
    await form.getByRole("textbox", { name: "Folder", exact: true }).fill("../outside");
    await expect(form.getByRole("alert")).toHaveText(['folder — "../outside" is outside the workspace. Fix: write a folder inside the workspace, relative to its root, e.g. folder: Projects/blog (. is the workspace root).']);
    await expect(app(page).getByTestId("form-error-count")).toHaveText("1 thing to fix before saving");
    await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
    await expect(form.getByText("“.” is the workspace root, workspace.")).toBeVisible();
    // A start on the first open of a project needs one: said on Starts.
    await form.getByRole("button", { name: "On first open of a project" }).click();
    await expect(form.getByRole("alert")).toHaveText(["start — starts on the first open of a project, and names none. Fix: add start-project: <the project's id> — `pomade-runner projects` lists them — or write start: login."]);
    // The job's own project, once it has one, is the one it starts on.
    await form.getByRole("combobox", { name: "Project", exact: true }).selectOption("alpha");
    await expect(form.getByTestId("start-project")).toHaveValue("alpha");
    await expect(form.getByRole("alert")).toHaveCount(0);
    // Alpha not opened since Pomade started: the service waits for its open, and the button promises no start.
    await expect(app(page).getByTestId("form-save")).toHaveText("Create job");
    await page.evaluate(() => window.setOpenedProjects(["alpha"]));
    await expect(app(page).getByTestId("form-save")).toHaveText("Create and start");
    await page.evaluate(() => window.setOpenedProjects([]));
    await expect(app(page).getByTestId("form-save")).toHaveText("Create job");
    // A port that is not one, as the checker words it.
    await form.getByRole("button", { name: "Check a port or URL instead" }).click();
    await form.getByRole("button", { name: "A port is open" }).click();
    await form.getByRole("textbox", { name: "Port" }).fill("99999");
    await expect(form.getByRole("alert")).toHaveText(["ready.port — 99999 is not a port. Fix: write a whole number from 1 to 65535, e.g. ready: { port: 5173 }."]);
    await form.getByRole("textbox", { name: "Port" }).fill("8080");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, "Apps/pomade-runner/jobs/alpha/docs.md")).toBe("---\nkind: service\nname: Docs\nproject: alpha\nfolder: .\nenabled: true\ncommand: npm run docs\nstart: project-first-open\nready: { port: 8080 }\n---\n");
  });

  test("editing writes only the changed fields — comments, the body stay — and a project moves the file to its sub-folder", async ({ page }) => {
    await start(page, { route: "edit/alpha.dev-server" });
    await writeJob(page, "alpha/dev-server.md", HAND);
    const form = app(page).getByTestId("form-service");
    await expect(form.getByRole("textbox", { name: "Command", exact: true })).toHaveValue("./start.sh");
    await expect(app(page).getByTestId("form-title")).toHaveText("Jobs / Dev server");
    await expect(form.getByRole("textbox", { name: "Port" })).toHaveValue("5173");
    // Nothing changed: nothing to save.
    await expect(app(page).getByTestId("form-save")).toHaveText("Saved");
    await expect(app(page).getByTestId("form-save")).toBeDisabled();
    await shoot(page, "tab-form-edit");

    await form.getByRole("textbox", { name: "Command", exact: true }).fill("npm run dev");
    await app(page).getByTestId("form-enabled").click();
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("toast")).toHaveText(`RunnerSaved ${WEB}`);
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    // A field the file did not have goes at the end of its block.
    expect(await fileText(page, WEB)).toBe(HAND.replace("./start.sh", "npm run dev").replace("# vite\n", "# vite\nenabled: false\n"));

    // Open file opens the file in Pomade.
    await navigate(page, "edit/alpha.dev-server");
    await app(page).getByTestId("form-open-file").click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: WEB }]);

    // To the Workspace: the file moves to the top of the jobs folder, its text kept.
    await app(page).getByTestId("form-service").getByRole("combobox", { name: "Project" }).selectOption("");
    await expect(app(page).getByTestId("form-path")).toHaveText("Apps/pomade-runner/jobs/dev-server.md");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, WEB)).toBeNull();
    expect(await fileText(page, "Apps/pomade-runner/jobs/dev-server.md")).toBe(HAND.replace("./start.sh", "npm run dev").replace("project: alpha\n", "").replace("# vite\n", "# vite\nenabled: false\n"));
  });

  test("the form follows the file on disk: untouched fields take its values, the person's edits stay with a notice", async ({ page }) => {
    await start(page, { route: "edit/alpha.dev-server" });
    await writeJob(page, "alpha/dev-server.md", HAND);
    const form = app(page).getByTestId("form-service");
    await form.getByRole("textbox", { name: "Command", exact: true }).fill("npm run dev");
    await writeJob(page, "alpha/dev-server.md", HAND.replace("name: Dev server", "name: Web server").replace("./start.sh", "./serve.sh"));
    await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Web server");
    await expect(form.getByRole("textbox", { name: "Command", exact: true })).toHaveValue("npm run dev");
    await expect(app(page).getByTestId("form-clash")).toHaveText("The file changed on disk while you edited it: command. Your edits stay, and Save writes them over the file's.");
    await shoot(page, "tab-form-clash");
    // A problem the form has no field for is the file's: shown, and Save still writes.
    await writeJob(page, "alpha/dev-server.md", HAND.replace("name: Dev server", "name: Web server\nowner: me"));
    await expect(app(page).getByTestId("form-file-errors")).toContainText("line 4: owner — owner is not a job field. Fix: remove it — the pomade-runner-jobs skill lists every field.");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, WEB)).toBe(HAND.replace("name: Dev server", "name: Web server\nowner: me").replace("./start.sh", "npm run dev"));
    // The file deleted while the form is open: it says so, and Save has nothing to write to.
    await navigate(page, "edit/alpha.dev-server");
    await expect(app(page).getByTestId("form-service")).toBeVisible();
    await page.evaluate((p) => window.fakeHost.deleteFile(p), WEB);
    await expect(app(page).getByTestId("form-gone")).toBeVisible();
    await expect(app(page).getByTestId("form-save")).toBeDisabled();
  });

  test("a job file deleted while its form follows it: the form says so, with no unhandled error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await start(page, { route: "edit/alpha.dev-server" });
    await writeJob(page, "alpha/dev-server.md", HAND);
    await expect(app(page).getByTestId("form-service")).toBeVisible();
    await app(page).getByTestId("form-open-file").click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: WEB }]);
    await page.evaluate((p) => window.fakeHost.deleteFile(p), WEB);
    await expect(app(page).getByTestId("form-gone")).toBeVisible();
    await expect(app(page).getByTestId("form-delete")).toBeDisabled();
    // Nothing to open: Open file is off, so it cannot ask the host for a file that is gone.
    await expect(app(page).getByTestId("form-open-file")).toBeDisabled();
    await writeJob(page, "alpha/dev-server.md", HAND);
    await expect(app(page).getByTestId("form-gone")).toHaveCount(0);
    await expect(app(page).getByTestId("form-open-file")).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("Open file on a file that vanished before the form heard of it says so in a toast, with no unhandled error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await start(page, { route: "edit/alpha.dev-server" });
    await writeJob(page, "alpha/dev-server.md", HAND);
    await expect(app(page).getByTestId("form-service")).toBeVisible();
    // Gone without a change event: the form still has it, and Pomade refuses to open it.
    await page.evaluate((p) => (window.fakeHost as unknown as { workspace: { deleteFile(path: string): unknown } }).workspace.deleteFile(p), WEB);
    await app(page).getByTestId("form-open-file").click();
    await expect(app(page).getByTestId("toast").last()).toHaveText(`RunnerCould not open ${WEB}: "${WEB}" does not exist`);
    expect(errors).toEqual([]);
  });

  test("Delete sits next to Open file; it confirms with the file's name, and a running service is said to be stopped first", async ({ page }) => {
    await start(page, { route: "edit/alpha.dev-server" });
    await writeJob(page, "alpha/dev-server.md", HAND);
    const actions = app(page).getByTestId("form-head").getByRole("button");
    await expect(actions.last()).toHaveText("Delete");
    expect(await actions.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent))).toEqual(["Back to Jobs", "Help", "Open file", "Delete"]);
    await app(page).getByTestId("form-delete").click();
    const confirm = app(page).getByTestId("delete-confirm");
    await expect(confirm.getByRole("heading")).toHaveText("Delete “Dev server”?");
    await expect(confirm.getByTestId("delete-path")).toHaveText(WEB);
    await expect(confirm).toContainText("The service is running: Runner stops it first, then removes the file. This can't be undone.");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await shoot(page, "tab-form-delete");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await fileText(page, WEB)).toBe(HAND);

    // A refusal stays in the dialog, in the scheduler's words.
    await page.evaluate(() => (window.refuseDelete = '"Dev server" did not stop, so its file is kept'));
    await app(page).getByTestId("form-delete").click();
    await confirm.getByRole("button", { name: "Delete job" }).click();
    await expect(confirm.getByRole("alert")).toHaveText('"Dev server" did not stop, so its file is kept');
    await page.evaluate(() => (window.refuseDelete = null));
    await confirm.getByRole("button", { name: "Delete job" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText(`RunnerDeleted ${WEB} · stopped first`);
    await expect(app(page).getByTestId("tab-empty")).toBeVisible();
    expect(await fileText(page, WEB)).toBeNull();
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "jobs.delete", params: { job: "alpha/dev-server" } },
      { method: "jobs.delete", params: { job: "alpha/dev-server" } },
    ]);
  });

  test("every field of the Service form has a working (i)", async ({ page }) => {
    await start(page, { route: "new" });
    const form = app(page).getByTestId("job-form");
    await form.getByRole("button", { name: "Check a port or URL instead" }).click();
    await form.getByTestId("form-policies").getByRole("button", { name: "Change" }).click();
    const tip = app(page).getByRole("tooltip");
    const keys = ["f.enabled", "f.name", "f.start", "f.ready", "f.after", "f.command", "f.folder", "f.project", "p.low", "p.notify", "f.file"] as const;
    for (const key of keys) {
      await form.getByTestId(`help-${key}`).hover();
      await expect(tip).toHaveText(HELP[key].join(""));
    }
    await form.getByTestId("kind-service").hover();
    await expect(tip).toHaveText(HELP["kind.service"].join(""));
  });

  test("an unknown job's route says so; a job whose file the form cannot read offers Open file", async ({ page }) => {
    await start(page, { route: "edit/nope" });
    await writeJob(page, "alpha/dev-server.md", VALID);
    await expect(app(page).getByTestId("form-missing")).toContainText("No job file has the id nope.");
    await writeJob(page, "summary.md", "---\nkind: [agent\nname: Summary\n---\nWrite my summary.\n");
    await navigate(page, "edit/summary");
    await expect(app(page).getByTestId("form-unsupported")).toContainText("The form cannot read its file: the frontmatter is broken, or its kind is not one Runner has. Open the file to fix it.");
    await app(page).getByTestId("form-unsupported").getByRole("button", { name: "Open file" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: "Apps/pomade-runner/jobs/summary.md" }]);
    await app(page).getByTestId("form-back").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
  });
});

test.describe("the Jobs view", () => {
  test.use({ viewport: { width: 1040, height: 760 } });
  // Pomade's order is not the alphabet's: Beta first.
  const PROJECTS = JSON.stringify([
    { id: "beta", name: "Beta", root: "Projects/beta" },
    { id: "alpha", name: "Alpha", root: "Projects/alpha" },
  ]);
  const file = (kind: string, name: string, rest: string, project: string | null = null): string =>
    `---\nkind: ${kind}\nname: ${name}\n${project === null ? "" : `project: ${project}\n`}${rest}---\n`;
  const BACKUP = file("script", "Backup", "folder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n");
  const MOUNT = file("script", "Mount drive", "folder: .\ncommand: ./mount.sh\nhook: { event: login }\n");
  const LINT = file("script", "Lint", "folder: Projects/beta\ncommand: npm run lint\nschedule:\n  daily: { at: 9:00 }\n", "beta");
  const WEB = file("service", "Dev server", "folder: Projects/alpha\ncommand: ./start.sh\nready: { port: 5173 }\n", "alpha");
  const PULL = file("git", "Pull", "git: { operation: pull, repos: [notes] }\nschedule:\n  daily: { at: 9:00 }\n", "alpha");
  const FILES: Record<string, string> = { "backup.md": BACKUP, "mount.md": MOUNT, "weekly-report.md": BROKEN, "beta/lint.md": LINT, "alpha/dev-server.md": WEB, "alpha/pull.md": PULL };

  async function start(page: Page, query: Record<string, string> = {}, files: Record<string, string> = FILES): Promise<void> {
    await page.goto(harness({ projects: PROJECTS, ...query }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    for (const [path, text] of Object.entries(files)) await writeJob(page, path, text);
    await expect(app(page).getByTestId("job-row").or(app(page).getByTestId("job-invalid")).first()).toBeVisible();
  }

  const record = (job: string, name: string, state: RunRecord["state"], endedAt: number, extra: Partial<RunRecord> = {}): RunRecord => ({
    job,
    name,
    kind: "script",
    project: null,
    folder: "",
    run: "20261117-120000-abcdef",
    trigger: "scheduled",
    cause: null,
    dueAt: endedAt - 3000,
    agent: null,
    missed: null,
    series: null,
    state,
    event: null,
    reason: null,
    startedAt: endedAt - 3000,
    endedAt,
    durationMs: 3000,
    exitCode: state === "failed" ? 2 : 0,
    signal: null,
    log: "/ud/output/r.log",
    lastLines: ["ok"],
    git: null,
    limitHit: null,
    ...extra,
  });

  test("groups by project — workspace first, then Pomade's order — each row with its kind, trigger, last result, next run and actions; helps on the heads", async ({ page }) => {
    await start(page);
    await expect(app(page).getByTestId("job-group")).toHaveText(["Workspacejobs/3", "Betajobs/beta/1", "Alphajobs/alpha/2"]);
    await expect(app(page).getByTestId("tab-jobs")).toContainText("6 jobs · 1 invalid");
    await expect(app(page).getByTestId("job-row")).toHaveText([/^Backup/, /^Mount drive/, /^Lint/, /^Dev server/, /^Pull/]);
    const kinds = await app(page).getByTestId("job-row").evaluateAll((rows) => rows.map((row) => row.querySelector("[data-tip]")?.getAttribute("data-tip")));
    expect(kinds).toEqual(["Script", "Script", "Script", "Service", "Git"]);
    for (const key of ["jobs.workspace", "jobs.this", "jobs.last", "jobs.next", "jobs.invalid"]) await expect(app(page).getByTestId(`help-${key}`)).toBeVisible();
    await expect(app(page).getByTestId("job-trigger")).toHaveText(["daily at 13:00", "at Mac login", "daily at 9:00", "always on · starts on Mac startup", "daily at 9:00"]);
    await expect(app(page).getByTestId("job-trigger").first()).toHaveAttribute("data-tip", "Daily at 13:00");
    // A running service's row stops it where the others run now, its terminal before; every row has Edit and Delete.
    await page.evaluate((session) => window.setServiceStatus("alpha/dev-server", { state: "running", session }), serviceSession("alpha/dev-server", 60_000));
    const buttons = (job: string) => app(page).locator(`[data-testid="job-row"][data-job="${job}"]`).getByRole("button").evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")));
    expect(await buttons("backup")).toEqual(["Run now", "Edit", "Delete"]);
    await expect.poll(() => buttons("alpha/dev-server")).toEqual(["Open terminal", "Stop service", "Edit", "Delete"]);
    await shoot(page, "tab-jobs-view");
  });

  test("each row's cells: the status chip with its help and sub line, a run going ahead of the last one, a paused job, the next run in words", async ({ page }) => {
    await start(page);
    await page.waitForFunction(() => typeof window.setRuns === "function");
    const now = await page.evaluate(() => Date.now());
    const failed = record("backup", "Backup", "failed", now - 3_600_000);
    // A pull that got 2 commits, as a Pomade that counts them prints it (`commits`).
    const pulled = { op: "pull" as const, job: "Pull", at: new Date(now - 7_200_000).toISOString(), results: [{ repo: "notes", path: "/fake/workspace/notes", op: "pull" as const, status: "done" as const, reason: null, commit: null, steps: [{ step: "pull" as const, outcome: "done" as const, detail: "got 2 commits from origin/main", commits: 2 }] }] };
    const done = record("alpha/pull", "Pull", "done", now - 7_200_000, { kind: "git", project: "alpha", git: pulled });
    const running: ActiveRun = {
      job: "beta/lint",
      name: "Lint",
      kind: "script",
      project: "beta",
      folder: "",
      run: "20261117-130000-aaaaaa",
      trigger: "scheduled",
      cause: null,
      dueAt: now - 200_000,
      agent: null,
      missed: null,
      series: null,
      state: "running",
      lowPriority: true,
      runAt: null,
      deadline: null,
      waits: null,
      startedAt: now - 200_000,
      session: "run:beta.lint:x",
      log: null,
      limitHit: null,
      warnedAt: null,
      warningDismissed: false,
    };
    await page.evaluate(
      ([f, d, r, at]) =>
        window.setRuns({
          report: {
            active: [r],
            nextUp: [],
            jobs: [
              { job: "backup", next: at + 12 * 60_000, finished: false, last: f, held: false },
              { job: "alpha/pull", next: at + 26 * 3_600_000, finished: false, last: d, held: false },
              { job: "beta/lint", next: at + 3 * 3_600_000, finished: false, last: null, held: false },
            ],
            needsYou: [{ id: "loop-paused:mount", kind: "loop-paused", job: "mount", name: "Mount drive", project: null, at, detail: "triggered 10× in 10 min" }],
            switch: { position: "running", since: null }, heldRuns: 0,
          },
          history: [f, d],
        }),
      [failed, done, running, now] as const,
    );
    const row = (job: string) => app(page).locator(`[data-testid="job-row"][data-job="${job}"]`);
    await expect(row("backup").getByTestId("job-status")).toHaveText("failed · exit 2");
    await expect(row("backup").getByTestId("job-status")).toHaveAttribute("data-help", "st.failed");
    await expect(row("backup").getByTestId("job-last-sub")).toHaveText(/^(today|yesterday) \d+:\d\d · 3s$/);
    await expect(row("backup").getByTestId("job-next")).toContainText("in 12 min");
    await expect(row("alpha/pull").getByTestId("job-status")).toHaveAttribute("data-help", "st.done");
    await expect(row("alpha/pull").getByTestId("job-status")).toHaveText("done · 2 commits pulled");
    await expect(row("alpha/pull").getByTestId("job-next")).toHaveText(/^(Today|Tomorrow|[A-Z][a-z]{2}) \d+:\d\d$/);
    // A run going shows ahead of the last finished one.
    await expect(row("beta/lint").getByTestId("job-status")).toHaveText("running");
    await expect(row("beta/lint").getByTestId("job-last-sub")).toHaveText("3m");
    await expect(row("beta/lint").getByTestId("job-status")).toHaveAttribute("data-help", "st.running");
    await expect(row("mount").getByTestId("job-next")).toHaveText("paused");
    // The loop guard's pause is the job's last result, as the prototype has it.
    await expect(row("mount").getByTestId("job-status")).toHaveText("paused · looks like a loop");
    await expect(row("mount").getByTestId("job-status")).toHaveAttribute("data-help", "st.paused");
    await expect(row("mount").getByTestId("job-last-sub")).toHaveText(/^today \d+:\d\d · 10× in 10 min$/);
    await expect(row("alpha/dev-server").getByTestId("job-next")).toHaveText("always on");
    await expect(row("alpha/dev-server").getByTestId("job-status")).toHaveText(/^running · up /);
    // A click on the last result opens that run's card; a service and a job that never ran have none.
    await expect(row("mount").getByTestId("job-last")).not.toHaveAttribute("role", "button");
    await expect(row("alpha/dev-server").getByTestId("job-last")).not.toHaveAttribute("role", "button");
    await shoot(page, "tab-jobs-cells");
    await row("backup").getByTestId("job-last").click();
    await expect(app(page).getByTestId("run-card")).toBeVisible();
  });

  test("T-025 · a job the switch holds says so in its Next run: the amber held tag after its countdown, with the switch's help, as Next up has it", async ({ page }) => {
    await start(page);
    await page.waitForFunction(() => typeof window.setRuns === "function");
    const now = await page.evaluate(() => Date.now());
    const runs = (held: boolean, position: "running" | "pause-low") =>
      page.evaluate(
        ([at, h, p]) =>
          window.setRuns({
            report: {
              active: [],
              nextUp: [],
              jobs: [
                { job: "backup", next: at + 2 * 60_000, finished: false, last: null, held: h },
                { job: "alpha/pull", next: at + 20 * 3_600_000, finished: false, last: null, held: h },
                { job: "beta/lint", next: at + 3 * 3_600_000, finished: false, last: null, held: false },
              ],
              needsYou: [],
              switch: { position: p, since: null },
              heldRuns: h ? 3 : 0,
            },
            history: [],
          }),
        [now, held, position] as const,
      );
    const row = (job: string) => app(page).locator(`[data-testid="job-row"][data-job="${job}"]`);
    await runs(false, "running");
    await expect(row("backup").getByTestId("job-next")).toHaveText(/^Today \d+:\d\din [12] min$/);
    await expect(app(page).getByTestId("job-held")).toHaveCount(0);
    await runs(true, "pause-low");
    await expect(row("backup").getByTestId("job-held")).toHaveText("held");
    await expect(row("backup").getByTestId("job-next")).toHaveText(/^Today \d+:\d\din [12] minheld$/);
    // A run more than an hour ahead has no countdown: the tag alone under its time.
    await expect(row("alpha/pull").getByTestId("job-next")).toHaveText(/^(Today|Tomorrow) \d+:\d\dheld$/);
    await expect(row("beta/lint").getByTestId("job-held")).toHaveCount(0);
    await expect(row("backup").getByTestId("job-held")).toHaveAttribute("data-help", "sw.held");
    // The tag is Next up's: its tone and size.
    const look = await row("backup").getByTestId("job-held").evaluate((tag) => {
      const style = getComputedStyle(tag);
      return { height: style.height, background: style.backgroundColor, color: style.color };
    });
    expect(look.height).toBe("15px");
    expect(look.background).not.toBe("rgba(0, 0, 0, 0)");
    await shoot(page, "tab-jobs-held");
    await runs(false, "running");
    await expect(app(page).getByTestId("job-held")).toHaveCount(0);
  });

  test("the This project chip keeps the open project's jobs, holds across Services, and says when there are none; New job is in the header and the empty block", async ({ page }) => {
    await start(page, { active: "alpha" });
    const chip = app(page).getByTestId("this-project");
    await expect(chip).toHaveText("This projectAlpha");
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(app(page).getByTestId("job-row")).toHaveText([/^Dev server/, /^Pull/]);
    await expect(app(page).getByTestId("job-invalid")).toHaveCount(0);
    await expect(app(page).getByTestId("job-group")).toHaveText(["Alphajobs/alpha/2"]);
    await expect(app(page).getByTestId("tab-jobs")).toContainText("2 jobs");
    await shoot(page, "tab-jobs-this-project");
    // The chip is the tab's: Services has it on too.
    await app(page).getByTestId("nav-services").click();
    await expect(app(page).getByTestId("this-project")).toHaveAttribute("aria-pressed", "true");
    await app(page).getByTestId("nav-jobs").click();
    await expect(app(page).getByTestId("this-project")).toHaveAttribute("aria-pressed", "true");
    for (const path of ["alpha/dev-server.md", "alpha/pull.md"]) await page.evaluate((p) => window.fakeHost.deleteFile(`Apps/pomade-runner/jobs/${p}`), path);
    const none = app(page).getByTestId("jobs-none");
    await expect(none.getByRole("heading")).toHaveText("No jobs in Alpha");
    await expect(none).toContainText("Jobs of other projects are hidden by the “This project” filter.");
    await expect(none.getByRole("button", { name: "New job" })).toBeVisible();
    await expect(app(page).getByTestId("job-row")).toHaveCount(0);
    await shoot(page, "tab-jobs-none");
    await none.getByRole("button", { name: "New job" }).click();
    await expect(app(page).getByTestId("form-title")).toBeVisible();
  });

  test("Run now calls Runner and toasts; Open terminal opens a service's attached tab; Edit opens the job's form", async ({ page }) => {
    await start(page);
    await page.evaluate((session) => window.setServiceStatus("alpha/dev-server", { state: "running", session }), serviceSession("alpha/dev-server", 60_000));
    const row = (job: string) => app(page).locator(`[data-testid="job-row"][data-job="${job}"]`);
    await row("backup").getByRole("button", { name: "Run now" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerBackup started · trigger “manual”");
    await row("alpha/dev-server").getByRole("button", { name: "Open terminal" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "svc:alpha.dev-server" }, title: "Dev server" }]);
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([{ method: "jobs.run", params: { job: "backup" } }]);
    await row("alpha/dev-server").getByRole("button", { name: "Edit" }).click();
    await expect(app(page).getByTestId("tab-jobs")).toHaveCount(0);
    await expect(app(page).getByTestId("form-title")).toContainText("Dev server");
  });

  test("a service's row: Start service where a script has Run now while it does not run, Stop service while it does; Open terminal only with a session to show; none of them a no-op", async ({ page }) => {
    await start(page);
    const row = app(page).locator('[data-testid="job-row"][data-job="alpha/dev-server"]');
    const labels = () => row.getByRole("button").evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")));
    const set = async (status: Partial<ServiceStatus>, words: RegExp, shot: string): Promise<void> => {
      await page.evaluate((next) => window.setServiceStatus("alpha/dev-server", next), status);
      await expect(row.getByTestId("job-status")).toHaveText(words);
      await page.mouse.move(0, 0);
      await shoot(page, shot);
    };
    const ended = serviceSession("alpha/dev-server", 3_600_000, Date.now() - 60_000);
    const up = serviceSession("alpha/dev-server", 60_000);

    // Stopped by you, its last output in the keeper: Start service, and its terminal.
    await set({ state: "stopped-by-you", session: ended }, /^stopped by you$/, "tab-jobs-service-stopped");
    expect.soft(await labels()).toEqual(["Open terminal", "Start service", "Edit", "Delete"]);
    await set({ state: "running", session: up }, /^running · up /, "tab-jobs-service-running");
    expect.soft(await labels()).toEqual(["Open terminal", "Stop service", "Edit", "Delete"]);
    await set({ state: "starting", session: up }, /^starting$/, "tab-jobs-service-starting");
    expect.soft(await labels()).toEqual(["Open terminal", "Stop service", "Edit", "Delete"]);
    // Never started — waiting for its project's first open, or given up before a session: nothing to open.
    await set({ state: "waiting", session: null }, /^waiting for first open$/, "tab-jobs-service-waiting");
    expect.soft(await labels()).toEqual(["Start service", "Edit", "Delete"]);
    await set({ state: "failed", session: null, lastCrashAt: Date.now() - 60_000 }, /^failed · gave up$/, "tab-jobs-service-failed");
    expect.soft(await labels()).toEqual(["Start service", "Edit", "Delete"]);
    await set({ state: "failed", session: ended }, /^failed · gave up$/, "tab-jobs-service-failed-ended");
    expect.soft(await labels()).toEqual(["Open terminal", "Start service", "Edit", "Delete"]);
    // Disabled: Start would be refused, so there is none; the toggle enables it.
    await set({ state: "disabled", session: null }, /^disabled$/, "tab-jobs-service-disabled");
    expect.soft(await labels()).toEqual(["Edit", "Delete"]);
    // Start service sits where a script's Run now does.
    const right = (locator: Locator): Promise<number> => locator.evaluate((element) => Math.round(element.getBoundingClientRect().right));
    await set({ state: "stopped-by-you", session: ended }, /^stopped by you$/, "tab-jobs-service-stopped-again");
    const backup = app(page).locator('[data-testid="job-row"][data-job="backup"]');
    expect(await right(row.getByRole("button", { name: "Start service" }))).toBe(await right(backup.getByRole("button", { name: "Run now" })));
    expect(await right(row.getByRole("button", { name: "Edit" }))).toBe(await right(backup.getByRole("button", { name: "Edit" })));

    // Start service and Stop service call Runner's service actions and toast what they did.
    await row.getByRole("button", { name: "Start service" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerDev server started");
    await set({ state: "running", session: up }, /^running · up /, "tab-jobs-service-started");
    await row.getByRole("button", { name: "Stop service" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerDev server stopped by you — it stays stopped until Start");
    await page.evaluate(() => {
      window.refuse["services.start"] = "the keeper is not connected";
    });
    await set({ state: "stopped-by-you", session: ended }, /^stopped by you$/, "tab-jobs-service-refused");
    await row.getByRole("button", { name: "Start service" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerCould not start Dev server: the keeper is not connected");
    await row.getByRole("button", { name: "Open terminal" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "svc:alpha.dev-server" }, title: "Dev server" }]);
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([
      { method: "services.start", params: { job: "alpha/dev-server" } },
      { method: "services.stop", params: { job: "alpha/dev-server" } },
      { method: "services.start", params: { job: "alpha/dev-server" } },
    ]);
  });

  test("T-034 · a job with a run going has Open terminal and Stop run on its row, acting on the latest run; the row's other icons stay where they are", async ({ page }) => {
    const SUMMARY = "---\nkind: agent\nname: Morning summary\nfolder: .\nagent: claude\nschedule:\n  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }\n---\nWrite my morning summary.\n";
    await start(page, {}, { ...FILES, "summary.md": SUMMARY });
    await page.waitForFunction(() => typeof window.setRuns === "function");
    const now = await page.evaluate(() => Date.now());
    const base: ActiveRun = {
      job: "backup",
      name: "Backup",
      kind: "script",
      project: null,
      folder: "",
      run: "20261117-130000-aaaaaa",
      trigger: "manual",
      cause: null,
      dueAt: now - 300_000,
      agent: null,
      missed: null,
      series: null,
      state: "running",
      lowPriority: false,
      runAt: null,
      deadline: null,
      waits: null,
      startedAt: now - 300_000,
      session: "run:backup:20261117-130000-aaaaaa",
      log: "/ud/output/backup/a.log",
      limitHit: null,
      warnedAt: null,
      warningDismissed: false,
    };
    const latest: ActiveRun = { ...base, run: "20261117-130200-bbbbbb", dueAt: now - 100_000, startedAt: now - 100_000, session: "run:backup:20261117-130200-bbbbbb" };
    const waiting: ActiveRun = {
      ...base,
      job: "summary",
      name: "Morning summary",
      kind: "agent",
      run: "20261117-130100-cccccc",
      session: "run:summary:20261117-130100-cccccc",
      agent: { agent: "claude", name: "claude", provider: "claude", mode: "normal", modeName: "Normal", sessionId: null, cwd: "/fake/workspace", startedAt: new Date(now).toISOString(), exit: "/exit", exitSentAt: null, worked: true, waiting: { prompt: "permission", since: now - 60_000 }, waitedMs: 0, background: null, answered: [], workedOn: false },
    };
    const queued: ActiveRun = { ...base, job: "mount", name: "Mount drive", run: "20261117-130300-dddddd", state: "queued", startedAt: null, session: null, log: null, waits: { kind: "slot", ahead: 1 } };
    const report = (active: ActiveRun[]): RunsReport => ({ active, nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 });
    const set = (active: ActiveRun[]) => page.evaluate((r) => window.setRuns({ report: r, history: [] }), report(active));
    const row = (job: string) => app(page).locator(`[data-testid="job-row"][data-job="${job}"]`);
    // The icons of the row's actions: the Last result cell is a button of its own.
    const icons = (job: string) => row(job).locator("button:not([role])");
    const labels = (job: string) => icons(job).evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")));
    // Each icon's left edge by its label — what must not move while Open terminal and Stop run come and go.
    const lefts = (job: string) =>
      icons(job).evaluateAll((all) => Object.fromEntries(all.map((b) => [b.getAttribute("aria-label"), Math.round(b.getBoundingClientRect().left * 100) / 100])));
    const box = (job: string) => row(job).getByRole("button", { name: "Delete" }).evaluate((b) => Math.round(b.getBoundingClientRect().right * 100) / 100);

    // No run going: Run now, Edit, Delete only; the two places are kept empty.
    await set([]);
    expect(await labels("backup")).toEqual(["Run now", "Edit", "Delete"]);
    const idle = await lefts("backup");
    const idleRight = await box("backup");
    await page.mouse.move(0, 0);
    await shoot(page, "T-034-row-idle");

    // Two runs of Backup go, a queued run of Mount drive: Open terminal and Stop run before Run now.
    await set([base, latest, queued]);
    await expect.poll(() => labels("backup")).toEqual(["Open terminal", "Stop run", "Run now", "Edit", "Delete"]);
    expect(await lefts("backup")).toMatchObject(idle);
    expect(await box("backup")).toBe(idleRight);
    // A queued run has no terminal and nothing to stop: its row keeps Run now.
    expect(await labels("mount")).toEqual(["Run now", "Edit", "Delete"]);
    await row("backup").getByRole("button", { name: "Stop run" }).hover();
    expect(await lefts("backup")).toMatchObject(idle);
    await shoot(page, "T-034-row-running-hover-stop");
    await row("backup").getByRole("button", { name: "Open terminal" }).focus();
    expect(await lefts("backup")).toMatchObject(idle);
    expect(await box("backup")).toBe(idleRight);
    await shoot(page, "T-034-row-running-focus-terminal");
    await page.mouse.move(0, 0);
    await shoot(page, "T-034-row-running");

    // Both act on the latest run.
    await row("backup").getByRole("button", { name: "Open terminal" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: latest.session }, title: "Backup" }]);
    await row("backup").getByRole("button", { name: "Stop run" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerBackup stopped by you");
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([{ method: "runs.stop", params: { job: "backup", run: latest.run } }]);
    // Run now stays, and still starts a run.
    await row("backup").getByRole("button", { name: "Run now" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerBackup started · trigger “manual”");

    // A refused stop says why.
    await page.evaluate(() => {
      window.refuse["runs.stop"] = "run is not running";
    });
    await row("backup").getByRole("button", { name: "Stop run" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerCould not stop Backup: run is not running");

    // The run ends: the icons leave, the rest has not moved.
    await set([]);
    await expect.poll(() => labels("backup")).toEqual(["Run now", "Edit", "Delete"]);
    expect(await lefts("backup")).toEqual(idle);

    // An agent run waiting at a prompt: its terminal is "Open at the prompt", as on its card.
    await set([waiting]);
    await expect.poll(() => labels("summary")).toEqual(["Open at the prompt", "Stop run", "Run now", "Edit", "Delete"]);
    expect(await box("summary")).toBe(idleRight);
    await page.mouse.move(0, 0);
    await shoot(page, "T-034-row-agent-waiting");
    await row("summary").getByRole("button", { name: "Open at the prompt" }).click();
    await expect
      .poll(() => page.evaluate(() => window.fakeHost.openedTabs.map((tab) => ("session" in tab ? tab.session : null))))
      .toEqual([
        { app: "pomade-runner", session: latest.session },
        { app: "pomade-runner", session: waiting.session },
      ]);
  });

  test("Delete turns red under the pointer and on focus, confirms with the file's name — a running service is stopped first — and can be cancelled or refused", async ({ page }) => {
    await start(page);
    const row = (job: string) => app(page).locator(`[data-testid="job-row"][data-job="${job}"]`);
    const remove = row("alpha/dev-server").getByRole("button", { name: "Delete" });
    await expect(remove).toHaveCSS("color", "rgb(90, 107, 122)");
    await remove.hover();
    await expect(remove).toHaveCSS("color", "rgb(192, 55, 75)");
    await row("backup").getByRole("button", { name: "Edit" }).focus();
    await page.keyboard.press("Tab");
    await expect(row("backup").getByRole("button", { name: "Delete" })).toBeFocused();
    await expect(row("backup").getByRole("button", { name: "Delete" })).toHaveCSS("color", "rgb(192, 55, 75)");
    await shoot(page, "tab-jobs-delete-hover");

    await remove.click();
    const confirm = app(page).getByTestId("delete-confirm");
    await expect(confirm.getByRole("heading")).toHaveText("Delete “Dev server”?");
    await expect(confirm.getByTestId("delete-path")).toHaveText("Apps/pomade-runner/jobs/alpha/dev-server.md");
    await expect(confirm).toContainText("The service is running: Runner stops it first, then removes the file. This can't be undone.");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await shoot(page, "tab-jobs-delete-confirm");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await page.evaluate(() => window.fakeHost.readFile("Apps/pomade-runner/jobs/alpha/dev-server.md"))).toBe(WEB);

    // A refusal stays in the dialog in the scheduler's words, and the row stays.
    await page.evaluate(() => (window.refuseDelete = '"Dev server" did not stop, so its file is kept'));
    await remove.click();
    await confirm.getByRole("button", { name: "Delete job" }).click();
    await expect(confirm.getByRole("alert")).toHaveText('"Dev server" did not stop, so its file is kept');
    await expect(row("alpha/dev-server")).toBeVisible();
    await page.evaluate(() => (window.refuseDelete = null));
    await confirm.getByRole("button", { name: "Delete job" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerDeleted Apps/pomade-runner/jobs/alpha/dev-server.md · stopped first");
    await expect(confirm).toHaveCount(0);
    await expect(row("alpha/dev-server")).toHaveCount(0);
    await expect(app(page).getByTestId("job-group")).toHaveText(["Workspacejobs/3", "Betajobs/beta/1", "Alphajobs/alpha/1"]);

    // A script's confirm says no more than that it cannot be undone.
    await row("backup").getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toContainText("This can't be undone.");
    await expect(confirm).not.toContainText("stops it first");
    await confirm.getByRole("button", { name: "Delete job" }).click();
    await expect(row("backup")).toHaveCount(0);
    expect(await page.evaluate(() => window.runnerCalls.map((call) => call.method))).toEqual(["jobs.delete", "jobs.delete", "jobs.delete"]);
  });

  test("a refused Run now or toggle says why in a toast", async ({ page }) => {
    await start(page, {}, { "backup.md": BACKUP });
    await page.evaluate(() => (window.refuseActions = "the switch holds it"));
    const row = app(page).getByTestId("job-row");
    await row.getByRole("button", { name: "Run now" }).click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerCould not run Backup: the switch holds it");
    await row.getByRole("switch").click();
    await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerCould not disable Backup: the switch holds it");
    await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  test("an invalid file is a red row with its file name, its first error and Open file; the marked row of a jobs/<job> route is scrolled into view", async ({ page }) => {
    const many: Record<string, string> = { ...FILES };
    for (let i = 0; i < 16; i += 1) many[`filler-${String(i).padStart(2, "0")}.md`] = file("script", `Filler ${i}`, "folder: .\ncommand: ./f.sh\nschedule:\n  daily: { at: 9:00 }\n");
    await start(page, {}, many);
    await expect(app(page).getByTestId("job-row")).toHaveCount(21);
    const invalid = app(page).getByTestId("job-invalid");
    await expect(invalid).toContainText("weekly-report.md");
    await expect(invalid).toContainText('Invalid: line 7: schedule.weekly.at — "25:00" is not a time.');
    await expect(invalid.getByTestId("help-jobs.invalid")).toBeVisible();
    // The route's job is marked, and scrolled to though it is far down the list.
    await expect(app(page).locator('[data-testid="job-row"][aria-current="true"]')).toHaveCount(0);
    await page.evaluate(() => window.mounted.navigate("jobs/alpha.pull"));
    const marked = app(page).locator('[data-testid="job-row"][data-job="alpha/pull"]');
    await expect(marked).toHaveAttribute("aria-current", "true");
    await expect(marked).toBeInViewport();
    await expect(app(page).locator('[data-testid="job-row"][aria-current="true"]')).toHaveCount(1);
    await expect(marked).toHaveCSS("box-shadow", /rgb\(79, 184, 216\)/);
    await shoot(page, "tab-jobs-marked");
    await invalid.getByRole("button", { name: "Open file" }).scrollIntoViewIfNeeded();
    await invalid.getByRole("button", { name: "Open file" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: "Apps/pomade-runner/jobs/weekly-report.md" }]);
  });

  test("T-041 · a job's description: one line in the form until a click opens its box; saved, the file holds it, Edit shows it, and the name's tooltip shows it on as many lines — the trigger's own tooltip never over the name", async ({ page }) => {
    const THREE = "Backs up the notes folder to the NAS.\nNeeds the drive mounted (Mount drive).\nAsk Daniil before changing the target.";
    const ONE = "Mounts the backup drive at login.";
    await start(page, {}, { "backup.md": BACKUP, "mount.md": file("script", "Mount drive", `description: ${ONE}\nfolder: .\ncommand: ./mount.sh\nhook: { event: login }\n`) });
    const tip = app(page).getByTestId("tooltip");
    const row = (id: string): Locator => app(page).locator(`[data-testid="job-row"][data-job="${id}"]`);

    // A job without one: its name has no tooltip — not even the trigger's, from right under it.
    await row("backup").getByTestId("job-trigger").hover();
    await expect(tip).toHaveText("Daily at 13:00");
    await row("backup").getByTestId("job-name").hover();
    await expect(tip).toHaveCount(0);
    await shoot(page, "t041-jobs-no-description");

    // The form of every kind: the one line under Name, no box.
    await app(page).getByTestId("new-job").click();
    for (const kind of ["service", "script", "agent", "git"]) {
      await app(page).getByTestId(`kind-${kind}`).click();
      const form = app(page).getByTestId(`form-${kind}`);
      await expect(form.getByTestId("description-add")).toHaveText("Add a description (optional)");
      await expect(form.getByRole("textbox", { name: "Description" })).toHaveCount(0);
      await shoot(page, `t041-form-${kind}-collapsed`);
    }
    await app(page).getByTestId("description-add").click();
    await expect(app(page).getByRole("textbox", { name: "Description" })).toBeFocused();
    await shoot(page, "t041-form-git-open");

    // Edit a job that has none: a click opens the box; three lines saved go into its file.
    await page.evaluate(() => window.mounted.navigate(""));
    await row("backup").getByRole("button", { name: "Edit" }).click();
    const form = app(page).getByTestId("form-script");
    await expect(form.getByTestId("description-add")).toBeVisible();
    await shoot(page, "t041-form-script-collapsed-edit");
    await form.getByTestId("description-add").click();
    const box = form.getByRole("textbox", { name: "Description" });
    await expect(box).toBeFocused();
    await shoot(page, "t041-form-script-open");
    await box.fill(THREE);
    await shoot(page, "t041-form-script-filled");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await page.evaluate(() => window.fakeHost.readFile("Apps/pomade-runner/jobs/backup.md"))).toBe(
      BACKUP.replace(/---\n$/, "description: |-\n  Backs up the notes folder to the NAS.\n  Needs the drive mounted (Mount drive).\n  Ask Daniil before changing the target.\n---\n"),
    );

    // Its name shows the three lines; the trigger under it keeps its own tooltip.
    await expect(row("backup").getByTestId("job-name")).toHaveAttribute("data-tip", THREE);
    await row("backup").getByTestId("job-trigger").hover();
    await expect(tip).toHaveText("Daily at 13:00");
    await row("backup").getByTestId("job-name").hover();
    await expect(tip).toHaveCount(1);
    expect(await tip.evaluate((el) => (el as HTMLElement).innerText)).toBe(THREE);
    const lineHeight = await tip.locator("span").first().evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect((await tip.locator("span").first().boundingBox())!.height).toBeGreaterThanOrEqual(lineHeight * 3 - 1);
    await shoot(page, "t041-jobs-tooltip-three-lines");
    // One line: a tip of one line.
    await row("mount").getByTestId("job-name").hover();
    await expect(tip).toHaveText(ONE);
    await shoot(page, "t041-jobs-tooltip-one-line");

    // Edit shows it in its box, filled; emptied and saved, the field leaves the file.
    await row("backup").getByRole("button", { name: "Edit" }).click();
    await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue(THREE);
    await expect(form.getByTestId("description-add")).toHaveCount(0);
    await shoot(page, "t041-form-script-edit-filled");
    await form.getByRole("textbox", { name: "Description" }).fill("");
    await expect(form.getByRole("textbox", { name: "Description" })).toBeVisible();
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await page.evaluate(() => window.fakeHost.readFile("Apps/pomade-runner/jobs/backup.md"))).toBe(BACKUP);
    await expect(row("backup").getByTestId("job-name")).not.toHaveAttribute("data-tip");

    // An agent job's form shows its description the same way.
    await writeJob(page, "summary.md", file("agent", "Summary", `description: |-\n  Summarizes the day.\n  Reads notes and mail.\nfolder: .\nagent: claude\nhook: { event: login }\n`).replace(/---\n$/, "---\nSummarize today.\n"));
    await row("summary").getByRole("button", { name: "Edit" }).click();
    await expect(app(page).getByTestId("form-agent").getByRole("textbox", { name: "Description" })).toHaveValue("Summarizes the day.\nReads notes and mail.");
    await shoot(page, "t041-form-agent-filled");
  });

  test("T-042 · a tooltip whose text is wider than its largest width wraps onto further lines: the text stays inside the tip, and the tip inside the tab", async ({ page }) => {
    const HUNT = "Job Hunt";
    const LONG = "Job Hunt for a very long season of applications and interviews";
    const projects = JSON.stringify([
      { id: "alpha", name: "Alpha", root: "Projects/alpha" },
      { id: "hunt", name: HUNT, root: "Projects/hunt" },
      { id: "long", name: LONG, root: "Projects/long" },
    ]);
    const service = (name: string, project: string): string => file("service", name, `folder: .\ncommand: ./docs.sh\nstart: project-first-open\nstart-project: ${project}\n`);
    const files = { "hunt.md": service("Docs hunt", "hunt"), "long.md": service("Docs long", "long") };
    const tip = app(page).getByTestId("tooltip");
    for (const size of [{ width: 1040, height: 760 }, { width: 420, height: 760 }]) {
      await page.setViewportSize(size);
      await start(page, { projects }, files);
      for (const [id, name] of [["hunt", HUNT], ["long", LONG]] as const) {
        const words = `from first open of ${name} while Pomade is running`;
        const trigger = app(page).locator(`[data-testid="job-row"][data-job="${id}"]`).getByTestId("job-trigger");
        await expect(trigger).toHaveText(words);
        await trigger.hover();
        await expect(tip).toHaveText(`F${words.slice(1)}`);
        await shoot(page, `t042-tooltip-${id}-${size.width}`);
        const box = (await tip.boundingBox())!;
        const text = (await tip.locator("span").first().boundingBox())!;
        // Inside its own box: the text's box within the tip's, nothing scrolls past its edge.
        expect(text.x).toBeGreaterThanOrEqual(box.x);
        expect(text.x + text.width).toBeLessThanOrEqual(box.x + box.width);
        expect(await tip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        // Inside the tab, near its edges too.
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height);
        // Wider than the largest width: it wraps onto further lines.
        expect(box.width).toBeLessThanOrEqual(280);
        const oneLine = await tip.locator("span").first().evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
        expect(text.height).toBeGreaterThan(oneLine * 1.5);
        await page.mouse.move(0, 0);
        await expect(tip).toHaveCount(0);
      }
      // At the tab's right and bottom borders the tip is kept inside them.
      const corner = app(page).locator("body");
      await corner.evaluate((body, text) => {
        const el = document.createElement("button");
        el.dataset.testid = "t042-corner";
        el.dataset.tip = text;
        el.textContent = "·";
        el.style.cssText = "position:fixed;right:0;bottom:0;width:24px;height:24px";
        body.append(el);
      }, `From first open of ${LONG} while Pomade is running`);
      await app(page).getByTestId("t042-corner").hover();
      await expect(tip).toBeVisible();
      await shoot(page, `t042-tooltip-corner-${size.width}`);
      const box = (await tip.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      expect(await tip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });
});

test.describe("services: Running now and the Services view", () => {
  /** A time of day as Runner's service rows write it: "9:02", "14:02". */
  const shortClock = (epochMs: number): string => `${new Date(epochMs).getHours()}:${String(new Date(epochMs).getMinutes()).padStart(2, "0")}`;
  const WEB = VALID.replace("command: ./start.sh\n", "command: ./start.sh\nready: { port: 5173 }\n");
  const DOCS = "---\nkind: service\nname: Docs preview\nfolder: .\ncommand: npm run docs:dev\n---\n";
  const GRAPH = "---\nkind: service\nname: Graph viewer\nproject: alpha\nfolder: Projects/alpha/graph\ncommand: npm run serve\nready: { port: 4000 }\n---\n";
  const BAD = "---\nkind: service\nname: API\nfolder: .\ncommand: ./api.sh\nready: { port: 99999 }\n---\n";
  const at = (hours: number, minutes: number, daysAgo = 0): number => {
    const when = new Date();
    when.setHours(hours, minutes, 0, 0);
    return when.getTime() - daysAgo * 86_400_000;
  };
  /** A service's session as the keeper reports it: started `ago` ms before now, ended at `endedAt`. */
  async function services(page: Page, query: Record<string, string>): Promise<void> {
    await page.goto(harness(query));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await writeJob(page, "alpha/dev-server.md", WEB);
    await writeJob(page, "alpha/graph-viewer.md", GRAPH);
    await writeJob(page, "docs-preview.md", DOCS);
    await writeJob(page, "api.md", BAD);
    const crash = at(14, 2, 1);
    const stopped = at(18, 10, 1);
    await page.evaluate(
      ([web, graph, docs, lastCrashAt]) => {
        window.setServiceStatus("alpha/dev-server", { state: "running", session: web, restarts: 3, lastCrashAt });
        window.setServiceStatus("alpha/graph-viewer", { state: "starting", session: graph });
        window.setServiceStatus("docs-preview", { state: "stopped-by-you", session: docs });
      },
      [serviceSession("alpha/dev-server", (3 * 24 + 4) * 3_600_000 + 60_000), serviceSession("alpha/graph-viewer", 2000), serviceSession("docs-preview", 3_600_000, stopped), crash] as const,
    );
  }

  test.describe("in the panel", () => {
    test.use({ viewport: { width: 240, height: 700 } });

    test("Running now lists the services that run — up for how long, the news on a third line — before the runs; a row opens the service's attached tab", async ({ page }) => {
      await services(page, { surface: "panel" });
      const section = app(page).getByTestId("section-running");
      await expect(app(page).getByTestId("section-running-head-count")).toHaveText("2");
      const rows = section.getByTestId("running-service");
      await expect(rows).toHaveText([/^Dev server/, /^Graph viewer/]);
      await expect(rows.nth(0)).toHaveText(`Dev serverup 3d 4hAlpha · Projects/alpharestarted 3× · last crash ${shortClock(at(14, 2, 1))}`);
      await expect(rows.nth(1)).toHaveText("Graph viewerstartingAlpha · Projects/alpha/graphwaiting for port 4000");
      await expect(rows.nth(0).locator('[data-help="st.up"]')).toHaveText("up 3d 4h");
      await expect(rows.nth(0).locator('[data-help="st.restarted"]')).toBeVisible();
      await expect(rows.nth(1).locator('[data-help="st.starting"]')).toHaveText("starting");
      await shoot(page, "panel-running-services");

      await rows.nth(0).locator('[data-help="st.up"]').hover();
      await expect(app(page).getByTestId("tooltip")).toHaveText("How long the service has been running since its last start.Example: up 3d 4h — it outlived two Pomade restarts.");

      await rows.nth(0).click();
      await expect
        .poll(() => page.evaluate(() => window.fakeHost.openedTabs))
        .toEqual([{ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "svc:alpha.dev-server" }, title: "Dev server" }]);
    });
  });

  test.describe("in the Runner tab", () => {
    test.use({ viewport: { width: 1040, height: 700 } });

    test("the Services view: a service never started has no Open terminal, its place kept; a disabled one no Start", async ({ page }) => {
      await services(page, { route: "services" });
      const rows = app(page).getByTestId("service-row");
      const edge = (row: Locator, name: string): Promise<number> => row.getByRole("button", { name, exact: true }).evaluate((element) => Math.round(element.getBoundingClientRect().right));
      const before = await edge(rows.nth(0), "Start");
      await page.evaluate(() => window.setServiceStatus("docs-preview", { state: "waiting", session: null }));
      await expect(rows.nth(0).getByTestId("service-status")).toHaveText("waiting for first open");
      await expect(rows.nth(0).getByRole("button")).toHaveText(["Start", "", ""]);
      await expect(rows.nth(0).getByRole("button", { name: "Open terminal" })).toHaveCount(0);
      expect(await edge(rows.nth(0), "Start")).toBe(before);
      expect(await edge(rows.nth(0), "Edit")).toBe(await edge(rows.nth(1), "Edit"));
      await page.evaluate(() => window.setServiceStatus("docs-preview", { state: "disabled", session: null }));
      await expect(rows.nth(0).getByTestId("service-status")).toHaveText("disabled");
      await expect(rows.nth(0).getByRole("button")).toHaveText(["", ""]);
      await shoot(page, "tab-services-no-session");
    });

    test("T-021 · a disabled service has no Start in Jobs or Services, even one that never ran with a report a tick behind; a service waiting for Pomade says so and has no Start either", async ({ page }) => {
      await services(page, { route: "services" });
      await writeJob(page, "off.md", "---\nkind: service\nname: Off\nfolder: .\nenabled: false\ncommand: ./off.sh\n---\n");
      await writeJob(page, "watch.md", "---\nkind: service\nname: Watch\nfolder: .\ncommand: ./watch.sh\nstart: pomade-started\n---\n");
      // The report still says Off would start (it was just turned off) and never ran.
      await page.evaluate(() => {
        window.setServiceStatus("off", { state: "queued", session: null });
        window.setServiceStatus("watch", { state: "waiting-for-pomade", session: null });
      });
      const row = (job: string) => app(page).locator(`[data-testid="service-row"][data-job="${job}"]`);
      await expect(row("off")).toBeVisible();
      await expect(row("off").getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
      await expect(row("watch").getByTestId("service-status")).toHaveText("waiting for Pomade");
      await expect(row("watch").getByTestId("service-sub")).toHaveText("starts when Pomade starts");
      await expect(row("watch").getByTestId("service-status")).toHaveAttribute("data-help", "st.svcwaitpomade");
      // Start would be refused while Pomade is not running: there is none.
      await expect(row("watch").getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
      await page.mouse.move(0, 0);
      await shoot(page, "tab-services-t021");
      await page.evaluate(() => window.setServiceStatus("off", { state: "disabled", session: null }));
      await expect(row("off").getByTestId("service-status")).toHaveText("disabled");
      await expect(row("off").getByRole("button", { name: "Start", exact: true })).toHaveCount(0);

      await page.evaluate(() => window.setServiceStatus("off", { state: "queued", session: null }));
      await page.evaluate(() => window.mounted.navigate(""));
      const job = (id: string) => app(page).locator(`[data-testid="job-row"][data-job="${id}"]`);
      await expect(job("off")).toBeVisible();
      await expect(job("off").getByRole("button", { name: "Start service" })).toHaveCount(0);
      await expect(job("off").getByRole("button", { name: "Run now" })).toHaveCount(0);
      await expect(job("watch").getByTestId("job-trigger")).toHaveText("while Pomade is running");
      await expect(job("watch").getByRole("button", { name: "Start service" })).toHaveCount(0);
      await expect(job("watch").getByRole("button", { name: "Run now" })).toHaveCount(0);
      await page.mouse.move(0, 0);
      await shoot(page, "tab-jobs-t021");
    });

    test("a service waiting for its project's first open names the project in Jobs' Last result, as Services does", async ({ page }) => {
      await services(page, { route: "services" });
      await writeJob(page, "alpha/docs.md", "---\nkind: service\nname: Docs\nproject: alpha\nfolder: .\ncommand: ./docs.sh\nstart: project-first-open\nstart-project: alpha\n---\n");
      await page.evaluate(() => window.setServiceStatus("alpha/docs", { state: "waiting", session: null }));
      const sub = app(page).locator('[data-testid="service-row"][data-job="alpha/docs"]').getByTestId("service-sub");
      await expect(sub).toHaveText("starts on first open of Alpha");
      await page.evaluate(() => window.mounted.navigate(""));
      const last = app(page).locator('[data-testid="job-row"][data-job="alpha/docs"]');
      await expect(last.getByTestId("job-status")).toHaveText("waiting for first open");
      await expect(last.getByTestId("job-last-sub")).toHaveText("starts on first open of Alpha");
    });

    test("an enabled service the scheduler has not reported says no state — no queued — and offers no Start or Stop, in Services and in Jobs; a Pomade-bound one too", async ({ page }) => {
      await services(page, { route: "services" });
      await writeJob(page, "fresh.md", "---\nkind: service\nname: Fresh\nfolder: .\ncommand: ./fresh.sh\n---\n");
      await writeJob(page, "bound.md", "---\nkind: service\nname: Bound\nfolder: .\ncommand: ./bound.sh\nstart: pomade-started\n---\n");
      await page.evaluate(() => {
        window.setServiceUnreported("fresh", true);
        window.setServiceUnreported("bound", true);
      });
      for (const id of ["fresh", "bound"]) {
        const row = app(page).locator(`[data-testid="service-row"][data-job="${id}"]`);
        await expect(row).toBeVisible();
        await expect(row.getByTestId("service-status")).toHaveCount(0);
        await expect(row).not.toContainText("queued");
        await expect(row.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
        await expect(row.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
        await expect(row.getByRole("button", { name: "Edit" })).toBeVisible();
      }
      await shoot(page, "t053-services-unreported");
      await page.evaluate(() => window.mounted.navigate(""));
      for (const id of ["fresh", "bound"]) {
        const row = app(page).locator(`[data-testid="job-row"][data-job="${id}"]`);
        await expect(row).toBeVisible();
        await expect(row.getByTestId("job-status")).toHaveCount(0);
        await expect(row).not.toContainText("queued");
        await expect(row.getByRole("button", { name: "Start service" })).toHaveCount(0);
        await expect(row.getByRole("button", { name: "Stop service" })).toHaveCount(0);
        await expect(row.getByRole("button", { name: "Run now" })).toHaveCount(0);
      }
      await shoot(page, "t053-jobs-unreported");
    });

    test("the Services view: each service where it stands, its actions by state, an invalid file with its error; Start, Stop and Restart call Runner and toast", async ({ page }) => {
      await services(page, { route: "services" });
      const rows = app(page).getByTestId("service-row");
      await expect(rows).toHaveCount(3);
      // Start order: workspace jobs first, then each project's, each by id.
      await expect(rows.locator('[data-testid="service-status"]')).toHaveText(["stopped by you", "running · up 3d 4h", "starting"]);
      await expect(rows.getByTestId("service-sub")).toHaveText([`yesterday ${shortClock(at(18, 10))}`, `restarted 3× · last crash ${shortClock(at(14, 2))}`, "waiting for port 4000"]);
      await expect(rows.nth(1)).toContainText("Dev serverAlpha · Projects/alpha./start.sh");
      for (const [i, help] of ["st.stopped", "st.up", "st.starting"].entries()) await expect(rows.nth(i).getByTestId("service-status")).toHaveAttribute("data-help", help);
      await expect(rows.nth(1).getByTestId("service-sub")).toHaveAttribute("data-help", "st.restarted");
      await expect(rows.nth(0).getByRole("button")).toHaveText(["Start", "", "", ""]);
      await expect(rows.nth(1).getByRole("button")).toHaveText(["Restart", "Stop", "", "", ""]);
      await expect(rows.nth(1).getByRole("button", { name: "Open terminal", exact: true })).toBeVisible();
      const invalid = app(page).getByTestId("service-invalid");
      await expect(invalid).toContainText("api.md");
      await expect(invalid).toContainText("Invalid: line 6: ready.port — 99999 is not a port.");
      await expect(invalid.getByTestId("help-jobs.invalid")).toBeVisible();
      await shoot(page, "tab-services-states");

      await rows.nth(0).getByRole("button", { name: "Start" }).click();
      await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerDocs preview started");
      await rows.nth(1).getByRole("button", { name: "Stop" }).click();
      await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerDev server stopped by you — it stays stopped until Start");
      await rows.nth(1).getByRole("button", { name: "Restart" }).click();
      await expect(app(page).getByTestId("toast").last()).toHaveText("RunnerCould not restart Dev server: the keeper is not connected");
      expect(await page.evaluate(() => window.runnerCalls)).toEqual([
        { method: "services.start", params: { job: "docs-preview" } },
        { method: "services.stop", params: { job: "alpha/dev-server" } },
        { method: "services.restart", params: { job: "alpha/dev-server" } },
      ]);

      await rows.nth(1).getByRole("button", { name: "Open terminal" }).click();
      await rows.nth(1).getByRole("button", { name: "Open file" }).click();
      await invalid.getByRole("button", { name: "Open file" }).click();
      await expect
        .poll(() => page.evaluate(() => window.fakeHost.openedTabs))
        .toEqual([
          { kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "svc:alpha.dev-server" }, title: "Dev server" },
          { kind: "file", projectId: "alpha", path: "Apps/pomade-runner/jobs/alpha/dev-server.md" },
          { kind: "file", projectId: "alpha", path: "Apps/pomade-runner/jobs/api.md" },
        ]);

      // Edit leaves the view for the job's form route.
      await rows.nth(1).getByRole("button", { name: "Edit" }).click();
      await expect(app(page).getByTestId("tab-services")).toHaveCount(0);
    });

    test("the This project chip keeps the services of the project Pomade has open, and says when it has none", async ({ page }) => {
      await services(page, { route: "services" });
      const chip = app(page).getByTestId("this-project");
      await expect(chip).toHaveText("This projectAlpha");
      await expect(chip).toHaveAttribute("aria-pressed", "false");
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(app(page).getByTestId("service-row")).toHaveText([/^Dev server/, /^Graph viewer/]);
      await expect(app(page).getByTestId("service-invalid")).toHaveCount(0);
      await shoot(page, "tab-services-this-project");
      await page.evaluate(() => window.fakeHost.deleteFile("Apps/pomade-runner/jobs/alpha/dev-server.md"));
      await page.evaluate(() => window.fakeHost.deleteFile("Apps/pomade-runner/jobs/alpha/graph-viewer.md"));
      await expect(app(page).getByTestId("services-none")).toHaveText("No services in this project.");
      await shoot(page, "tab-services-none");
    });
  });
});

/** A History day's head for `time` by the clock now: "Today", "Yesterday", "Sun 15 Nov". */
function dayHead(time: number): string {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(time).setHours(0, 0, 0, 0)) / 86_400_000);
  const date = new Date(time);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]} ${date.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]}`;
}

test.describe("History and result cards", () => {
  test.use({ viewport: { width: 1040, height: 700 } });
  const now = new Date();
  /** A moment `days` before today at `hours:minutes`. */
  const at = (days: number, hours: number, minutes: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hours, minutes).getTime();
  const done: RunRecord = {
    job: "backup",
    name: "Backup",
    kind: "script",
    project: null,
    folder: "",
    run: "20261117-000000-aaaaaa",
    trigger: "scheduled",
    cause: null,
    dueAt: at(0, 0, 10),
    agent: null,
    missed: null,
    series: null,
    state: "done",
    event: null,
    reason: null,
    startedAt: at(0, 0, 10),
    endedAt: at(0, 0, 10) + 2000,
    durationMs: 2000,
    exitCode: 0,
    signal: null,
    log: "/ud/output/backup/a.log",
    lastLines: ["ok"],
    git: null,
    limitHit: null,
  };
  const failed: RunRecord = { ...done, job: "scraper", name: "Scraper", project: "alpha", run: "20261117-000100-bbbbbb", state: "failed", exitCode: 1, dueAt: at(1, 9, 14), startedAt: at(1, 9, 14), endedAt: at(1, 9, 14) + 8000, durationMs: 8000 };
  const skipped: RunRecord = { ...done, job: "health", name: "Health check", project: "alpha", run: "20261117-000200-cccccc", state: "skipped", reason: "previous run still going", dueAt: at(3, 13, 0), startedAt: null, endedAt: at(3, 13, 0), durationMs: null, exitCode: null, log: null, lastLines: [] };
  const missed: RunRecord = { ...skipped, job: "summary", name: "Summary", project: null, run: "20261117-000300-dddddd", state: "missed", reason: "skipped", dueAt: at(3, 7, 0), endedAt: at(3, 7, 0) };
  const running: ActiveRun = {
    job: "lint",
    name: "Lint",
    kind: "script",
    project: "alpha",
    folder: "",
    run: "20261117-000400-eeeeee",
    trigger: "manual",
    cause: null,
    dueAt: Date.now() - 180_000,
    agent: null,
    missed: null,
    series: null,
    state: "running",
    lowPriority: true,
    runAt: null,
    deadline: null,
    waits: null,
    startedAt: Date.now() - 180_000,
    session: "run:lint:20261117-000400-eeeeee",
    log: "/ud/output/lint/e.log",
    limitHit: null,
    warnedAt: null,
    warningDismissed: false,
  };
  const queued: ActiveRun = { ...running, job: "reindex", name: "Reindex", project: null, run: "20261117-000500-ffffff", trigger: "scheduled", state: "queued", dueAt: Date.now() - 60_000, startedAt: null, session: null, log: null, waits: { kind: "slot", ahead: 1 } };
  const quiet: RunsReport = { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 };

  async function show(page: Page, route: string, runs: { active?: ActiveRun[]; history?: RunRecord[]; output?: string }): Promise<void> {
    await page.goto(harness({ route }));
    await page.waitForFunction(() => typeof window.setRuns === "function");
    await page.evaluate(([report, history, output]) => window.setRuns({ report, history, output }), [{ ...quiet, active: runs.active ?? [] }, runs.history ?? [], runs.output ?? ""] as const);
  }

  test("History groups the runs by day, the runs going among them by time; each chip keeps its runs and counts them; This project keeps the open project's", async ({ page }) => {
    await show(page, "history", { active: [running, queued], history: [done, failed, skipped, missed] });
    const rows = app(page).getByTestId("history-row");
    await expect(rows).toHaveCount(6);
    // The heads by the clock as the test runs: near midnight a run minutes old is yesterday's.
    const heads = (times: number[]): string[] => [...new Set([...times].sort((a, b) => b - a).map(dayHead))];
    const going = [running.startedAt ?? 0, queued.dueAt];
    expect(heads([done.dueAt, failed.dueAt, skipped.dueAt])).toEqual(["Today", "Yesterday", expect.stringMatching(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d+ \w{3}$/)]);
    await expect(app(page).getByTestId("history-day")).toHaveText(heads([...going, done.dueAt, failed.dueAt, skipped.dueAt, missed.dueAt]));
    await expect(app(page).locator('[data-testid="history-row"][data-job="lint"]')).toContainText(/Lint\s*running\s*3m\s*manual/);
    await expect(app(page).locator('[data-testid="history-row"][data-job="scraper"]')).toContainText(/9:14\s*Scraper\s*failed · exit 1\s*8s\s*scheduled/);
    await expect(app(page).getByTestId("history-filter-active")).toHaveText("Active2");
    await expect(app(page).getByTestId("history-filter-failed")).toHaveText("Failed1");
    await expect(app(page).getByTestId("history-filter-missed")).toHaveText("Skipped & missed2");
    await expect(app(page).getByTestId("history-filter-all")).toHaveAttribute("aria-pressed", "true");
    await shoot(page, "tab-history-days");

    const kept = async (chip: string): Promise<string[]> => {
      await app(page).getByTestId(`history-filter-${chip}`).click();
      return rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-job") ?? ""));
    };
    expect(await kept("active")).toEqual(["reindex", "lint"]);
    await expect(app(page).getByTestId("history-day")).toHaveText(heads(going));
    expect(await kept("failed")).toEqual(["scraper"]);
    expect(await kept("missed")).toEqual(["health", "summary"]);
    await expect(app(page).getByTestId("history-day")).toHaveCount(1);
    await app(page).getByTestId("this-project").click();
    await expect(app(page).getByTestId("this-project")).toContainText("Alpha");
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-job")))).toEqual(["health"]);
    await expect(app(page).getByTestId("history-filter-missed")).toHaveText("Skipped & missed1");
    await app(page).getByTestId("history-filter-all").click();
    await expect(rows).toHaveCount(3);
    await app(page).getByTestId("history-filter-failed").click();
    await app(page).getByTestId("this-project").click();
    await expect(rows).toHaveCount(1);
    await page.evaluate((report) => window.setRuns({ report, history: [] }), quiet);
    await expect(app(page).getByTestId("history-empty")).toContainText("Every run lands here with its result and output.");
    await app(page).getByTestId("history-empty-new-job").click();
    await expect(app(page).getByTestId("form-save")).toBeVisible();
  });

  test("T-025 · a run that stands for more than one missed run says how many — History's rows, the result card, the missed-run card; one missed run reads as before", async ({ page }) => {
    const three = { count: 3, first: at(1, 17, 40), last: at(1, 17, 44) };
    const caught: RunRecord = { ...done, job: "low", name: "Low", run: "20261117-000600-gggggg", trigger: "caught-up", dueAt: three.last, startedAt: at(1, 17, 45), endedAt: at(1, 17, 45) + 2000, missed: three };
    const skippedMany: RunRecord = { ...missed, job: "skip", name: "Skip", run: "20261117-000700-hhhhhh", dueAt: three.last, endedAt: at(1, 17, 45), missed: three };
    const waiting: ActiveRun = { ...running, job: "wait", name: "Wait", project: null, run: "20261117-000800-iiiiii", trigger: "scheduled", state: "missed-waiting", dueAt: three.last, startedAt: null, session: null, log: null, missed: three };
    const once: RunRecord = { ...missed, missed: { count: 1, first: missed.dueAt, last: missed.dueAt } };
    await show(page, "history", { active: [waiting], history: [caught, skippedMany, once] });
    const row = (job: string) => app(page).locator(`[data-testid="history-row"][data-job="${job}"]`);
    await expect(row("low")).toContainText(/Low\s*done\s*2s\s*missed 3 runs, 17:40–17:44 · caught up once/);
    await expect(row("skip")).toContainText("missed 3 runs, 17:40–17:44 · skipped");
    await expect(row("wait")).toContainText("missed 3 runs, 17:40–17:44 · waiting for you");
    await expect(row("summary")).toContainText(/missed · skipped—scheduled/);
    await shoot(page, "tab-history-missed-runs");

    const dialog = app(page).getByTestId("run-dialog");
    await page.evaluate((route) => window.mounted.navigate(route), `run/low/${caught.run}`);
    await expect(dialog).toContainText("Missed 3 runs, 17:40–17:44 — caught up once");
    await expect(app(page).getByTestId("run-trigger")).toHaveText("caught up");
    await shoot(page, "tab-run-caught-up-missed-runs");
    await page.evaluate((route) => window.mounted.navigate(route), `run/skip/${skippedMany.run}`);
    await expect(app(page).getByTestId("run-reason")).toHaveText("Missed 3 runs, 17:40–17:44 · skipped.");
    await page.evaluate((route) => window.mounted.navigate(route), `run/summary/${once.run}`);
    await expect(app(page).getByTestId("run-reason")).toHaveText("Skipped.");
    await page.evaluate((route) => window.mounted.navigate(route), `run/wait/${waiting.run}`);
    await expect(app(page).getByTestId("run-missed-runs")).toHaveText("This job missed 3 runs, 17:40–17:44.");
    await expect(app(page).getByTestId("run-result")).toHaveText("Missed · waiting for you");
    await shoot(page, "tab-run-missed-runs-waiting");
  });

  test("older runs load as History scrolls to its end", async ({ page }) => {
    const many = Array.from({ length: 130 }, (_, index): RunRecord => ({ ...done, run: `20261117-000000-${String(index).padStart(6, "0")}`, dueAt: done.dueAt - index * 60_000, startedAt: done.dueAt - index * 60_000, endedAt: done.dueAt - index * 60_000 + 2000 }));
    await show(page, "history", { history: many });
    const rows = app(page).getByTestId("history-row");
    await expect(rows).toHaveCount(100);
    await expect(app(page).getByTestId("history-filter-failed")).toHaveText("Failed0+");
    await app(page).getByTestId("history-end").scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(130);
    await expect(app(page).getByTestId("history-filter-failed")).toHaveText("Failed0");
    await expect(app(page).getByTestId("history-end")).toHaveText("");
  });

  test("T-030 · every History column with text has a grip — Job, Result, Duration, Trigger; the time and the icon have none — and dragging one widens that column only, the rows and day heads staying in line", async ({ page }) => {
    const long: RunRecord = { ...failed, name: "Scraper with a very long job name that gets cut" };
    await page.setViewportSize({ width: 1500, height: 700 });
    await show(page, "history", { active: [running], history: [done, long, skipped] });
    const table = app(page).getByTestId("resizable-table");
    const head = table.locator("> div > div").first();
    const headCell = (id: string) => head.locator(`:scope > [data-col="${id}"]`);
    const grip = (id: string) => app(page).locator(`[data-testid="column-grip"][data-grip="${id}"]`);
    const ids = ["trigger", "job", "result", "duration"] as const;
    await expect(app(page).getByTestId("column-grip")).toHaveCount(4);
    await expect(head).toHaveText("TimeJobResultDurationTrigger");
    const widths = async (): Promise<number[]> => Promise.all(ids.map(async (id) => (await headCell(id).boundingBox())!.width));
    // The last column's grip is dragged first, while it is still in the tab.
    const aligned = async (): Promise<void> => {
      for (const view of await app(page).getByTestId("history-row").all()) {
        for (const [index, id] of [[2, "job"], [3, "result"], [4, "duration"], [5, "trigger"]] as const) {
          const cellBox = (await view.locator(":scope > *").nth(index).boundingBox())!;
          const headBox = (await headCell(id).boundingBox())!;
          expect(cellBox.x).toBeCloseTo(headBox.x, 0);
          expect(cellBox.width).toBeCloseTo(headBox.width, 0);
        }
      }
    };
    await aligned();
    for (const id of ids) {
      const cellBox = (await headCell(id).boundingBox())!;
      const gripBox = (await grip(id).boundingBox())!;
      expect(gripBox.x).toBeGreaterThanOrEqual(cellBox.x + cellBox.width - 4.5);
      expect(gripBox.x).toBeLessThanOrEqual(cellBox.x + cellBox.width + 0.5);
    }
    await headCell("result").hover();
    await shoot(page, "t030-history-grip-hover");

    for (const id of ids) {
      const before = await widths();
      const box = (await grip(id).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      const after = await widths();
      after.forEach((value, index) => expect(value, `${ids[index]} after dragging ${id}`).toBeCloseTo(before[index]! + (ids[index] === id ? 40 : 0), 0));
      await aligned();
    }
    await page.mouse.move(0, 0);
    await shoot(page, "t030-history-widened");
    // A day head spans the table, as wide as a row.
    const rowBox = (await app(page).getByTestId("history-row").first().boundingBox())!;
    for (const day of await app(page).getByTestId("history-day").all()) expect((await day.boundingBox())!.width).toBeCloseTo(rowBox.width, 0);
  });

  test("T-030 · History scrolls sideways when its columns are wider than the tab: head, rows and day heads together, the day's title kept at the left edge, the page itself never", async ({ page }) => {
    await show(page, "history", { active: [running], history: [done, failed, skipped] });
    const table = app(page).getByTestId("resizable-table");
    expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const grip = app(page).locator('[data-testid="column-grip"][data-grip="trigger"]');
    const box = (await grip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 500, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const room = await table.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(room).toBeGreaterThan(300);
    expect(await app(page).locator("html").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const day = app(page).getByTestId("history-day").first();
    const title = day.locator("[class*=title]");
    const titleAt = (await title.boundingBox())!.x;
    const first = app(page).getByTestId("history-row").first();
    const trigger = first.getByTestId("history-trigger");
    expect((await trigger.boundingBox())!.x + (await trigger.boundingBox())!.width).toBeGreaterThan(1040);
    for (const left of [0, 150, room]) {
      await table.evaluate((el, x) => void (el.scrollLeft = x), left);
      const head = (await table.locator("> div > div").first().boundingBox())!;
      const rowBox = (await first.boundingBox())!;
      expect(head.x).toBeCloseTo(rowBox.x, 0);
      expect(head.width).toBeCloseTo(rowBox.width, 0);
      expect((await day.boundingBox())!.x).toBeCloseTo(rowBox.x, 0);
      expect((await day.boundingBox())!.width).toBeCloseTo(rowBox.width, 0);
      // The title stays where it was; the day's line goes on under the columns.
      expect((await title.boundingBox())!.x).toBeCloseTo(titleAt, 0);
      const t = (await trigger.boundingBox())!;
      const h = (await table.locator('> div > div').first().locator(':scope > [data-col="trigger"]').boundingBox())!;
      expect(t.x).toBeCloseTo(h.x, 0);
      expect(await rowPastEdge(table), `a row past the edge at ${left}`).toBe(false);
    }
    const end = (await trigger.boundingBox())!;
    expect(end.x + end.width).toBeLessThanOrEqual(1040);
    const wide = (await first.boundingBox())!;
    expect(wide.width).toBeCloseTo(await table.evaluate((el) => el.scrollWidth), 0);
    expect(wide.x + wide.width).toBeGreaterThanOrEqual(end.x + end.width);
    await shoot(page, "t030-history-scrolled");
  });

  test("T-056 · a History longer than the tab scrolls in the table's own area: the head stays at its top with the day under it, the sideways scrollbar's place at the tab's bottom, the page itself never scrolls", async ({ page }) => {
    // Six runs a day over ten days: far longer than the 700 px tab.
    const long = Array.from({ length: 60 }, (_, n): RunRecord => {
      const due = at(Math.floor(n / 6), 20 - (n % 6) * 2, 0);
      return { ...done, run: `20261117-0${String(n).padStart(5, "0")}-long${String(n).padStart(2, "0")}`, dueAt: due, startedAt: due, endedAt: due + 2000 };
    });
    await show(page, "history", { history: long });
    await expect(app(page).getByTestId("history-row")).toHaveCount(60);
    const table = app(page).getByTestId("resizable-table");
    const head = table.locator("> div > div").first();
    const frame = (await page.locator('iframe[data-frame="main"]').boundingBox())!;
    const view = frame.y + frame.height;
    // Wider than the tab: Trigger grows by 6 large steps.
    const grip = app(page).locator('[data-testid="column-grip"][data-grip="trigger"]');
    await grip.focus();
    for (let step = 0; step < 6; step++) await page.keyboard.press("Shift+ArrowRight");
    await grip.blur();
    expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(200);
    expect(await table.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1000);
    // The page's own scroll region has nothing to scroll; the table ends inside the tab.
    expect(await table.evaluate((el) => (el.closest("main")!.lastElementChild as HTMLElement).scrollHeight - (el.closest("main")!.lastElementChild as HTMLElement).clientHeight)).toBeLessThanOrEqual(0);
    const top = (await head.boundingBox())!.y;
    const bottom = async (): Promise<number> => {
      const box = (await table.boundingBox())!;
      return box.y + box.height;
    };
    expect(await bottom()).toBeLessThanOrEqual(view);
    expect(await bottom()).toBeGreaterThan(view - 40);

    // A wheel over the rows scrolls the list, not the page: the head stays put, a day under it.
    const rowBox = (await app(page).getByTestId("history-row").nth(3).boundingBox())!;
    await page.mouse.move(rowBox.x + 100, rowBox.y + rowBox.height / 2);
    // 700 px: three days (each its head, six rows and the gap: 232 px) and a little of the fourth.
    await page.mouse.wheel(0, 700);
    await expect.poll(() => table.evaluate((el) => el.scrollTop)).toBe(700);
    expect((await head.boundingBox())!.y).toBeCloseTo(top, 0);
    /** The day heads whose top is at the column head's bottom. */
    const pinnedDays = async () => {
      const headBox = (await head.boundingBox())!;
      const boxes = await Promise.all((await app(page).getByTestId("history-day").all()).map(async (day) => (await day.boundingBox())!));
      return boxes.filter((box) => Math.abs(box.y - (headBox.y + headBox.height)) < 1);
    };
    expect(await pinnedDays(), "a day head pinned right under the column head").toHaveLength(1);
    // The head paints over the rows passing beneath it.
    const hit = await head.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(el.ownerDocument.elementFromPoint(box.left + 300, box.top + box.height / 2));
    });
    expect(hit).toBe(true);
    expect(await bottom()).toBeLessThanOrEqual(view);

    // Sideways too: the head and the rows move together, the head and the day stay at the top.
    await table.evaluate((el) => void (el.scrollLeft = 160));
    const first = app(page).getByTestId("history-row").nth(20);
    await first.scrollIntoViewIfNeeded();
    expect((await head.boundingBox())!.x).toBeCloseTo((await first.boundingBox())!.x, 0);
    const trigger = (await first.getByTestId("history-trigger").boundingBox())!.x;
    expect(trigger).toBeCloseTo((await head.locator(':scope > [data-col="trigger"]').boundingBox())!.x, 0);
    expect((await head.boundingBox())!.y).toBeCloseTo(top, 0);
    await shoot(page, "t056-history-scrolled");

    // A row taking focus above the view comes into sight below the head and its day, not under them.
    await table.evaluate((el) => void (el.scrollTop = el.scrollHeight));
    const target = app(page).getByTestId("history-row").nth(13);
    await target.focus();
    const [stuck] = await pinnedDays();
    expect((await target.boundingBox())!.y).toBeGreaterThanOrEqual(stuck!.y + stuck!.height - 1);
  });

  test("T-030 · History's widths are kept on this Mac, and a double click on a grip puts them back to the default", async ({ page }) => {
    await show(page, "history", { active: [running], history: [done, failed] });
    const headCell = (id: string) => app(page).getByTestId("resizable-table").locator("> div > div").first().locator(`:scope > [data-col="${id}"]`);
    const result = async (): Promise<number> => (await headCell("result").boundingBox())!.width;
    const start = await result();
    const grip = app(page).locator('[data-testid="column-grip"][data-grip="result"]');
    await grip.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(result).toBeCloseTo(start + 64, 0);
    const key = "pomade-runner.history.column-widths";
    expect(JSON.parse((await app(page).locator("html").evaluate((_, k) => window.localStorage.getItem(k), key))!).result).toBe(Math.round(start + 64));

    await show(page, "history", { active: [running], history: [done, failed] });
    expect(await result()).toBeCloseTo(start + 64, 0);
    await grip.dblclick();
    expect(await app(page).locator("html").evaluate((_, k) => window.localStorage.getItem(k), key)).toBeNull();
    expect(await result()).toBeCloseTo(start, 0);
  });

  test("T-030 · a cut Job, Result or Trigger shows whole in its tooltip — above the help the Result and Trigger carry; one that fits shows the help alone", async ({ page }) => {
    const long: RunRecord = { ...failed, name: "Scraper with a very long job name that gets cut" };
    const three = { count: 3, first: at(1, 17, 40), last: at(1, 17, 44) };
    const caught: RunRecord = { ...done, job: "low", name: "Low", run: "20261117-000600-gggggg", trigger: "caught-up", dueAt: three.last, startedAt: at(1, 17, 45), endedAt: at(1, 17, 45) + 2000, missed: three };
    await show(page, "history", { history: [done, long, skipped, caught] });
    const tip = app(page).getByTestId("tooltip");
    const view = (job: string) => app(page).locator(`[data-testid="history-row"][data-job="${job}"]`);
    // Job: no help of its own, so the tip is the name — only while it is cut.
    await view("scraper").locator("[class*=name]").hover();
    await expect(tip).toHaveText(long.name);
    await view("backup").locator("[class*=name]").hover();
    await expect(tip).toHaveCount(0);
    // Result and Trigger fit: the help alone, as before.
    await view("health").getByTestId("history-result").hover();
    await expect(tip).toHaveText(HELP["st.skipped"].join(""));
    await view("low").getByTestId("history-trigger").hover();
    await expect(tip).toHaveText(HELP["tr.caught up"].join(""));
    // Narrowed to their least, they are cut: the whole text leads, the help follows.
    for (const id of ["result", "trigger"]) {
      await app(page).locator(`[data-testid="column-grip"][data-grip="${id}"]`).focus();
      for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowLeft");
    }
    await view("health").getByTestId("history-result").hover();
    await expect(tip).toHaveText(`skipped · previous run still going${HELP["st.skipped"].join("")}`);
    await view("low").getByTestId("history-trigger").hover();
    await expect(tip).toHaveText(`missed 3 runs, 17:40–17:44 · caught up once${HELP["tr.caught up"].join("")}`);
    await shoot(page, "t030-history-cut-tooltip");
    await view("backup").getByTestId("history-trigger").hover();
    await expect(tip).toHaveText(HELP["tr.scheduled"].join(""));
  });

  test("T-038 · an agent run queued for a fresh keeper says why on its card", async ({ page }) => {
    const waiting: ActiveRun = { ...queued, kind: "agent", job: "digest", name: "Morning digest", run: "20261117-000700-hhhhhh", waits: { kind: "keeper" } };
    await show(page, `run/digest/${waiting.run}`, { active: [running, waiting] });
    const dialog = app(page).getByTestId("run-dialog");
    await expect(app(page).getByTestId("run-result")).toHaveText("Queued");
    await expect(dialog.getByTestId("run-waits")).toHaveText(
      "The keeper cannot reach the macOS keychain, so an agent started there would have no login. Runner starts a fresh keeper once the runs going have finished, then this run.",
    );
    await shoot(page, "tab-run-queued-keeper");
  });

  test("a running run's card: its latest output, Open terminal opens its attached tab, Stop run stops it", async ({ page }) => {
    await show(page, `run/lint/${running.run}`, { active: [running], output: "$ ./lint.sh\r\nchecking 12 files\r\n" });
    const dialog = app(page).getByTestId("run-dialog");
    await expect(app(page).getByTestId("run-result")).toHaveText("Running");
    await expect(dialog.getByTestId("run-last-lines")).toHaveText("$ ./lint.sh\nchecking 12 files");
    await expect(dialog.getByTestId("run-trigger")).toHaveText("manual");
    await shoot(page, "tab-run-running");
    await dialog.getByRole("button", { name: "Open terminal" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: running.session }, title: "Lint" }]);
    await dialog.getByRole("button", { name: "Stop run" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([{ method: "runs.stop", params: { job: "lint", run: running.run } }]);
  });

  test("a queued run's card says what it waits for; a skipped run's why it never started", async ({ page }) => {
    await show(page, `run/reindex/${queued.run}`, { active: [queued], history: [skipped] });
    const dialog = app(page).getByTestId("run-dialog");
    await expect(app(page).getByTestId("run-result")).toHaveText("Queued");
    await expect(dialog.getByTestId("run-waits")).toHaveText("Low-priority runs are going in every free slot — 1 run ahead. This one starts when one of them finishes.");
    // The low-priority runs holding the slots are named, as the prototype's card names them.
    const backup: ActiveRun = { ...running, job: "backup", name: "Photo backup", run: "20261117-000600-gggggg" };
    const holding: [RunsReport, RunRecord[]] = [{ ...quiet, active: [running, backup, queued] }, [skipped]];
    await page.evaluate(([report, history]) => window.setRuns({ report, history }), holding);
    await expect(dialog.getByTestId("run-waits")).toHaveText("Two low-priority runs are going (Lint, Photo backup). This one starts when one of them finishes.");
    await page.evaluate((route) => window.mounted.navigate(route), `run/health/${skipped.run}`);
    await expect(app(page).getByTestId("run-result")).toHaveText("Skipped");
    await expect(dialog.getByTestId("run-reason")).toHaveText("Previous run still going.");
    await expect(dialog.getByRole("button", { name: "View output" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Run now" })).toBeVisible();
    await dialog.getByRole("button", { name: "Edit job" }).click();
    await expect(app(page).getByTestId("run-dialog")).toHaveCount(0);
  });

  test("statuses explain themselves on hover, with no (i): History's results and the card's pill", async ({ page }) => {
    await show(page, "history", { active: [running], history: [failed, skipped] });
    const tip = app(page).getByRole("tooltip");
    const text = (key: keyof typeof HELP): string => HELP[key].join("");
    await app(page).locator('[data-testid="history-row"][data-job="scraper"]').getByTestId("history-result").hover();
    await expect(tip).toHaveText(text("st.failed"));
    await app(page).locator('[data-testid="history-row"][data-job="health"]').getByTestId("history-result").hover();
    await expect(tip).toHaveText(text("st.skipped"));
    await app(page).locator('[data-testid="history-row"][data-job="lint"]').getByTestId("history-result").hover();
    await expect(tip).toHaveText(text("st.running"));
    await app(page).locator('[data-testid="history-row"][data-job="lint"]').getByTestId("history-trigger").hover();
    await expect(tip).toHaveText(text("tr.manual"));
    await shoot(page, "tab-history-help");
    await expect(app(page).getByTestId("history").locator('[data-testid^="help-st."]')).toHaveCount(0);

    await app(page).locator('[data-testid="history-row"][data-job="scraper"]').click();
    await app(page).getByTestId("run-result").hover();
    await expect(tip).toHaveText(text("st.failed"));
    await expect(app(page).getByTestId("run-dialog").locator('[data-testid^="help-st."]')).toHaveCount(0);
  });
});

test.describe("the Script form and the schedule picker", () => {
  test.use({ viewport: { width: 1040, height: 760 } });
  /** The prototype's clock: Tue 17 Nov 2026, 12:48. */
  const NOW = new Date(2026, 10, 17, 12, 48);
  const JOBS = "Apps/pomade-runner/jobs";

  async function start(page: Page, route = "new"): Promise<void> {
    await page.clock.setFixedTime(NOW);
    await page.goto(harness({ route }));
    // The stand-in scheduler first, then the mounted app.
    await page.waitForFunction(() => typeof window.setServiceStatus === "function" && typeof window.mounted === "object");
  }

  function fileText(page: Page, path: string): Promise<string | null> {
    return page.evaluate((p) => {
      try {
        return window.fakeHost.readFile(p);
      } catch {
        return null;
      }
    }, path);
  }

  /** New job → Script, its name, command and folder typed; the form. */
  async function newScript(page: Page, name: string): Promise<FrameLocator> {
    await page.evaluate(() => {
      window.mounted.navigate("");
      window.mounted.navigate("new");
    });
    await app(page).getByTestId("kind-script").click();
    const form = app(page).getByTestId("form-script");
    await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await form.getByRole("textbox", { name: "Command", exact: true }).fill("./run.sh");
    await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
    return app(page);
  }

  /** The words box: the schedule in words, and the next runs. */
  async function expectWords(frame: FrameLocator, words: string, next: string): Promise<void> {
    await expect(frame.getByTestId("schedule-in-words")).toHaveText(words);
    await expect(frame.getByTestId("schedule-next")).toHaveText(next);
  }

  /** Create, back on Jobs, and the file the form wrote. */
  async function create(page: Page, slug: string): Promise<string | null> {
    await expect(app(page).getByTestId("form-save")).toHaveText("Create job");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    return fileText(page, `${JOBS}/${slug}.md`);
  }

  const header = (name: string): string => `---\nkind: script\nname: ${name}\nfolder: .\nenabled: true\ncommand: ./run.sh\n`;

  test("a script in each shape: once, every, daily, weekly, monthly — the words and next three runs live, and the file the checker accepts", async ({ page }) => {
    await start(page);
    // The Script card is live; the form's order: Kind · Trigger · Runs · Policies.
    let frame = await newScript(page, "Daily report");
    const form = frame.getByTestId("form-script");
    await expect(form.getByRole("region")).toHaveText([/^Kind/, /^Trigger/, /^Runs/, /^Policies/]);
    await expect(frame.getByTestId("trigger-choice").getByRole("button", { name: "On a schedule" })).toHaveAttribute("aria-pressed", "true");
    await expect(frame.getByTestId("schedule-shape").getByRole("button", { name: "Daily" })).toHaveAttribute("aria-pressed", "true");
    // Daily, two times, weekdays only.
    await expectWords(frame, "Runs daily at 9:00", "Next: tomorrow 9:00 · Thu 9:00 · Fri 9:00 · Mac’s local time");
    await form.getByRole("textbox", { name: "Time 1" }).fill("13:00");
    await form.getByRole("button", { name: "Add time" }).click();
    await expect(form.getByRole("textbox", { name: "Time 2" })).toHaveValue("20:00");
    await expect(form.getByRole("textbox", { name: "Time 2" })).toBeFocused();
    await expectWords(frame, "Runs daily at 13:00 and 20:00", "Next: today 13:00 · today 20:00 · tomorrow 13:00 · Mac’s local time");
    await frame.getByTestId("day-filter").getByRole("button", { name: "Weekdays only" }).click();
    await expectWords(frame, "Runs weekdays at 13:00 and 20:00", "Next: today 13:00 · today 20:00 · tomorrow 13:00 · Mac’s local time");
    await shoot(page, "tab-form-script-daily");
    expect(await create(page, "daily-report")).toBe(`${header("Daily report")}schedule:\n  daily: { at: [13:00, 20:00] }\n  only: weekdays\n---\n`);

    // Every 2 hours, only between 9:00 and 17:00.
    frame = await newScript(page, "Ping");
    await frame.getByTestId("schedule-shape").getByRole("button", { name: "Every…" }).click();
    await frame.getByRole("textbox", { name: "Interval" }).fill("2");
    await frame.getByRole("combobox", { name: "Unit" }).selectOption("hours");
    await frame.getByRole("switch", { name: "Only between" }).click();
    await frame.getByRole("textbox", { name: "To" }).fill("17:00");
    await expectWords(frame, "Runs every 2 hours, 9:00–17:00", "Next: today 13:00 · today 15:00 · today 17:00 · Mac’s local time");
    await frame.getByTestId("day-filter").getByRole("button", { name: "Weekends only" }).click();
    await expectWords(frame, "Runs every 2 hours on weekends, 9:00–17:00", "Next: Sat 9:00 · Sat 11:00 · Sat 13:00 · Mac’s local time");
    expect(await create(page, "ping")).toBe(`${header("Ping")}schedule:\n  every: { hours: 2, from: 9:00, to: 17:00 }\n  only: weekends\n---\n`);

    // Weekly on Monday and Saturday.
    frame = await newScript(page, "Backup");
    await frame.getByTestId("schedule-shape").getByRole("button", { name: "Weekly" }).click();
    const week = frame.getByTestId("week-days");
    for (const day of ["Tue", "Wed", "Thu", "Fri", "Sat"]) await week.getByRole("button", { name: day }).click();
    await expect(week.getByRole("button", { pressed: true })).toHaveText(["Mon", "Sat"]);
    await frame.getByRole("textbox", { name: "Time 1" }).fill("7:00");
    await expectWords(frame, "Runs every Mon and Sat at 7:00", "Next: Sat 7:00 · Mon 7:00 · Sat 28 Nov 7:00 · Mac’s local time");
    expect(await create(page, "backup")).toBe(`${header("Backup")}schedule:\n  weekly: { days: [mon, sat], at: 7:00 }\n---\n`);

    // Monthly: the 15th, the last day and the first Monday.
    frame = await newScript(page, "Rotate logs");
    await frame.getByTestId("schedule-shape").getByRole("button", { name: "Monthly" }).click();
    const grid = frame.getByTestId("month-days");
    await grid.getByRole("button", { name: "1", exact: true }).click();
    await grid.getByRole("button", { name: "15", exact: true }).click();
    await grid.getByRole("button", { name: "Last day" }).click();
    await frame.getByRole("button", { name: "Add", exact: true }).click();
    await frame.getByRole("combobox", { name: "Which" }).selectOption("last");
    await frame.getByRole("combobox", { name: "Weekday" }).selectOption("fri");
    await frame.getByRole("button", { name: "Add", exact: true }).click();
    await expect(frame.getByRole("checkbox")).toHaveText(["the first Monday", "the last Friday"]);
    await frame.getByRole("checkbox", { name: "the last Friday" }).click();
    await expect(frame.getByRole("checkbox")).toHaveText(["the first Monday"]);
    await expectWords(frame, "Runs monthly on the 15th, the last day and the first Monday at 9:00", "Next: Mon 30 Nov 9:00 · Mon 7 Dec 9:00 · Tue 15 Dec 9:00 · Mac’s local time");
    await shoot(page, "tab-form-script-monthly");
    expect(await create(page, "rotate-logs")).toBe(`${header("Rotate logs")}schedule:\n  monthly: { days: [15, last, first mon], at: 9:00 }\n---\n`);

    // Once: a phrase fills in the day and the time; one it cannot read says so.
    frame = await newScript(page, "Tidy notes");
    await frame.getByTestId("schedule-shape").getByRole("button", { name: "Once" }).click();
    await expect(frame.getByRole("combobox", { name: "Date" })).toHaveValue("2026-11-17");
    await expect(frame.getByRole("combobox", { name: "Date" }).locator("option")).toHaveText(["Today", "Tomorrow", "Thu", "Fri", "Sat", "Sun", "Mon"]);
    await expectWords(frame, "Runs once, today at 23:00", "Next: today 23:00 — then finished · Mac’s local time");
    const phrase = frame.getByRole("textbox", { name: "Or say it in words" });
    await phrase.fill("whenever");
    await expect(frame.getByTestId("schedule-box").getByRole("alert")).toHaveText("Can’t read that — try “tonight 23:00”, “tomorrow 7:00” or “+2h”.");
    await phrase.fill("tomorrow 7:30");
    await expect(frame.getByTestId("schedule-box").getByRole("alert")).toHaveCount(0);
    await expect(frame.getByRole("combobox", { name: "Date" })).toHaveValue("2026-11-18");
    await expect(frame.getByRole("textbox", { name: "Time" })).toHaveValue("7:30");
    await expectWords(frame, "Runs once, tomorrow at 7:30", "Next: tomorrow 7:30 — then finished · Mac’s local time");
    // A day further out keeps the date: only today and tomorrow are said as such.
    await phrase.fill("2026-11-19 7:30");
    await expectWords(frame, "Runs once on Nov 19, 2026 at 7:30", "Next: Thu 7:30 — then finished · Mac’s local time");
    await phrase.fill("+2h");
    await expect(frame.getByRole("textbox", { name: "Time" })).toHaveValue("14:48");
    await shoot(page, "tab-form-script-once");
    expect(await create(page, "tidy-notes")).toBe(`${header("Tidy notes")}schedule:\n  once: 2026-11-17 14:48\n---\n`);
  });

  test("a schedule error shows on the control that caused it, the words wait for a fix, and Save focuses it", async ({ page }) => {
    await start(page);
    const frame = await newScript(page, "Report");
    await frame.getByRole("button", { name: "Add time" }).click();
    const second = frame.getByRole("textbox", { name: "Time 2" });
    await second.fill("25:00");
    // A filled-in field's error shows at once, on that time.
    await expect(second).toHaveAttribute("aria-invalid", "true");
    await expect(frame.getByRole("textbox", { name: "Time 1" })).not.toHaveAttribute("aria-invalid");
    await expect(frame.getByTestId("form-trigger").getByRole("alert")).toHaveText('schedule.daily.at[1] — "25:00" is not a time. Fix: write a time like 7:00 or 13:30 (H:MM, 24-hour).');
    await expect(frame.getByTestId("schedule-in-words")).toHaveText("Fix the schedule to see it in words");
    await expect(frame.getByTestId("schedule-next")).toHaveCount(0);
    await frame.getByRole("textbox", { name: "Name", exact: true }).fill("");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("form-error-count")).toHaveText("2 things to fix before saving");
    await expect(frame.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
    await shoot(page, "tab-form-script-errors");
    await frame.getByRole("textbox", { name: "Name", exact: true }).fill("Report");
    await frame.getByTestId("form-save").click();
    await expect(second).toBeFocused();
    // Weekly with no day: said on the days.
    await second.fill("20:00");
    await frame.getByTestId("schedule-shape").getByRole("button", { name: "Weekly" }).click();
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) await frame.getByTestId("week-days").getByRole("button", { name: day }).click();
    await expect(frame.getByTestId("form-trigger").getByRole("alert")).toHaveText("schedule.weekly.days — empty. Fix: list at least one a weekday (mon, tue, wed, thu, fri, sat or sun).");
    await frame.getByTestId("week-days").getByRole("button", { name: "Sun" }).click();
    await expect(frame.getByTestId("form-trigger").getByRole("alert")).toHaveCount(0);
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/report.md`)).toBe(`${header("Report")}schedule:\n  weekly: { days: [sun], at: [9:00, 20:00] }\n---\n`);
  });

  test("policies: one sentence until Change; overlap's options with the default tagged; a non-default in bold", async ({ page }) => {
    await start(page);
    const frame = await newScript(page, "Sync");
    const policies = frame.getByTestId("form-policies");
    await expect(policies.getByTestId("policy-summary")).toHaveText("If missed, run on wake · never overlaps itself · low priority · no time limit · notifies on failure");
    await expect(policies).toContainText("defaults for Script");
    await policies.getByRole("button", { name: "Change" }).click();
    const overlap = policies.getByRole("group", { name: "If still running" });
    await expect(overlap.getByRole("button")).toHaveText(["Skipdefault", "Run in parallel", "Queue after"]);
    await overlap.getByRole("button", { name: "Queue after" }).click();
    await policies.getByRole("group", { name: "Notify me" }).getByRole("button", { name: "Never" }).click();
    await expect(policies).toContainText("customised");
    await shoot(page, "tab-form-script-policies");
    expect(await create(page, "sync")).toBe(`${header("Sync")}schedule:\n  daily: { at: 9:00 }\noverlap: queue\nnotify: never\n---\n`);
  });

  test("policies: what a missed run becomes, until when a catch-up is worth it, a time limit — each written to the job file, the file's other fields untouched", async ({ page }) => {
    await start(page);
    const frame = await newScript(page, "Weekly review");
    const policies = frame.getByTestId("form-policies");
    await policies.getByRole("button", { name: "Change" }).click();
    const missed = policies.getByRole("group", { name: "If a run is missed" });
    await expect(missed.getByRole("button")).toHaveText(["Run on wakedefault", "Wait for me", "Skip"]);
    const worth = policies.getByRole("group", { name: "Still worth it until" });
    await expect(worth.getByRole("button", { pressed: true })).toHaveText("the next scheduled run");
    await expect(policies.getByRole("textbox", { name: "Time limit" })).toHaveAttribute("placeholder", "none");
    await expect(policies).toContainText("No limit · the “still expected?” warning still applies");
    // Until a time of day.
    await worth.getByRole("button", { name: "a time of day" }).click();
    await expect(policies.getByRole("textbox", { name: "Worth it until" })).toHaveValue("12:00");
    await policies.getByRole("textbox", { name: "Worth it until" }).fill("8:30");
    await policies.getByRole("textbox", { name: "Time limit" }).fill("45m");
    await expect(policies).toContainText("Stops the run with a red card");
    await shoot(page, "tab-form-script-policies-open");
    expect(await create(page, "weekly-review")).toBe(`${header("Weekly review")}schedule:\n  daily: { at: 9:00 }\nworth-until: 8:30\ntime-limit: 45m\n---\n`);

    // Edited from the file: the form shows it, a change writes only that field.
    const text = "---\nkind: script # tidy\nname: Tidy\nfolder: .\ncommand: ./t.sh\nschedule:\n  daily: { at: 7:00 } # early\nworth-until: 12:00\ntime-limit: 45m\nnotify: always # say so\n---\nNotes.\n";
    await page.evaluate((t) => {
      window.fakeHost.writeFile("Apps/pomade-runner/jobs/tidy.md", t);
      window.mounted.navigate("");
      window.mounted.navigate("edit/tidy");
    }, text);
    await expect(policies.getByTestId("policy-summary")).toHaveText("If missed, run on wake until 12:00 · never overlaps itself · low priority · stops after 45m · always notifies");
    await expect(policies.getByTestId("policy-summary").locator("b")).toHaveText(["If missed, run on wake until 12:00", "stops after 45m", "always notifies"]);
    await policies.getByRole("button", { name: "Change" }).click();
    await expect(policies.getByRole("group", { name: "If a run is missed" }).getByRole("button", { pressed: true })).toHaveText("Run on wakedefault");
    await expect(policies.getByRole("textbox", { name: "Worth it until" })).toHaveValue("12:00");
    await expect(policies.getByRole("textbox", { name: "Time limit" })).toHaveValue("45m");
    await expect(frame.getByTestId("form-save")).toHaveText("Saved");
    await policies.getByRole("group", { name: "If a run is missed" }).getByRole("button", { name: "Wait for me" }).click();
    // worth-until goes with run-on-wake: its line is gone, and so is the field from the file.
    await expect(policies.getByRole("group", { name: "Still worth it until" })).toHaveCount(0);
    await policies.getByRole("textbox", { name: "Time limit" }).fill("");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/tidy.md`)).toBe("---\nkind: script # tidy\nname: Tidy\nfolder: .\ncommand: ./t.sh\nschedule:\n  daily: { at: 7:00 } # early\nnotify: always # say so\nmissed: wait-for-me\n---\nNotes.\n");
  });

  test("policies: a time limit that is no duration and a time of day that is no time say so on their rows, and Save stays", async ({ page }) => {
    await start(page);
    const frame = await newScript(page, "Late");
    const policies = frame.getByTestId("form-policies");
    await policies.getByRole("button", { name: "Change" }).click();
    await policies.getByRole("textbox", { name: "Time limit" }).fill("soon");
    await policies.getByRole("group", { name: "Still worth it until" }).getByRole("button", { name: "a time of day" }).click();
    await policies.getByRole("textbox", { name: "Worth it until" }).fill("noon");
    await expect(policies.getByRole("textbox", { name: "Time limit" })).toHaveAttribute("aria-invalid", "true");
    await expect(policies.getByRole("textbox", { name: "Worth it until" })).toHaveAttribute("aria-invalid", "true");
    await expect(policies).toContainText('time-limit — "soon" is not a duration. Fix: write minutes or hours, e.g. time-limit: 45m, 2h or 1h30m — or leave it empty for no limit.');
    await expect(policies).toContainText('worth-until — "noon" is not a time of day. Fix: write a time like worth-until: 12:00 (H:MM, 24-hour), or worth-until: next-run.');
    await shoot(page, "tab-form-script-policies-errors");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("form-error-count")).toHaveText("2 things to fix before saving");
    await expect(policies.getByRole("textbox", { name: "Worth it until" })).toBeFocused();
    expect(await fileText(page, `${JOBS}/late.md`)).toBeNull();
    await policies.getByRole("textbox", { name: "Worth it until" }).fill("13:00");
    await policies.getByRole("textbox", { name: "Time limit" }).fill("1h30m");
    expect(await create(page, "late")).toBe(`${header("Late")}schedule:\n  daily: { at: 9:00 }\nworth-until: 13:00\ntime-limit: 1h30m\n---\n`);
  });

  test("policies: a missed-run policy only a schedule has — a hook says it does not apply; a stray worth-until is the file's problem, not a blocked Save", async ({ page }) => {
    await start(page, "edit/mount");
    const text = "---\nkind: script\nname: Mount\nfolder: .\ncommand: ./mount.sh\nhook: { event: login }\n---\n";
    await page.evaluate((t) => window.fakeHost.writeFile("Apps/pomade-runner/jobs/mount.md", t), text);
    const frame = app(page);
    const policies = frame.getByTestId("form-policies");
    await expect(policies.getByTestId("policy-summary")).toHaveText("Never overlaps itself · low priority · no time limit · notifies on failure");
    await policies.getByRole("button", { name: "Change" }).click();
    await expect(policies.getByTestId("missed-n-a")).toHaveText("Doesn’t apply — hooks fire only while Pomade is running.");
    await expect(policies.getByRole("group", { name: "If a run is missed" })).toHaveCount(0);
    await policies.getByRole("textbox", { name: "Time limit" }).fill("5m");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/mount.md`)).toBe(text.replace("hook: { event: login }\n", "hook: { event: login }\ntime-limit: 5m\n"));

    const stray = "---\nkind: script\nname: Stray\nfolder: .\ncommand: ./s.sh\nschedule:\n  daily: { at: 7:00 }\nmissed: skip\nworth-until: 12:00\n---\n";
    await page.evaluate((t) => {
      window.fakeHost.writeFile("Apps/pomade-runner/jobs/stray.md", t);
      window.mounted.navigate("");
      window.mounted.navigate("edit/stray");
    }, stray);
    await expect(frame.getByTestId("form-file-errors")).toContainText("worth-until — only applies with missed: run-on-wake");
    await frame.getByRole("textbox", { name: "Command", exact: true }).fill("./s2.sh");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/stray.md`)).toBe(stray.replace("./s.sh", "./s2.sh"));
  });

  test("editing a script writes the schedule field only: comments elsewhere and the body stay", async ({ page }) => {
    const text = "---\nkind: script # tidy\nname: Tidy\nfolder: .\ncommand: ./tidy.sh\nschedule:\n  daily: { at: 7:00 }\nnotify: always # say so\n---\nNotes.\n";
    await start(page, "edit/tidy");
    await page.evaluate((t) => window.fakeHost.writeFile("Apps/pomade-runner/jobs/tidy.md", t), text);
    const frame = app(page);
    await expect(frame.getByRole("textbox", { name: "Time 1" })).toHaveValue("7:00");
    await expect(frame.getByTestId("form-save")).toHaveText("Saved");
    await frame.getByRole("textbox", { name: "Time 1" }).fill("7:30");
    await expect(frame.getByTestId("form-save")).toHaveText("Save");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/tidy.md`)).toBe(text.replace("at: 7:00", "at: 7:30"));
  });

  test("a script whose hook is on an event the checker does not know keeps it: said in words, changed in the file, Save held", async ({ page }) => {
    const text = "---\nkind: script\nname: Init\nfolder: .\ncommand: ./init.sh\nhook: { event: session-opened, agent: claude } # after claude\n---\n";
    await start(page, "edit/init");
    await page.evaluate((t) => window.fakeHost.writeFile("Apps/pomade-runner/jobs/init.md", t), text);
    const frame = app(page);
    const choice = frame.getByTestId("trigger-choice");
    await expect(choice.getByRole("button", { name: "When something happens" })).toHaveAttribute("aria-pressed", "true");
    await expect(frame.getByTestId("file-trigger")).toContainText("Runs on its hookThis hook is set in the job file: hook:");
    await expect(frame.getByTestId("hook-event")).toHaveCount(0);
    await frame.getByTestId("trigger-open-file").click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: `${JOBS}/init.md` }]);
    // To a schedule and back: the hook is the file's again.
    await choice.getByRole("button", { name: "On a schedule" }).click();
    await expect(frame.getByTestId("schedule-words")).toBeVisible();
    await choice.getByRole("button", { name: "When something happens" }).click();
    await expect(frame.getByTestId("file-trigger")).toBeVisible();
    await frame.getByRole("textbox", { name: "Command", exact: true }).fill("./init-all.sh");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("form-error-count")).toBeVisible();
    expect(await fileText(page, `${JOBS}/init.md`)).toBe(text);
  });

  const BACKUP = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
  const WEB = "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh # dev server\n---\nNotes.\n";

  async function writeJobs(page: Page, files: Record<string, string>): Promise<void> {
    await page.evaluate((all) => {
      for (const [path, text] of Object.entries(all)) window.fakeHost.writeFile(`Apps/pomade-runner/jobs/${path}`, text);
    }, files);
  }

  test("T-010 · a script on the Mac login hook and one chained after another job: the Event list, the chain's job and result, the trigger in words — and the files a hand-written hook and chain are", async ({ page }) => {
    await start(page, "");
    await writeJobs(page, { "backup.md": BACKUP, "web.md": WEB });
    await expect(app(page).getByTestId("job-row")).toHaveCount(2);
    let frame = await newScript(page, "Mount");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    const event = frame.getByTestId("hook-event");
    // The hooks the engine fires, then the chain, last.
    await expect(event.locator("option")).toHaveText(["Mac login", "Pomade started", "First open of a project since Pomade started", "Project opened (every time)", "Project created", "Agent session finished", "Session status changed to…", "Another job finished"]);
    await expect(event).toHaveValue("login");
    await expect(frame.getByTestId("hook-words")).toHaveText("Runs at Mac loginOnce per login, after the 2-minute warm-up.");
    await frame.getByTestId("form-policies").getByRole("button", { name: "Change" }).click();
    await expect(frame.getByTestId("missed-n-a")).toHaveText("Doesn’t apply — hooks fire only while Pomade is running.");
    await shoot(page, "tab-form-hook-login");
    expect(await create(page, "mount")).toBe(`${header("Mount")}hook: { event: login }\n---\n`);

    frame = await newScript(page, "Cleanup");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "Another job finished" });
    const job = frame.getByTestId("chain-job");
    // Jobs that finish, by name: no service, not the job itself.
    await expect(job.locator("option")).toHaveText(["Choose a job…", "Backup", "Mount"]);
    await expect(frame.getByTestId("hook-words")).toHaveText("Runs after another job finishesA chain. History will show “chain: after …”.");
    await job.selectOption({ label: "Backup" });
    await frame.getByTestId("chain-result").getByRole("button", { name: "Fails" }).click();
    await expect(frame.getByTestId("hook-words")).toHaveText("Runs after Backup failsA chain. History will show “chain: after Backup”.");
    await shoot(page, "tab-form-chain");
    expect(await create(page, "cleanup")).toBe(`${header("Cleanup")}after: { job: backup, result: failed }\n---\n`);
    await expect(app(page).getByTestId("job-trigger")).toContainText(["daily at 13:00", "after Backup fails", "at Mac login"]);

    // A chain with no job chosen: Save asks for one on the picker.
    frame = await newScript(page, "Orphan");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "Another job finished" });
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("chain-error")).toHaveText("after — names no job. Fix: add the job to follow: after: { job: backup, result: done }.");
    await expect(frame.getByTestId("chain-job")).toBeFocused();
  });

  test("T-013 · a script on Pomade's hooks: Pomade started, the first open of a project with its picker, Project created — each with its (i), the words, and the file a hand-written hook is", async ({ page }) => {
    await start(page, "");
    let frame = await newScript(page, "Updates");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    const pomade = "Fires only while Pomade is running, so there are no missed runs.";
    await frame.getByTestId("hook-event").selectOption({ label: "Pomade started" });
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs when Pomade starts${pomade}`);
    await expect(frame.getByTestId("hook-box")).toHaveCount(0);
    await frame.getByTestId("help-hk.pomade-started").hover();
    await expect(frame.getByRole("tooltip")).toHaveText(HELP["hk.pomade-started"].join(""));
    await frame.getByTestId("form-policies").getByRole("button", { name: "Change" }).click();
    await expect(frame.getByTestId("missed-n-a")).toHaveText("Doesn’t apply — hooks fire only while Pomade is running.");
    await shoot(page, "tab-form-hook-pomade-started");
    expect(await create(page, "updates")).toBe(`${header("Updates")}hook: { event: pomade-started }\n---\n`);

    frame = await newScript(page, "Scraper");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "First open of a project since Pomade started" });
    const project = frame.getByTestId("hook-project");
    await expect(project.locator("option")).toHaveText(["Any project", "Alpha"]);
    await expect(project).toHaveValue("");
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs on first open of a project${pomade}`);
    await frame.getByTestId("help-hk.project-first-open").hover();
    await expect(frame.getByRole("tooltip")).toHaveText(HELP["hk.project-first-open"].join(""));
    await project.selectOption({ label: "Alpha" });
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs on first open of Alpha${pomade}`);
    await shoot(page, "tab-form-hook-first-open");
    expect(await create(page, "scraper")).toBe(`${header("Scraper")}hook: { event: project-first-open, project: alpha }\n---\n`);

    frame = await newScript(page, "Init");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "Project created" });
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs when a project is created${pomade}`);
    await frame.getByTestId("help-hk.project-created").hover();
    await expect(frame.getByRole("tooltip")).toHaveText(HELP["hk.project-created"].join(""));
    await shoot(page, "tab-form-hook-project-created");
    expect(await create(page, "init")).toBe(`${header("Init")}hook: { event: project-created }\n---\n`);
    await expect(app(page).getByTestId("job-trigger")).toContainText(["when a project is created", "on first open of Alpha", "when Pomade starts"]);

    frame = await newScript(page, "Dashboard");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "Project opened (every time)" });
    await expect(frame.getByTestId("hook-project").locator("option")).toHaveText(["Any project", "Alpha"]);
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs whenever a project is opened${pomade}`);
    await frame.getByTestId("help-hk.project-opened").hover();
    await expect(frame.getByRole("tooltip")).toHaveText(HELP["hk.project-opened"].join(""));
    await frame.getByTestId("hook-project").selectOption({ label: "Alpha" });
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs whenever Alpha is opened${pomade}`);
    await shoot(page, "tab-form-hook-project-opened");
    expect(await create(page, "dashboard")).toBe(`${header("Dashboard")}hook: { event: project-opened, project: alpha }\n---\n`);
    await expect(app(page).getByTestId("job-trigger")).toContainText(["whenever Alpha is opened"]);

    // Edited: the form shows the file's hook and its project.
    await page.evaluate(() => window.mounted.navigate("edit/scraper"));
    await expect(app(page).getByTestId("hook-event")).toHaveValue("project-first-open");
    await expect(app(page).getByTestId("hook-project")).toHaveValue("alpha");
  });

  test("T-014 · a script on the agents' hooks: Agent session finished and Session status changed to…, with their status, project and agent pickers — the roster's agents — each with its (i), the words, and the file a hand-written hook is", async ({ page }) => {
    await start(page, "");
    const pomade = "Fires only while Pomade is running, so there are no missed runs.";
    let frame = await newScript(page, "Lint after session");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "Agent session finished" });
    await expect(frame.getByTestId("hook-status")).toHaveCount(0);
    const project = frame.getByTestId("hook-project");
    const agent = frame.getByTestId("hook-agent");
    await expect(project.locator("option")).toHaveText(["Any project", "Alpha"]);
    await expect(agent.locator("option")).toHaveText(["Any agent", "claude", "claude-editor", "claude-coder", "claude-pm", "codex"]);
    await expect(frame.getByTestId("hook-box").getByRole("combobox", { name: "Only in project" })).toBeVisible();
    await expect(frame.getByTestId("hook-box").getByRole("combobox", { name: "Only agent" })).toBeVisible();
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs after an agent session finishes${pomade}`);
    await frame.getByTestId("help-hk.session-finished").hover();
    await expect(frame.getByRole("tooltip")).toHaveText(HELP["hk.session-finished"].join(""));
    await project.selectOption({ label: "Alpha" });
    await agent.selectOption({ label: "claude" });
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs after a claude session finishes in Alpha${pomade}`);
    await frame.getByTestId("hook-words").hover();
    await shoot(page, "tab-form-hook-session-finished");
    expect(await create(page, "lint-after-session")).toBe(`${header("Lint after session")}hook: { event: session-finished, project: alpha, agent: claude }\n---\n`);

    frame = await newScript(page, "Session Analyzer");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "Session status changed to…" });
    const status = frame.getByTestId("hook-status");
    await expect(status.locator("option")).toHaveText(["Active", "On hold", "Done", "Done–skip/Failed"]);
    await expect(status).toHaveValue("done");
    await expect(frame.getByTestId("hook-box").getByRole("combobox")).toHaveCount(3);
    await expect(frame.getByTestId("hook-box").getByRole("combobox", { name: "Status" })).toBeVisible();
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs when a session is marked Done${pomade}`);
    await frame.getByTestId("help-hk.session-status").hover();
    await expect(frame.getByRole("tooltip")).toHaveText(HELP["hk.session-status"].join(""));
    await frame.getByTestId("hook-words").hover();
    await shoot(page, "tab-form-hook-session-status");
    await status.selectOption({ label: "On hold" });
    await frame.getByTestId("hook-agent").selectOption({ label: "codex" });
    await expect(frame.getByTestId("hook-words")).toHaveText(`Runs when a codex session is marked On hold${pomade}`);
    await status.selectOption({ label: "Done" });
    await frame.getByTestId("hook-agent").selectOption({ label: "Any agent" });
    expect(await create(page, "session-analyzer")).toBe(`${header("Session Analyzer")}hook: { event: session-status, status: done }\n---\n`);
    await expect(app(page).getByTestId("job-trigger")).toContainText(["after a claude session finishes in Alpha", "when a session is marked Done"]);

    // Edited: the form shows the file's hook and its filters.
    await page.evaluate(() => window.mounted.navigate("edit/lint-after-session"));
    await expect(app(page).getByTestId("hook-event")).toHaveValue("session-finished");
    await expect(app(page).getByTestId("hook-project")).toHaveValue("alpha");
    await expect(app(page).getByTestId("hook-agent")).toHaveValue("claude");
  });

  test("T-014 · without the Agents app an agent session hook says so under its pickers, and keeps the file's agent", async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await page.goto(harness({ route: "", agents: "none" }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function" && typeof window.mounted === "object");
    await page.evaluate((t) => window.fakeHost.writeFile("Apps/pomade-runner/jobs/lint.md", t), "---\nkind: script\nname: Lint\nfolder: .\ncommand: ./lint.sh\nhook: { event: session-finished, agent: claude }\n---\n");
    await expect(app(page).getByTestId("job-row")).toHaveCount(1);
    await page.evaluate(() => window.mounted.navigate("edit/lint"));
    const frame = app(page);
    await expect(frame.getByTestId("agents-absent")).toHaveText("The Agents app (pomade-agents) is not running. Runner lists the agents from its roster, and the Agents app tells Runner of its sessions: this hook fires only while it runs.");
    await expect(frame.getByTestId("hook-agent").locator("option")).toHaveText(["Any agent", "claude"]);
    await expect(frame.getByTestId("hook-agent")).toHaveValue("claude");
    await shoot(page, "tab-form-hook-session-absent");
  });

  test("T-013 · a service's Starts: on first open of a project, with its project picked; the file has start-project, the Jobs view says it", async ({ page }) => {
    await start(page, "");
    await page.evaluate(() => {
      window.mounted.navigate("");
      window.mounted.navigate("new");
    });
    await app(page).getByTestId("kind-service").click();
    const form = app(page).getByTestId("form-service");
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("Docs");
    await form.getByRole("textbox", { name: "Command", exact: true }).fill("npm run docs");
    await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
    await expect(form.getByTestId("start-project")).toHaveCount(0);
    await form.getByRole("button", { name: "On first open of a project" }).click();
    const picker = form.getByTestId("start-project");
    // A workspace service names the project it waits for.
    await expect(picker.locator("option")).toHaveText(["Choose a project…", "Alpha"]);
    await picker.selectOption({ label: "Alpha" });
    await expect(picker.locator("option")).toHaveText(["Alpha"]);
    await form.getByTestId("help-f.start").hover();
    await expect(app(page).getByRole("tooltip")).toHaveText(HELP["f.start"].join(""));
    await shoot(page, "tab-form-service-starts-first-open");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/docs.md`)).toBe("---\nkind: service\nname: Docs\nfolder: .\nenabled: true\ncommand: npm run docs\nstart: project-first-open\nstart-project: alpha\n---\n");
    await expect(app(page).locator('[data-testid="job-row"][data-job="docs"]').getByTestId("job-trigger")).toHaveText("from first open of Alpha while Pomade is running");
  });

  test("T-021 · a service's Starts: On Mac startup, While Pomade is running, On first open of a project — each with its hint, the create button and the file", async ({ page }) => {
    await start(page, "");
    await page.evaluate(() => {
      window.mounted.navigate("");
      window.mounted.navigate("new");
    });
    await app(page).getByTestId("kind-service").click();
    const form = app(page).getByTestId("form-service");
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("Watch");
    await form.getByRole("textbox", { name: "Command", exact: true }).fill("npm run watch");
    await form.getByRole("textbox", { name: "Folder", exact: true }).fill(".");
    const starts = form.locator('[data-field="start"]');
    await expect(starts.getByRole("button")).toHaveText(["On Mac startupdefault", "While Pomade is running", "On first open of a project"]);
    await expect(form.getByText("Up before you open Pomade, and it outlives Pomade.", { exact: false })).toBeVisible();
    await expect(app(page).getByTestId("form-save")).toHaveText("Create and start");
    await form.getByRole("button", { name: "While Pomade is running" }).click();
    await expect(form.getByText("Starts when Pomade starts and stops when Pomade quits.", { exact: false })).toBeVisible();
    await expect(form.getByTestId("start-project")).toHaveCount(0);
    await expect(app(page).getByTestId("form-save")).toHaveText("Create and start");
    await page.mouse.move(0, 0);
    await shoot(page, "tab-form-service-starts-pomade");
    await form.getByRole("button", { name: "On first open of a project" }).click();
    await expect(form.getByText("and stops when Pomade quits. Stopped by you", { exact: false })).toBeVisible();
    await expect(app(page).getByTestId("form-save")).toHaveText("Create job");
    await form.getByRole("button", { name: "While Pomade is running" }).click();
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/watch.md`)).toBe("---\nkind: service\nname: Watch\nfolder: .\nenabled: true\ncommand: npm run watch\nstart: pomade-started\n---\n");
    await expect(app(page).locator('[data-testid="job-row"][data-job="watch"]').getByTestId("job-trigger")).toHaveText("while Pomade is running");
  });

  test("T-010 · a chain that leads back to itself is refused on Save, both jobs named in the checker's words, with the (i) on why", async ({ page }) => {
    const a = "---\nkind: script\nname: A\nfolder: .\ncommand: ./a.sh\nschedule:\n  daily: { at: 9:00 }\n---\n";
    const b = "---\nkind: script\nname: B\nfolder: .\ncommand: ./b.sh\nafter: { job: a }\n---\n";
    await start(page, "edit/a");
    await writeJobs(page, { "a.md": a, "b.md": b });
    const frame = app(page);
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("hook-event").selectOption({ label: "Another job finished" });
    await frame.getByTestId("chain-job").selectOption({ label: "B" });
    const error = frame.getByTestId("chain-error");
    await expect(error).toHaveText("after.job — the chain loops back: a → b → a. Fix: remove after: from one of these jobs, or point it at a job outside the loop.");
    await expect(frame.getByTestId("chain-job")).toHaveAttribute("aria-invalid", "true");
    await error.getByTestId("help-hk.loop").hover();
    await expect(frame.getByRole("tooltip")).toHaveText(HELP["hk.loop"].join(""));
    await shoot(page, "tab-form-loop");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("form-error-count")).toHaveText("1 thing to fix before saving");
    await expect(frame.getByTestId("job-form")).toBeVisible();
    expect(await fileText(page, `${JOBS}/a.md`)).toBe(a);
    // Pointed outside the loop, it saves.
    await frame.getByTestId("chain-job").selectOption({ label: "Choose a job…" });
    await writeJobs(page, { "c.md": a.replace("name: A", "name: C") });
    await frame.getByTestId("chain-job").selectOption({ label: "C" });
    await expect(error).toHaveCount(0);
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/a.md`)).toBe(a.replace("schedule:\n  daily: { at: 9:00 }\n", "after: { job: c, result: done }\n"));
  });

  test("T-010 · a service's chain: + Restart, start or stop it after another job adds the line; it writes after:, field-only; × removes it", async ({ page }) => {
    await start(page, "edit/web");
    await writeJobs(page, { "backup.md": BACKUP, "web.md": WEB, "docs.md": WEB.replace("name: Web", "name: Docs") });
    const frame = app(page);
    const add = frame.getByTestId("service-chain-add");
    await expect(add).toHaveText("+ Restart, start or stop it after another job");
    await add.click();
    const line = frame.getByTestId("service-chain");
    await expect(line).toContainText("Also");
    await expect(line.getByRole("combobox", { name: "What it does" }).locator("option")).toHaveText(["restart it", "start it", "stop it"]);
    // Jobs that finish: never a service.
    await expect(frame.getByTestId("chain-job").locator("option")).toHaveText(["choose a job…", "Backup"]);
    await line.getByRole("combobox", { name: "What it does" }).selectOption({ label: "stop it" });
    await frame.getByTestId("chain-job").selectOption({ label: "Backup" });
    await line.getByRole("combobox", { name: "When it" }).selectOption({ label: "fails" });
    await shoot(page, "tab-form-service-chain");
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    const chained = WEB.replace("---\nNotes", "after: { job: backup, result: failed, action: stop }\n---\nNotes");
    expect(await fileText(page, `${JOBS}/web.md`)).toBe(chained);
    await expect(app(page).locator('[data-testid="job-row"][data-job="web"]').getByTestId("job-trigger")).toHaveText("always on · starts on Mac startup · stops after Backup fails");

    await page.evaluate(() => {
      window.mounted.navigate("");
      window.mounted.navigate("edit/web");
    });
    await expect(frame.getByTestId("chain-job")).toHaveValue("backup");
    await frame.getByTestId("service-chain-remove").click();
    await expect(frame.getByTestId("service-chain")).toHaveCount(0);
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/web.md`)).toBe(WEB);
  });

  test("T-027 · Manually: the Trigger's third choice, one sentence under it; the file has no trigger and checks clean; the Jobs row says manual, not scheduled, and Run now runs it", async ({ page }) => {
    await start(page);
    const frame = await newScript(page, "Clean cache");
    const choice = frame.getByTestId("trigger-choice");
    await expect(choice.getByRole("button")).toHaveText(["On a schedule", "When something happens", "Manually"]);
    await choice.getByRole("button", { name: "Manually" }).click();
    await expect(choice.getByRole("button", { name: "Manually" })).toHaveAttribute("aria-pressed", "true");
    await expect(frame.getByTestId("manual-trigger")).toHaveText("It runs only when you press Run now — never by itself.");
    await expect(frame.getByTestId("schedule-box")).toHaveCount(0);
    await expect(frame.getByTestId("hook-event")).toHaveCount(0);
    const policies = frame.getByTestId("form-policies");
    await expect(policies.getByTestId("policy-summary")).toHaveText("Never overlaps itself · low priority · no time limit · notifies on failure");
    await policies.getByRole("button", { name: "Change" }).click();
    await expect(policies.getByTestId("missed-n-a")).toHaveText("Doesn’t apply — a manual job runs only when you start it.");
    await expect(policies.getByRole("group", { name: "If a run is missed" })).toHaveCount(0);
    await shoot(page, "tab-form-script-manual");
    expect(await create(page, "clean-cache")).toBe(`${header("Clean cache")}---\n`);

    // The checker takes it: a valid row, its trigger and Next run in words; Run now calls Runner.
    const row = frame.locator('[data-testid="job-row"][data-job="clean-cache"]');
    await expect(row.getByTestId("job-trigger")).toHaveText("manual");
    await expect(row.getByTestId("job-next")).toHaveText("not scheduled");
    await expect(frame.locator('[data-testid="job-invalid"][data-job="clean-cache"]')).toHaveCount(0);
    await shoot(page, "tab-jobs-manual-row");
    await page.evaluate(() => (window.runnerCalls.length = 0));
    await row.getByRole("button", { name: "Run now" }).click();
    await expect(frame.getByTestId("toast").last()).toHaveText("RunnerClean cache started · trigger “manual”");
    expect(await page.evaluate(() => window.runnerCalls)).toEqual([{ method: "jobs.run", params: { job: "clean-cache" } }]);
  });

  test("T-027 · Manually on a scheduled job takes out only its schedule: lines — comments, other fields and the body stay", async ({ page }) => {
    const text = "---\nkind: script # tidy\nname: Tidy\nfolder: .\ncommand: ./tidy.sh\nschedule:\n  daily: { at: 7:00 }\nnotify: always # say so\n---\nNotes.\n";
    await start(page, "edit/tidy");
    await page.evaluate((t) => window.fakeHost.writeFile("Apps/pomade-runner/jobs/tidy.md", t), text);
    const frame = app(page);
    await expect(frame.getByRole("textbox", { name: "Time 1" })).toHaveValue("7:00");
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "Manually" }).click();
    await frame.getByTestId("form-save").click();
    await expect(frame.getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/tidy.md`)).toBe(text.replace("schedule:\n  daily: { at: 7:00 }\n", ""));
  });

  test("every field the Script form adds has a working (i)", async ({ page }) => {
    await start(page);
    const frame = await newScript(page, "Help");
    const tip = frame.getByRole("tooltip");
    const shapes = frame.getByTestId("schedule-shape");
    for (const [name, key] of [["Once", "sh.once"], ["Every…", "sh.every"], ["Daily", "sh.daily"], ["Weekly", "sh.weekly"], ["Monthly", "sh.monthly"]] as const) {
      await shapes.getByRole("button", { name }).hover();
      await expect(tip).toHaveText(HELP[key].join(""));
    }
    await frame.getByTestId("kind-script").hover();
    await expect(tip).toHaveText(HELP["kind.script"].join(""));
    await frame.getByTestId("form-policies").getByRole("button", { name: "Change" }).click();
    const keys = ["f.trigger", "sh.filter", "p.missed", "p.worth", "p.overlap", "p.low", "p.limit", "p.notify", "f.command", "f.folder", "f.project"] as const;
    for (const key of keys) {
      await frame.getByTestId(`help-${key}`).hover();
      await expect(tip).toHaveText(HELP[key].join(""));
    }
    // Each missed-run choice explains itself.
    const missed = frame.getByRole("group", { name: "If a run is missed" });
    for (const [name, key] of [["Run on wake", "p.wake"], ["Wait for me", "p.waitme"], ["Skip", "p.skip"]] as const) {
      await missed.getByRole("button", { name }).hover();
      await expect(tip).toHaveText(HELP[key].join(""));
    }
    await shapes.getByRole("button", { name: "Every…" }).click();
    await frame.getByTestId("help-sh.within").hover();
    await expect(tip).toHaveText(HELP["sh.within"].join(""));
    await shapes.getByRole("button", { name: "Once" }).click();
    await frame.getByTestId("help-sh.phrase").hover();
    await expect(tip).toHaveText(HELP["sh.phrase"].join(""));
    // The hooks: the event's (i) follows the event; a chain's result and a loop have theirs.
    await frame.getByTestId("trigger-choice").getByRole("button", { name: "When something happens" }).click();
    await frame.getByTestId("help-hk.login").hover();
    await expect(tip).toHaveText(HELP["hk.login"].join(""));
    await frame.getByTestId("hook-event").selectOption({ label: "Another job finished" });
    // The pointer leaves the (i) it was on, which now explains the chain.
    await frame.getByTestId("hook-event").hover();
    for (const key of ["hk.job-finished", "hk.result"] as const) {
      await frame.getByTestId(`help-${key}`).hover();
      await expect(tip).toHaveText(HELP[key].join(""));
    }
  });
});

test.describe("the panel: Needs you, Next up, Running now", () => {
  test.use({ viewport: { width: 240, height: 1100 } });
  const SCRIPT = (name: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./run.sh\nschedule:\n  daily: { at: 13:00 }\n---\n`;
  const SERVICE = "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n";
  const minutes = (n: number): number => n * 60_000;

  const run = (job: string, name: string, id: string, extra: Partial<ActiveRun> = {}, now = Date.now()): ActiveRun => ({
    job,
    name,
    kind: "script",
    project: null,
    folder: "",
    run: id,
    trigger: "scheduled",
    cause: null,
    dueAt: now,
    agent: null,
    missed: null,
    series: null,
    state: "running",
    lowPriority: true,
    runAt: null,
    deadline: null,
    waits: null,
    startedAt: now - minutes(3) - 5000,
    session: `run:${job}:${id}`,
    log: null,
    limitHit: null,
    warnedAt: null,
    warningDismissed: false,
    ...extra,
  });

  /** One item of each kind, with times relative to `now`. */
  const items = (now: number): NeedsYouItem[] => [
    { id: "run-failed:backup", kind: "run-failed", job: "backup", name: "Backup", project: null, run: "20261117-130000-aaaaaa", at: now - minutes(20), count: 2, detail: "exit 2" },
    { id: "service-failed:web", kind: "service-failed", job: "web", name: "Web", project: null, at: now - minutes(30), detail: "crashed 5 times within a minute", problem: null, session: true },
    { id: "missed:weekly", kind: "missed", job: "weekly", name: "Weekly", project: null, run: "20261117-030000-bbbbbb", at: now - 2 * 86_400_000, missed: null, detail: "missed" },
    { id: "long-run:lint:20261117-100000-cccccc", kind: "long-run", job: "lint", name: "Lint", project: null, run: "20261117-100000-cccccc", at: now, startedAt: now - minutes(3 * 60 + 2), detail: "running 3 h" },
    { id: "loop-paused:echo", kind: "loop-paused", job: "echo", name: "Echo", project: null, at: now - 86_400_000, detail: "triggered 10× in 10 min — looks like a loop" },
    { id: "waiting:tidy-drafts:20261117-123100-dddddd", kind: "waiting", job: "tidy-drafts", name: "Tidy drafts", project: null, run: "20261117-123100-dddddd", prompt: "permission", at: now - minutes(17), detail: "waiting for approval" },
  ];

  async function panel(page: Page, report: (now: number) => RunsReport): Promise<void> {
    // Midday on the prototype's day: an item minutes old is today's at any time the suite runs.
    await page.clock.setFixedTime(new Date(2026, 10, 17, 12, 48));
    await page.goto(harness({ surface: "panel" }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await writeJob(page, "backup.md", SCRIPT("Backup"));
    await writeJob(page, "lint.md", SCRIPT("Lint"));
    await writeJob(page, "web.md", SERVICE);
    await expect(app(page).getByTestId("panel-jobs")).toBeVisible();
    const now = await page.evaluate(() => Date.now());
    await page.evaluate((r) => window.setRuns({ report: r, history: [] }), report(now));
  }

  const quiet = (now: number): RunsReport => ({ active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: now - now }, heldRuns: 0 });
  const withItems = (now: number): RunsReport => ({ ...quiet(now), needsYou: items(now) });
  const card = (page: Page, kind: string): ReturnType<FrameLocator["locator"]> => app(page).locator(`[data-testid="needs-you-item"][data-kind="${kind}"]`);
  const toasts = (page: Page): ReturnType<FrameLocator["getByTestId"]> => app(page).getByTestId("toast");
  const calls = (page: Page): Promise<{ method: string; params: unknown }[]> => page.evaluate(() => window.runnerCalls);

  test("every kind of item is a card: the dot, the name, the (i), the time, the line of text, and its actions", async ({ page }) => {
    await panel(page, withItems);
    await expect(app(page).getByTestId("needs-you-item")).toHaveCount(6);
    await expect(app(page).getByTestId("section-needs-you-head-count")).toHaveText("6");
    const look: Record<string, { help: string; words: string; when: RegExp; buttons: string[] }> = {
      "run-failed": { help: "need.failed", words: "Failed: exit 2 · 2×", when: /^\d{1,2}:\d{2}$/, buttons: ["Backup", "", "Open", "Run now", "Dismiss"] },
      "service-failed": { help: "need.crashloop", words: "Crashed 5× in 1 min — gave up.", when: /^\d{1,2}:\d{2}$/, buttons: ["Web", "", "Start", "View output"] },
      missed: { help: "need.waitforme", words: "Missed — it waits for you to pick a time.", when: /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d{2}$/, buttons: ["Weekly", "", "Run now", "Run at…", "Skip"] },
      "long-run": { help: "need.longrun", words: "Running 3h — still expected?", when: /^3h 0[23]m$/, buttons: ["Lint", "", "Open", "Stop", "Dismiss"] },
      "loop-paused": { help: "need.loopguard", words: "Paused: triggered 10× in 10 min.", when: /^yesterday$/, buttons: ["Echo", "", "Resume", "Edit job"] },
      waiting: { help: "need.approval", words: "Waiting for approval at a permission prompt.", when: /^17m$/, buttons: ["Tidy drafts", "", "Open at the prompt"] },
    };
    for (const [kind, expected] of Object.entries(look)) {
      const item = card(page, kind);
      await expect(item.getByTestId("needs-you-words")).toHaveText(expected.words);
      await expect(item.getByTestId(`help-${expected.help}`)).toBeVisible();
      await expect(item.getByRole("button")).toHaveText(expected.buttons);
      await expect(item.locator("h2 ~ span")).toHaveText(expected.when);
    }
    // The first action of each card but the long run's is the primary one.
    for (const kind of ["run-failed", "service-failed", "missed", "loop-paused", "waiting"]) await expect(card(page, kind).getByRole("button").nth(2)).toHaveCSS("background-color", "rgb(47, 146, 178)");
    await expect(card(page, "long-run").getByRole("button").nth(2)).not.toHaveCSS("background-color", "rgb(47, 146, 178)");
    await shoot(page, "panel-needs-you");

    await card(page, "service-failed").getByTestId("help-need.crashloop").hover();
    await expect(app(page).getByTestId("tooltip")).toHaveText("The service crashed 5 times within a minute, so Runner stopped restarting it.Example: fix the port clash, then press Start.");
  });

  test("a card's name opens what it is about: the run's card, the service's terminal, the job in Jobs", async ({ page }) => {
    await panel(page, withItems);
    const opened = (): Promise<unknown[]> => page.evaluate(() => window.fakeHost.openedTabs);
    await card(page, "run-failed").getByRole("button", { name: "Backup" }).click();
    await card(page, "service-failed").getByRole("button", { name: "Web" }).click();
    await card(page, "missed").getByRole("button", { name: "Weekly" }).click();
    await card(page, "long-run").getByRole("button", { name: "Lint" }).click();
    await card(page, "loop-paused").getByRole("button", { name: "Echo" }).click();
    await expect.poll(opened).toEqual([
      { kind: "app", projectId: "alpha", route: "run/backup/20261117-130000-aaaaaa" },
      { kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "svc:web" }, title: "Web" },
      { kind: "app", projectId: "alpha", route: "run/weekly/20261117-030000-bbbbbb" },
      { kind: "app", projectId: "alpha", route: "run/lint/20261117-100000-cccccc" },
      { kind: "app", projectId: "alpha", route: "jobs/echo" },
    ]);
  });

  test("a service that gave up: Start runs it, View output opens its terminal; a loop-paused job: Resume, Edit job opens its form", async ({ page }) => {
    await panel(page, withItems);
    await card(page, "service-failed").getByRole("button", { name: "View output" }).click();
    await card(page, "service-failed").getByRole("button", { name: "Start" }).click();
    await expect(toasts(page)).toHaveText("RunnerWeb started");
    await card(page, "loop-paused").getByRole("button", { name: "Edit job" }).click();
    await card(page, "loop-paused").getByRole("button", { name: "Resume" }).click();
    await expect(toasts(page).last()).toHaveText("RunnerEcho resumed");
    await expect(card(page, "loop-paused")).toHaveCount(0);
    expect(await page.evaluate(() => window.fakeHost.openedTabs)).toEqual([
      { kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "svc:web" }, title: "Web" },
      { kind: "app", projectId: "alpha", route: "edit/echo" },
    ]);
    expect(await calls(page)).toEqual([
      { method: "services.start", params: { job: "web" } },
      { method: "jobs.resume", params: { job: "echo" } },
    ]);
  });

  test("a service that gave up before it got a terminal has no View output, says why it could not start, and its name opens the job in Jobs", async ({ page }) => {
    const docs = (now: number): NeedsYouItem => ({ id: "service-failed:docs", kind: "service-failed", job: "docs", name: "Docs", project: null, at: now - minutes(10), detail: "no folder nowhere", problem: "no folder nowhere", session: false });
    await panel(page, (now) => ({ ...quiet(now), needsYou: [docs(now), ...items(now).filter((item) => item.kind === "service-failed")] }));
    const [without, withSession] = [card(page, "service-failed").first(), card(page, "service-failed").last()];
    await expect(without.getByTestId("needs-you-words")).toHaveText("Gave up — could not start: no folder nowhere");
    await expect(without.getByRole("button")).toHaveText(["Docs", "", "Start"]);
    await expect(withSession.getByTestId("needs-you-words")).toHaveText("Crashed 5× in 1 min — gave up.");
    await expect(withSession.getByRole("button")).toHaveText(["Web", "", "Start", "View output"]);
    await shoot(page, "panel-service-gave-up");
    await without.getByRole("button", { name: "Docs" }).click();
    await withSession.getByRole("button", { name: "Web" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([
      { kind: "app", projectId: "alpha", route: "jobs/docs" },
      { kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "svc:web" }, title: "Web" },
    ]);
  });

  test("a failed run: Run now says it started, Dismiss clears the card and counts down; a long run: Open its terminal, Stop, Dismiss", async ({ page }) => {
    await panel(page, withItems);
    const count = app(page).getByTestId("section-needs-you-head-count");
    await card(page, "run-failed").getByRole("button", { name: "Run now" }).click();
    await expect(toasts(page)).toHaveText("RunnerBackup started");
    await card(page, "run-failed").getByRole("button", { name: "Dismiss" }).click();
    await expect(card(page, "run-failed")).toHaveCount(0);
    await expect(count).toHaveText("5");

    await card(page, "long-run").getByRole("button", { name: "Open" }).click();
    await card(page, "long-run").getByRole("button", { name: "Stop" }).click();
    await expect(toasts(page).last()).toHaveText("RunnerLint stopped by you");
    await card(page, "long-run").getByRole("button", { name: "Dismiss" }).click();
    await expect(toasts(page).last()).toHaveText("RunnerOK — it keeps running. No more reminders for this run.");
    await expect(card(page, "long-run")).toHaveCount(0);
    await expect(count).toHaveText("4");
    expect((await calls(page)).map((call) => call.method)).toEqual(["jobs.run", "needsYou.dismiss", "runs.stop", "needsYou.dismiss"]);
    expect((await page.evaluate(() => window.fakeHost.openedTabs))[0]).toEqual({ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "run:lint:20261117-100000-cccccc" }, title: "Lint" });

    // A run waiting for you: Open at the prompt opens its terminal tab; it cannot be dismissed.
    await card(page, "waiting").getByRole("button", { name: "Open at the prompt" }).click();
    await expect.poll(async () => (await page.evaluate(() => window.fakeHost.openedTabs))[1]).toEqual({ kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "run:tidy-drafts:20261117-123100-dddddd" }, title: "Tidy drafts" });
  });

  test("a missed run: Run now, Skip, and Run at… with its field, what the time comes to, and Set", async ({ page }) => {
    await panel(page, withItems);
    const item = card(page, "missed");
    await item.getByRole("button", { name: "Run at…" }).click();
    const field = item.getByRole("textbox", { name: "Run at" });
    await expect(field).toHaveValue("tonight 23:00");
    await expect(field).toBeFocused();
    await field.fill("soon");
    await expect(item.getByTestId("run-at-hint")).toHaveText("Try: tonight 23:00 · tomorrow 7:00 · +2h");
    await field.fill("+2h");
    await expect(item.getByTestId("run-at-hint")).toHaveText(/^→ (today|tomorrow) \d{1,2}:\d{2}$/);
    await shoot(page, "panel-needs-you-run-at");
    await field.fill("23:00");
    await item.getByRole("button", { name: "Set" }).click();
    await expect(toasts(page)).toHaveText(/^RunnerWeekly will run (today|tomorrow) 23:00$/);
    await item.getByRole("button", { name: "Run now" }).click();
    await item.getByRole("button", { name: "Skip" }).click();
    await expect(toasts(page).last()).toHaveText("RunnerRecorded as “missed · skipped”");
    expect(await calls(page)).toEqual([
      { method: "runs.missed", params: { job: "weekly", choice: "run-at", at: "23:00" } },
      { method: "runs.missed", params: { job: "weekly", choice: "run-now" } },
      { method: "runs.missed", params: { job: "weekly", choice: "skip" } },
    ]);
    await field.press("Escape");
    await expect(field).toHaveCount(0);
  });

  test("a refusal is a toast that names the job and why", async ({ page }) => {
    await panel(page, withItems);
    await page.evaluate(() => {
      window.refuse = { "jobs.run": "a run of Backup is going", "services.start": "the keeper is not connected", "needsYou.dismiss": "no such item" };
    });
    await card(page, "run-failed").getByRole("button", { name: "Run now" }).click();
    await expect(toasts(page)).toHaveText("RunnerCould not run Backup: a run of Backup is going");
    await card(page, "service-failed").getByRole("button", { name: "Start" }).click();
    await expect(toasts(page).last()).toHaveText("RunnerCould not start Web: the keeper is not connected");
    await card(page, "run-failed").getByRole("button", { name: "Dismiss" }).click();
    await expect(toasts(page).last()).toHaveText("RunnerCould not dismiss Backup: no such item");
    await expect(card(page, "run-failed")).toHaveCount(1);
  });

  test("a quiet panel: Needs you is a grey 0 and says so; with items the count is a red badge", async ({ page }) => {
    await panel(page, quiet);
    const count = app(page).getByTestId("section-needs-you-head-count");
    await expect(count).toHaveText("0");
    await expect(count).not.toHaveCSS("background-color", "rgb(209, 73, 91)");
    await expect(app(page).getByTestId("needs-you")).toHaveText("Nothing needs you.");
    await shoot(page, "panel-quiet");
    await page.evaluate((r) => window.setRuns({ report: r, history: [] }), withItems(Date.now()));
    await expect(count).toHaveText("6");
    await expect(count).toHaveCSS("background-color", "rgb(209, 73, 91)");
  });

  test("Next up: the next runs — in N min, then the time — with the job's kind; a row opens the job in Jobs", async ({ page }) => {
    await panel(page, (now) => ({
      ...quiet(now),
      nextUp: [
        { job: "backup", name: "Backup", project: null, at: now + minutes(40) + 30_000, held: false },
        { job: "lint", name: "Lint", project: null, at: now + minutes(95), held: false },
        { job: "web", name: "Web", project: null, at: now + 30 * 3_600_000, held: false },
        { job: "a", name: "A", project: null, at: now + 31 * 3_600_000, held: false },
        { job: "b", name: "B", project: null, at: now + 32 * 3_600_000, held: false },
        { job: "c", name: "C", project: null, at: now + 33 * 3_600_000, held: false },
      ],
    }));
    const rows = app(page).getByTestId("next-up-item");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toHaveText(/^in 4[01] minBackup$/);
    await expect(rows.nth(1)).toHaveText(/^(\d{1,2}:\d{2}|tmrw \d{1,2}:\d{2})Lint$/);
    await expect(rows.nth(2)).toHaveText(/^(tmrw|Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2}Web$/);
    await rows.nth(1).locator("span").first().hover();
    await expect(app(page).getByTestId("tooltip")).toHaveText(/^(Today|Tomorrow) \d{1,2}:\d{2}$/);
    await shoot(page, "panel-next-up");
    await rows.nth(0).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", projectId: "alpha", route: "jobs/backup" }]);
  });

  test("Running now: a running run's row opens its terminal, a queued run's its card; statuses explain themselves on hover, with no (i)", async ({ page }) => {
    await panel(page, (now) => ({
      ...quiet(now),
      active: [run("backup", "Backup", "20261120-120000-aaaaaa", {}, now), run("lint", "Lint", "20261120-120000-bbbbbb", { state: "queued", startedAt: null, session: null, waits: { kind: "slot", ahead: 1 } }, now)],
    }));
    const rows = app(page).getByTestId("active-run");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveText(/^Backuprunning 3mworkspace · /);
    await expect(rows.nth(1)).toHaveText(/^Lintqueued · 1 aheadworkspace · /);
    await expect(rows.nth(0)).toHaveAttribute("data-state", "running");
    await expect(rows.nth(1)).toHaveAttribute("data-state", "queued");
    await expect(app(page).getByTestId("active-runs").locator('[data-testid^="help-"]')).toHaveCount(0);
    await rows.nth(0).locator('[data-help="st.running"]').hover();
    await expect(app(page).getByTestId("tooltip")).toHaveText("The process is alive right now. Click the row to open its terminal.Example: running · 3m.");
    await rows.nth(1).locator('[data-help="st.queued"]').hover();
    await expect(app(page).getByTestId("tooltip")).toContainText("Waiting for a free slot");
    await shoot(page, "panel-running-runs");

    await rows.nth(0).click();
    await rows.nth(1).click();
    await expect
      .poll(() => page.evaluate(() => window.fakeHost.openedTabs))
      .toEqual([
        { kind: "attached", projectId: "alpha", session: { app: "pomade-runner", session: "run:backup:20261120-120000-aaaaaa" }, title: "Backup" },
        { kind: "app", projectId: "alpha", route: "run/lint/20261120-120000-bbbbbb" },
      ]);
  });

  // T-009 — missed runs, time limits, Next up.
  test("T-009 · Next up: a job as often as it comes; a run the switch holds carries the held tag, its name faint, with the switch's help", async ({ page }) => {
    await panel(page, (now) => ({
      ...quiet(now),
      switch: { position: "pause-low", since: now }, heldRuns: 0,
      nextUp: [
        { job: "backup", name: "Backup", project: null, at: now + minutes(10), held: true },
        { job: "lint", name: "Lint", project: null, at: now + minutes(15), held: false },
        { job: "backup", name: "Backup", project: null, at: now + minutes(40), held: true },
        { job: "lint", name: "Lint", project: null, at: now + minutes(45), held: false },
      ],
    }));
    const rows = app(page).getByTestId("next-up-item");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveText(/^in 1\d minBackupheld$/);
    await expect(rows.nth(1)).toHaveText(/^in 1\d minLint$/);
    await expect(rows.nth(2)).toHaveText(/^in [34]\d minBackupheld$/);
    await expect(app(page).getByTestId("next-up-held")).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-held", "true");
    const colours = await rows.evaluateAll((all) => all.map((row) => getComputedStyle(row.querySelector("span:nth-of-type(3)") ?? row).color));
    expect(colours[0]).not.toBe(colours[1]);
    await app(page).getByTestId("next-up-held").first().hover();
    await expect(app(page).getByTestId("tooltip")).toHaveText('A held run becomes a missed run and follows its own "If a run is missed" policy when you switch back — once per job, however many it held; the note counts them meanwhile, and History shows each job\'s as a held row.Example: 4 runs held — the 13:00 commit is skipped; the morning summary catches up once, "missed 3 runs".');
    await shoot(page, "panel-next-up-held");
  });

  for (const width of [240, 300]) {
    test(`at ${width} px nothing in the panel clips or scrolls sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      await panel(page, (now) => ({
        ...withItems(now),
        active: [run("backup", "A job with a really long name that cannot fit the panel", "20261120-120000-aaaaaa", {}, now)],
        nextUp: [{ job: "backup", name: "A job with a really long name that cannot fit the panel", project: null, at: now + minutes(40), held: false }],
      }));
      await expect(app(page).getByTestId("needs-you-item")).toHaveCount(6);
      const overflow = await app(page).locator("body").evaluate(() => {
        const wide = [...document.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 || el.getBoundingClientRect().left < -0.5);
        return { wide: wide.map((el) => el.tagName + "." + el.className), scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(overflow).toEqual({ wide: [], scroll: 0 });
      await shoot(page, `panel-${width}`);
    });
  }
});

test.describe("the switch and Settings (T-009)", () => {
  const SCRIPT = "---\nkind: script\nname: Summary\nfolder: .\ncommand: ./summary.sh\nschedule:\n  daily: { at: 7:00 }\n---\n";
  const quiet: RunsReport = { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 };
  const SETTINGS_FILE = "Apps/pomade-runner/settings.yaml";

  async function openPanel(page: Page, width: number): Promise<void> {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(harness({ surface: "panel" }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await writeJob(page, "summary.md", SCRIPT);
    await page.evaluate((report) => window.setRuns({ report, history: [] }), quiet);
    await expect(app(page).getByTestId("panel-jobs")).toBeVisible();
  }

  async function openSettings(page: Page): Promise<FrameLocator> {
    await page.setViewportSize({ width: 1040, height: 900 });
    await page.goto(harness({ route: "settings" }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await expect(app(page).getByTestId("settings")).toBeVisible();
    return app(page);
  }

  const written = (page: Page): Promise<{ method: string; params: unknown }[]> => page.evaluate(() => window.runnerCalls.filter((call) => call.method === "settings.set"));

  test("the switch is pinned above the panel's scroll and reads Pause low in a narrow panel", async ({ page }) => {
    await openPanel(page, 240);
    const control = app(page).getByTestId("switch");
    const names = control.getByRole("button");
    expect(await names.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["Running", "Pause low-priority", "Pause all"]);
    await expect(names).toHaveText(["Running", "Pause low", "Pause all"], { useInnerText: true });
    await shoot(page, "panel-switch-240");

    await page.setViewportSize({ width: 300, height: 700 });
    await expect(names).toHaveText(["Running", "Pause low-priority", "Pause all"], { useInnerText: true });
    await shoot(page, "panel-switch-300");

    // Many items: the sections scroll, the switch stays where it is.
    await page.evaluate(
      (report) =>
        window.setRuns({
          report: {
            ...report,
            needsYou: Array.from({ length: 12 }, (_, index) => ({ id: `loop-paused:job-${index}`, kind: "loop-paused" as const, job: `job-${index}`, name: `Job ${index}`, project: null, at: Date.now(), detail: "triggered 10× in 10 min" })),
          },
        }),
      quiet,
    );
    await expect(app(page).getByTestId("needs-you-item")).toHaveCount(12);
    const before = await control.boundingBox();
    const scrolled = await app(page).locator("body").evaluate(() => {
      const region = [...document.querySelectorAll<HTMLElement>("main > div")].find((el) => el.scrollHeight > el.clientHeight + 1);
      if (region === undefined) return false;
      region.scrollTop = region.scrollHeight;
      return region.scrollTop > 0;
    });
    expect(scrolled).toBe(true);
    expect(await control.boundingBox()).toEqual(before);
  });

  test("each position: its dot and note, and the position it asks the scheduler for", async ({ page }) => {
    await openPanel(page, 300);
    const control = app(page).getByTestId("switch");
    const note = app(page).getByTestId("switch-note");
    await expect(note).toHaveCount(0);
    const dotIs = (name: string, token: string): Promise<boolean> =>
      control.getByRole("button", { name }).locator("i").evaluate((el, tone) => {
        const probe = document.createElement("i");
        probe.style.background = `var(${tone})`;
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return getComputedStyle(el).backgroundColor === expected;
      }, token);
    for (const [name, position, text] of [
      ["Pause low-priority", "pause-low", "Low-priority jobs are held. Services keep running."],
      ["Pause all", "pause-all", "Every scheduled job is held. Services keep running."],
    ] as const) {
      await control.getByRole("button", { name }).click();
      await expect(control).toHaveAttribute("data-position", position);
      await expect(control.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
      await expect(note).toHaveText(text);
      expect(await dotIs(name, "--warning")).toBe(true);
    }
    await shoot(page, "panel-switch-all");
    await control.getByRole("button", { name: "Running" }).click();
    await expect(control).toHaveAttribute("data-position", "running");
    await expect(note).toHaveCount(0);
    expect(await dotIs("Running", "--ok")).toBe(true);
    expect((await page.evaluate(() => window.runnerCalls)).map((call) => call.params)).toEqual([{ position: "pause-low" }, { position: "pause-all" }, { position: "running" }]);
  });

  test("a position's help and each setting's help show their text and an example", async ({ page }) => {
    await openPanel(page, 300);
    const tip = app(page).getByRole("tooltip");
    for (const [key, target] of [
      ["sw.running", "switch-running"],
      ["sw.low", "switch-pause-low"],
      ["sw.all", "switch-pause-all"],
    ] as const) {
      await app(page).getByTestId(target).hover();
      await expect(tip).toHaveText(`${HELP[key][0]}${HELP[key][1]}`);
    }
    await app(page).getByTestId("switch-pause-low").click();
    await app(page).getByTestId("help-sw.held").hover();
    await expect(tip).toHaveText(`${HELP["sw.held"][0]}${HELP["sw.held"][1]}`);

    const view = await openSettings(page);
    for (const key of ["s.heavy", "s.warm", "s.long", "s.keep", "s.native", "s.folder", "s.skill", "f.file"] as const) {
      await view.getByTestId(`help-${key}`).hover();
      await expect(tip).toHaveText(`${HELP[key][0]}${HELP[key][1]}`);
      expect(HELP[key][1]).toMatch(/^Example: /);
    }
  });

  test("Settings: the four settings as the file says them, each a stepper in its unit", async ({ page }) => {
    const view = await openSettings(page);
    const row = (name: string) => view.getByTestId(`setting-${name}`);
    await expect(row("max-low-priority-runs")).toContainText("Low-priority runs at once");
    await expect(row("max-low-priority-runs").getByTestId("setting-max-low-priority-runs-stepper-value")).toHaveText("2");
    await expect(row("max-low-priority-runs")).toContainText("runs");
    await expect(row("warm-up").getByTestId("setting-warm-up-stepper-value")).toHaveText("2");
    await expect(row("warm-up")).toContainText("min");
    await expect(row("long-run-warning").getByTestId("setting-long-run-warning-stepper-value")).toHaveText("3");
    await expect(row("long-run-warning")).toContainText("hours");
    await expect(row("history-days").getByTestId("setting-history-days-stepper-value")).toHaveText("30");
    await expect(row("history-days")).toContainText("days");
    await shoot(page, "tab-settings");

    await page.evaluate(() => window.setSettings("max-low-priority-runs: 1\nwarm-up: 0m\nlong-run-warning: 1h\nhistory-days: 1\n"));
    await expect(view.getByTestId("setting-max-low-priority-runs-unit")).toHaveText("run");
    await expect(view.getByTestId("setting-long-run-warning-unit")).toHaveText("hour");
    await expect(view.getByTestId("setting-history-days-unit")).toHaveText("day");
    // At the file's ends a step does not go on.
    for (const name of ["max-low-priority-runs", "warm-up", "long-run-warning", "history-days"]) await expect(view.getByTestId(`setting-${name}-stepper-less`)).toBeDisabled();
  });

  test("Settings: a step is written field-only — one write for a run of clicks — and the file's value takes over", async ({ page }) => {
    const view = await openSettings(page);
    const text = "# how loaded the Mac may get\nmax-low-priority-runs: 3 # three at once\nwarm-up: 2m\n";
    await page.evaluate((t) => window.setSettings(t), text);
    const more = view.getByTestId("setting-max-low-priority-runs-stepper-more");
    await expect(view.getByTestId("setting-max-low-priority-runs-stepper-value")).toHaveText("3");

    await more.dblclick();
    await expect(view.getByTestId("setting-max-low-priority-runs-stepper-value")).toHaveText("5");
    await expect.poll(() => page.evaluate(() => window.settingsText())).toBe(text.replace("3 # three", "5 # three"));
    expect(await written(page)).toEqual([{ method: "settings.set", params: { field: "max-low-priority-runs", value: 5 } }]);
    await expect(view.getByTestId("settings-error")).toHaveCount(0);

    // A field the file lacks is added; the rest stays byte for byte.
    await view.getByTestId("setting-long-run-warning-stepper-more").click();
    await expect(view.getByTestId("setting-long-run-warning-stepper-value")).toHaveText("4");
    await expect.poll(() => page.evaluate(() => window.settingsText())).toBe(`${text.replace("3 # three", "5 # three")}long-run-warning: 4h\n`);
    await view.getByTestId("setting-history-days-stepper-less").click();
    await expect.poll(() => page.evaluate(() => window.settingsText())).toContain("history-days: 29\n");
    await view.getByTestId("setting-warm-up-stepper-less").click();
    await expect.poll(() => page.evaluate(() => window.settingsText())).toContain("warm-up: 1m\n");
    expect((await written(page)).map((call) => call.params)).toEqual([
      { field: "max-low-priority-runs", value: 5 },
      { field: "long-run-warning", value: 240 },
      { field: "history-days", value: 29 },
      { field: "warm-up", value: 1 },
    ]);
    await expect(view.getByTestId("setting-warm-up-stepper-value")).toHaveText("1");
  });

  test("Settings: the keyboard steps a value; a long-run warning under an hour starts at the hour; the ends hold", async ({ page }) => {
    const view = await openSettings(page);
    await page.evaluate(() => window.setSettings("long-run-warning: 30m\nmax-low-priority-runs: 16\n"));
    await expect(view.getByTestId("setting-long-run-warning-stepper-value")).toHaveText("30");
    await expect(view.getByTestId("setting-long-run-warning-unit")).toHaveText("min");
    await expect(view.getByTestId("setting-long-run-warning-stepper-less")).toBeDisabled();
    await expect(view.getByTestId("setting-max-low-priority-runs-stepper-more")).toBeDisabled();

    await view.getByTestId("setting-long-run-warning-stepper-value").focus();
    await page.keyboard.press("ArrowUp");
    await expect(view.getByTestId("setting-long-run-warning-unit")).toHaveText("hour");
    await page.keyboard.press("ArrowUp");
    await expect(view.getByTestId("setting-long-run-warning-unit")).toHaveText("hours");
    await expect(view.getByTestId("setting-long-run-warning-stepper-value")).toHaveText("2");
    await expect.poll(() => page.evaluate(() => window.settingsText())).toContain("long-run-warning: 2h\n");
    await view.getByTestId("setting-long-run-warning-stepper-less").focus();
    await page.keyboard.press("Enter");
    await expect(view.getByTestId("setting-long-run-warning-stepper-value")).toHaveText("1");
    await expect.poll(() => page.evaluate(() => window.settingsText())).toContain("long-run-warning: 1h\n");
  });

  test("Settings: a held button repeats; the whole run is one write when it is let go", async ({ page }) => {
    const view = await openSettings(page);
    const value = view.getByTestId("setting-history-days-stepper-value");
    const more = view.getByTestId("setting-history-days-stepper-more");
    await more.hover();
    await page.mouse.down();
    await expect.poll(async () => Number(await value.textContent())).toBeGreaterThan(36);
    await page.mouse.up();
    const reached = Number(await value.textContent());
    await expect.poll(() => written(page)).toEqual([{ method: "settings.set", params: { field: "history-days", value: reached } }]);
    await expect.poll(() => page.evaluate(() => window.settingsText())).toBe(`history-days: ${reached}\n`);
    // Let go: it stays where it is.
    await expect(value).toHaveText(String(reached));
  });

  test("Settings: a step not yet written goes out when the person leaves the view", async ({ page }) => {
    const view = await openSettings(page);
    await view.getByTestId("setting-warm-up-stepper-more").click();
    await view.getByTestId("nav-jobs").click();
    await expect(view.getByTestId("settings")).toHaveCount(0);
    await expect.poll(() => written(page)).toEqual([{ method: "settings.set", params: { field: "warm-up", value: 3 } }]);
    await expect.poll(() => page.evaluate(() => window.settingsText())).toBe("warm-up: 3m\n");
  });

  test("Settings: a refused write puts the value back and says why; a settings file with a problem is listed", async ({ page }) => {
    const view = await openSettings(page);
    await page.evaluate(() => (window.refuse["settings.set"] = "cannot write Apps/pomade-runner/settings.yaml: disk is full"));
    await view.getByTestId("setting-history-days-stepper-more").click();
    await expect(view.getByTestId("setting-history-days-error")).toHaveText("cannot write Apps/pomade-runner/settings.yaml: disk is full");
    await expect(view.getByTestId("setting-history-days-stepper-value")).toHaveText("30");
    await page.evaluate(() => delete window.refuse["settings.set"]);
    await view.getByTestId("setting-history-days-stepper-more").click();
    await expect(view.getByTestId("setting-history-days-error")).toHaveCount(0);
    await expect(view.getByTestId("setting-history-days-stepper-value")).toHaveText("31");

    await page.evaluate(() => window.setSettings("max-low-priority-runs: 3\nwarm-up: soon\n"));
    await expect(view.getByTestId("setting-max-low-priority-runs-stepper-value")).toHaveText("3");
    await expect(view.getByTestId("settings-error")).toHaveText('Line 2: warm-up — "soon" is not a duration. Fix: write minutes or hours from 0m to 1h, e.g. warm-up: 2m.');
    await shoot(page, "tab-settings-problem");
  });

  test("Settings: the notification permission follows the Mac; the skill's row says where the skill is, that no agent is given it, and what kept it from being written", async ({ page }) => {
    const view = await openSettings(page);
    const notifications = view.getByTestId("notifications-status");
    const skill = view.getByTestId("skill-status");
    const row = view.getByTestId("setting-skill");
    await expect(notifications).toHaveText("Not available yet");
    await expect(skill).toHaveText("In place");
    await expect(row).toContainText("Knowledge/_skills/apps/pomade-runner-jobs/SKILL.md");
    await expect(row).toContainText("Runner gives it to no agent — which agents get it is your choice.");
    await expect(row).not.toContainText("linked into");

    for (const [state, words] of [
      ["allowed", "Allowed"],
      ["denied", "Blocked"],
      ["not-asked", "Not asked yet"],
    ] as const) {
      await page.evaluate((notification) => window.setEnvironment({ notifications: notification, skill: { folder: "Knowledge/_skills/apps/pomade-runner-jobs", problem: null } }), state);
      await expect(notifications).toHaveText(words);
    }
    // Read-only: the notifications row has no control.
    await expect(view.getByTestId("setting-notifications").locator("button:not([data-help])")).toHaveCount(0);
    await shoot(page, "tab-settings-environment");

    const problem = "cannot write Skills/pomade-runner-jobs/SKILL.md: EACCES: permission denied, mkdir 'Skills/pomade-runner-jobs'";
    await page.evaluate((reason) => window.setEnvironment({ notifications: "allowed", skill: { folder: "Skills/pomade-runner-jobs", problem: reason } }), problem);
    await expect(skill).toHaveText("Not written");
    await expect(view.getByTestId("setting-skill-error")).toHaveText(problem);
    await expect(row).toContainText("Skills/pomade-runner-jobs/SKILL.md");
    await expect(row.getByRole("button", { name: "Show in Files" })).toBeDisabled();
    await shoot(page, "tab-settings-skill-not-written");
  });

  test("Settings: Show in Files shows the skill's file in Pomade's Files panel", async ({ page }) => {
    const view = await openSettings(page);
    await page.evaluate(() => window.fakeHost.writeFile("Knowledge/_skills/apps/pomade-runner-jobs/SKILL.md", "---\nname: pomade-runner-jobs\n---\n"));
    await view.getByTestId("setting-skill").getByRole("button", { name: "Show in Files" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.reveals)).toEqual([{ projectId: "__workspace__", path: "Knowledge/_skills/apps/pomade-runner-jobs/SKILL.md" }]);
  });

  test("Settings: the skills folder is a path, written field-only on Enter or when the field is left; Escape puts it back; a refusal says why", async ({ page }) => {
    const view = await openSettings(page);
    const input = view.getByTestId("setting-skills-folder-input");
    await expect(view.getByTestId("setting-skills-folder")).toContainText("Skills folder");
    await expect(input).toHaveValue("Knowledge/_skills/apps/");

    await input.fill("Apps/pomade-runner/skills-test/");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.settingsText())).toBe("skills-folder: Apps/pomade-runner/skills-test/\n");
    await expect(input).toHaveValue("Apps/pomade-runner/skills-test/");

    await input.fill("Somewhere/else/");
    await input.press("Escape");
    await expect(input).toHaveValue("Apps/pomade-runner/skills-test/");

    await input.fill("../outside/");
    await input.blur();
    await expect(view.getByTestId("setting-skills-folder-error")).toHaveText("skills-folder: ../outside/ is not inside the workspace — write a folder relative to the workspace root, e.g. skills-folder: Knowledge/_skills/apps/");
    await expect(input).toHaveValue("Apps/pomade-runner/skills-test/");
    expect(await page.evaluate(() => window.settingsText())).toBe("skills-folder: Apps/pomade-runner/skills-test/\n");
    await shoot(page, "tab-settings-skills-folder-refused");

    // Empty is the default: the field goes from the file.
    await input.fill("");
    await input.press("Enter");
    await expect(view.getByTestId("setting-skills-folder-error")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.settingsText())).toBe("");
    await expect(input).toHaveValue("Knowledge/_skills/apps/");
  });

  test("Settings: the file locations; Open file opens settings.yaml once there is one", async ({ page }) => {
    const view = await openSettings(page);
    const file = view.getByTestId("setting-file");
    await expect(file).toContainText(SETTINGS_FILE);
    await expect(file).toContainText("No file yet: every setting is its default, and the first change writes it.");
    await expect(file.getByRole("button", { name: "Open file" })).toBeDisabled();
    await expect(view.getByTestId("setting-jobs-folder")).toContainText("Apps/pomade-runner/jobs/");

    await view.getByTestId("setting-warm-up-stepper-more").click();
    await expect(file.getByRole("button", { name: "Open file" })).toBeEnabled();
    await expect(file).not.toContainText("No file yet");
    await file.getByRole("button", { name: "Open file" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "file", projectId: "alpha", path: SETTINGS_FILE }]);
  });

  test("Settings: Show in Files shows the jobs folder in Pomade's Files panel; a folder not there yet says so", async ({ page }) => {
    const view = await openSettings(page);
    const jobs = view.getByTestId("setting-jobs-folder");
    await jobs.getByRole("button", { name: "Show in Files" }).click();
    await expect(app(page).getByTestId("toast")).toHaveText(/^RunnerCould not show Apps\/pomade-runner\/jobs in Files: /);
    expect(await page.evaluate(() => window.fakeHost.reveals)).toEqual([]);
    await writeJob(page, "backup.md", "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\n---\n");
    await jobs.getByRole("button", { name: "Show in Files" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.reveals)).toEqual([{ projectId: "__workspace__", path: "Apps/pomade-runner/jobs" }]);
    await shoot(page, "tab-settings-files");
  });
});

test.describe("the Git form (T-011)", () => {
  test.use({ viewport: { width: 1040, height: 760 } });
  /** The prototype's clock: Tue 17 Nov 2026, 12:48. */
  const NOW = new Date(2026, 10, 17, 12, 48);
  const JOBS = "Apps/pomade-runner/jobs";

  async function start(page: Page, route: string): Promise<void> {
    await page.clock.setFixedTime(NOW);
    await page.goto(harness({ route, projects: "prototype", repos: "blog,shop" }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function" && typeof window.mounted === "object");
  }

  function fileText(page: Page, path: string): Promise<string | null> {
    return page.evaluate((p) => {
      try {
        return window.fakeHost.readFile(p);
      } catch {
        return null;
      }
    }, path);
  }

  test("a new git job: the operation, the workspace's repos, a project and no folder; Skip, normal priority and On failure; the file a hand-written one is", async ({ page }) => {
    await start(page, "new");
    await app(page).getByTestId("kind-git").click();
    const form = app(page).getByTestId("form-git");
    await expect(form.getByRole("region")).toHaveText([/^Kind/, /^Trigger/, /^Git/, /^Policies/]);
    const git = form.getByRole("region", { name: "Git" });
    // The operation, Commit & push first; the repos as the Git panel names them; a project, no folder.
    await expect(git.getByRole("group", { name: "Operation" }).getByRole("button")).toHaveText(["Commit & push", "Pull", "Push", "Fetch"]);
    await expect(git.getByRole("button", { name: "Commit & push" })).toHaveAttribute("aria-pressed", "true");
    const repos = git.getByRole("group", { name: "Repositories" }).getByTestId("repo-name");
    await expect(repos).toHaveText(["blog", "notes", "shop"]);
    await expect(git.getByRole("combobox", { name: "Project" })).toHaveValue("");
    await expect(git.getByRole("searchbox", { name: "Filter repositories" })).toHaveCount(0);
    await expect(form.getByRole("textbox", { name: "Folder", exact: true })).toHaveCount(0);
    await expect(form.getByRole("textbox", { name: "Command", exact: true })).toHaveCount(0);
    await expect(form.getByTestId("form-policies")).toContainText("defaults for Git");
    await expect(form.getByTestId("policy-summary")).toHaveText("If missed, skip · never overlaps itself · normal priority · no time limit · notifies on failure");
    await form.getByTestId("form-policies").getByRole("button", { name: "Change" }).click();
    await expect(form.getByTestId("form-policies")).toContainText("Runs at normal priority · default for Git");

    // Save with no repo: the checker's words on the repos.
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("Pull");
    await app(page).getByTestId("form-save").click();
    await expect(git.getByRole("alert")).toHaveText("git.repos — names no repos. Fix: list the repos by the name Pomade's Git panel shows: repos: [notes, blog].");
    await expect(app(page).getByTestId("form-error-count")).toHaveText("1 thing to fix before saving");
    await shoot(page, "tab-form-git-errors");

    // Picked; the project puts the file in its sub-folder.
    await git.getByRole("button", { name: "Pull" }).click();
    await git.getByRole("checkbox", { name: "notes", exact: true }).click();
    await git.getByRole("checkbox", { name: "blog", exact: true }).click();
    await expect(git.getByRole("checkbox", { name: "blog", exact: true })).toBeChecked();
    await expect(git.getByRole("alert")).toHaveCount(0);
    await git.getByRole("combobox", { name: "Project" }).selectOption("blog");
    await expect(app(page).getByTestId("form-path")).toHaveText(`${JOBS}/blog/pull.md`);
    await shoot(page, "tab-form-git-new");
    await expect(app(page).getByTestId("form-save")).toHaveText("Create job");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("toast")).toHaveText(`RunnerCreated ${JOBS}/blog/pull.md`);
    expect(await fileText(page, `${JOBS}/blog/pull.md`)).toBe(
      "---\nkind: git\nname: Pull\nproject: blog\nenabled: true\ngit: { operation: pull, repos: [blog, notes] }\nschedule:\n  daily: { at: 9:00 }\n---\n",
    );
    const row = app(page).locator('[data-testid="job-row"][data-job="blog/pull"]');
    await expect(row.getByTestId("job-trigger")).toHaveAttribute("data-tip", "Daily at 9:00 · Pull · blog, notes");
  });

  test("every field of the Git form has a working (i): the kind, the operation, the repos, the project and each policy with its kind's default", async ({ page }) => {
    await start(page, "new");
    await app(page).getByTestId("kind-git").click();
    await expect(app(page).getByTestId("form-git")).toBeVisible();
    const form = app(page).getByTestId("job-form");
    await form.getByTestId("form-policies").getByRole("button", { name: "Change" }).click();
    const tip = app(page).getByRole("tooltip");
    const keys = ["f.enabled", "f.name", "f.trigger", "f.gitop", "f.repos", "f.project", "p.missed", "p.overlap", "p.low", "p.limit", "p.notify", "f.file"] as const;
    for (const key of keys) {
      await form.getByTestId(`help-${key}`).hover();
      await expect(tip).toHaveText(HELP[key].join(""));
    }
    // Skip is the Git kind's default, with its own help.
    const skip = form.getByRole("group", { name: "If a run is missed" }).getByRole("button", { name: /^Skip/ });
    await expect(skip).toHaveAttribute("aria-pressed", "true");
    await expect(skip).toContainText("default");
    await skip.hover();
    await expect(tip).toHaveText(HELP["p.skip"].join(""));
    await form.getByTestId("kind-git").hover();
    await expect(tip).toHaveText(HELP["kind.git"].join(""));
  });

  test("editing a git job: its operation and repos as the file says — one the workspace lacks stays, checked and said — and Save writes only what changed", async ({ page }) => {
    const HAND = "---\nkind: git # twice a day\nname: Commit notes\nproject: notes\ngit: { operation: commit-push, repos: [notes, Journal] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\nThe notes.\n";
    await start(page, "edit/notes.commit-notes");
    await writeJob(page, "notes/commit-notes.md", HAND);
    const form = app(page).getByTestId("form-git");
    const git = form.getByRole("region", { name: "Git" });
    await expect(git.getByRole("button", { name: "Commit & push" })).toHaveAttribute("aria-pressed", "true");
    const repos = git.getByRole("group", { name: "Repositories" }).getByTestId("repo-name");
    await expect(repos).toHaveText(["blog", "notes", "shop", "Journal"]);
    await expect(git.locator('[data-testid="repo-row"]:has(input:checked) [data-testid="repo-name"]')).toHaveText(["notes", "Journal"]);
    await expect(git.getByTestId("repos-missing")).toHaveText("Journal is not in this workspace — clear it, or bring the repo back.");
    await expect(git.getByRole("combobox", { name: "Project" })).toHaveValue("notes");
    await expect(app(page).getByTestId("form-save")).toHaveText("Saved");
    await shoot(page, "tab-form-git-edit");

    await git.getByRole("checkbox", { name: "Journal", exact: true }).click();
    await expect(git.getByTestId("repos-missing")).toHaveCount(0);
    await expect(repos).toHaveText(["blog", "notes", "shop"]);
    await git.getByRole("button", { name: "Fetch" }).click();
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page, `${JOBS}/notes/commit-notes.md`)).toBe(HAND.replace("{ operation: commit-push, repos: [notes, Journal] }", "{ operation: fetch, repos: [notes] }"));
  });
});

test.describe("the repository picker (T-049)", () => {
  test.use({ viewport: { width: 1040, height: 760 } });
  const JOBS = "Apps/pomade-runner/jobs";
  /** A workspace of 30 repos, as Pomade's Git panel lists them (by path); notes is the harness's own. */
  const WORKSPACE = [
    "my-workspace=",
    "Knowledge",
    "archive-2019=Archive/archive-2019",
    "old-blog=Archive/old-blog",
    ...["AI Lab", "blog", "Coda-helper", "delta", "fantasy-league-helper", "landing", "Media-Library", "Pomade", "pomade-agents", "pomade-kit", "pomade-planner", "pomade-runner", "photo-tools", "recipes", "shop", "VoxApp"].map((name) => `${name}=Projects/${name}`),
    ...["ai-book-club", "club-ops-hq", "cv"].map((name) => `${name}=Projects/Book-Club/${name}`),
    ...["papers-reader", "Proto-research", "a-repo-with-a-rather-long-name-to-show-how-it-is-cut"].map((name) => `${name}=Projects/Research/a-deep-folder/that-goes/on-and-on/${name}`),
    "mcp_whiteboard=Services/mcp_whiteboard",
    "mcp-gateway=Services/mcp-gateway",
    "search=Services/search",
  ].join(",");
  const ORDER = {
    top: ["Knowledge", "my-workspace", "notes"],
    archive: ["archive-2019", "old-blog"],
    projects: ["a-repo-with-a-rather-long-name-to-show-how-it-is-cut", "AI Lab", "ai-book-club", "blog", "club-ops-hq", "Coda-helper", "cv", "delta", "fantasy-league-helper", "landing", "Media-Library", "papers-reader", "photo-tools", "Pomade", "pomade-agents", "pomade-kit", "pomade-planner", "pomade-runner", "Proto-research", "recipes", "shop", "VoxApp"],
    services: ["mcp_whiteboard", "mcp-gateway", "search"],
  };
  const gitJob = (repos: string): string => `---\nkind: git\nname: Commit notes\nproject: notes\ngit: { operation: commit-push, repos: [${repos}] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n`;

  async function open(page: Page, repos: string): Promise<Locator> {
    await page.clock.setFixedTime(new Date(2026, 10, 17, 12, 48));
    await page.goto(harness({ route: "edit/notes.commit-notes", projects: "prototype", repos: WORKSPACE }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function" && typeof window.mounted === "object");
    await page.evaluate(([p, t]) => window.fakeHost.writeFile(p, t), [`${JOBS}/notes/commit-notes.md`, gitJob(repos)] as const);
    const picker = app(page).getByRole("group", { name: "Repositories" });
    await expect(picker.getByTestId("repos-count")).toContainText("of 30 selected");
    return picker;
  }

  const fileText = (page: Page): Promise<string> => page.evaluate((p) => window.fakeHost.readFile(p), `${JOBS}/notes/commit-notes.md`);
  const gitSection = (page: Page): Locator => app(page).getByRole("region", { name: "Git" });
  const picked = (picker: Locator): Locator => picker.locator('[data-testid="repo-row"]:has(input:checked) [data-testid="repo-name"]');

  test("30 repos: grouped by top folder, Top level first, each group by name with its path; a box of fixed height where every repo is reachable", async ({ page }) => {
    const picker = await open(page, "notes");
    await expect(picker.getByTestId("repo-group-title")).toHaveText(["Top level", "Archive", "Projects", "Services"]);
    await expect(picker.getByTestId("repo-group-count")).toHaveText(["1 of 3", "0 of 2", "0 of 22", "0 of 3"]);
    await expect(picker.getByTestId("repo-name")).toHaveText([...ORDER.top, ...ORDER.archive, ...ORDER.projects, ...ORDER.services]);
    const row = (name: string): Locator => picker.locator(`[data-testid="repo-row"][data-repo="${name}"]`);
    await expect(row("my-workspace").getByTestId("repo-path")).toHaveText("workspace root");
    await expect(row("cv").getByTestId("repo-path")).toHaveText("Projects/Book-Club/cv");
    await expect(picker.getByTestId("repos-count")).toHaveText("1 of 30 selected");
    await expect(picker.getByRole("checkbox", { name: "Top level" })).toBeChecked({ indeterminate: true });
    await expect(picker.getByRole("checkbox", { name: "Archive", exact: true })).not.toBeChecked();
    // The path says where the repo is.
    await expect(picker.getByRole("checkbox", { name: "cv", exact: true })).toHaveAccessibleDescription("Projects/Book-Club/cv");

    // A fixed height, whatever the list holds; the last repo scrolls into view and takes a click.
    const list = picker.getByTestId("repo-list");
    expect((await list.boundingBox())?.height).toBe(292);
    await expect(row("search")).not.toBeInViewport();
    await shoot(page, "tab-form-repos-30");
    await row("search").scrollIntoViewIfNeeded();
    await row("search").click();
    await expect(picker.getByRole("checkbox", { name: "search", exact: true })).toBeChecked();
    await expect(gitSection(page).getByTestId("repos-order")).toHaveText("Runs one repo at a time, top to bottom in this list.");
    await expect(app(page).getByTestId("form-path")).toBeVisible();
    // A long name and a long path are cut, the whole of them in the tooltip.
    await row("a-repo-with-a-rather-long-name-to-show-how-it-is-cut").scrollIntoViewIfNeeded();
    await shoot(page, "tab-form-repos-long");
    const cut = await row("a-repo-with-a-rather-long-name-to-show-how-it-is-cut").getByTestId("repo-path").evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(cut).toBe(true);
  });

  test("Select all, then Clear: all, then none; Save refuses none, the box's border red; picks are written in the list's order, not the order they were ticked", async ({ page }) => {
    const picker = await open(page, "notes");
    const selectAll = picker.getByRole("button", { name: "Select all" });
    const clear = picker.getByRole("button", { name: "Clear", exact: true });
    await selectAll.click();
    await expect(picker.getByTestId("repos-count")).toHaveText("30 of 30 selected");
    await expect(picker.getByRole("checkbox", { checked: false })).toHaveCount(0);
    await expect(selectAll).toBeDisabled();
    await clear.click();
    await expect(picker.getByTestId("repos-count")).toHaveText("0 of 30 selected");
    await expect(picker.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(clear).toBeDisabled();

    await app(page).getByTestId("form-save").click();
    await expect(gitSection(page).getByRole("alert")).toHaveText("git.repos — names no repos. Fix: list the repos by the name Pomade's Git panel shows: repos: [notes, blog].");
    await expect(app(page).getByTestId("form-error-count")).toHaveText("1 thing to fix before saving");
    const box = picker.getByTestId("repo-list").locator("..");
    const danger = await box.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--danger").trim());
    const rgb = await box.evaluate((el, color) => {
      const probe = document.createElement("i");
      probe.style.color = color;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).borderTopColor, value];
    }, danger);
    expect(rgb[0]).toBe(rgb[1]);
    await shoot(page, "tab-form-repos-none-saved");

    // Ticked: pomade-kit, then notes, then all of Services, then Knowledge — written as the list runs them.
    await picker.getByRole("checkbox", { name: "pomade-kit", exact: true }).click();
    await picker.getByRole("checkbox", { name: "notes", exact: true }).click();
    await picker.getByRole("checkbox", { name: "Services" }).click();
    await picker.getByRole("checkbox", { name: "Knowledge", exact: true }).click();
    await expect(gitSection(page).getByRole("alert")).toHaveCount(0);
    await expect(picked(picker)).toHaveText(["Knowledge", "notes", "pomade-kit", ...ORDER.services]);
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page)).toBe(gitJob("Knowledge, notes, pomade-kit, mcp_whiteboard, mcp-gateway, search"));
  });

  test("the filter: by name or path; Select N shown and Clear shown act on what it shows; a head's checkbox takes its group, mixed while some are picked; Esc clears it", async ({ page }) => {
    const picker = await open(page, "notes");
    const filter = picker.getByRole("searchbox", { name: "Filter repositories" });
    await expect(filter).toHaveAttribute("placeholder", "Filter by name or path");
    await filter.fill("pomade");
    await expect(picker.getByTestId("repo-name")).toHaveText(["Pomade", "pomade-agents", "pomade-kit", "pomade-planner", "pomade-runner"]);
    await expect(picker.getByTestId("repo-group-title")).toHaveText(["Projects"]);
    await expect(picker.getByTestId("repo-group-count")).toHaveText(["0 of 5"]);
    expect((await picker.getByTestId("repo-list").boundingBox())?.height).toBe(292);
    await expect(picker.getByRole("button", { name: "Clear shown" })).toBeDisabled();
    await shoot(page, "tab-form-repos-filter");
    await picker.getByRole("button", { name: "Select 5 shown" }).click();
    await expect(picker.getByTestId("repos-count")).toHaveText("6 of 30 selected");
    await expect(picker.getByRole("checkbox", { name: "Projects" })).toBeChecked();
    await expect(picker.getByRole("button", { name: "Select 5 shown" })).toBeDisabled();

    // By path: the Book-Club folder.
    await filter.fill("book-club");
    await expect(picker.getByTestId("repo-name")).toHaveText(["ai-book-club", "club-ops-hq", "cv"]);
    await filter.fill("nothing-like-it");
    await expect(picker.getByTestId("repo-row")).toHaveCount(0);
    await expect(picker.getByText("No repo matches “nothing-like-it”.")).toBeVisible();

    // Esc clears the filter; every repo is back, Projects mixed; its head takes all, then none.
    await filter.press("Escape");
    await expect(filter).toHaveValue("");
    await expect(app(page).getByTestId("job-form")).toBeVisible();
    await expect(picker.getByTestId("repo-row")).toHaveCount(30);
    const projects = picker.getByRole("checkbox", { name: "Projects" });
    await expect(projects).toBeChecked({ indeterminate: true });
    await projects.click();
    await expect(projects).toBeChecked();
    await expect(picker.getByTestId("repo-group-count")).toHaveText(["1 of 3", "0 of 2", "22 of 22", "0 of 3"]);
    await projects.click();
    await expect(projects).not.toBeChecked();
    await expect(picker.getByTestId("repos-count")).toHaveText("1 of 30 selected");

    // The clear button; Clear shown leaves the others.
    await filter.fill("mcp");
    await picker.getByRole("button", { name: "Select 2 shown" }).click();
    await picker.getByRole("button", { name: "Clear the filter" }).click();
    await expect(filter).toHaveValue("");
    await expect(picked(picker)).toHaveText(["notes", "mcp_whiteboard", "mcp-gateway"]);
    await filter.fill("mcp_");
    await picker.getByRole("button", { name: "Clear shown" }).click();
    await filter.fill("");
    await expect(picked(picker)).toHaveText(["notes", "mcp-gateway"]);

    // The keyboard: a repo's checkbox takes focus and Space ticks it.
    await picker.getByRole("checkbox", { name: "Knowledge", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(picked(picker)).toHaveText(["Knowledge", "notes", "mcp-gateway"]);
  });

  test("a file in another order says so, and one click puts it in the list's; a repo the workspace lacks keeps its red line, in a group of its own, and Clear takes it too", async ({ page }) => {
    const picker = await open(page, "pomade-kit, notes, old-site, Knowledge");
    await expect(gitSection(page).getByTestId("repos-order")).toHaveText("Runs one repo at a time, in the job file’s order: pomade-kit, notes, old-site, Knowledge.Use this list’s order");
    await expect(gitSection(page).getByTestId("repos-missing")).toHaveText("old-site is not in this workspace — clear it, or bring the repo back.");
    await expect(picker.getByTestId("repo-group-title")).toHaveText(["Top level", "Archive", "Projects", "Services", "Not in this workspace"]);
    await expect(picker.getByTestId("repos-count")).toHaveText("3 of 30 selected");
    await picker.locator('[data-repo="old-site"]').scrollIntoViewIfNeeded();
    await expect(picker.locator('[data-repo="old-site"]').getByTestId("repo-path")).toHaveText("named in the job file");
    await shoot(page, "tab-form-repos-missing");
    await gitSection(page).getByRole("button", { name: "Use this list’s order" }).click();
    await expect(gitSection(page).getByTestId("repos-order")).toHaveText("Runs one repo at a time, top to bottom in this list.");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("tab-jobs")).toBeVisible();
    expect(await fileText(page)).toBe(gitJob("Knowledge, notes, pomade-kit, old-site"));

    const again = await open(page, "notes, old-site");
    await expect(again.getByTestId("repo-row")).toHaveCount(31);
    await again.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(gitSection(page).getByTestId("repos-missing")).toHaveCount(0);
    await expect(again.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(again.getByTestId("repo-group-title")).toHaveText(["Top level", "Archive", "Projects", "Services"]);
  });
});

test.describe("agent jobs", () => {
  test.use({ viewport: { width: 1040, height: 760 } });
  const SESSION = "5f0c2a1e-7b3d-4c8e-9a61-0d2f4b6e8c90";
  const RUN = "20261118-070000-abcdef";
  const at = (hours: number, minutes: number): number => new Date(2026, 10, 18, hours, minutes).getTime();
  const done: RunRecord = {
    job: "morning-summary",
    name: "Morning summary",
    kind: "agent",
    project: null,
    folder: "",
    run: RUN,
    trigger: "scheduled",
    cause: null,
    dueAt: at(7, 0),
    agent: { agent: "claude", name: "claude", provider: "claude", mode: "normal", modeName: "Normal", sessionId: SESSION, cwd: "/fake/workspace", startedAt: new Date(at(7, 0)).toISOString(), exit: "/exit", exitSentAt: at(7, 4), worked: true, waiting: null, waitedMs: 0, background: null, answered: [], workedOn: false },
    missed: null,
    series: null,
    state: "done",
    event: null,
    reason: null,
    startedAt: at(7, 0),
    endedAt: at(7, 4) + 12_000,
    durationMs: 4 * 60_000 + 12_000,
    exitCode: 0,
    signal: null,
    log: "/ud/output/morning-summary/r.log",
    lastLines: ["● Done.", "> /exit", "Bye."],
    git: null,
    limitHit: null,
  };
  const SUMMARY = "---\nkind: agent\nname: Morning summary\nfolder: .\nagent: claude\nschedule:\n  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }\n---\nWrite my morning summary.\n";

  async function start(page: Page, query: Record<string, string> = {}): Promise<void> {
    await page.goto(harness({ projects: "prototype", ...query }));
    // The stand-in scheduler watches the jobs folder by the time it can set a service's state.
    await page.waitForFunction(() => typeof window.setRuns === "function" && typeof window.setServiceStatus === "function");
  }

  async function setHistory(page: Page, history: RunRecord[], messages: Record<string, string | null> = {}): Promise<void> {
    await page.evaluate(
      ([h, m]) => {
        Object.assign(window.agentMessages, m);
        window.setRuns({ report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 }, history: h });
      },
      [history, messages] as const,
    );
  }

  test("the form makes an agent job: the roster's agents, the projects connected to the agent grouped in the folder picker, its modes, the Full-autonomy warning, the prompt as the body", async ({ page }) => {
    await start(page, { route: "new" });
    await app(page).getByTestId("kind-agent").click();
    const form = app(page).getByTestId("form-agent");
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("Morning summary");
    const agents = form.getByRole("group", { name: "Agent" });
    await expect(agents.getByRole("button")).toHaveText(["claude", "claude-editor", "claude-coder", "claude-pm", "codex"]);
    await expect(agents.getByRole("button", { name: "claude", exact: true })).toHaveAttribute("aria-pressed", "true");
    // Choose… groups the projects: the workspace, the ones connected to the agent, the others; a
    // pick fills the folder and the project. Nothing under the Folder box.
    const folderMenu = app(page).getByTestId("folder-menu");
    const groups = folderMenu.locator('[role="presentation"], [role="menuitem"]');
    await form.getByRole("button", { name: "Choose…" }).click();
    await expect(groups).toHaveText(["Workspace", "workspaceworkspace root", "Connected projects", "PomadeProjects/Pomade", "blogProjects/blog", "shopProjects/shop", "Other projects", "notesnotes", "pomade-kitProjects/pomade-kit", "pomade-runnerProjects/pomade-runner", "AlphaProjects/alpha", "Other folder…Pomade's folder picker"]);
    await shoot(page, "agent-form-folder-menu");
    await folderMenu.getByRole("menuitem", { name: /^blog/ }).click();
    await expect(form.getByRole("textbox", { name: "Folder", exact: true })).toHaveValue("Projects/blog");
    await expect(form.getByRole("combobox", { name: "Project" })).toHaveValue("blog");
    await expect(form.getByRole("button", { name: "shop" })).toHaveCount(0);
    // Only the agent's modes; one it lacks is faded with why; another agent's own modes after them.
    const modes = form.getByRole("group", { name: "Mode" });
    await expect(modes.getByRole("button")).toHaveText(["Normaldefault", "Full autonomy"]);
    await modes.getByRole("button", { name: "Full autonomy" }).click();
    await expect(form.getByTestId("full-autonomy-warning")).toHaveText("Skips every approval. The agent edits files and runs commands without asking. The job shows a “Full autonomy” mark in the list.");
    await shoot(page, "agent-form-full-autonomy");
    await agents.getByRole("button", { name: "claude-pm" }).click();
    await expect(modes.getByRole("button", { name: "Normal" })).toHaveAttribute("aria-pressed", "true");
    await expect(modes.getByRole("button", { name: "Full autonomy" })).toBeDisabled();
    await expect(modes.getByRole("button", { name: "Full autonomy" })).toHaveAttribute("data-tip", "claude-pm has no full autonomy mode");
    await expect(form.getByTestId("full-autonomy-warning")).toHaveCount(0);
    await agents.getByRole("button", { name: "codex" }).click();
    await expect(modes.getByRole("button")).toHaveText(["Normaldefault", "Full autonomy", "Read-only"]);
    await form.getByRole("button", { name: "Choose…" }).click();
    await expect(groups).toHaveText(["Workspace", "workspaceworkspace root", "Connected projects", "pomade-kitProjects/pomade-kit", "Other projects", "notesnotes", "PomadeProjects/Pomade", "pomade-runnerProjects/pomade-runner", "AlphaProjects/alpha", "blogProjects/blog", "shopProjects/shop", "Other folder…Pomade's folder picker"]);
    await page.keyboard.press("Escape");
    await agents.getByRole("button", { name: "claude", exact: true }).click();
    // Save with no prompt: the checker's words on the prompt.
    await app(page).getByTestId("form-save").click();
    await expect(form.getByTestId("form-error-count").or(app(page).getByTestId("form-error-count"))).toHaveText("1 thing to fix before saving");
    await expect(form.locator('[data-field="prompt"]')).toBeFocused();
    await expect(form).toContainText("body — an agent job's prompt is its body, and the body is empty. Fix: write what the agent should do below the closing --- line.");
    await form.getByRole("textbox", { name: "Prompt" }).fill("Write my morning summary.\n\n1. Read today's items with `pomade-planner today`.");
    await expect(form.getByTestId("policy-summary")).toHaveText("If missed, run on wake · never overlaps itself · low priority · no time limit · always notifies");
    await shoot(page, "agent-form");
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("toast")).toHaveText("RunnerCreated Apps/pomade-runner/jobs/blog/morning-summary.md");
    expect(await page.evaluate(() => window.fakeHost.readFile("Apps/pomade-runner/jobs/blog/morning-summary.md"))).toBe(
      "---\nkind: agent\nname: Morning summary\nproject: blog\nfolder: Projects/blog\nenabled: true\nagent: claude\nschedule:\n  daily: { at: 9:00 }\n---\nWrite my morning summary.\n\n1. Read today's items with `pomade-planner today`.\n",
    );
  });

  test("editing an agent job writes the prompt as the body and the mode field-only — a field the file lacked at the end of its block", async ({ page }) => {
    await start(page);
    await writeJob(page, "morning-summary.md", SUMMARY.replace("agent: claude\n", "agent: claude # the 7:00 one\n"));
    await expect(app(page).getByTestId("job-row")).toHaveCount(1);
    await page.evaluate(() => window.mounted.navigate("edit/morning-summary"));
    const form = app(page).getByTestId("form-agent");
    await expect(form.getByRole("textbox", { name: "Prompt" })).toHaveValue("Write my morning summary.");
    await expect(app(page).getByTestId("form-save")).toHaveText("Saved");
    await form.getByRole("textbox", { name: "Prompt" }).fill("Write my morning summary, in 12 lines.");
    await form.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Full autonomy" }).click();
    await app(page).getByTestId("form-save").click();
    await expect(app(page).getByTestId("toast")).toHaveText("RunnerSaved Apps/pomade-runner/jobs/morning-summary.md");
    expect(await page.evaluate(() => window.fakeHost.readFile("Apps/pomade-runner/jobs/morning-summary.md"))).toBe(
      SUMMARY.replace("agent: claude\n", "agent: claude # the 7:00 one\n").replace("Write my morning summary.", "Write my morning summary, in 12 lines.").replace("7:00 }\n---", "7:00 }\nmode: full-autonomy\n---"),
    );
  });

  test("without the Agents app the form says so in place of the agent and mode pickers, and keeps the file's", async ({ page }) => {
    await start(page, { agents: "none" });
    await writeJob(page, "morning-summary.md", SUMMARY);
    await expect(app(page).getByTestId("job-row")).toHaveCount(1);
    await page.evaluate(() => window.mounted.navigate("edit/morning-summary"));
    const form = app(page).getByTestId("form-agent");
    await expect(form.getByTestId("agents-absent")).toHaveText("The Agents app (pomade-agents) is not running. Runner lists the agents and their modes from it, so the job keeps claude in mode Normal until it answers; a run due meanwhile fails.");
    await expect(form.getByRole("group", { name: "Agent" })).toHaveCount(0);
    await expect(form.getByRole("group", { name: "Mode" })).toHaveCount(0);
    await expect(form.getByRole("textbox", { name: "Prompt" })).toHaveValue("Write my morning summary.");
    await shoot(page, "agent-form-absent");
    // Choose… has no Connected projects group: Runner cannot ask which projects are the agent's.
    await form.getByRole("button", { name: "Choose…" }).click();
    await expect(app(page).getByTestId("folder-menu").locator('[role="presentation"]')).toHaveText(["Workspace", "Projects"]);
  });

  test("an agent the roster lacks has no Connected projects group in the folder picker", async ({ page }) => {
    await start(page);
    await writeJob(page, "morning-summary.md", SUMMARY.replace("agent: claude\n", "agent: ghost\n"));
    await expect(app(page).getByTestId("job-row")).toHaveCount(1);
    await page.evaluate(() => window.mounted.navigate("edit/morning-summary"));
    const form = app(page).getByTestId("form-agent");
    await expect(form).toContainText("ghost is not in the Agents app's roster.");
    await form.getByRole("button", { name: "Choose…" }).click();
    const menu = app(page).getByTestId("folder-menu");
    await expect(menu.locator('[role="presentation"]')).toHaveText(["Workspace", "Projects"]);
    await expect(menu.getByRole("menuitem")).toHaveCount(9);
    await shoot(page, "agent-form-folder-menu-no-agent");
  });

  test("an agent job's row: the Full-autonomy mark with its help, Run now", async ({ page }) => {
    await start(page);
    await writeJob(page, "weekly-review.md", SUMMARY.replace("name: Morning summary", "name: Weekly review").replace("agent: claude\n", "agent: claude\nmode: full-autonomy\n"));
    await writeJob(page, "morning-summary.md", SUMMARY);
    const rows = app(page).getByTestId("job-row");
    await expect(rows).toHaveCount(2);
    const weekly = app(page).locator('[data-testid="job-row"][data-job="weekly-review"]');
    await expect(weekly.getByTestId("job-full-autonomy")).toHaveText("Full autonomy");
    await expect(weekly.getByTestId("job-full-autonomy")).toHaveAttribute("data-help", "jobs.fullauto");
    await expect(app(page).locator('[data-testid="job-row"][data-job="morning-summary"]').getByTestId("job-full-autonomy")).toHaveCount(0);
    await weekly.getByRole("button", { name: "Run now" }).click();
    await expect.poll(() => page.evaluate(() => window.runnerCalls)).toContainEqual({ method: "jobs.run", params: { job: "weekly-review" } });
    await shoot(page, "agent-rows");
  });

  test("a done agent run's card: agent · mode, the last message; Open session resumes the session in a Pomade agent tab", async ({ page }) => {
    await start(page, { route: `run/morning-summary/${RUN}` });
    await setHistory(page, [done], { [SESSION]: "**Tuesday 17 Nov.** Four items today.\n\nOvernight: notes was committed and pushed at 20:00 (`a1b2c3d`)." });
    const dialog = app(page).getByTestId("run-dialog");
    await expect(app(page).getByTestId("run-result")).toHaveText("Done");
    await expect(dialog.getByTestId("run-agent")).toHaveText("claude · Normal");
    const message = dialog.getByTestId("run-agent-message");
    await expect(message.locator("p")).toHaveText(["Tuesday 17 Nov. Four items today.", "Overnight: notes was committed and pushed at 20:00 (a1b2c3d)."]);
    await expect(message.locator("b")).toHaveText("Tuesday 17 Nov.");
    await expect(dialog.getByTestId("dialog-foot").getByRole("button")).toHaveText(["Open session", "View output", "Run again", "Edit job"]);
    await shoot(page, "agent-card-done");
    await dialog.getByRole("button", { name: "Open session" }).click();
    await expect.poll(() => page.evaluate(() => window.fakeHost.openedAgentTabs)).toEqual([{ kind: "agent", tabId: expect.any(String) as unknown as string, projectId: "__workspace__", agentId: "claude", cwd: "", mode: "normal", sessionId: SESSION }]);
  });

  test("a run waiting for you: the amber card with the prompt it waits at, Open at the prompt opens its terminal tab; its notice's route opens that tab and then the card", async ({ page }) => {
    const session = `run:morning-summary:${RUN}`;
    const waiting: ActiveRun = {
      ...done,
      state: "running",
      lowPriority: true,
      runAt: null,
      deadline: null,
      waits: null,
      startedAt: Date.now() - 17 * 60_000,
      session,
      log: "/ud/output/morning-summary/r.log",
      limitHit: null,
      warnedAt: null,
      warningDismissed: false,
      agent: { ...done.agent!, exitSentAt: null, waiting: { prompt: "permission", since: Date.now() - 60_000 }, waitedMs: 0 },
    };
    const output = ["● Read 14 files", "● Moving 14 notes", "", "  Bash command", "  git mv a b", "", "  Do you want to proceed?", "  ❯ 1. Yes", "  3. No", "", "  Esc to cancel", ""].join("\r\n");
    await start(page, { route: "history" });
    await page.evaluate(([a, o]) => window.setRuns({ report: { active: [a], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 }, history: [], output: o }), [waiting, output] as const);
    const row = app(page).locator('[data-testid="history-row"][data-job="morning-summary"]');
    await expect(row.getByTestId("history-result")).toHaveText("waiting for you");
    await row.click();
    const dialog = app(page).getByTestId("run-dialog");
    await expect(dialog).toHaveAttribute("data-tone", "warning");
    await expect(app(page).getByTestId("run-result")).toHaveText("Waiting for you");
    await expect(dialog.getByTestId("run-waits")).toHaveText("The agent stopped at a permission prompt and waits for your answer.");
    await expect(dialog.getByTestId("run-prompt")).toHaveText("● Moving 14 notes\n \n  Bash command\n  git mv a b\n \n  Do you want to proceed?\n  ❯ 1. Yes\n  3. No\n \n  Esc to cancel");
    await expect(dialog).toContainText("The time limit is paused while it waits.");
    await expect(dialog.getByTestId("dialog-foot").getByRole("button")).toHaveText(["Open at the prompt", "Stop run", "Edit job"]);
    await shoot(page, "agent-card-waiting");
    await dialog.getByRole("button", { name: "Open at the prompt" }).click();
    const attached = (): Promise<unknown[]> => page.evaluate(() => window.fakeHost.openedTabs.map((tab) => ("session" in tab ? tab.session : null)));
    await expect.poll(attached).toEqual([{ app: "pomade-runner", session }]);
    await page.evaluate((route) => window.mounted.navigate(route), `prompt/morning-summary/${RUN}`);
    await expect.poll(attached).toEqual([
      { app: "pomade-runner", session },
      { app: "pomade-runner", session },
    ]);
    await expect(app(page).getByTestId("tab-run")).toBeVisible();
    await expect(app(page).getByTestId("run-result")).toHaveText("Waiting for you");
  });

  test("a failed agent run's card is red with the reason; a session the Agents app has no answer of yet says so", async ({ page }) => {
    const failed: RunRecord = { ...done, state: "failed", reason: "the agent exited before its turn was done", agent: { ...done.agent!, exitSentAt: null }, durationMs: 9000, endedAt: at(7, 0) + 9000 };
    await start(page, { route: `run/morning-summary/${RUN}` });
    await setHistory(page, [failed], { [SESSION]: null });
    const dialog = app(page).getByTestId("run-dialog");
    await expect(dialog).toHaveAttribute("data-tone", "danger");
    await expect(app(page).getByTestId("run-result")).toHaveText("Failed");
    await expect(dialog.getByTestId("run-why")).toHaveText("The agent exited before its turn was done");
    await expect(dialog.getByTestId("run-agent-note")).toHaveText("The agent left no message in this session.");
    await expect(dialog.getByRole("button", { name: "Run again" })).toBeVisible();
    await shoot(page, "agent-card-failed");
  });

  test("T-037 · a run whose turn ended without an answer is red with the reason and shows the agent's screen, not a missing message", async ({ page }) => {
    const screen = ["● Write my morning summary.", "  ⎿  API Error: Not logged in · Please run /login", "> /exit", "Bye."];
    const unanswered: RunRecord = { ...done, state: "failed", reason: "the agent's turn ended without an answer", lastLines: screen };
    await start(page, { route: `run/morning-summary/${RUN}` });
    await setHistory(page, [unanswered], { [SESSION]: null });
    const dialog = app(page).getByTestId("run-dialog");
    await expect(dialog).toHaveAttribute("data-tone", "danger");
    await expect(app(page).getByTestId("run-result")).toHaveText("Failed");
    await expect(dialog.getByTestId("run-why")).toHaveText("The agent's turn ended without an answer");
    await expect(dialog.getByTestId("run-last-lines")).toHaveText(screen.join("\n"));
    await expect(dialog.getByTestId("run-agent-note")).toHaveCount(0);
    await expect(dialog.getByTestId("run-agent-message")).toHaveCount(0);
    await shoot(page, "agent-card-no-answer");
  });
});

test.describe("T-022 · T-030 · the Services table's columns", () => {
  test.use({ viewport: { width: 1040, height: 700 } });

  const LONG = "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort --logLevel info --config vite.config.ts --mode staging";
  const MID = "npm run dev -- --host 0.0.0.0 --port 5173";
  const job = (name: string, command: string, extra = ""): string => `---\nkind: service\nname: ${name}\nfolder: .\ncommand: ${command}\n${extra}---\n`;
  const KEPT = "pomade-runner.services.column-widths";
  const COLUMNS = ["service", "command", "status"] as const;

  /** The Services view with a short command, a medium one, a long one, a disabled one, one waiting for Pomade and an invalid file. */
  async function open(page: Page, reload = false): Promise<void> {
    if (reload) await page.reload();
    else await page.goto(harness({ route: "services" }));
    await page.waitForFunction(() => typeof window.setServiceStatus === "function");
    await writeJob(page, "short.md", job("Short", "./start.sh"));
    await writeJob(page, "long.md", job("Long", LONG));
    await writeJob(page, "mid.md", job("Mid", MID));
    await writeJob(page, "off.md", job("Off", "./off.sh --quiet", "enabled: false\n"));
    await writeJob(page, "watch.md", job("Watch", "./watch.sh --poll", "start: pomade-started\n"));
    await writeJob(page, "bad.md", "---\nkind: service\nname: Bad\nfolder: .\ncommand: ./bad.sh\nready: { port: abc }\n---\n");
    await page.evaluate(() => {
      window.setServiceStatus("off", { state: "disabled", session: null });
      window.setServiceStatus("watch", { state: "waiting-for-pomade", session: null });
    });
    await expect(app(page).getByTestId("service-row")).toHaveCount(5);
  }

  const table = (page: Page) => app(page).getByTestId("resizable-table");
  const head = (page: Page) => table(page).locator("> div > div").first();
  const headCell = (page: Page, id: string) => head(page).locator(`:scope > [data-col="${id}"]`);
  const grip = (page: Page, id: string) => app(page).locator(`[data-testid="column-grip"][data-grip="${id}"]`);
  const row = (page: Page, jobId: string) => app(page).locator(`[data-testid="service-row"][data-job="${jobId}"]`);
  const cell = (page: Page, jobId: string) => row(page, jobId).getByTestId("service-command");
  const width = async (page: Page, jobId: string): Promise<number> => (await cell(page, jobId).boundingBox())?.width ?? 0;
  /** The three sized columns' head widths. */
  async function widths(page: Page): Promise<Record<(typeof COLUMNS)[number], number>> {
    const [service, command, status] = await Promise.all(COLUMNS.map(async (id) => (await headCell(page, id).boundingBox())!.width));
    return { service: service!, command: command!, status: status! };
  }
  const kept = (page: Page): Promise<string | null> => app(page).locator("html").evaluate((_, key) => window.localStorage.getItem(key), KEPT);
  const scrollTo = (page: Page, left: number): Promise<void> => table(page).evaluate((el, x) => void (el.scrollLeft = x), left);

  /** Drag `id`'s grip by `dx` px, naming a screenshot taken mid-drag. */
  async function drag(page: Page, id: string, dx: number, name?: string): Promise<void> {
    await grip(page, id).scrollIntoViewIfNeeded();
    const box = (await grip(page, id).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 });
    if (name !== undefined) await shoot(page, name);
    await page.mouse.up();
  }

  /** Every cell of a row sits under its head cell, at every scroll position. */
  async function aligned(page: Page, jobId: string): Promise<void> {
    const at = async (locator: Locator): Promise<number> => (await locator.boundingBox())!.x;
    const r = row(page, jobId);
    expect(await at(r.locator("[class*=main]"))).toBeCloseTo(await at(headCell(page, "service")), 0);
    expect(await at(cell(page, jobId))).toBeCloseTo(await at(headCell(page, "command")), 0);
    expect(await at(r.getByTestId("service-status"))).toBeCloseTo(await at(headCell(page, "status")), 0);
  }

  test("the command has a column of its own: the head names it, the line under the name is project · folder, a long one is cut with … and shows whole in a tooltip", async ({ page }) => {
    await open(page);
    await expect(head(page)).toHaveText("Service · project · folderCommandStatus");
    const long = row(page, "long");
    await expect(long.getByRole("button", { name: "Restart" })).toBeVisible();
    await expect(long).toContainText(/Long\s*Workspace · \./);
    await expect(long.locator("[class*=sub]").first()).not.toContainText("npm run dev");

    // The head's labels sit over their columns.
    await aligned(page, "long");

    // Short fits: no tooltip, not a tab stop. Long is cut: focusable, with the whole command as its tip.
    await expect(cell(page, "short")).toHaveAttribute("data-cut", "false");
    await expect(cell(page, "short")).not.toHaveAttribute("data-tip", /.*/);
    await expect(cell(page, "short")).not.toHaveAttribute("tabindex", /.*/);
    await expect(cell(page, "long")).toHaveAttribute("data-cut", "true");
    await expect(cell(page, "long")).toHaveAttribute("data-tip", LONG);
    expect(await cell(page, "long").evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");

    await cell(page, "long").hover();
    await expect(app(page).getByTestId("tooltip")).toHaveText(LONG);
    await cell(page, "short").hover();
    await expect(app(page).getByTestId("tooltip")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(app(page).getByTestId("tooltip")).toHaveCount(0);
    await page.keyboard.press("Tab");
    await cell(page, "long").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(cell(page, "long")).toBeFocused();
    await expect(app(page).getByTestId("tooltip")).toHaveText(LONG);
    await shoot(page, "t022-services-cut-tooltip");

    // Level lines: the command's text sits on the name's line in every row; the columns hold in the tab.
    const rows = app(page).getByTestId("service-row");
    for (let i = 0; i < 5; i++) {
      const name = await rows.nth(i).locator("[class*=name]").boundingBox();
      const command = await rows.nth(i).getByTestId("service-command").boundingBox();
      expect(command!.y + command!.height / 2).toBeCloseTo(name!.y + name!.height / 2, 0);
      const actions = await rows.nth(i).locator("[class*=actions]").boundingBox();
      expect(actions!.x + actions!.width).toBeLessThanOrEqual(1040 - 24);
    }
    await expect(app(page).getByTestId("service-invalid")).toContainText("Invalid:");
    await page.mouse.move(0, 0);
    await cell(page, "long").blur();
    await expect(app(page).getByTestId("tooltip")).toHaveCount(0);
    await shoot(page, "t022-services-default");
  });

  test("T-030 · Service, Command and Status each have a grip on the head's right edge; the icon and the actions have none; Jobs has no grips", async ({ page }) => {
    await open(page);
    await expect(app(page).getByTestId("column-grip")).toHaveCount(3);
    for (const id of COLUMNS) {
      const g = grip(page, id);
      await expect(g).toHaveAttribute("role", "separator");
      await expect(g).toHaveAttribute("tabindex", "0");
      expect(await g.evaluate((el) => getComputedStyle(el).cursor)).toBe("col-resize");
      // On the head cell's right edge, in the gap before the next column.
      const cellBox = (await headCell(page, id).boundingBox())!;
      const gripBox = (await g.boundingBox())!;
      expect(gripBox.x).toBeCloseTo(cellBox.x + cellBox.width, 0);
      expect(gripBox.width).toBeCloseTo(12, 0);
    }
    // Hovering a head cell shows its grip's line; nothing moves.
    const before = await widths(page);
    await headCell(page, "command").hover();
    await shoot(page, "t030-services-grip-hover");
    expect(await widths(page)).toEqual(before);

    await page.evaluate(() => window.mounted.navigate(""));
    await expect(app(page).getByTestId("job-row").first()).toBeVisible();
    await expect(app(page).getByTestId("column-grip")).toHaveCount(0);
    await expect(app(page).getByTestId("resizable-table")).toHaveCount(0);
  });

  for (const id of COLUMNS) {
    test(`T-030 · dragging the ${id} grip widens that column only; the rows stay under their heads and Status and the actions never leave the table`, async ({ page }) => {
      await open(page);
      const before = await widths(page);
      const statusRight = (await row(page, "mid").getByTestId("service-status").boundingBox())!.x;
      await drag(page, id, 50, `t030-services-dragging-${id}`);
      const after = await widths(page);
      for (const other of COLUMNS) expect(after[other]).toBeCloseTo(before[other] + (other === id ? 50 : 0), 0);
      for (const jobId of ["short", "long", "mid", "off", "watch"]) await aligned(page, jobId);
      // Only the columns after it move, by what it grew.
      const moved = (await row(page, "mid").getByTestId("service-status").boundingBox())!.x - statusRight;
      expect(moved).toBeCloseTo(id === "status" ? 0 : 50, 0);
      await page.mouse.move(0, 0);
      await shoot(page, `t030-services-widened-${id}`);
    });
  }

  test("T-030 · columns wider than the tab scroll the table sideways: the head scrolls with the rows, the last column is reached, the page itself never scrolls", async ({ page }) => {
    await open(page);
    expect(await table(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await drag(page, "command", 500, "t030-services-dragging-wide");
    const room = await table(page).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(room).toBeGreaterThan(200);
    expect(await app(page).locator("html").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    // The actions are out of the tab until the table is scrolled to its end.
    const open_ = row(page, "mid").getByRole("button", { name: "Open file" });
    expect((await open_.boundingBox())!.x).toBeGreaterThan(1040);
    for (const left of [0, 120, room]) {
      await scrollTo(page, left);
      for (const jobId of ["short", "long", "mid", "off", "watch"]) await aligned(page, jobId);
      // The head cells keep their place over the rows.
      const rowBox = (await row(page, "mid").boundingBox())!;
      expect((await head(page).boundingBox())!.x).toBeCloseTo(rowBox.x, 0);
      expect(await rowPastEdge(table(page)), `a row past the edge at ${left}`).toBe(false);
    }
    await scrollTo(page, room);
    const last = (await open_.boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(1040);
    expect(last.x).toBeGreaterThan(0);
    // A row, with its hover tint and hairline, is as wide as the columns: it reaches past the last cell.
    const wide = (await row(page, "mid").boundingBox())!;
    expect(wide.width).toBeCloseTo(await table(page).evaluate((el) => el.scrollWidth), 0);
    expect(wide.x + wide.width).toBeGreaterThanOrEqual(last.x + last.width);
    // The invalid row spans the same width as the others.
    expect((await app(page).getByTestId("service-invalid").boundingBox())!.width).toBeCloseTo((await row(page, "mid").boundingBox())!.width, 0);
    await shoot(page, "t030-services-scrolled");
    // The grips keep working scrolled: Status narrows by a step.
    const status = (await headCell(page, "status").boundingBox())!.width;
    await grip(page, "status").focus();
    await page.keyboard.press("ArrowLeft");
    expect((await headCell(page, "status").boundingBox())!.width).toBeCloseTo(status - 16, 0);
  });

  test("T-056 · a Services list longer than the tab scrolls in the table's own area: the head stays at its top, the sideways scrollbar's place at the tab's bottom, the page itself never scrolls", async ({ page }) => {
    await open(page);
    for (let n = 0; n < 16; n++) await writeJob(page, `more-${n}.md`, job(`More ${n}`, `${MID} --name more-${n}`));
    await expect(app(page).getByTestId("service-row")).toHaveCount(21);
    const frame = (await page.locator('iframe[data-frame="main"]').boundingBox())!;
    const view = frame.y + frame.height;
    await drag(page, "command", 500);
    expect(await table(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(200);
    expect(await table(page).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
    expect(await table(page).evaluate((el) => (el.closest("main")!.lastElementChild as HTMLElement).scrollHeight - (el.closest("main")!.lastElementChild as HTMLElement).clientHeight)).toBeLessThanOrEqual(0);
    const top = (await head(page).boundingBox())!.y;
    const bottom = async (): Promise<number> => {
      const box = (await table(page).boundingBox())!;
      return box.y + box.height;
    };
    expect(await bottom()).toBeLessThanOrEqual(view);
    expect(await bottom()).toBeGreaterThan(view - 40);

    // A wheel over the rows scrolls the list, not the page: the head stays put and paints over the rows.
    const rowBox = (await row(page, "mid").boundingBox())!;
    await page.mouse.move(rowBox.x + 100, rowBox.y + rowBox.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => table(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    expect((await head(page).boundingBox())!.y).toBeCloseTo(top, 0);
    expect(await head(page).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(el.ownerDocument.elementFromPoint(box.left + 200, box.top + box.height / 2));
    })).toBe(true);
    expect(await bottom()).toBeLessThanOrEqual(view);

    // Sideways too: the cells stay under their head cells, the head at the top.
    await scrollTo(page, 160);
    const seen = app(page).locator('[data-testid="service-row"][data-job="more-12"]');
    await seen.scrollIntoViewIfNeeded();
    const at = async (locator: Locator): Promise<number> => (await locator.boundingBox())!.x;
    expect(await at(seen.getByTestId("service-command"))).toBeCloseTo(await at(headCell(page, "command")), 0);
    expect(await at(seen.getByTestId("service-status"))).toBeCloseTo(await at(headCell(page, "status")), 0);
    expect((await head(page).boundingBox())!.y).toBeCloseTo(top, 0);
    await page.mouse.move(0, 0);
    await shoot(page, "t056-services-scrolled");
  });

  test("T-030 · the widths are kept on this Mac: the same after the tab is closed and opened again; a double click on a grip puts the table back to its default layout", async ({ page }) => {
    await open(page);
    const first = await widths(page);
    await drag(page, "command", 80);
    await drag(page, "service", -30);
    const resized = await widths(page);
    expect(resized.command).toBeCloseTo(first.command + 80, 0);
    expect(resized.service).toBeCloseTo(first.service - 30, 0);
    expect(JSON.parse((await kept(page))!)).toEqual({ service: Math.round(resized.service), command: Math.round(resized.command), status: Math.round(resized.status) });

    await open(page, true);
    const again = await widths(page);
    for (const id of COLUMNS) expect(again[id]).toBeCloseTo(resized[id], 0);
    await aligned(page, "mid");

    await grip(page, "status").dblclick();
    expect(await kept(page)).toBeNull();
    const reset = await widths(page);
    for (const id of COLUMNS) expect(reset[id]).toBeCloseTo(first[id], 0);
    await open(page, true);
    expect(await widths(page)).toEqual(reset);
  });

  test("T-030 · the grip is a separator with a keyboard: Left and Right change that column's width in steps, Shift in larger ones, never under its minimum", async ({ page }) => {
    await open(page);
    const g = grip(page, "command");
    const start = await width(page, "mid");
    await g.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => width(page, "mid")).toBeCloseTo(start + 16, 0);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => width(page, "mid")).toBeCloseTo(start + 80, 0);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => width(page, "mid")).toBeCloseTo(start + 64, 0);
    await expect(g).toHaveAttribute("aria-valuenow", String(Math.round(start + 64)));
    await expect(g).toHaveAttribute("aria-valuemin", "120");
    expect(JSON.parse((await kept(page))!).command).toBe(Math.round(start + 64));
    // The grip is lit while focused, and nothing moves for it.
    const before = await widths(page);
    await page.mouse.move(0, 0);
    await shoot(page, "t030-services-grip-focus");
    expect(await widths(page)).toEqual(before);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(() => width(page, "mid")).toBeCloseTo(120, 0);
    await drag(page, "service", -900);
    expect((await headCell(page, "service").boundingBox())!.width).toBeCloseTo(120, 0);
  });

  test("with a store that refuses, the view renders at the default layout and still resizes", async ({ page }) => {
    await page.addInitScript(() => {
      if (window.parent === window) return;
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
    });
    await open(page);
    expect(await width(page, "mid")).toBeCloseTo(260, 0);
    await grip(page, "command").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => width(page, "mid")).toBeCloseTo(276, 0);
  });

  test("T-030 · widths kept in a shape the table does not know leave the default layout", async ({ page }) => {
    await page.addInitScript((key) => {
      if (window.parent !== window) window.localStorage.setItem(key, '{"command":400}');
    }, KEPT);
    await open(page);
    expect(await width(page, "mid")).toBeCloseTo(260, 0);
  });

  for (const tab of [640, 560]) {
    test(`a ${tab} px tab puts the command under the name — still cut, still with its tooltip — and nothing overlaps or leaves the tab`, async ({ page }) => {
      await page.setViewportSize({ width: tab, height: 700 });
      await open(page);
      await expect(app(page).getByTestId("column-grip").first()).toBeHidden();
      await expect(headCell(page, "command")).toBeHidden();
      const rows = app(page).getByTestId("service-row");
      for (let i = 0; i < 5; i++) {
        const row = (await rows.nth(i).boundingBox())!;
        const boxes = [
          await rows.nth(i).locator("[class*=main]").boundingBox(),
          await rows.nth(i).getByTestId("service-command").boundingBox(),
          await rows.nth(i).getByTestId("service-status").boundingBox(),
          await rows.nth(i).locator("[class*=actions]").boundingBox(),
        ];
        for (const [a, b] of [[0, 1], [0, 3], [1, 3], [2, 3], [0, 2]] as const) {
          const [p, q] = [boxes[a]!, boxes[b]!];
          const apart = p.x + p.width <= q.x + 0.5 || q.x + q.width <= p.x + 0.5 || p.y + p.height <= q.y + 0.5 || q.y + q.height <= p.y + 0.5;
          expect(apart, `row ${i}: ${a} and ${b} overlap`).toBe(true);
        }
        for (const box of boxes) expect(box!.x + box!.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
      }
      const command = cell(page, "long");
      await expect(command).toHaveAttribute("data-cut", "true");
      const name = (await app(page).locator('[data-testid="service-row"][data-job="long"] [class*=main]').boundingBox())!;
      expect((await command.boundingBox())!.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
      await command.hover();
      await expect(app(page).getByTestId("tooltip")).toHaveText(LONG);
      await expect(app(page).getByTestId("service-invalid")).toContainText("Invalid:");
      const invalid = (await app(page).getByTestId("service-invalid").boundingBox())!;
      const invalidActions = (await app(page).getByTestId("service-invalid").getByRole("button", { name: "Open file" }).boundingBox())!;
      expect(invalidActions.x + invalidActions.width).toBeLessThanOrEqual(invalid.x + invalid.width);
      await page.mouse.move(0, 0);
      await shoot(page, `t022-services-narrow-${tab}`);
      // Widths kept from a wider tab do not widen the narrow layout: no sideways scroll.
      expect(await app(page).locator("html").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(await table(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    });
  }

  test("T-030 · widths kept from a wide tab leave a narrow tab as it is: the command under the name, no sideways scroll", async ({ page }) => {
    await open(page);
    await drag(page, "command", 400);
    await page.setViewportSize({ width: 640, height: 700 });
    await expect(grip(page, "status")).toBeHidden();
    expect(await table(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const actions = (await row(page, "mid").locator("[class*=actions]").boundingBox())!;
    expect(actions.x + actions.width).toBeLessThanOrEqual(640);
  });

  test("a command cut in a tab at its default width is measured again as the tab changes size, and as its column does", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 700 });
    await open(page);
    await writeJob(page, "fit.md", job("Fit", "./serve.sh --port 5173 --open"));
    await expect(app(page).getByTestId("service-row")).toHaveCount(6);
    await expect(cell(page, "fit")).toHaveAttribute("data-cut", "false");
    await page.setViewportSize({ width: 860, height: 700 });
    await expect(cell(page, "fit")).toHaveAttribute("data-cut", "true");
    await expect(cell(page, "fit")).toHaveAttribute("data-tip", "./serve.sh --port 5173 --open");
    await page.setViewportSize({ width: 1500, height: 700 });
    await expect(cell(page, "fit")).toHaveAttribute("data-cut", "false");

    await expect(cell(page, "mid")).toHaveAttribute("data-cut", "true");
    await grip(page, "command").focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(cell(page, "mid")).toHaveAttribute("data-cut", "false");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await expect(cell(page, "mid")).toHaveAttribute("data-cut", "true");
    await expect(cell(page, "mid")).toHaveAttribute("data-tip", MID);
  });
});

test.describe("the countdown to the next run", () => {
  const SCRIPT = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  every: { minutes: 2 }\n---\n";
  const SECOND = 1000;

  /** The panel and the Jobs view, each in a page of its own on the same clock: the panel's Next up and
   *  the Jobs row of a script due `ahead` ms after the clocks stop. */
  async function surfaces(browser: Browser, ahead: number): Promise<{ panel: Page; jobs: Page }> {
    const open = async (query: Record<string, string>, size: { width: number; height: number }): Promise<Page> => {
      const page = await browser.newPage({ viewport: size });
      // The clock runs from 17:48:00 while the page loads, and stops at 17:49:10.
      await page.clock.install({ time: new Date(2026, 10, 17, 17, 48, 0) });
      await page.goto(harness(query));
      await page.waitForFunction(() => typeof window.setServiceStatus === "function");
      await writeJob(page, "backup.md", SCRIPT);
      await expect(app(page).getByTestId(query.surface === "panel" ? "panel-jobs" : "job-row")).toBeVisible();
      return page;
    };
    const panel = await open({ surface: "panel" }, { width: 240, height: 640 });
    const jobs = await open({}, { width: 1040, height: 760 });
    const stop = new Date(2026, 10, 17, 17, 49, 10);
    const due = stop.getTime() + ahead;
    for (const page of [panel, jobs]) {
      const report: RunsReport = {
        active: [],
        nextUp: [{ job: "backup", name: "Backup", project: null, at: due, held: false }],
        jobs: [{ job: "backup", next: due, finished: false, last: null, held: false }],
        needsYou: [],
        switch: { position: "running", since: null }, heldRuns: 0,
      };
      await page.evaluate((r) => window.setRuns({ report: r, history: [] }), report);
      await expect(app(page).getByTestId(page === panel ? "next-up-item" : "job-next").first()).toBeVisible();
      await page.clock.pauseAt(stop);
    }
    return { panel, jobs };
  }

  const words = (page: Page, testId: string): Promise<string> => app(page).getByTestId(testId).first().innerText();

  /** What the two places say now, after `elapsed` ms more on both clocks. */
  async function both(pages: { panel: Page; jobs: Page }, elapsed: number, expected: string): Promise<void> {
    // A second at a time: the page schedules its next redraw after it has drawn, as it does in real time.
    for (let done = 0; done < elapsed; done += SECOND) {
      for (const page of [pages.panel, pages.jobs]) await page.clock.runFor(Math.min(SECOND, elapsed - done));
      await pages.panel.waitForTimeout(25);
    }
    await expect(app(pages.panel).getByTestId("next-up-item").first()).toContainText(expected);
    await expect(app(pages.jobs).getByTestId("job-next")).toContainText(expected);
  }

  test("a script every 2 minutes reads the same in Next up and in Jobs: clock minutes, then seconds, then now", async ({ browser }) => {
    // 17:49:10 now, due 17:51:00: 110 s ahead.
    const pages = await surfaces(browser, 110 * SECOND);
    try {
      await expect(app(pages.panel).getByTestId("next-up-item").first()).toContainText("in 2 min");
      await expect(app(pages.jobs).getByTestId("job-next")).toContainText("Today 17:51");
      await expect(app(pages.jobs).getByTestId("job-next")).toContainText("in 2 min");
      expect(await words(pages.panel, "next-up-item")).toMatch(/^in 2 min\s*Backup/);
      await both(pages, 49 * SECOND, "in 2 min"); // 17:49:59
      await both(pages, 1 * SECOND, "in 1 min"); // 17:50:00 → 60 s ahead
      await both(pages, 4 * SECOND, "in 56 s"); // 17:50:04
      await both(pages, 1 * SECOND, "in 55 s");
      await shoot(pages.panel, "t028-panel-next-up-seconds");
      await shoot(pages.jobs, "t028-jobs-next-run-seconds");
      await both(pages, 54 * SECOND, "in 1 s"); // 17:50:59
      await both(pages, 1 * SECOND, "now"); // 17:51:00
      expect(await words(pages.panel, "next-up-item")).toMatch(/^now\s*Backup/);
      await both(pages, 30 * SECOND, "now"); // nothing says anything else before the row turns to running
    } finally {
      await pages.panel.close();
      await pages.jobs.close();
    }
  });

  test("a run 90 s ahead: 2 minutes in both places, then 1 minute, then the seconds", async ({ browser }) => {
    const pages = await surfaces(browser, 90 * SECOND);
    try {
      expect([await words(pages.panel, "next-up-item"), await words(pages.jobs, "job-next")]).toEqual([expect.stringMatching(/^in 2 min\s*Backup/), expect.stringContaining("in 2 min")]);
      await shoot(pages.panel, "t028-panel-next-up-90s");
      await shoot(pages.jobs, "t028-jobs-next-run-90s");
      await both(pages, 30 * SECOND, "in 1 min"); // 60 s ahead
      await both(pages, 20 * SECOND, "in 40 s");
      await shoot(pages.panel, "t028-panel-next-up-40s");
      await shoot(pages.jobs, "t028-jobs-next-run-40s");
    } finally {
      await pages.panel.close();
      await pages.jobs.close();
    }
  });

  test("the seconds do not move the layout: the name in Next up and the cells of the Jobs row stay put from 1 min to 55 s", async ({ browser }) => {
    const pages = await surfaces(browser, 62 * SECOND);
    try {
      const places = async (): Promise<number[]> => {
        const name = await app(pages.panel).getByTestId("next-up-item").first().locator("span").last().boundingBox();
        const cells = await app(pages.jobs).getByTestId("job-row").first().locator("> *").evaluateAll((all) => all.map((cell) => cell.getBoundingClientRect().x));
        return [name!.x, ...cells];
      };
      const before = await places();
      await both(pages, 7 * SECOND, "in 55 s");
      expect(await places()).toEqual(before);
    } finally {
      await pages.panel.close();
      await pages.jobs.close();
    }
  });
});

test.describe("the time a run has been going", () => {
  const SCRIPT = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
  const SECOND = 1000;
  const RUN_ID = "20261117-174850-aaaaaa";
  // The clocks stop at 17:49:10; the run started 20 s before.
  const STOP = new Date(2026, 10, 17, 17, 49, 10).getTime();

  const going = (startedAt: number): ActiveRun => ({
    job: "backup",
    name: "Backup",
    kind: "script",
    project: null,
    folder: "",
    run: RUN_ID,
    trigger: "scheduled",
    cause: null,
    dueAt: startedAt,
    agent: null,
    missed: null,
    series: null,
    state: "running",
    lowPriority: true,
    runAt: null,
    deadline: null,
    waits: null,
    startedAt,
    session: `run:backup:${RUN_ID}`,
    log: null,
    limitHit: null,
    warnedAt: null,
    warningDismissed: false,
  });

  type Places = { panel: Page; history: Page; card: Page };

  /** The panel, History and the run's card, each in a page of its own on the same clock, all showing
   *  a run that started 20 s before the clocks stop at 17:49:10. */
  async function surfaces(browser: Browser, active: ActiveRun[]): Promise<Places> {
    const open = async (query: Record<string, string>, size: { width: number; height: number }, ready: string): Promise<Page> => {
      const page = await browser.newPage({ viewport: size });
      await page.clock.install({ time: new Date(STOP - 10 * SECOND) });
      await page.goto(harness(query));
      await page.waitForFunction(() => typeof window.setServiceStatus === "function");
      await writeJob(page, "backup.md", SCRIPT);
      const report: RunsReport = { active, nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 };
      await page.evaluate((r) => window.setRuns({ report: r, history: [] }), report);
      await expect(app(page).getByTestId(ready)).toBeVisible();
      await page.clock.pauseAt(new Date(STOP));
      return page;
    };
    return {
      panel: await open({ surface: "panel" }, { width: 240, height: 640 }, "active-run"),
      history: await open({ route: "history" }, { width: 1040, height: 760 }, "history-row"),
      card: await open({ route: `run/backup/${RUN_ID}` }, { width: 1040, height: 760 }, "run-card"),
    };
  }

  const close = async (pages: Places): Promise<void> => {
    for (const page of Object.values(pages)) await page.close();
  };

  /** What each place says of the run's time. */
  async function says(pages: Places): Promise<string[]> {
    const text = (page: Page, testId: string): Promise<string> => app(page).getByTestId(testId).first().innerText();
    return [(await text(pages.panel, "active-run")).replace(/^[\s\S]*running\s+(\S+)[\s\S]*$/, "$1"), (await text(pages.history, "history-duration")).trim(), (await text(pages.card, "run-duration")).trim()];
  }

  /** After `ms` more on every clock, a second at a time as the pages schedule their next redraw after drawing. */
  async function after(pages: Places, ms: number): Promise<void> {
    for (let done = 0; done < ms; done += SECOND) {
      for (const page of Object.values(pages)) await page.clock.runFor(Math.min(SECOND, ms - done));
      await pages.panel.waitForTimeout(25);
    }
  }

  test("a run going 20 s reads 20s, 21s, 22s… in the panel, History and its card alike, without leaving the tab", async ({ browser }) => {
    const pages = await surfaces(browser, [going(STOP - 20 * SECOND)]);
    try {
      await expect.poll(() => says(pages)).toEqual(["20s", "20s", "20s"]);
      await shoot(pages.panel, "t031-panel-20s");
      await shoot(pages.history, "t031-history-20s");
      await shoot(pages.card, "t031-card-20s");
      for (let seconds = 21; seconds <= 26; seconds++) {
        await after(pages, SECOND);
        await expect.poll(() => says(pages)).toEqual(Array(3).fill(`${seconds}s`));
      }
    } finally {
      await close(pages);
    }
  });

  test("past a minute the three still agree: 59s, then 1m on to the minutes", async ({ browser }) => {
    const pages = await surfaces(browser, [going(STOP - 57 * SECOND)]);
    try {
      await expect.poll(() => says(pages)).toEqual(["57s", "57s", "57s"]);
      await after(pages, 2 * SECOND);
      await expect.poll(() => says(pages)).toEqual(["59s", "59s", "59s"]);
      await after(pages, SECOND);
      await expect.poll(() => says(pages)).toEqual(["1m", "1m", "1m"]);
      await after(pages, 130 * SECOND);
      await expect.poll(() => says(pages)).toEqual(["3m", "3m", "3m"]);
    } finally {
      await close(pages);
    }
  });

  test("the digits do not shift the row: the panel's status, History's duration and the card's meta keep their places from 20s to 26s", async ({ browser }) => {
    const pages = await surfaces(browser, [going(STOP - 20 * SECOND)]);
    try {
      const places = async (): Promise<number[]> => {
        const status = await app(pages.panel).getByTestId("active-run").locator("span").last().boundingBox();
        const cells = await app(pages.history).getByTestId("history-row").first().locator("> *").evaluateAll((all) => all.map((cell) => cell.getBoundingClientRect().x));
        const trigger = await app(pages.card).getByTestId("run-trigger").boundingBox();
        return [status!.x, ...cells, trigger!.x];
      };
      const before = await places();
      await after(pages, 6 * SECOND);
      await expect.poll(() => says(pages)).toEqual(["26s", "26s", "26s"]);
      expect(await places()).toEqual(before);
    } finally {
      await close(pages);
    }
  });
});
