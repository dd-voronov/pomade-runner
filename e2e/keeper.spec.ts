// The keeper as processes: the scheduler of a copy of the built app folder starts Runner's keeper
// as its own detached process and owns its sessions, with Pomade closed (`support/runner.ts`).
// Clients attach the way Pomade's attached tabs do — `pomade-kit/node`'s `followSession`, as a
// viewer. Every keeper a test started is stopped in teardown, with what it runs.

import { execFileSync } from "node:child_process";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { followSession, type Follower } from "pomade-kit/node";
import type { SessionExit, SessionInfo } from "pomade-kit/protocol";

import manifest from "../app/manifest.json" with { type: "json" };
import { DIST } from "./support/env";
import { alive, keeperAt } from "./support/keeper";
import { createRunnerWorld, serviceFile, type RunnerWorld } from "./support/runner";

/** A service: a numbered tick a second; a typed line is echoed back at once. */
// A closed terminal (its keeper gone) ends it: `read` then fails at once, where a second without
// input takes a second (bash 3.2 gives both status 1, so the clock tells them apart).
const TICKER = 'i=0; while :; do i=$((i+1)); echo "tick $i"; t=$SECONDS; if read -t 1 line; then echo "got: $line"; elif [ $SECONDS -eq $t ]; then exit 0; fi; done';

