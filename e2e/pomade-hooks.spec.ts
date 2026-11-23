// Pomade's hooks in a real Pomade (E-007 acceptance 1, 2, 3, 6; T-013): the Pomade checkout's built
// app (`POMADE_REPO`) in test mode on a temp workspace, user data and home, with the built `dist/`
// dev-linked; the scheduler started the way the login item starts it (see `pomade.spec.ts`). A
// project created runs its hook with the project in the environment; Pomade started fires once per
// Pomade start — a restart of Pomade fires it again, a restart of the scheduler does not; the first
// open of a project runs its job and starts its service, a second open does nothing; a project
// moved keeps its jobs listed and firing, its sub-folder and folders following it. A first-open
// service made in the job form after its project's open starts at once, one of a project not opened
// yet waits for the open, a stopped one stays stopped through an edit, a restarted scheduler knows
// the opens, a first-open hook made late fires for no earlier open, and after a Pomade restart a new
// one waits again (T-019). Projects are made, opened and moved through Pomade's workspace store, as
// its Projects panel does. A service's Jobs row starts and stops it, and opens its terminal once it
// has run (T-020). A first-open service stops when Pomade quits and starts on the next start's
// first open (T-021; the other service lifetimes are in `pomade-lifetimes.spec.ts`). The
// scheduler's quit grace is short here (`QUIT_GRACE_MS`).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { connectSocket } from "pomade-kit/node";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { newRoute } from "../src/integrations/runner-api";
import type { ServicesReport } from "../src/keeper/model";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { alive, expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const HUNT = "proj-hunt";
/** The scheduler's quit grace in these tests. */
const QUIT_GRACE_MS = 2000;

test.describe("Pomade's hooks in Pomade", () => {
  test.describe.configure({ mode: "serial" });

  const pomade = pomadeCheckout();
  let tmp: string;
  let folders: PomadeFolders;
  let jobs: string;
  let app: ElectronApplication | null = null;
  let page: Page;
  let scheduler: SchedulerProcess | null = null;
  let keeperSocket: string;
  const pids: number[] = [];

  const schedulerSocket = (): string => join(folders.userData, "app-state", manifest.id, "scheduler.sock");

  function command(...args: string[]) {
    return run(join(folders.home, "bin", "pomade-runner"), args, { env: cleanEnv(), cwd: tmp });
  }

  async function launchPomade(): Promise<void> {
    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: DIST }) });
    page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
  }

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
        POMADE_KEEPER_SOCKET: keeperSocket,
        POMADE_HOME: folders.home,
        HOME: join(tmp, "user"),
        SHELL: "/bin/sh",
        POMADE_RUNNER_QUIT_GRACE_MS: String(QUIT_GRACE_MS),
      }),
    );
    scheduler = started;
    await expect.poll(() => started.output()).toContain("connected to Pomade");
    return started;
  }

  /** The runs of `job` the scheduler recorded, newest first. */
  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(schedulerSocket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  /** What each recorded run of `job` printed, oldest first. */
  async function printed(job: string): Promise<string[]> {
    return (await history(job)).reverse().map((record) => record.lastLines.join("\n"));
  }

  async function services(): Promise<ServicesReport["services"]> {
    const result = await callScheduler(schedulerSocket(), "services", null);
    return result.status === "ok" ? result.value.services : [];
  }

  async function service(job: string): Promise<ServicesReport["services"][number] | undefined> {
    return (await services()).find((candidate) => candidate.job === job);
  }

  /** Runner's own connection to Pomade, as its scheduler has it: it opens Runner's tab at a route. */
  async function connectAsRunner(): Promise<HostClient> {
    const host = JSON.parse(await readFile(join(folders.home, "host.json"), "utf8")) as { socket: string };
    const result = await connectSocket({ socketPath: host.socket, appId: manifest.id, keyFile: join(folders.userData, "app-keys", manifest.id), role: "backend" });
    if (result.status !== "connected") throw new Error(`Runner's connection to Pomade: ${result.status}`);
    return result.host;
  }

  /** In the job form (in the Workspace's Runner tab) of a new service in `project`, made to start on its project's first open: the
   *  create button's words; then created, the toast's. */
  async function createFirstOpenService(project: string, name: string, folder: string): Promise<{ button: string; toast: string }> {
    // The Runner tab in the Workspace, in front: opening a tab in the project would open the project.
    const tab = page.locator(`[data-testid="app-frame-${manifest.id}"]:visible`).contentFrame();
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: newRoute(project), projectId: WORKSPACE_PROJECT_ID });
      const form = tab.getByTestId("form-service");
      await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
      await form.getByRole("textbox", { name: "Command", exact: true }).fill(`echo ${name.toLowerCase()}; while :; do sleep 1; done`);
      await form.getByRole("textbox", { name: "Folder", exact: true }).fill(folder);
      await form.getByRole("button", { name: "On first open of a project" }).click();
      await expect(form.getByTestId("start-project")).toHaveValue(project);
      await expect(form.getByRole("alert")).toHaveCount(0);
      const button = (await tab.getByTestId("form-save").textContent()) ?? "";
      await tab.getByTestId("form-save").click();
      await expect(tab.getByTestId("toast")).toBeVisible();
      const toast = (await tab.getByTestId("toast").textContent()) ?? "";
      await expect(tab.getByTestId("tab-jobs")).toBeVisible();
      return { button, toast };
    } finally {
      runner.close();
    }
  }

  /** The attached tabs in the Workspace scope, by id. */
  function attachedTabIds(): Promise<string[]> {
    return page.evaluate((project) => {
      const stores = (window as unknown as { __pomadeStores: { useTabsStore: { getState(): { tabsByProject: Record<string, { id: string; kind: string }[] | undefined> } } } }).__pomadeStores;
      return (stores.useTabsStore.getState().tabsByProject[project] ?? []).filter((tab) => tab.kind === "attached").map((tab) => tab.id);
    }, WORKSPACE_PROJECT_ID);
  }

  /** Pomade's workspace store, as its Projects panel uses it. */
  function store<A extends unknown[]>(call: string, ...args: A): Promise<void> {
    return page.evaluate(
      ([name, given]) => {
        const state = (window as unknown as { __pomadeStores: { useWorkspaceStore: { getState(): Record<string, (...args: unknown[]) => void> } } }).__pomadeStores.useWorkspaceStore.getState();
        state[name]?.(...given);
      },
      [call, args] as const,
    );
  }

  const script = (name: string, command: string, more: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\n${more}low-priority: false\noverlap: parallel\n---\n`;

  test.beforeAll(async () => {
    tmp = await tempDir();
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(join(jobs, "hunt"), { recursive: true });
    await mkdir(join(folders.workspace, "Projects/hunt"), { recursive: true });
    await mkdir(join(tmp, "user"));
    // No warm-up: the hook runs start as soon as the services are up.
    await writeFile(join(folders.workspace, "Apps/pomade-runner/settings.yaml"), "warm-up: 0m\n");
    await writeFile(join(jobs, "init.md"), script("Init", 'echo "init $POMADE_PROJECT $POMADE_PROJECT_PATH"', "hook: { event: project-created }\n"));
    await writeFile(join(jobs, "updates.md"), script("Updates", "echo updates", "hook: { event: pomade-started }\n"));
    await writeFile(join(jobs, "scrape.md"), script("Scrape", 'echo "scrape $POMADE_PROJECT $POMADE_PROJECT_PATH"', `hook: { event: project-first-open, project: ${HUNT} }\n`));
    await writeFile(join(jobs, "hunt/greet.md"), script("Greet", 'echo "greet $POMADE_PROJECT from $PWD"', `project: ${HUNT}\nhook: { event: project-created }\n`).replace("folder: .", "folder: Projects/hunt"));
    await writeFile(join(jobs, "hunt/dash.md"), `---\nkind: service\nname: Dash\nproject: ${HUNT}\nfolder: Projects/hunt\ncommand: "echo dash in $PWD; while :; do sleep 1; done"\nstart: project-first-open\n---\n`);
    await launchPomade();
  });

  test.afterAll(async () => {
    await scheduler?.kill();
    await app?.close();
    await stopKeeper(keeperSocket, pids);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  });

  test("Pomade started runs its job once Pomade is ready; a restarted scheduler, on the same Pomade, runs it no more", async () => {
    const running = await startTheScheduler();
    await expect.poll(() => printed("updates")).toEqual(["updates"]);
    expect((await history("updates"))[0]).toMatchObject({ trigger: "hook", cause: { kind: "hook", event: "pomade-started" } });

    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
    const again = await startTheScheduler();
    await expect.poll(() => again.output()).toContain("Pomade ready: the Pomade started hooks fired for this Pomade start already");
    expect(await printed("updates")).toEqual(["updates"]);
  });

  test("E-007 #1 · creating a project runs its hook with POMADE_PROJECT and POMADE_PROJECT_PATH", async () => {
    await store("addProject", { id: HUNT, name: "Hunt", rootPath: "Projects/hunt", visibleAgents: ["*"], order: 0 });
    const path = join(folders.workspace, "Projects/hunt");
    await expect.poll(() => printed("init")).toEqual([`init ${HUNT} ${path}`]);
    // Hunt's own jobs were not valid before Hunt was there: its creation is not theirs to hear.
    await expect.poll(async () => (await command("check")).code).toBe(0);
    expect((await history("init"))[0]).toMatchObject({ trigger: "hook", cause: { event: "project-created", projectName: "Hunt" } });
    // Created is not opened: the first-open job and service wait.
    expect(await history("scrape")).toEqual([]);
    expect((await services()).find((service) => service.job === "hunt/dash")).toMatchObject({ state: "waiting" });
  });

  test("E-007 #3 · the first open of a project runs its job and starts its service; a second open does neither", async () => {
    await store("setActiveProject", HUNT);
    const path = join(folders.workspace, "Projects/hunt");
    await expect.poll(() => printed("scrape")).toEqual([`scrape ${HUNT} ${path}`]);
    await expect.poll(async () => (await services()).find((service) => service.job === "hunt/dash")?.state, { timeout: 15_000 }).toBe("running");
    const dash = (await services()).find((service) => service.job === "hunt/dash");
    pids.push(dash?.session?.info.pid ?? 0);

    await store("setActiveProject", WORKSPACE_PROJECT_ID);
    await store("setActiveProject", HUNT);
    // Another project's first open comes after any event the second open made, in order.
    await store("addProject", { id: "proj-seen", name: "Seen", rootPath: "Projects/seen", visibleAgents: ["*"], order: 1 });
    await store("setActiveProject", "proj-seen");
    await expect.poll(() => scheduler?.output() ?? "").toContain("project Seen (proj-seen) opened for the first time since Pomade started");
    expect(await printed("scrape")).toHaveLength(1);
    expect((await services()).find((service) => service.job === "hunt/dash")?.session?.info.pid).toBe(dash?.session?.info.pid);
    expect(scheduler?.output().match(/project Hunt \(proj-hunt\) opened for the first time since Pomade started/g)).toHaveLength(1);
    // Seen's creation ran Hunt's Greet in Hunt's folder: done before the next test moves that folder.
    await expect.poll(() => printed("hunt/greet")).toEqual([`greet proj-seen from ${path}`]);
  });

  test("E-007 #6 · after a project is moved, its jobs are still listed — in the renamed sub-folder, in the new folder — and still fire", async () => {
    await store("setActiveProject", WORKSPACE_PROJECT_ID);
    await rename(join(folders.workspace, "Projects/hunt"), join(folders.workspace, "Projects/hunt-2"));
    await store("updateProject", HUNT, { name: "Hunt 2", rootPath: "Projects/hunt-2" });
    const path = join(folders.workspace, "Projects/hunt-2");

    await expect.poll(async () => (await command("list")).stdout).toMatch(/^hunt-2\/dash {2}Dash {2}service {2}from first open of proj-hunt while Pomade is running {2}/);
    const listed = (await command("list")).stdout;
    expect(listed).toMatch(/\nhunt-2\/greet {2}Greet {2}script {2}when a project is created {2}/);
    expect(listed).not.toContain("hunt/");
    expect(await readFile(join(jobs, "hunt-2/greet.md"), "utf8")).toContain("\nfolder: Projects/hunt-2\n");
    // The service ran: it starts again under its new id, in the new folder.
    // (Up once it has run 5 s.)
    await expect.poll(async () => (await services()).find((service) => service.job === "hunt-2/dash"), { timeout: 15_000 }).toMatchObject({ state: "running", session: { info: { cwd: path } } });
    pids.push((await services()).find((service) => service.job === "hunt-2/dash")?.session?.info.pid ?? 0);
    // The history follows the job.
    const before = join(folders.workspace, "Projects/hunt");
    await expect.poll(() => printed("hunt-2/greet")).toEqual([`greet proj-seen from ${before}`]);

    // Still firing: a project created runs the moved job, in its new folder.
    await store("addProject", { id: "proj-other", name: "Other", rootPath: "Projects/other", visibleAgents: ["*"], order: 2 });
    await expect.poll(() => printed("hunt-2/greet")).toHaveLength(2);
    expect((await printed("hunt-2/greet"))[1]).toBe(`greet proj-other from ${path}`);
  });

  test("T-019 · a first-open service made after its project's open starts at once; one of a project not opened yet waits for the open; stopped, it stays stopped through an edit", async () => {
    // Hunt was opened in this Pomade start (E-007 #3), and moved to Projects/hunt-2 since (E-007 #6). Acceptance 1.
    const made = await createFirstOpenService(HUNT, "Board", "Projects/hunt-2");
    expect(made).toEqual({ button: "Create and start", toast: "RunnerCreated Apps/pomade-runner/jobs/hunt-2/board.md · started" });
    await expect.poll(async () => (await service("hunt-2/board"))?.state, { timeout: 15_000 }).toBe("running");
    pids.push((await service("hunt-2/board"))?.session?.info.pid ?? 0);

    // Acceptance 3: stopped, then edited and saved, it stays stopped.
    expect((await command("stop", "hunt-2/board")).code).toBe(0);
    await expect.poll(async () => (await service("hunt-2/board"))?.state).toBe("stopped-by-you");
    const file = join(jobs, "hunt-2/board.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("echo board;", "echo board edited;"));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await service("hunt-2/board"))?.state).toBe("stopped-by-you");

    // Acceptance 2: a project not opened yet — the button promises no start; it waits, and the open starts it.
    await mkdir(join(folders.workspace, "Projects/later"), { recursive: true });
    await store("addProject", { id: "proj-later", name: "Later", rootPath: "Projects/later", visibleAgents: ["*"], order: 3 });
    await expect.poll(() => scheduler?.output() ?? "").toContain("project Later (proj-later) created");
    const waiting = await createFirstOpenService("proj-later", "Feed", "Projects/later");
    expect(waiting).toEqual({ button: "Create job", toast: "RunnerCreated Apps/pomade-runner/jobs/later/feed.md" });
    await expect.poll(async () => (await service("later/feed"))?.state).toBe("waiting");
    await store("setActiveProject", "proj-later");
    await expect.poll(async () => (await service("later/feed"))?.state, { timeout: 15_000 }).toBe("running");
    pids.push((await service("later/feed"))?.session?.info.pid ?? 0);
    await store("setActiveProject", WORKSPACE_PROJECT_ID);
  });

  test("T-019 · a first-open hook made after its project's open fires for no earlier open; a restarted scheduler knows the opens", async () => {
    await writeFile(join(jobs, "late-scrape.md"), script("Late scrape", "echo late", `hook: { event: project-first-open, project: ${HUNT} }\n`));
    await expect.poll(async () => (await command("list")).stdout).toContain("late-scrape  Late scrape");
    await store("setActiveProject", HUNT);
    await store("setActiveProject", WORKSPACE_PROJECT_ID);

    // The scheduler restarted (an update) while the same Pomade runs.
    const running = scheduler;
    running?.child.kill("SIGTERM");
    expect(await running?.exited).toBe(0);
    const again = await startTheScheduler();
    await expect.poll(() => again.output()).toContain("Pomade ready: the Pomade started hooks fired for this Pomade start already");
    // A first-open service of Hunt made now starts; Hunt opened again fires nothing.
    await writeFile(join(jobs, "hunt-2/tail.md"), `---\nkind: service\nname: Tail\nproject: ${HUNT}\nfolder: Projects/hunt-2\ncommand: "echo tail; while :; do sleep 1; done"\nstart: project-first-open\n---\n`);
    await expect.poll(async () => (await service("hunt-2/tail"))?.state, { timeout: 15_000 }).toBe("running");
    pids.push((await service("hunt-2/tail"))?.session?.info.pid ?? 0);
    await store("setActiveProject", HUNT);
    await store("addProject", { id: "proj-next", name: "Next", rootPath: "Projects/next", visibleAgents: ["*"], order: 4 });
    await store("setActiveProject", "proj-next");
    await expect.poll(() => again.output()).toContain("project Next (proj-next) opened for the first time since Pomade started");
    expect(again.output()).not.toContain("project Hunt (proj-hunt) opened for the first time since Pomade started");
    expect(await history("late-scrape")).toEqual([]);
    expect(await printed("scrape")).toHaveLength(1);
    await store("setActiveProject", WORKSPACE_PROJECT_ID);
  });

  test("T-020 · a service's Jobs row: Start service starts it, Stop service stops it, Open terminal shows its last output; a service that never ran has no Open terminal", async () => {
    const tab = page.locator(`[data-testid="app-frame-${manifest.id}"]:visible`).contentFrame();
    const runner = await connectAsRunner();
    try {
      await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
      const row = (job: string) => tab.locator(`[data-testid="job-row"][data-job="${job}"]`);
      const labels = (job: string) => row(job).getByRole("button").evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")));
      // Board was stopped by you (T-019 above): its last output is in the keeper.
      await expect(row("hunt-2/board").getByTestId("job-status")).toHaveText("stopped by you");
      expect(await labels("hunt-2/board")).toEqual(["Open terminal", "Start service", "Edit", "Delete"]);
      await row("hunt-2/board").getByRole("button", { name: "Start service" }).click();
      await expect(tab.getByTestId("toast").last()).toHaveText("RunnerBoard started");
      await expect(row("hunt-2/board").getByTestId("job-status")).toHaveText(/^(starting|running · up )/);
      pids.push((await service("hunt-2/board"))?.session?.info.pid ?? 0);
      await expect.poll(() => labels("hunt-2/board")).toEqual(["Open terminal", "Stop service", "Edit", "Delete"]);
      await row("hunt-2/board").getByRole("button", { name: "Stop service" }).click();
      await expect(row("hunt-2/board").getByTestId("job-status")).toHaveText("stopped by you");
      await expect.poll(async () => (await service("hunt-2/board"))?.state).toBe("stopped-by-you");
      await expect.poll(() => labels("hunt-2/board")).toEqual(["Open terminal", "Start service", "Edit", "Delete"]);

      // Its terminal opens on its last output, with Start in the header.
      await row("hunt-2/board").getByRole("button", { name: "Open terminal" }).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(1);
      const [id = ""] = await attachedTabIds();
      await expect(page.getByTestId(`attached-status-${id}`)).toHaveText("Stopped by you");
      await expect(page.getByTestId(`attached-${id}`).getByTestId("attached-action-start")).toBeVisible();
      await page.getByTestId(`close-${id}`).click();
      await expect.poll(() => attachedTabIds()).toHaveLength(0);

      // A service that never ran — Other is not opened — has Start service and no terminal; Start runs it.
      await mkdir(join(folders.workspace, "Projects/other"), { recursive: true });
      await mkdir(join(jobs, "other"), { recursive: true });
      await writeFile(join(jobs, "other/site.md"), `---\nkind: service\nname: Site\nproject: proj-other\nfolder: Projects/other\ncommand: "echo site; while :; do sleep 1; done"\nstart: project-first-open\n---\n`);
      await runner.tabs.openApp({ route: "", projectId: WORKSPACE_PROJECT_ID });
      await expect(row("other/site").getByTestId("job-status")).toHaveText("waiting for first open");
      expect(await labels("other/site")).toEqual(["Start service", "Edit", "Delete"]);
      await row("other/site").getByRole("button", { name: "Start service" }).click();
      await expect.poll(async () => (await service("other/site"))?.state, { timeout: 15_000 }).toBe("running");
      pids.push((await service("other/site"))?.session?.info.pid ?? 0);
      await expect.poll(() => labels("other/site")).toEqual(["Open terminal", "Stop service", "Edit", "Delete"]);
    } finally {
      runner.close();
    }
  });

  test("E-007 #2 · T-021 #1 · restarting Pomade runs the Pomade started job once more, after its tabs are restored; a first-open service stops with Pomade and starts on the next first open", async () => {
    const running = scheduler;
    const dash = (await service("hunt-2/dash"))?.session?.info.pid ?? 0;
    expect(alive(dash)).toBe(true);
    await app?.close();
    app = null;
    await expect.poll(() => running?.output() ?? "").toContain("Pomade went away; reconnecting");
    // Pomade quit: within the grace, its first-open service ends and waits for Pomade.
    await expect.poll(() => alive(dash), { timeout: QUIT_GRACE_MS + 8000 }).toBe(false);
    expect(running?.output()).toContain("Pomade is not running: the services that run with it stop");
    await expect.poll(async () => (await service("hunt-2/dash"))?.state).toBe("waiting-for-pomade");
    await launchPomade();
    await expect.poll(() => printed("updates")).toEqual(["updates", "updates"]);
    await expect.poll(async () => (await service("hunt-2/dash"))?.state).toBe("waiting");
    // A new Pomade start: the moved project's first open fires its job again and starts its service.
    await store("setActiveProject", HUNT);
    await expect.poll(() => printed("scrape")).toHaveLength(2);
    expect((await printed("scrape"))[1]).toBe(`scrape ${HUNT} ${join(folders.workspace, "Projects/hunt-2")}`);
    await expect.poll(async () => (await service("hunt-2/dash"))?.state, { timeout: 15_000 }).toBe("running");
    const again = (await service("hunt-2/dash"))?.session?.info.pid ?? 0;
    expect(again).not.toBe(dash);
    pids.push(again);
    // Once per Pomade start, still. The late hook fires on this start's first open.
    expect(await printed("updates")).toHaveLength(2);
    await expect.poll(() => printed("late-scrape")).toEqual(["late"]);
    // T-019 acceptance 4: a first-open service of a project opened in the last Pomade start, made now, waits for its open again.
    await writeFile(join(jobs, "later/news.md"), `---\nkind: service\nname: News\nproject: proj-later\nfolder: Projects/later\ncommand: "echo news; while :; do sleep 1; done"\nstart: project-first-open\n---\n`);
    await expect.poll(async () => (await service("later/news"))?.state).toBe("waiting");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await service("later/news"))?.state).toBe("waiting");
  });
});
