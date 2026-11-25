// Pomade opened for an agent run (E-004 acceptance 1, T-017), on the injected clock in Madrid's
// time zone. With a real Pomade — the Pomade checkout's built app (`POMADE_REPO`) in test mode on a
// temp workspace, user data and home, with the built `dist/` and the fixture Agents app dev-linked,
// the scripted fake agent CLI as the roster's Claude — started once so it records how to launch it
// (`host.json`) and then closed: at a weekday 7:00 the scheduler opens Pomade through that record,
// a script due with it runs meanwhile, a second agent run due with it waits for the same launch,
// and once Pomade and the Agents app are up both agent runs start, in their order, and
// Runner's panel in that Pomade shows them running, the job in Next up. The test reaches the Pomade
// the scheduler opened over the DevTools protocol (a port added to the recorded launch) and closes
// it at the end. With no Pomade recorded at all (`support/runner.ts`), the run fails with why and
// its notice waits in Pomade's queue. `RUNNER_SHOTS=<dir>` saves a screenshot of the panel.

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { _electron as electron, chromium, expect, test, type Browser, type Page } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { STRIP_ICON } from "../src/app";
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { AGENTS_APP, fakeAgents } from "./support/agents";
import { DIST, cleanEnv, removeDir, tempDir } from "./support/env";
import { drawn } from "./support/frames";
import { expectNothingLeft, stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { createRunnerWorld } from "./support/runner";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const SHOTS = process.env.RUNNER_SHOTS;
const STRIP_KEY = `app-${manifest.id}-${STRIP_ICON}`;
const ZONE = { TZ: "Europe/Madrid" };

/** A scheduler clock that starts at `local` (Madrid). */
const clock = (local: string): Record<string, string> => ({ ...ZONE, POMADE_RUNNER_CLOCK: `${local}+01:00` });

/** The weekday 7:00 morning summary. */
const summaryJob = (prompt: string, folder = "Projects/notes"): string =>
  `---\nkind: agent\nname: Morning summary\nfolder: ${folder}\nagent: claude\nschedule:\n  daily: { at: 7:00 }\n  only: weekdays\n---\n${prompt}\n`;

/** A port nothing listens on now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Pomade's window, over a DevTools connection to it. */
async function pomadeWindow(browser: Browser): Promise<Page> {
  const find = (): Page | undefined => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().endsWith("/index.html"));
  await expect.poll(() => find() !== undefined).toBe(true);
  const page = find();
  if (page === undefined) throw new Error("no Pomade window");
  return page;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.describe("Pomade opened for an agent run", () => {
  test.describe.configure({ mode: "serial" });

  const pomade = pomadeCheckout();
  let tmp: string;
  let user: string;
  let folders: PomadeFolders;
  let scheduler: SchedulerProcess | null = null;
  let keeperSocket: string;
  /** The Pomade the scheduler opened: its process, and the DevTools connection to it. */
  let opened: { pid: number; browser: Browser | null } | null = null;
  const socket = (): string => join(folders.userData, "app-state", manifest.id, "scheduler.sock");

  test.beforeAll(async () => {
    tmp = await tempDir();
    user = join(tmp, "user");
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    await mkdir(join(folders.workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await mkdir(join(folders.workspace, "Projects/notes"), { recursive: true });
    await fakeAgents(user, join(tmp, "bin"));
    // Pomade started once — it records how to launch it, the app keys and the command folder — then closed.
    const first = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: `${DIST};${AGENTS_APP}`, HOME: user }) });
    const page = await first.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect.poll(() => readFile(join(folders.home, "host.json"), "utf8").catch(() => "")).toContain('"launch"');
    await first.close();
  });

  test.afterAll(async () => {
    await scheduler?.kill();
    await closeOpened();
    await stopKeeper(keeperSocket);
    await expectNothingLeft(tmp);
    await removeDir(tmp);
  });

  /** Close the Pomade the scheduler opened, and wait until it is gone. */
  async function closeOpened(): Promise<void> {
    if (opened === null) return;
    const { pid, browser } = opened;
    opened = null;
    await browser?.close().catch(() => undefined);
    if (alive(pid)) process.kill(pid, "SIGTERM");
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
  }

  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(socket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  test("E-004 1 · at a weekday 7:00 with Pomade closed, Runner opens Pomade, the runs that came due meanwhile wait for that one launch and start in their order, and the panel shows them running", async () => {
    const jobs = join(folders.workspace, "Apps/pomade-runner/jobs");
    await writeFile(join(jobs, "summary.md"), summaryJob("Write my morning summary. [long]"));
    await writeFile(join(jobs, "inbox.md"), summaryJob("Tidy the drafts. [long]").replace("name: Morning summary", "name: Tidy drafts"));
    await writeFile(join(jobs, "backup.md"), "---\nkind: script\nname: Backup\nfolder: .\ncommand: echo backed up\nschedule:\n  daily: { at: 7:00 }\n---\n");
    // The recorded launch, with a DevTools port: the test reaches the Pomade the scheduler opens.
    const hostFile = join(folders.home, "host.json");
    const host = JSON.parse(await readFile(hostFile, "utf8")) as { socket: string; launch: { argv: string[]; env: Record<string, string> } };
    expect(host.launch.argv).toEqual([pomade.runtime, pomade.main]);
    const port = await freePort();
    await writeFile(hostFile, JSON.stringify({ ...host, launch: { ...host.launch, argv: [pomade.runtime, `--remote-debugging-port=${port}`, pomade.main] } }));

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
        HOME: user,
        SHELL: "/bin/sh",
        // A Monday, three seconds before 7:00.
        ...clock("2026-11-23T06:59:57"),
      }),
    );
    scheduler = started;
    const output = (): string => started.output();
    await expect.poll(output, { timeout: 15_000 }).toMatch(/Pomade: opened \(pid \d+\); waiting until it is ready\n/);
    const pid = Number(/Pomade: opened \(pid (\d+)\)/.exec(output())?.[1]);
    opened = { pid, browser: null };
    await expect.poll(output, { timeout: 90_000 }).toContain("Pomade: up for agent runs\n");
    await expect.poll(output, { timeout: 15_000 }).toMatch(/run inbox \S+: started \(scheduled\)\n[\s\S]*run summary \S+: started \(scheduled\)\n|run summary \S+: started \(scheduled\)\n[\s\S]*run inbox \S+: started \(scheduled\)\n/);
    // Both agent runs due at 7:00 waited for the one launch, Pomade closed; the script due with them
    // ran without waiting; once Pomade was up, the agent runs started in the order they queued.
    const at = (pattern: RegExp): number => output().search(pattern);
    expect(output().match(/Pomade: opening it for an agent run/g)).toHaveLength(1);
    const queued = [...output().matchAll(/run (summary|inbox) \S+: queued · opening Pomade\n/g)].map((match) => match[1]);
    expect([...queued].sort()).toEqual(["inbox", "summary"]);
    expect(at(/Pomade: opening it/)).toBeLessThan(at(/connected to Pomade/));
    expect(at(/run backup \S+: started \(scheduled\)/)).toBeGreaterThan(-1);
    expect(at(/run backup \S+: started \(scheduled\)/)).toBeLessThan(at(/Pomade: up for agent runs/));
    expect([...output().matchAll(/run (summary|inbox) \S+: started \(scheduled\)\n/g)].map((match) => match[1])).toEqual(queued);
    // No agent run starts before Runner is connected to the Pomade it opened. ("up for agent runs" is
    // logged when the opening resolves; another pass of the queue can see Pomade up and start a run
    // before that line, so it is no marker of order.)
    expect(at(/connected to Pomade/)).toBeLessThan(at(new RegExp(`run ${queued[0] ?? ""} \\S+: started`)));

    // The panel of the Pomade the scheduler opened shows them running, and the job's next run.
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    opened = { pid, browser };
    const page = await pomadeWindow(browser);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    await expect(page.getByTestId(`panel-frame-${STRIP_KEY}`)).toBeVisible();
    await drawn(page);
    const panel = page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);
    await expect(panel.getByTestId("active-run").filter({ hasText: "Morning summary" })).toContainText("running");
    await expect(panel.getByTestId("active-run").filter({ hasText: "Tidy drafts" })).toContainText("running");
    await expect(panel.getByTestId("next-up-item").filter({ hasText: "Morning summary" })).toBeVisible();
    await page.mouse.move(900, 600);
    await shoot(page, "pomade-opened-panel");

    // Both turns end, and the runs are done in the job's folder.
    await expect.poll(async () => [...(await history("summary")), ...(await history("inbox"))].map((record) => record.state), { timeout: 40_000 }).toEqual(["done", "done"]);
    const [summary] = await history("summary");
    const [inbox] = await history("inbox");
    for (const record of [summary, inbox]) expect(record).toMatchObject({ trigger: "scheduled", dueAt: Date.parse("2026-11-23T07:00:00+01:00"), agent: { agent: "claude", cwd: await realpath(join(folders.workspace, "Projects/notes")) } });
    expect(await history("backup")).toMatchObject([{ state: "done" }]);
    await closeOpened();
  });
});

