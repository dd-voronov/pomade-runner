// Chains and the Mac login hook as processes: the scheduler of a copy of the built app folder runs
// the scripts and services of a temp workspace as sessions of a real keeper, with Pomade closed
// (`support/runner.ts`). Every rule's edge is in the unit tests (`src/scheduler/hooks-chains.test.ts`
// and its neighbours); these show E-005's acceptance on real processes.
//
// A login is the scheduler's start — it is the login item — so a simulated login is the scheduler
// started again. The login specs run its clock 60 times as fast: a second is a minute, so the
// warm-up's minute passes in a second.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { createRunnerWorld, serviceFile, type RunnerWorld } from "./support/runner";
import type { SchedulerProcess } from "./support/scheduler";

const ZONE = { TZ: "Europe/Madrid" };

/** A scheduler clock that starts at `local` (Madrid) and runs 60 times as fast. */
const fast = (local: string): Record<string, string> => ({ ...ZONE, POMADE_RUNNER_CLOCK: `${local}+01:00`, POMADE_RUNNER_CLOCK_RATE: "60" });

/** A script job file. */
const scriptFile = (name: string, command: string, extra: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\n${extra}---\n`;

const madrid = (local: string): number => Date.parse(`${local}+01:00`);

async function schedulerTime(world: RunnerWorld): Promise<number> {
  const status = await callScheduler(world.socketPath, "status", null);
  return status.status === "ok" && status.value.lastTickAt !== null ? Date.parse(status.value.lastTickAt) : 0;
}

async function writeSettings(world: RunnerWorld, text: string): Promise<void> {
  await mkdir(join(world.tmp, "ws/Apps/pomade-runner"), { recursive: true });
  await writeFile(join(world.tmp, "ws/Apps/pomade-runner/settings.yaml"), text);
}

/** When the latest warm-up the scheduler logged ends, on its clock (to the minute it names). */
function warmUpEnd(scheduler: SchedulerProcess, day: string): number {
  const time = [...scheduler.output().matchAll(/warm-up: the services are up; caught-up and hook runs wait until (\d\d:\d\d)\n/g)].at(-1)?.[1];
  if (time === undefined) throw new Error("no warm-up in the log");
  return madrid(`${day}T${time}:00`);
}

test.describe("chains and login hooks", () => {
  let world: RunnerWorld;

  test.beforeEach(async () => {
    world = await createRunnerWorld();
  });

  test.afterEach(async () => {
    await world.dispose();
  });

  test("1 · chain on done: script A done → the chained service restarts; History shows chain: after A", async () => {
    await world.writeJob("a.md", scriptFile("A", "echo pulled", "hook: { event: project-created }\n"));
    await world.writeJob("web.md", serviceFile("Web", "sleep 600", "after: { job: a }\n"));
    const scheduler = world.startScheduler(ZONE);
    await world.ready(scheduler);
    const first = await world.running("svc:web");

    expect((await world.command("run", "a")).code).toBe(0);
    await expect.poll(() => world.history("web"), { timeout: 15_000 }).toEqual([
      expect.objectContaining({ kind: "service", trigger: "chain", action: "restart", state: "done", cause: expect.objectContaining({ kind: "chain", job: "a", name: "A", result: "done" }) as unknown }) as RunRecord,
    ]);
    const [parent] = await world.history("a");
    expect((await world.history("web"))[0]?.cause).toMatchObject({ run: parent?.run });
    const again = await world.running("svc:web", first);
    expect(again.info.startedAt).toBeGreaterThan(first.info.startedAt);
    expect(await world.service("web")).toMatchObject({ state: expect.stringMatching(/^(starting|running)$/) as unknown, restarts: 0 });
    expect((await world.command("history", "web")).stdout).toMatch(/^web {2}Web {2}chain: after A {2}restarted, \S+\n$/);
    expect(scheduler.output()).toContain("service web: Restart — chain: after A\n");
  });

  test("2 · chain on failure: a failure-only chain doesn't fire on success, and fires on failure with its parent in the environment", async () => {
    await world.writeJob("a.md", scriptFile("A", "test -e fail && exit 3; echo ok", "hook: { event: project-created }\n"));
    await world.writeJob("cleanup.md", scriptFile("Cleanup", 'echo "$POMADE_TRIGGER after $POMADE_PARENT_JOB $POMADE_PARENT_RESULT $POMADE_PARENT_RUN_ID"', "after: { job: a, result: failed }\n"));
    await world.writeJob("next.md", scriptFile("Next", "echo next", "after: { job: a }\n"));
    const scheduler = world.startScheduler(ZONE);
    await world.ready(scheduler);

    expect((await world.command("run", "a")).code).toBe(0);
    // Next follows the same end: once it ran, the chains of that end have all fired.
    await expect.poll(() => world.history("next"), { timeout: 15_000 }).toEqual([expect.objectContaining({ state: "done", trigger: "chain" }) as RunRecord]);
    expect(await world.history("cleanup")).toEqual([]);

    await writeFile(join(world.tmp, "ws", "fail"), "");
    expect((await world.command("run", "a")).code).toBe(0);
    await expect.poll(() => world.history("cleanup"), { timeout: 15_000 }).toHaveLength(1);
    const [failed] = await world.history("a");
    expect(failed).toMatchObject({ state: "failed", exitCode: 3 });
    expect(await world.history("cleanup")).toEqual([expect.objectContaining({ state: "done", trigger: "chain", lastLines: [`chain after a failed ${failed?.run ?? ""}`] }) as RunRecord]);
    expect(await world.history("next")).toHaveLength(1);
    expect(scheduler.output()).toMatch(/run cleanup \S+: started \(chain\)\n/);
  });

  test("3 · cycle refusal: pomade-runner check reports a chain that loops back, on every job in the loop", async () => {
    await world.writeJob("a.md", scriptFile("A", "echo a", "after: { job: b }\n"));
    await world.writeJob("b.md", scriptFile("B", "echo b", "after: { job: a, result: any }\n"));
    const checked = await world.command("check");
    expect(checked.code).toBe(1);
    const fix = "Fix: remove after: from one of these jobs, or point it at a job outside the loop.";
    expect(checked.stdout).toBe(
      `ws/Apps/pomade-runner/jobs/a.md:6: after.job — the chain loops back: a → b → a. ${fix}\n` +
        `ws/Apps/pomade-runner/jobs/b.md:6: after.job — the chain loops back: a → b → a. ${fix}\n` +
        "2 problems in 2 of 2 job files in ws/Apps/pomade-runner/jobs.\n" +
        "Project ids were not checked: Pomade is closed. Run it again with Pomade open to check them too.\n",
    );
  });

  test("4 · safety net: a hook firing 11 times in 10 min — eleven logins — pauses the job with a Needs-you item and a notice; Resume lets it run again", async () => {
    await writeSettings(world, "warm-up: 0m\n");
    await world.writeJob("mount.md", scriptFile("Mount", "echo mounted", "hook: { event: login }\n"));
    for (let login = 1; login <= 11; login++) {
      const scheduler = world.startScheduler(ZONE);
      await world.ready(scheduler);
      await expect.poll(() => scheduler.output(), { timeout: 15_000 }).toMatch(login <= 10 ? /run mount \S+: done — exit 0\n/ : /job mount: fired more than 10 times in 10 min by hooks or chains — looks like a loop; paused until Resume\n/);
      await scheduler.kill();
    }
    await expect.poll(() => world.queuedNotices()).toContainEqual(expect.objectContaining({ title: "Mount paused: triggered 10× in 10 min — looks like a loop" }));

    // The pause survives a restart — itself a twelfth login, which finds the job paused.
    const scheduler = world.startScheduler(ZONE);
    await world.ready(scheduler);
    await expect.poll(() => scheduler.output()).toContain("job mount: paused by the loop guard; hook: Mac login does not fire it\n");
    expect(await world.history("mount")).toHaveLength(10);
    expect((await world.command("runs")).stdout).toContain("needs you: Mount — paused: triggered 10× in 10 min — looks like a loop; pomade-runner resume-job mount lets hooks and chains fire it again\n");
    expect((await world.queuedNotices()).filter((notice) => notice.title.startsWith("Mount paused"))).toHaveLength(1);

    expect(await world.command("resume-job", "Mount")).toMatchObject({ code: 0, stdout: "mount  Mount  resumed: hooks and chains fire it again\n" });
    expect((await world.command("runs")).stdout).not.toContain("needs you: Mount");
    expect(await world.command("resume-job", "mount")).toMatchObject({ code: 1, stderr: 'pomade-runner resume-job: cannot resume "mount": "mount" is not paused.\n' });
    await scheduler.kill();
    const resumed = world.startScheduler(ZONE);
    await world.ready(resumed);
    await expect.poll(() => world.history("mount"), { timeout: 15_000 }).toHaveLength(11);
  });

  test("5 · login one-shot: runs once after a simulated login, after the warm-up — and again at the next login", async () => {
    await writeSettings(world, "warm-up: 1m\n");
    await world.writeJob("mount.md", scriptFile("Mount", 'echo "mounted $POMADE_TRIGGER"', "hook: { event: login }\n"));
    await world.writeJob("web.md", serviceFile("Web", "sleep 600"));
    const scheduler = world.startScheduler(fast("2026-11-18T08:00:00"));
    await world.ready(scheduler);
    await expect.poll(() => world.history("mount"), { timeout: 15_000 }).toEqual([
      expect.objectContaining({ trigger: "hook", state: "done", cause: { kind: "hook", event: "login", context: {} }, lastLines: ["mounted hook"] }) as RunRecord,
    ]);
    const [mounted] = await world.history("mount");
    expect(mounted?.startedAt ?? 0).toBeGreaterThanOrEqual(warmUpEnd(scheduler, "2026-11-18"));
    const log = scheduler.output();
    expect(log.indexOf("hook login: fires mount\n")).toBeGreaterThan(-1);
    expect(log.search(/run mount \S+: started \(hook\)/)).toBeGreaterThan(log.indexOf("warm-up: the services are up"));
    expect((await world.command("history", "mount")).stdout).toMatch(/^mount {2}Mount {2}hook: Mac login {2}done, /);
    // Once per login, however long the scheduler runs.
    await expect.poll(() => schedulerTime(world), { timeout: 30_000 }).toBeGreaterThan(madrid("2026-11-18T08:10:00"));
    expect(await world.history("mount")).toHaveLength(1);

    await scheduler.kill();
    const next = world.startScheduler(fast("2026-11-19T08:00:00"));
    await world.ready(next);
    await expect.poll(() => world.history("mount"), { timeout: 15_000 }).toHaveLength(2);
  });
});
