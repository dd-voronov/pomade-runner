// A missed run that waits for you, in a real Pomade: the Pomade checkout's built app
// (`POMADE_REPO`) in test mode on a temp workspace, user data and home, with the built `dist/`
// dev-linked, and the scheduler started the way the login item starts it, on a clock set through
// POMADE_RUNNER_CLOCK. The missed runs come the way Runner meets them after the Mac was off: the
// scheduler is stopped and started again later on its clock. They come while Runner is paused, so
// they reach Pomade once the switch is set back — after the scheduler connected, so the notices
// go to the running Pomade.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";

import manifest from "../app/manifest.json" with { type: "json" };
import { STRIP_ICON } from "../src/app";
import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { DIST, cleanEnv, removeDir, run, tempDir } from "./support/env";
import { stopKeeper } from "./support/keeper";
import { pomadeCheckout, pomadeEnv, type PomadeFolders } from "./support/pomade";
import { startSchedulerProcess, type SchedulerProcess } from "./support/scheduler";

const STRIP_KEY = `app-${manifest.id}-${STRIP_ICON}`;
const SHOTS = process.env.RUNNER_SHOTS;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** A local time on Madrid's clock, as epoch ms. */
const madrid = (local: string): number => Date.parse(`${local}+01:00`);

test.describe("missed runs in Pomade", () => {
  test.describe.configure({ mode: "serial" });

  const pomade = pomadeCheckout();
  let tmp: string;
  let folders: PomadeFolders;
  let app: ElectronApplication | null = null;
  let page: Page;
  const schedulers: SchedulerProcess[] = [];
  let keeperSocket: string;
  const socket = (): string => join(folders.userData, "app-state", manifest.id, "scheduler.sock");

  test.beforeAll(async () => {
    tmp = await tempDir();
    folders = { workspace: join(tmp, "ws"), userData: join(tmp, "ud"), home: join(tmp, "home") };
    keeperSocket = join(folders.userData, "run", "keepers", `${manifest.id}.sock`);
    await mkdir(join(folders.workspace, "Apps/pomade-runner/jobs"), { recursive: true });
    await mkdir(join(tmp, "user"));
    app = await electron.launch({ executablePath: pomade.runtime, args: [pomade.main], env: pomadeEnv(folders, { POMADE_DEV_APPS: DIST }) });
    page = await app.firstWindow();
    await page.waitForURL("**/index.html");
    await expect(page.getByTestId("app-shell")).toBeVisible();
  });

  test.afterAll(async () => {
    for (const scheduler of schedulers.splice(0)) await scheduler.kill();
    await app?.close();
    await stopKeeper(keeperSocket);
    await removeDir(tmp);
  });

  /** The scheduler, started the way the login item starts it, on a clock at `local` (Madrid)
   *  running 30 times as fast. */
  async function startTheScheduler(local: string): Promise<SchedulerProcess> {
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
        POMADE_RUNNER_CLOCK: `${local}+01:00`,
        POMADE_RUNNER_CLOCK_RATE: "30",
        TZ: "Europe/Madrid",
        HOME: join(tmp, "user"),
        SHELL: "/bin/sh",
      }),
    );
    schedulers.push(started);
    await expect.poll(() => started.output()).toMatch(/keeper: connected/);
    return started;
  }

  async function schedulerTime(): Promise<number> {
    const status = await callScheduler(socket(), "status", null);
    return status.status === "ok" && status.value.lastTickAt !== null ? Date.parse(status.value.lastTickAt) : 0;
  }

  async function history(job: string): Promise<RunRecord[]> {
    const result = await callScheduler(socket(), "history", { job, limit: 50 });
    return result.status === "ok" ? result.value.records : [];
  }

  function command(...args: string[]) {
    return run(join(folders.home, "bin", "pomade-runner"), args, { env: cleanEnv(), cwd: tmp });
  }

  /** The scheduler again, on a clock at `local`, after the ones before it stopped. */
  async function restartTheScheduler(local: string): Promise<SchedulerProcess> {
    for (const before of schedulers.splice(0)) await before.kill();
    const started = await startTheScheduler(local);
    await expect.poll(() => started.output()).toContain("connected to Pomade");
    return started;
  }

  /** Click `target` while it is there — and, given `unless`, while that is not visible: a click
   *  that may be retried, made once it took. */
  async function clickIfThere(target: Locator, unless?: Locator): Promise<void> {
    if (unless !== undefined && (await unless.isVisible())) return;
    if ((await target.count()) > 0) await target.click();
  }

  /** Each of Next up's rows (`rows`, the panel's): its job's name — Low or High — and " held" when
   *  it carries the held tag. */
  async function tagged(rows: Locator): Promise<string[]> {
    return rows.evaluateAll((all) => all.map((row) => `${row.textContent.includes("Low") ? "Low" : "High"}${row.querySelector('[data-testid="next-up-held"]') === null ? "" : " held"}`));
  }

  /** Runner's notices in Pomade's Notices panel, newest first. */
  async function runnerNotices(): Promise<string[]> {
    if (!(await page.getByTestId("notices-panel").isVisible())) await page.getByTestId("strip-notices").click();
    return page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"] [data-testid="notice-row-title"]').allTextContents();
  }

  test("3 · wait for me: a card and a notice; Run now runs it now, Run at… 23:00 at 23:00; Skip clears it", async () => {
    const job = (name: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: "echo ${name.toLowerCase()} $POMADE_TRIGGER"\nschedule:\n  daily: { at: 22:00 }\nmissed: wait-for-me\n---\n`;
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/nightly.md"), job("Nightly"));
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/tidy.md"), job("Tidy"));
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/early.md"), job("Early"));

    // Alive at 21:00, paused; then off until 22:50.
    const before = await startTheScheduler("2026-11-18T21:00:00");
    expect(await callScheduler(socket(), "switch", { position: "pause-all" })).toMatchObject({ status: "ok" });
    await expect.poll(() => schedulerTime()).toBeGreaterThan(madrid("2026-11-18T21:01:00"));
    await before.kill();
    const scheduler = await startTheScheduler("2026-11-18T22:50:00");
    await expect.poll(() => scheduler.output()).toContain("connected to Pomade");
    expect(await callScheduler(socket(), "switch", { position: "running" })).toMatchObject({ status: "ok", value: { position: "running" } });

    await expect.poll(async () => (await runnerNotices()).sort()).toEqual(["Early · missed Wed 22:00", "Nightly · missed Wed 22:00", "Tidy · missed Wed 22:00"]);
    const badge = page.getByTestId(`strip-badge-${STRIP_KEY}`);
    await expect(badge).toHaveText("3");

    await page.getByTestId(`strip-${STRIP_KEY}`).click();
    const panel = page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`);
    const item = (name: string) => panel.locator('[data-testid="needs-you-item"][data-kind="missed"]', { hasText: name });
    await expect(item("Nightly").getByTestId("needs-you-words")).toHaveText("Missed — it waits for you to pick a time.");
    await shoot(page, "pomade-missed");
    // The panel was just shown: click until it takes. Run now is idempotent here — once the run
    // took the item's place, the card is gone and there is nothing to click again.
    await expect(async () => {
      await clickIfThere(item("Early").getByRole("button", { name: "Run now" }));
      await expect(item("Early")).toHaveCount(0, { timeout: 1500 });
    }).toPass({ intervals: [500, 1000] });
    await expect.poll(() => history("early"), { timeout: 15_000 }).toEqual([expect.objectContaining({ trigger: "manual", state: "done", lastLines: ["early manual"] }) as RunRecord]);
    await item("Nightly").getByRole("button", { name: "Run at…" }).click();
    await item("Nightly").getByRole("textbox", { name: "Run at" }).fill("23:00");
    await item("Nightly").getByRole("button", { name: "Set" }).click();
    await expect(item("Nightly")).toHaveCount(0);
    await item("Tidy").getByRole("button", { name: "Skip" }).click();
    await expect(item("Tidy")).toHaveCount(0);
    await expect(badge).toHaveCount(0);
    expect(await history("tidy")).toEqual([expect.objectContaining({ state: "missed", reason: "skipped by you", dueAt: madrid("2026-11-18T22:00:00") }) as RunRecord]);
    expect(await history("nightly")).toEqual([]);
    await expect(panel.getByTestId("next-up-item").first()).toContainText("Nightly");

    await expect.poll(() => history("nightly"), { timeout: 30_000 }).toEqual([expect.objectContaining({ trigger: "caught-up", state: "done", lastLines: ["nightly caught-up"] }) as RunRecord]);
    const [ran] = await history("nightly");
    expect(ran?.startedAt ?? 0).toBeGreaterThanOrEqual(madrid("2026-11-18T23:00:00"));
    expect(ran?.startedAt ?? Infinity).toBeLessThan(madrid("2026-11-18T23:01:00"));
    expect(await history("tidy")).toHaveLength(1);
  });

  // T-009 — missed runs, time limits, Next up.
  test("T-009 · a run stopped at its time limit reads “stopped: time limit, 1 min” in the notice, its card, History and pomade-runner history", async () => {
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/slow.md"), "---\nkind: script\nname: Slow\nfolder: .\ncommand: \"echo working; sleep 600\"\nhook: { event: project-created }\ntime-limit: 1m\n---\n");
    await restartTheScheduler("2026-11-19T10:00:00");
    expect((await command("run", "slow")).code).toBe(0);
    await expect.poll(() => history("slow"), { timeout: 20_000 }).toEqual([expect.objectContaining({ state: "failed", reason: "stopped: time limit, 1 min", limitHit: 1 }) as RunRecord]);

    const notice = page.getByTestId("notices-panel").locator('[data-testid="notice-row"][data-source="pomade-runner"]', { hasText: "Slow failed" });
    await expect.poll(() => runnerNotices()).toContain("Slow failed");
    await expect(notice).toContainText("stopped: time limit, 1 min · working");
    await notice.click();
    const frame = page.frameLocator(`[data-testid="app-frame-${manifest.id}"]`);
    const card = frame.getByTestId("run-card");
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(frame.getByTestId("run-dialog")).toHaveAttribute("data-tone", "danger");
    await expect(frame.getByTestId("run-result")).toHaveText("Stopped: time limit");
    await expect(card.getByTestId("run-limit")).toHaveText("Time limit, 1 min — the job’s time limit");
    await expect(card.getByTestId("run-last-lines")).toHaveText("working");
    await shoot(page, "pomade-card-limit");

    await frame.getByTestId("run-dialog").getByRole("button", { name: "Close (Esc)" }).click();
    const row = frame.locator('[data-testid="history-row"][data-job="slow"]');
    await expect(row.getByTestId("history-result")).toHaveText("stopped: time limit, 1 min");
    const printed = await command("history", "slow");
    expect(printed.code).toBe(0);
    expect(printed.stdout).toMatch(/^slow {2}Slow {2}manual {2}stopped: time limit, 1 min, /);
  });

  test("T-009 · Next up tags the runs the switch holds, at each of its positions", async () => {
    const every = (name: string, extra: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: echo ${name}\nschedule:\n  every: { minutes: 10 }\n${extra}---\n`;
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/low.md"), every("Low", ""));
    await writeFile(join(folders.workspace, "Apps/pomade-runner/jobs/high.md"), every("High", "low-priority: false\n"));
    await restartTheScheduler("2026-11-19T11:01:00");

    await clickIfThere(page.getByTestId(`strip-${STRIP_KEY}`), page.getByTestId(`panel-frame-${STRIP_KEY}`));
    const rows = page.frameLocator(`[data-testid="panel-frame-${STRIP_KEY}"]`).getByTestId("next-up-item");
    await expect.poll(() => tagged(rows)).toEqual(["High", "Low", "High", "Low", "High"]);
    expect(await callScheduler(socket(), "switch", { position: "pause-low" })).toMatchObject({ status: "ok" });
    await expect.poll(() => tagged(rows)).toEqual(["High", "Low held", "High", "Low held", "High"]);
    await shoot(page, "pomade-next-up-held-low");
    expect(await callScheduler(socket(), "switch", { position: "pause-all" })).toMatchObject({ status: "ok" });
    await expect.poll(() => tagged(rows)).toEqual(["High held", "Low held", "High held", "Low held", "High held"]);
    await expect(rows.first().getByTestId("next-up-held")).toHaveText("held");
    expect(await callScheduler(socket(), "switch", { position: "running" })).toMatchObject({ status: "ok" });
    await expect.poll(() => tagged(rows)).toEqual(["High", "Low", "High", "Low", "High"]);
  });
});
