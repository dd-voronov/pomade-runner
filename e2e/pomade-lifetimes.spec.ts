// Service lifetimes in a real Pomade (T-021 acceptance 2–6): the Pomade checkout's built app
// (`POMADE_REPO`) in test mode on a temp workspace, user data and home, with the built `dist/`
// dev-linked; the scheduler started the way the login item starts it, with a short quit grace
// (`QUIT_GRACE_MS`). Services that run with Pomade — `pomade-started`, `project-first-open` — stop
// when it quits and start fresh with the next Pomade start, Stop forgotten; a `login` service runs
// on, and stays stopped after Stop; Start is refused while Pomade is closed; Enabled off and on
// lets go of Stop; a project opened fires its hook every time; a scheduler killed while Pomade runs
// stops nothing, one started while Pomade is closed stops what was left running. Each test makes
// its own jobs and begins on a fresh Pomade start, so each fails or passes on its own.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";

import manifest from "../app/manifest.json" with { type: "json" };
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import type { ServicesReport } from "../src/keeper/model";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { alive, expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const ALPHA = "proj-alpha";
const BETA = "proj-beta";
/** The scheduler's quit grace in these tests. */
const QUIT_GRACE_MS = 2000;
/** Services start one at a time, each up after 5 s. */
const UP_MS = 30_000;

test.describe("service lifetimes in Pomade", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

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
  const command = (...args: string[]) => run(join(folders.home, "bin", "pomade-runner"), args, { env: cleanEnv(), cwd: tmp });
  const loop = (name: string): string => `"echo ${name}; while :; do sleep 1; done"`;
  const service = (name: string, more = ""): string => `---\nkind: service\nname: ${name}\nfolder: .\ncommand: ${loop(name.toLowerCase())}\n${more}---\n`;

  async function launchPomade(): Promise<void> {
    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: DIST }) });
    page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
  }

  async function quitPomade(): Promise<void> {
    await app?.close();
    app = null;
  }

  /** The scheduler, started the way the login item starts it; it connects when Pomade runs. */
  async function startTheScheduler(connects = true): Promise<SchedulerProcess> {
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
    if (connects) await expect.poll(() => started.output()).toContain("connected to Pomade");
    return started;
  }

  /** A fresh Pomade start, in the Workspace: nothing opened yet; the scheduler running. */
  async function freshPomadeStart(): Promise<void> {
    if (app !== null) {
      const ready = (scheduler?.output().match(/Pomade started/g) ?? []).length;
      // Pomade starts again on the project in front at its quit: the Workspace, so nothing is opened.
      await store("setActiveProject", WORKSPACE_PROJECT_ID);
      await quitPomade();
      await launchPomade();
      await expect.poll(() => (scheduler?.output().match(/Pomade started/g) ?? []).length, { timeout: 15_000 }).toBeGreaterThan(ready);
    } else {
      await launchPomade();
      if (scheduler === null || scheduler.child.exitCode !== null || scheduler.child.signalCode !== null) await startTheScheduler();
    }
    await store("setActiveProject", WORKSPACE_PROJECT_ID);
  }

  async function services(): Promise<ServicesReport["services"]> {
    const result = await callScheduler(schedulerSocket(), "services", null);
    return result.status === "ok" ? result.value.services : [];
  }
  const state = async (job: string): Promise<string | undefined> => (await services()).find((one) => one.job === job)?.state;
  const pid = async (job: string): Promise<number> => (await services()).find((one) => one.job === job)?.session?.info.pid ?? 0;
  /** Waits until `job` is running; its pid, kept for the teardown's check. */
  async function up(job: string): Promise<number> {
    await expect.poll(() => state(job), { timeout: UP_MS }).toBe("running");
    const found = await pid(job);
    pids.push(found);
    return found;
  }

  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(schedulerSocket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
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

  /** Write the tests' job files; removed at the test's end, which stops their services. */
  const made: string[] = [];
  async function job(file: string, text: string): Promise<void> {
    made.push(file);
    await writeFile(join(jobs, file), text);
  }

  test.beforeAll(async () => {
    tmp = await tempDir();
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await mkdir(jobs, { recursive: true });
    await mkdir(join(tmp, "user"));
    for (const name of ["alpha", "beta"]) await mkdir(join(folders.workspace, "Projects", name), { recursive: true });
    await writeFile(join(folders.workspace, "Apps/pomade-runner/settings.yaml"), "warm-up: 0m\n");
    await launchPomade();
    await store("addProject", { id: ALPHA, name: "Alpha", rootPath: "Projects/alpha", visibleAgents: ["*"], order: 0 });
    await store("addProject", { id: BETA, name: "Beta", rootPath: "Projects/beta", visibleAgents: ["*"], order: 1 });
    await store("setActiveProject", WORKSPACE_PROJECT_ID);
    await startTheScheduler();
  });

  test.beforeEach(async () => {
    await freshPomadeStart();
  });

  test.afterEach(async () => {
    for (const file of made.splice(0)) await rm(join(jobs, file), { force: true });
    await expect.poll(async () => (await services()).filter((one) => one.session?.info.state === "running"), { timeout: 15_000 }).toEqual([]);
  });

  test.afterAll(async () => {
    await scheduler?.kill();
    await quitPomade();
    await stopKeeper(keeperSocket, pids);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  });

  test("T-021 #3 · a pomade-started service starts with Pomade, stops when it quits, is refused a Start while Pomade is closed, and starts with the next Pomade start", async () => {
    await job("watch.md", service("Watch", "start: pomade-started\n"));
    const watch = await up("watch");
    expect((await command("list")).stdout).toMatch(/^watch {2}Watch {2}service {2}while Pomade is running {2}/m);
    await quitPomade();
    await expect.poll(() => alive(watch), { timeout: QUIT_GRACE_MS + 8000 }).toBe(false);
    await expect.poll(() => state("watch")).toBe("waiting-for-pomade");
    const refused = await command("run", "watch");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('"Watch" starts with Pomade; Pomade is not running');
    await launchPomade();
    expect(await up("watch")).not.toBe(watch);
  });

  test("T-021 #2 · a first-open service stopped by you starts on its project's open after Pomade quit and started", async () => {
    await job("alpha-web.md", service("Alpha web", `start: project-first-open\nstart-project: ${ALPHA}\n`));
    await store("setActiveProject", ALPHA);
    await up("alpha-web");
    expect((await command("stop", "alpha-web")).code).toBe(0);
    await expect.poll(() => state("alpha-web")).toBe("stopped-by-you");
    await freshPomadeStart();
    await expect.poll(() => state("alpha-web")).toBe("waiting");
    await store("setActiveProject", ALPHA);
    await up("alpha-web");
  });

  test("T-021 #4 · a login service is untouched by a Pomade quit, and stays stopped after Stop over a Pomade restart", async () => {
    await job("api.md", service("Api"));
    await job("db.md", service("Db"));
    const api = await up("api");
    await up("db");
    expect((await command("stop", "db")).code).toBe(0);
    await expect.poll(() => state("db")).toBe("stopped-by-you");
    await quitPomade();
    await new Promise((resolve) => setTimeout(resolve, QUIT_GRACE_MS + 3000));
    expect(scheduler?.output()).toContain("Pomade is not running: the services that run with it stop");
    expect([alive(api), await state("api"), await state("db")]).toEqual([true, "running", "stopped-by-you"]);
    await launchPomade();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect([await pid("api"), await state("db")]).toEqual([api, "stopped-by-you"]);
  });

  test("T-021 #5 · a first-open service stopped by you, Enabled off then on: it starts when its project was opened since Pomade started, else it waits and starts on the open", async () => {
    await job("alpha-web.md", service("Alpha web", `start: project-first-open\nstart-project: ${ALPHA}\n`));
    await job("beta-web.md", service("Beta web", `start: project-first-open\nstart-project: ${BETA}\n`));
    await store("setActiveProject", ALPHA);
    await store("setActiveProject", WORKSPACE_PROJECT_ID);
    await up("alpha-web");
    expect((await command("run", "beta-web")).code).toBe(0);
    await up("beta-web");
    for (const one of ["alpha-web", "beta-web"]) expect((await command("stop", one)).code).toBe(0);
    await expect.poll(async () => [await state("alpha-web"), await state("beta-web")]).toEqual(["stopped-by-you", "stopped-by-you"]);
    // Enabling a service whose session has not yet been seen to end reads as running: wait until it has.
    await expect.poll(async () => (await services()).filter((one) => one.session?.info.state === "running").length).toBe(0);
    for (const one of ["alpha-web", "beta-web"]) expect((await command("disable", one)).code).toBe(0);
    await expect.poll(async () => [await state("alpha-web"), await state("beta-web")]).toEqual(["disabled", "disabled"]);
    for (const one of ["alpha-web", "beta-web"]) expect((await command("enable", one)).code).toBe(0);
    await up("alpha-web");
    expect(await state("beta-web")).toBe("waiting");
    await store("setActiveProject", BETA);
    await up("beta-web");
  });

  test("T-021 · a project opened fires every time its project comes to the front; the first open once per Pomade start", async () => {
    await job("every-alpha.md", `---\nkind: script\nname: Every alpha\nfolder: .\ncommand: echo every\nhook: { event: project-opened, project: ${ALPHA} }\nlow-priority: false\n---\n`);
    await job("first-alpha.md", `---\nkind: script\nname: First alpha\nfolder: .\ncommand: echo first\nhook: { event: project-first-open, project: ${ALPHA} }\nlow-priority: false\n---\n`);
    await expect.poll(async () => (await command("list")).stdout).toContain("every-alpha  Every alpha  script  whenever proj-alpha is opened");
    for (const project of [ALPHA, WORKSPACE_PROJECT_ID, ALPHA, BETA, ALPHA]) await store("setActiveProject", project);
    await expect.poll(async () => (await history("every-alpha")).length).toBe(3);
    expect((await history("every-alpha"))[0]).toMatchObject({ cause: { kind: "hook", event: "project-opened", projectName: "Alpha" } });
    expect(await history("first-alpha")).toHaveLength(1);
  });

  test("T-021 #6 · a scheduler killed while Pomade runs comes back and stops nothing", async () => {
    await job("watch.md", service("Watch", "start: pomade-started\n"));
    await job("alpha-web.md", service("Alpha web", `start: project-first-open\nstart-project: ${ALPHA}\n`));
    await store("setActiveProject", ALPHA);
    const watch = await up("watch");
    const web = await up("alpha-web");
    await scheduler?.kill();
    const back = await startTheScheduler();
    await expect.poll(() => back.output()).toContain("Pomade ready: the Pomade started hooks fired for this Pomade start already");
    await new Promise((resolve) => setTimeout(resolve, QUIT_GRACE_MS + 2000));
    expect([await pid("watch"), await pid("alpha-web"), await state("watch"), await state("alpha-web")]).toEqual([watch, web, "running", "running"]);
    expect(back.output()).not.toContain("stopping it");
  });

  test("T-021 #6 · a scheduler started while Pomade is closed stops a service that runs with Pomade, left running", async () => {
    await job("watch.md", service("Watch", "start: pomade-started\n"));
    const watch = await up("watch");
    // Killed, the scheduler does not see Pomade quit.
    await scheduler?.kill();
    await quitPomade();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(alive(watch)).toBe(true);
    const closed = await startTheScheduler(false);
    await expect.poll(() => alive(watch), { timeout: QUIT_GRACE_MS + 10_000 }).toBe(false);
    expect(closed.output()).toContain("Pomade is not running: the services that run with it stop");
    await expect.poll(() => state("watch")).toBe("waiting-for-pomade");
  });
});
