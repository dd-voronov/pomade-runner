// Git jobs with a real Pomade: the Pomade checkout's built app (`POMADE_REPO`) in test mode on a temp
// workspace, user data, home and git configuration, with the built `dist/` dev-linked and a
// throwaway repo `notes` in the workspace (`support/git.ts`). The scheduler is started the way
// the login item starts it (`pomade.spec.ts`). A git job made in Runner's job form — the file one
// written by hand is — runs through the `pomade-git` Pomade wrote into its command folder; Pomade's
// Git panel shows the job on the repo's row — the Scheduled line Runner's `jobs.forRepo` answers —
// whose link opens Runner's tab at the job; a conflict fails the run, and its card is red with the
// conflict as the repo's reason. `RUNNER_SHOTS=<dir>` saves screenshots of the form, the row, the
// tab it opens and the card.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { connectSocket } from "pomade-kit/node";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { runRoute } from "../src/integrations/runner-api";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { drawn } from "./support/frames";
import { createGitFixture, gitEnv, type GitFixture } from "./support/git";
import { expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const SHOTS = process.env.RUNNER_SHOTS;
const NAME = "Commit notes";
/** The job's id: the form files it under its name's slug, at the top of the jobs folder. */
const ID = "commit-notes";
/** The job as a person or an agent writes it by hand. */
const HAND = `---\nkind: git\nname: ${NAME}\ngit: { operation: commit-push, repos: [notes] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n`;

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
    repos.git(folders.workspace, "init", "--quiet", "Journal");
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
    await expectNothingLeft(tmp);
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
    const result = await callScheduler(socket(), "history", { job: ID, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  /** A connection to Pomade as Runner's backend — what opens Runner's tab at a route here. */
  async function connectAsRunner(): Promise<HostClient> {
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    const result = await connectSocket({ socketPath: host.socket, appId: manifest.id, keyFile: join(folders.userData, "app-keys", manifest.id), role: "backend" });
    if (result.status !== "connected") throw new Error(`Runner's connection to Pomade: ${result.status}`);
    return result.host;
  }

  /** Runner's tab at `route`, in the Workspace. */
  async function openRunnerTab(route: string): Promise<void> {
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route, projectId: WORKSPACE_PROJECT_ID });
    } finally {
      runner.close();
    }
    await drawn(page);
  }

  const tab = (): ReturnType<Page["frameLocator"]> => page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);

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

  test("a git job made in the job form — the workspace's repos to pick from — is the file one written by hand is, and pomade-runner check accepts it", async () => {
    await startTheScheduler();
    await openRunnerTab("new");
    await tab().getByTestId("kind-git").click();
    const form = tab().getByTestId("form-git");
    await form.getByRole("textbox", { name: "Name", exact: true }).fill(NAME);
    await form.getByRole("textbox", { name: "Time 1" }).fill("13:00");
    await form.getByRole("button", { name: "Add time" }).click();
    await expect(form.getByRole("textbox", { name: "Time 2" })).toHaveValue("20:00");
    // Pomade's git state: the workspace's repos, by the names its Git panel shows.
    const picks = form.getByRole("group", { name: "Repositories" });
    await expect(picks.getByTestId("repo-name")).toHaveText(["Journal", "notes"]);
    await picks.getByRole("checkbox", { name: "notes", exact: true }).click();
    await expect(form.getByTestId("policy-summary")).toHaveText("If missed, skip · never overlaps itself · normal priority · no time limit · notifies on failure");
    await shoot(page, "pomade-git-form");
    await tab().getByTestId("form-save").click();
    await expect(tab().getByTestId("toast").last()).toHaveText(`RunnerCreated Apps/pomade-runner/jobs/${ID}.md`);
    const path = join(folders.workspace, `Apps/pomade-runner/jobs/${ID}.md`);
    expect(await readFile(path, "utf8")).toBe(HAND.replace(`name: ${NAME}\n`, `name: ${NAME}\nenabled: true\n`));
    const checked = await run(join(folders.home, "bin", "pomade-runner"), ["check", path], { env: cleanEnv(), cwd: tmp });
    expect(checked).toMatchObject({ code: 0, stdout: "1 job file: no problems.\n" });
  });

  test("a git job runs through the pomade-git Pomade wrote into its command folder; the repo's row shows the run", async () => {
    expect(existsSync(join(folders.home, "bin", "pomade-git"))).toBe(true);
    await writeFile(join(repos.repo, "notes.md"), "# Notes\n\nfirst line\nwritten with Pomade open\n");
    const ran = await run(join(folders.home, "bin", "pomade-runner"), ["run", ID], { env: cleanEnv(), cwd: tmp });
    expect(ran.code).toBe(0);
    await expect.poll(async () => (await history()).length, { timeout: 30_000 }).toBe(1);
    const [record] = await history();
    expect(record).toMatchObject({ state: "done", exitCode: 0 });
    const hash = record?.git?.results[0]?.commit ?? "";
    expect(repos.git(repos.remote, "rev-parse", "main")).toBe(hash);

    await openGitPanel();
    await expect(page.getByTestId("git-run-notes")).toHaveAttribute("data-status", "done");
  });

  test("4 · the repo's row shows the job's Scheduled line from jobs.forRepo; its link opens Runner's tab at the job", async () => {
    await openGitPanel();
    await windowRegainsFocus();
    const line = page.getByTestId("git-scheduled-notes");
    await expect(line).toHaveText("Scheduled: Commit & push · daily at 13:00 and 20:00 — edit in Runner");
    await expect(line).toHaveAttribute("data-job", ID);
    await shoot(page, "pomade-git-scheduled");

    await page.getByTestId("git-scheduled-edit-notes").click();
    const row = tab().locator(`[data-testid="job-row"][data-job="${ID}"]`);
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row.getByTestId("job-trigger")).toHaveAttribute("data-tip", "Daily at 13:00 and 20:00 · Commit & push · notes");
    await shoot(page, "pomade-git-job");
  });

  test("a conflict: the run fails, and its card is red with the conflict as the repo's reason and the step that stopped", async () => {
    // The other machine has the job's commit, then changes the line this one changes too.
    repos.git(repos.other, "pull", "--quiet");
    await writeFile(join(repos.other, "notes.md"), "# Notes\n\nfirst line, as the other machine has it\n");
    repos.git(repos.other, "commit", "--quiet", "-am", "Theirs");
    repos.git(repos.other, "push", "--quiet");
    await writeFile(join(repos.repo, "notes.md"), "# Notes\n\nfirst line, as this machine has it\n");
    expect((await run(join(folders.home, "bin", "pomade-runner"), ["run", ID], { env: cleanEnv(), cwd: tmp })).code).toBe(0);
    await expect.poll(async () => (await history()).length, { timeout: 30_000 }).toBe(2);
    const [record] = await history();
    expect(record).toMatchObject({ state: "failed", exitCode: 1 });
    const reason = record?.git?.results[0]?.reason ?? "";
    expect(reason).toContain("conflict with yours in notes.md");

    await openRunnerTab(runRoute(ID, record?.run ?? ""));
    const dialog = tab().getByTestId("run-dialog");
    await expect(dialog).toHaveAttribute("data-tone", "danger");
    await expect(tab().getByTestId("run-result")).toHaveText("Failed");
    const repo = dialog.getByTestId("run-git-repo");
    await expect(repo).toHaveAttribute("data-status", "failed");
    await expect(repo).toContainText("notes");
    // The step that stopped says the conflict; the repo's reason — what the conflict left — follows.
    await expect(repo.locator('[data-testid="run-git-step"][data-outcome="failed"]')).toHaveText("conflict in notes.md");
    await expect(dialog.getByTestId("run-git-note")).toHaveText(reason);
    await shoot(page, "pomade-git-conflict");
  });

  test("4 · with Runner's scheduler not answering, the row shows no Scheduled line", async () => {
    await scheduler?.kill();
    scheduler = null;
    await openGitPanel();
    await windowRegainsFocus();
    await expect(page.getByTestId("git-run-notes")).toBeVisible();
    await expect(page.getByTestId("git-scheduled-notes")).toHaveCount(0);
  });
});