test.describe("no Pomade to open", () => {
  test("an agent run due with no Pomade recorded fails with why, and its notice waits for Pomade's next start", async () => {
    const world = await createRunnerWorld();
    try {
      await world.writeJob("summary.md", summaryJob("Write my morning summary.", "."));
      const scheduler = world.startScheduler(clock("2026-11-23T06:59:58"));
      await world.ready(scheduler);
      await expect.poll(() => world.history("summary"), { timeout: 10_000 }).toHaveLength(1);
      const reason = "cannot start — Pomade could not be opened: this Pomade recorded no way to launch it (no host.json)";
      const [record] = await world.history("summary");
      expect(record).toMatchObject({ kind: "agent", trigger: "scheduled", state: "failed", reason, startedAt: null });
      await expect.poll(() => world.queuedNotices()).toMatchObject([{ source: "pomade-runner", title: "Morning summary failed", action: { kind: "openApp", route: `run/summary/${record?.run ?? ""}` } }]);
      expect((await world.queuedNotices())[0]?.body).toContain(reason.replace("cannot start — ", ""));
      expect(scheduler.output()).toContain("Pomade: opening it for an agent run\n");
      expect(scheduler.output()).toContain('notice "Morning summary failed": queued for Pomade\'s next launch\n');
    } finally {
      await world.dispose();
    }
  });
});
