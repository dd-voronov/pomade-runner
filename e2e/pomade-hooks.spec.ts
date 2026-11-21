// Pomade's hooks in a real Pomade (E-007 acceptance 1, 2, 3, 6; T-013): the Pomade checkout's built
// app (`POMADE_REPO`) in test mode on a temp workspace, user data and home, with the built `dist/`
// dev-linked; the scheduler started the way the login item starts it (see `pomade.spec.ts`). A
// project created runs its hook with the project in the environment; Pomade started fires once per
// Pomade start — a restart of Pomade fires it again, a restart of the scheduler does not; the first
// open of a project runs its job and starts its service, a second open does nothing; a project
// moved keeps its jobs listed and firing, its sub-folder and folders following it. Projects are
// made, opened and moved through Pomade's workspace store, as its Projects panel does.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import type { ServicesReport } from "../src/keeper/model";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const HUNT = "proj-hunt";

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
  });

  test("E-007 #6 · after a project is moved, its jobs are still listed — in the renamed sub-folder, in the new folder — and still fire", async () => {
    await store("setActiveProject", WORKSPACE_PROJECT_ID);
    await rename(join(folders.workspace, "Projects/hunt"), join(folders.workspace, "Projects/hunt-2"));
    await store("updateProject", HUNT, { name: "Hunt 2", rootPath: "Projects/hunt-2" });
    const path = join(folders.workspace, "Projects/hunt-2");

    await expect.poll(async () => (await command("list")).stdout).toMatch(/^hunt-2\/dash {2}Dash {2}service {2}always on · starts on first open of proj-hunt {2}/);
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

  test("E-007 #2 · restarting Pomade runs the Pomade started job once more, after its tabs are restored; the next first open fires again", async () => {
    const running = scheduler;
    await app?.close();
    app = null;
    await expect.poll(() => running?.output() ?? "").toContain("Pomade went away; reconnecting");
    await launchPomade();
    await expect.poll(() => printed("updates")).toEqual(["updates", "updates"]);
    // A new Pomade start: the moved project's first open fires its job again; its service still runs.
    const dash = (await services()).find((service) => service.job === "hunt-2/dash");
    await store("setActiveProject", HUNT);
    await expect.poll(() => printed("scrape")).toHaveLength(2);
    expect((await printed("scrape"))[1]).toBe(`scrape ${HUNT} ${join(folders.workspace, "Projects/hunt-2")}`);
    expect((await services()).find((service) => service.job === "hunt-2/dash")?.session?.info.pid).toBe(dash?.session?.info.pid);
    // Once per Pomade start, still.
    expect(await printed("updates")).toHaveLength(2);
  });
});