test.describe("the keeper", () => {
  let world: RunnerWorld;
  const followers: Follower[] = [];

  const session = async (id: string): Promise<SessionInfo | undefined> => (await world.sessions()).sessions.find((candidate) => candidate.id === id)?.info;

  /** Attach as Pomade's tabs do; what arrives is collected. */
  function attach(id: string, size = { cols: 100, rows: 30 }) {
    const seen = { snapshot: "", output: "", exit: null as SessionExit | null, attached: false };
    const follower = followSession(
      { socketPath: world.keeperSocket, app: "pomade", session: id, ...size },
      {
        onSnapshot: (data) => {
          seen.snapshot = data;
          seen.attached = true;
        },
        onOutput: (data) => (seen.output += data),
        onExit: (exit) => (seen.exit = exit),
      },
    );
    followers.push(follower);
    return { follower, seen };
  }

  test.beforeEach(async () => {
    world = await createRunnerWorld();
    await world.writeJob("ticker.md", serviceFile("Ticker", TICKER));
  });

  test.afterEach(async () => {
    for (const follower of followers.splice(0)) follower.close();
    await world.dispose();
  });

  test("the scheduler starts the keeper as its own process; a session it started survives the scheduler's restart and is listed with its job", async () => {
    const first = world.startScheduler();
    await world.ready(first);
    const keeper = await keeperAt(world.keeperSocket);
    expect(keeper).not.toBeNull();
    expect(execFileSync("ps", ["-o", "command=", "-p", String(keeper?.pid)], { encoding: "utf8" })).toContain(join(world.build, "backend/keeper.mjs"));

    const ticker = await world.running("svc:ticker");
    expect(ticker).toMatchObject({ id: "svc:ticker", job: "ticker", kind: "service", info: { state: "running", actions: [{ id: "restart", title: "Restart" }] } });
    expect(ticker.log).toBe(join(world.userData, "app-state", manifest.id, "output", "ticker", `${ticker.run ?? ""}.log`));
    await expect.poll(() => readFile(ticker.log ?? "", "utf8").catch(() => "")).toContain("tick 2");

    // The scheduler dies (launchd restarts it after a crash); the keeper and the session run on.
    await first.kill();
    expect(alive(keeper?.pid ?? 0)).toBe(true);
    expect(alive(ticker.info.pid ?? 0)).toBe(true);
    const second = world.startScheduler();
    await world.ready(second);
    expect(second.output()).not.toContain("keeper: started");
    expect(await keeperAt(world.keeperSocket)).toEqual(keeper);
    expect(await session("svc:ticker")).toMatchObject({ state: "running", pid: ticker.info.pid, startedAt: ticker.info.startedAt });
    expect((await world.sessions()).sessions).toEqual([expect.objectContaining({ id: "svc:ticker", job: "ticker", run: ticker.run, log: ticker.log })]);

    const listed = await world.command("sessions");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toBe(
      `keeper: running — version ${keeper?.version ?? ""}, pid ${keeper?.pid ?? ""}\n` +
        `svc:ticker  job ticker  running, pid ${ticker.info.pid ?? ""}, since ${new Date(ticker.info.startedAt).toISOString()}  output ${ticker.log ?? ""}\n`,
    );
    expect(second.output()).not.toContain("ended");
  });

  test("an attached client gets the earlier output, then the live output; its input and size reach the session; detaching leaves it running", async () => {
    await world.ready(world.startScheduler());
    const ticker = await world.running("svc:ticker");
    await expect.poll(() => readFile(ticker.log ?? "", "utf8").catch(() => "")).toContain("tick 2");

    const { follower, seen } = attach("svc:ticker");
    await expect.poll(() => seen.attached).toBe(true);
    expect(seen.snapshot).toContain("tick 1");
    expect(seen.snapshot).toContain("tick 2");
    await expect.poll(() => seen.output).toMatch(/tick \d+/);
    expect((await session("svc:ticker"))?.clients).toBe(1);

    follower.input("hello keeper\r");
    await expect.poll(() => seen.output).toContain("got: hello keeper");
    follower.resize(120, 40);
    await expect.poll(async () => (await session("svc:ticker"))?.cols).toBe(120);
    expect((await session("svc:ticker"))?.rows).toBe(40);

    follower.close();
    await expect.poll(async () => (await session("svc:ticker"))?.clients).toBe(0);
    expect(await session("svc:ticker")).toMatchObject({ state: "running", pid: ticker.info.pid });
  });

  test("Ctrl+C typed through an attached client ends the session as stopped by you; kill -9 of the program as crashed", async () => {
    const scheduler = world.startScheduler();
    await world.ready(scheduler);
    await world.running("svc:ticker");
    await world.writeJob("sleeper.md", serviceFile("Sleeper", "echo up; exec sleep 600"));
    const sleeper = await world.running("svc:sleeper");
    await expect.poll(() => readFile(sleeper.log ?? "", "utf8").catch(() => "")).toContain("up");

    const { follower, seen } = attach("svc:ticker");
    // The program runs (the interrupt reaches it, not the keeper's shim around it).
    await expect.poll(() => seen.snapshot + seen.output).toContain("tick 1");
    follower.input("\x03");
    await expect.poll(() => seen.exit?.reason).toBe("stopped-by-you");
    await expect.poll(() => scheduler.output()).toContain("session svc:ticker: ended: stopped-by-you — code 130, SIGINT\n");

    process.kill(world.childOf(sleeper.info.pid), "SIGKILL");
    await expect.poll(() => scheduler.output()).toContain("session svc:sleeper: ended: crashed — code 137, SIGKILL\n");
  });

  test("a keeper that dies is started again; it reports the sessions it took with it as lost, and the services start again", async () => {
    const scheduler = world.startScheduler();
    await world.ready(scheduler);
    const ticker = await world.running("svc:ticker");
    await expect.poll(() => readFile(ticker.log ?? "", "utf8").catch(() => "")).toContain("tick 1");
    const before = await keeperAt(world.keeperSocket);
    process.kill(before?.pid ?? 0, "SIGKILL");

    await expect.poll(() => scheduler.output()).toContain("session svc:ticker: ended: lost-in-keeper-crash");
    const after = await keeperAt(world.keeperSocket);
    expect(after?.pid).not.toBe(before?.pid);
    expect(after?.version).toBe(before?.version);
    await expect.poll(() => alive(ticker.info.pid ?? 0)).toBe(false);
    // Not the service's fault: it starts again, and no crash is counted.
    const again = await world.running("svc:ticker", ticker);
    expect(again.info.pid).not.toBe(ticker.info.pid);
    expect(await world.service("ticker")).toMatchObject({ restarts: 0, lastCrashAt: null });
  });

  test("a Runner update that ships another keeper updates the running one: sessions keep running with the same pids", async () => {
    await world.writeJob("sleeper.md", serviceFile("Sleeper", "echo up; exec sleep 600"));
    const first = world.startScheduler();
    await world.ready(first);
    const sleeper = await world.running("svc:sleeper");
    const ticker = await world.running("svc:ticker");
    const old = await keeperAt(world.keeperSocket);
    const { seen } = attach("svc:ticker");
    await expect.poll(() => seen.attached).toBe(true);

    // The update: a build whose keeper differs replaces the installed folder, as `pomade apps
    // install` does (stage beside it, swap, delete the old copy); the scheduler restarts.
    const next = "e2e0000000a2";
    const staging = join(world.tmp, "apps", ".staging");
    await cp(DIST, staging, { recursive: true });
    await writeFile(join(staging, "backend/keeper.mjs"), `${await readFile(join(staging, "backend/keeper.mjs"), "utf8")}\n// the next keeper\n`);
    const scheduler = await readFile(join(staging, "backend/scheduler.mjs"), "utf8");
    expect(scheduler).toContain(`"${old?.version ?? ""}"`);
    await writeFile(join(staging, "backend/scheduler.mjs"), scheduler.replaceAll(`"${old?.version ?? ""}"`, `"${next}"`));
    await rename(world.build, join(world.tmp, "apps", ".trash"));
    await rename(staging, world.build);
    await rm(join(world.tmp, "apps", ".trash"), { recursive: true });
    first.child.kill("SIGTERM");
    expect(await first.exited).toBe(0);

    const second = world.startScheduler();
    await expect.poll(() => second.output()).toContain(`keeper: version ${old?.version ?? ""} (pid ${old?.pid ?? ""}) is not this build's ${next}; updating it\n`);
    await expect.poll(() => second.output()).toMatch(new RegExp(`keeper: connected — version ${next}, pid (?!${old?.pid ?? ""}\\b)\\d+\\n`));
    const updated = await keeperAt(world.keeperSocket);
    expect(updated?.version).toBe(next);
    await expect.poll(() => alive(old?.pid ?? 0)).toBe(false);
    for (const before of [ticker, sleeper]) {
      expect(await session(before.id)).toMatchObject({ state: "running", pid: before.info.pid, startedAt: before.info.startedAt });
    }
    // The attached client followed the session to the new keeper.
    const marker = seen.output.length;
    await expect.poll(() => seen.output.slice(marker)).toMatch(/tick \d+/);
    expect(second.output()).not.toContain("ended");
    expect(second.output()).not.toContain("keeper: started");
    expect(second.output()).not.toMatch(/service \S+: (starting|restarted)/);
  });
});
