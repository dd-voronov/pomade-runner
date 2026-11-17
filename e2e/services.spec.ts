// Service supervision as processes: the scheduler of a copy of the built app folder supervises the
// services of a temp workspace in a real keeper, with Pomade closed (`support/runner.ts`); the
// `pomade-runner` command starts, stops and restarts them. The rules' every edge is in the
// supervisor's unit tests; these show them on real processes, on the real clock.

import { once } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { followSession } from "pomade-kit/node";

import { alive } from "./support/keeper";
import { createRunnerWorld, serviceFile, type RunnerWorld } from "./support/runner";

const SLEEPER = "echo up; exec sleep 600";

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** How many times the scheduler started or restarted `job`. */
function starts(output: string, job: string): number {
  return output.split("\n").filter((line) => new RegExp(`service ${job}: (starting|restarted \\(\\d+×\\))$`).test(line)).length;
}

test.describe("service supervision", () => {
  let world: RunnerWorld;

  test.beforeEach(async () => {
    world = await createRunnerWorld();
  });

  test.afterEach(async () => {
    await world.dispose();
  });

  test("at a fresh start the services start one after another — workspace jobs first, then each project's — each once the one before is up", async () => {
    const port = await freePort();
    const listen = `exec ${JSON.stringify(process.execPath)} -e "setTimeout(() => require('node:net').createServer().listen(${port}, '127.0.0.1'), 1000)"`;
    await mkdir(join(world.jobs, "alpha"));
    await world.writeJob("zeta.md", serviceFile("Zeta", SLEEPER));
    await world.writeJob("alpha/api.md", serviceFile("Api", listen, `project: alpha\nready: { port: ${port} }\n`));
    await world.writeJob("alpha/web.md", serviceFile("Web", SLEEPER, "project: alpha\n"));
    const scheduler = world.startScheduler();
    await world.ready(scheduler);

    const zeta = await world.running("svc:zeta");
    expect((await world.services()).services.map(({ job, state }) => [job, state])).toEqual([
      ["zeta", "starting"],
      ["alpha/api", "queued"],
      ["alpha/web", "queued"],
    ]);
    const api = await world.running("svc:alpha.api");
    const web = await world.running("svc:alpha.web");
    // Zeta is up once it has run 5 s; Api once its port accepts, about a second after its start.
    expect(api.info.startedAt - zeta.info.startedAt).toBeGreaterThanOrEqual(5000);
    expect(web.info.startedAt - api.info.startedAt).toBeGreaterThanOrEqual(1000);
    expect(web.info.startedAt - api.info.startedAt).toBeLessThan(5000);
    expect(scheduler.output().match(/service \S+: (starting|up)/g)).toEqual([
      "service zeta: starting",
      "service zeta: up",
      "service alpha/api: starting",
      "service alpha/api: up",
      "service alpha/web: starting",
    ]);
    // Web is up once it has run 5 s.
    await expect.poll(async () => (await world.command("services")).stdout, { timeout: 10_000 }).toMatch(/^keeper: running — .*\nzeta {2}Zeta {2}running, pid \d+, since \S+\nalpha\/api {2}Api {2}running, pid \d+, since \S+\nalpha\/web {2}Web {2}running, pid \d+, since \S+\n$/);
  });

  test("a scheduler restart reattaches the running services and restarts none", async () => {
    await world.writeJob("a.md", serviceFile("A", SLEEPER));
    await world.writeJob("b.md", serviceFile("B", SLEEPER));
    const first = world.startScheduler();
    await world.ready(first);
    const a = await world.running("svc:a");
    const b = await world.running("svc:b");
    await first.kill();

    const second = world.startScheduler();
    await world.ready(second);
    // B, started just before, is up once it has run 5 s.
    await expect.poll(async () => (await world.services()).services.map(({ state }) => state), { timeout: 10_000 }).toEqual(["running", "running"]);
    for (const before of [a, b]) {
      expect((await world.sessions()).sessions.find((session) => session.id === before.id)?.info).toMatchObject({ state: "running", pid: before.info.pid, startedAt: before.info.startedAt });
    }
    expect(second.output()).not.toMatch(/service \S+: (starting|restarted)/);
    expect(second.output()).not.toContain("stopping");
  });

  test("kill -9 of a service's program → restarted, and it says restarted 1×", async () => {
    await world.writeJob("web.md", serviceFile("Web", SLEEPER));
    const scheduler = world.startScheduler();
    await world.ready(scheduler);
    const web = await world.running("svc:web");
    // The program runs: a signal before its first output would hit the keeper's shim.
    await expect.poll(() => readFile(web.log ?? "", "utf8").catch(() => "")).toContain("up");
    process.kill(world.childOf(web.info.pid), "SIGKILL");

    await expect.poll(() => scheduler.output()).toContain("service web: crashed; restarting in 1 s\n");
    const again = await world.running("svc:web", web);
    expect(again.info.startedAt - web.info.startedAt).toBeGreaterThanOrEqual(1000);
    expect(await world.service("web")).toMatchObject({ restarts: 1, lastCrashAt: expect.any(Number) as unknown });
    expect((await world.command("services")).stdout).toMatch(/\nweb {2}Web {2}(starting|running), pid \d+, since \S+ · restarted 1× · last crash \S+\n/);
  });

  test("a command that exits at once ends failed after 5 crashes within a minute, noticed once: no more restarts, also after a scheduler restart, until it is run", async () => {
    test.setTimeout(90_000);
    await world.writeJob("flaky.md", serviceFile("Flaky", "echo starting; exit 3"));
    const first = world.startScheduler();
    await world.ready(first);

    // Crashes at about 0, 1, 3, 8 and 18 s: the back-off is 1, 2, 5 and 10 s.
    await expect.poll(async () => (await world.service("flaky"))?.state, { timeout: 40_000 }).toBe("failed");
    expect(first.output()).toContain("service flaky: crashed; failed — 5 crashes within a minute, no restarts until Start\n");
    expect(starts(first.output(), "flaky")).toBe(5);
    expect(await world.service("flaky")).toMatchObject({ restarts: 4, retryAt: null });
    // Giving up is noticed once; with Pomade closed the notice waits in its queue.
    await expect.poll(async () => (await world.queuedNotices()).map((notice) => notice.title)).toEqual(["Flaky gave up"]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(starts(first.output(), "flaky")).toBe(5);

    await first.kill();
    const second = world.startScheduler();
    await world.ready(second);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await world.service("flaky")).toMatchObject({ state: "failed", restarts: 4 });
    expect(starts(second.output(), "flaky")).toBe(0);
    expect(await world.queuedNotices()).toHaveLength(1);
    expect((await world.command("services")).stdout).toContain("flaky  Flaky  failed: 5 crashes within a minute · restarted 4× · last crash ");

    const run = await world.command("run", "flaky");
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(run.stdout).toMatch(/^flaky {2}Flaky {2}starting, pid \d+, since \S+\n$/);
    expect(second.output()).toContain("service flaky: Start\n");
  });

  test("Ctrl+C in an attached tab → stopped by you, and it stays stopped; pomade-runner run brings it back", async () => {
    await world.writeJob("ticker.md", serviceFile("Ticker", 'i=0; while :; do i=$((i+1)); echo "tick $i"; sleep 1; done'));
    const scheduler = world.startScheduler();
    await world.ready(scheduler);
    const ticker = await world.running("svc:ticker");
    let output = "";
    const tab = followSession({ socketPath: world.keeperSocket, app: "pomade", session: "svc:ticker", cols: 80, rows: 24 }, { onSnapshot: (data) => (output += data), onOutput: (data) => (output += data) });
    try {
      // The program runs (the interrupt reaches it, not the keeper's shim around it).
      await expect.poll(() => output).toContain("tick 1");
      tab.input("\x03");
      await expect.poll(async () => (await world.service("ticker"))?.state).toBe("stopped-by-you");
    } finally {
      tab.close();
    }
    expect(scheduler.output()).toContain("service ticker: stopped by you; it stays stopped until Start\n");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await world.service("ticker")).toMatchObject({ state: "stopped-by-you", session: { info: { state: "exited" } } });
    expect(starts(scheduler.output(), "ticker")).toBe(1);

    expect((await world.command("run", "Ticker")).stdout).toMatch(/^ticker {2}Ticker {2}starting, pid \d+/);
    const again = await world.running("svc:ticker", ticker);
    expect(again.info.pid).not.toBe(ticker.info.pid);
  });

  test("pomade-runner restart restarts a service under the same session; stop leaves it stopped by you; both refuse a job that is no service", async () => {
    await world.writeJob("web.md", serviceFile("Web", SLEEPER));
    await world.writeJob("backup.md", "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nhook: { event: project-created }\n---\n");
    const scheduler = world.startScheduler();
    await world.ready(scheduler);
    const web = await world.running("svc:web");

    expect(await world.command("restart", "web")).toMatchObject({ code: 0, stdout: expect.stringMatching(/^web {2}Web {2}starting, pid \d+/) as unknown });
    const restarted = await world.running("svc:web", web);
    expect(restarted.run).not.toBe(web.run);
    await expect.poll(() => alive(web.info.pid ?? 0)).toBe(false);
    expect(scheduler.output()).toContain("session svc:web: ended: stopped");

    expect(await world.command("stop", "Web")).toMatchObject({ code: 0, stdout: "web  Web  stopped by you\n" });
    await expect.poll(async () => (await world.service("web"))?.session?.info.state).toBe("exited");
    expect(await world.service("web")).toMatchObject({ state: "stopped-by-you", session: { info: { exit: { reason: "stopped-by-you" } } } });

    expect(await world.command("restart", "backup")).toEqual({ code: 1, stdout: "", stderr: 'pomade-runner restart: cannot restart "backup": "backup" is a script job, not a service.\n' });
    expect(await world.command("stop", "nothing")).toEqual({ code: 1, stdout: "", stderr: 'pomade-runner stop: cannot stop "nothing": no service "nothing".\n' });
  });

  test("disabling a running service in its file stops it; deleting the file stops it and drops it", async () => {
    await world.writeJob("a.md", serviceFile("A", SLEEPER));
    await world.writeJob("b.md", serviceFile("B", SLEEPER));
    const scheduler = world.startScheduler();
    await world.ready(scheduler);
    const a = await world.running("svc:a");
    const b = await world.running("svc:b");

    await world.writeJob("a.md", serviceFile("A", SLEEPER, "enabled: false\n"));
    await expect.poll(async () => (await world.service("a"))?.session?.info.exit?.reason).toBe("stopped");
    expect(await world.service("a")).toMatchObject({ state: "disabled" });
    expect(scheduler.output()).toContain("service a: disabled in its file; stopping it\n");
    await expect.poll(() => alive(a.info.pid ?? 0)).toBe(false);

    await rm(join(world.jobs, "b.md"));
    await expect.poll(async () => (await world.service("b"))?.state).toBe("removed");
    // After the 2 s grace for an editor that saves by deleting and writing again.
    await expect.poll(async () => (await world.services()).services.map(({ job }) => job), { timeout: 10_000 }).toEqual(["a"]);
    expect(scheduler.output()).toContain("service b: its file is gone; stopping it\n");
    expect((await world.sessions()).sessions.map(({ id }) => id)).toEqual(["svc:a"]);
    expect(alive(b.info.pid ?? 0)).toBe(false);
  });
});
