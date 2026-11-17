// Git jobs with a real Pomade: the Pomade checkout's built app (`POMADE_REPO`) in test mode on a temp
// workspace, user data, home and git configuration, with the built `dist/` dev-linked and a
// throwaway repo `Knowledge` in the workspace (`support/git.ts`). The scheduler is started the way
// the login item starts it (`pomade.spec.ts`). It runs a git job through the `pomade-git` Pomade
// wrote into its command folder, and Pomade's Git panel shows the job on the repo's row — the
// Scheduled line Runner's `jobs.forRepo` answers — whose link opens Runner's tab at the job.
// `RUNNER_SHOTS=<dir>` saves screenshots of the row and the tab it opens.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { createGitFixture, gitEnv, type GitFixture } from "./support/git";
import { stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const SHOTS = process.env.RUNNER_SHOTS;
const NAME = "Knowledge twice daily";
const JOB = `---\nkind: git\nname: ${NAME}\ngit: { operation: commit-push, repos: [Knowledge] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n`;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe("git jobs in Pomade", () => {
  test.describe.configure({ mode: "serial" });

  const pomade = pomadeCheckout();
  let tmp: string;
  let folders: PomadeFolders;
  let repos: GitFixture;
  let app: ElectronApplication | null = null;
  let page: Page;
  let scheduler: SchedulerProcess | null = null;
  let keeperSocket: string;
  const socket = (): string => join(folders.userData, "app-state", manifest.id, "scheduler.sock");

  test.beforeAll(async () => {
    tmp = await tempDir();
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    await mkdir(join(folders.workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await mkdir(join(tmp, "user"));
    repos = await createGitFixture(tmp, folders.workspace);
    // A second repo, so the Git panel lists the workspace's repos rather than opening the one.
    repos.git(folders.workspace, "init", "--quiet", "Notes");
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/knowledge.md"), JOB);
    // Pomade reads the repo's state with git too: the same throwaway configuration and home.
    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: DIST, HOME: join(tmp, "user"), ...gitEnv(tmp) }) });
    page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
  });

  test.afterAll(async () => {
    await scheduler?.kill();
    await app?.close();
    await stopKeeper(keeperSocket);
    await removeDir(tmp);
  });

  async function startTheScheduler(): Promise<void> {
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
        HOME: join(tmp, "user"),
        SHELL: "/bin/sh",
        ...gitEnv(tmp),
      }),
    );
    scheduler = started;
    await expect.poll(() => started.output()).toContain("connected to Pomade");
  }

  async function history(): Promise<RunRecord[]> {
    const result = await callScheduler(socket(), "history", { job: "knowledge", limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  /** Open the Git panel at the workspace's repos. Its rows ask Runner for their jobs when they show
   *  and when the window regains focus: the panel stays mounted once shown, so the specs that need
   *  the rows to ask again — after the scheduler connected, after it stopped — focus the window. */
  async function openGitPanel(): Promise<void> {
    await page.getByTestId("project-__workspace__").click();
    if (!(await page.getByTestId("side-panel-git").isVisible())) await page.getByTestId("strip-git").click();
    await expect(page.getByTestId("git-repo-list-title")).toHaveText("All repositories");
  }

  async function windowRegainsFocus(): Promise<void> {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }

  test("a git job runs through the pomade-git Pomade wrote into its command folder; the repo's row shows the run", async () => {
    expect(existsSync(join(folders.home, "bin", "pomade-git"))).toBe(true);
    await startTheScheduler();
    await writeFile(join(repos.repo, "notes.md"), "# Notes\n\nfirst line\nwritten with Pomade open\n");
    const ran = await run(join(folders.home, "bin", "pomade-runner"), ["run", "knowledge"], { env: cleanEnv(), cwd: tmp });
    expect(ran.code).toBe(0);
    await expect.poll(async () => (await history()).length, { timeout: 30_000 }).toBe(1);
    const [record] = await history();
    expect(record).toMatchObject({ state: "done", exitCode: 0 });
    const hash = record?.git?.results[0]?.commit ?? "";
    expect(repos.git(repos.remote, "rev-parse", "main")).toBe(hash);

    await openGitPanel();
    await expect(page.getByTestId("git-run-Knowledge")).toHaveAttribute("data-status", "done");
  });

  test("4 · the repo's row shows the job's Scheduled line from jobs.forRepo; its link opens Runner's tab at the job", async () => {
    await openGitPanel();
    await windowRegainsFocus();
    const line = page.getByTestId("git-scheduled-Knowledge");
    await expect(line).toHaveText("Scheduled: Commit & push · daily at 13:00 and 20:00 — edit in Runner");
    await expect(line).toHaveAttribute("data-job", "knowledge");
    await shoot(page, "pomade-git-scheduled");

    await page.getByTestId("git-scheduled-edit-Knowledge").click();
    const tab = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const row = tab.locator('[data-testid="job-row"][data-job="knowledge"]');
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row.getByTestId("job-git")).toHaveText("Commit & push · Knowledge");
    await shoot(page, "pomade-git-job");
  });

  test("4 · with Runner's scheduler not answering, the row shows no Scheduled line", async () => {
    await scheduler?.kill();
    scheduler = null;
    await openGitPanel();
    await windowRegainsFocus();
    await expect(page.getByTestId("git-run-Knowledge")).toBeVisible();
    await expect(page.getByTestId("git-scheduled-Knowledge")).toHaveCount(0);
  });
});
