import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_VERSION } from "../app";
import type { PomadeLinkHandlers } from "../integrations/pomade";
import { callScheduler } from "./control/client";
import { CONTROL_PROTOCOL } from "./control/protocol";
import { startScheduler, type Scheduler } from "./scheduler";

/** One raw line to the socket, and the first line that comes back. */
function exchange(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let text = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(line));
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end === -1) return;
      socket.destroy();
      resolve(JSON.parse(text.slice(0, end)));
    });
  });
}

describe("scheduler", () => {
  let dir: string;
  let socketPath: string;
  let now: Date;
  let lines: string[];
  let link: PomadeLinkHandlers | null;
  let linkStopped: boolean;
  const running: Scheduler[] = [];

  async function start(tick = 1000): Promise<Scheduler> {
    const result = await startScheduler({
      socketPath,
      clock: { now: () => now },
      tickMs: tick,
      log: (message) => lines.push(message),
      linkPomade: (handlers) => {
        link = handlers;
        return { stop: () => void (linkStopped = true) };
      },
    });
    if (result.status !== "started") throw new Error(`not started: ${result.status}`);
    running.push(result.scheduler);
    return result.scheduler;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    socketPath = join(dir, "state", "scheduler.sock");
    now = new Date("2026-11-17T08:00:00.000Z");
    lines = [];
    link = null;
    linkStopped = false;
  });

  afterEach(async () => {
    for (const scheduler of running.splice(0)) await scheduler.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("answers its status over the control socket", async () => {
    await start();
    expect(await callScheduler(socketPath, "status")).toEqual({
      status: "ok",
      value: { version: APP_VERSION, pid: process.pid, startedAt: "2026-11-17T08:00:00.000Z", lastTickAt: null, pomade: "disconnected" },
    });
    expect(lines).toEqual([`scheduler ${APP_VERSION} started (pid ${process.pid}, tick 1000 ms)`]);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it("ticks on the clock it was given, at the tick it was given", async () => {
    const scheduler = await start(20);
    now = new Date("2026-11-17T08:00:05.000Z");
    vi.advanceTimersByTime(19);
    expect(scheduler.status().lastTickAt).toBeNull();
    vi.advanceTimersByTime(1);
    expect(scheduler.status().lastTickAt).toBe("2026-11-17T08:00:05.000Z");
    now = new Date("2026-11-17T08:00:09.000Z");
    vi.advanceTimersByTime(20);
    expect(scheduler.status().lastTickAt).toBe("2026-11-17T08:00:09.000Z");
  });

  it("follows its connection to Pomade", async () => {
    const scheduler = await start();
    link?.connected();
    expect(scheduler.status().pomade).toBe("connected");
    link?.disconnected();
    expect(scheduler.status().pomade).toBe("disconnected");
    link?.rejected("unauthorized");
    expect(scheduler.status().pomade).toBe("rejected");
    expect(lines.slice(1)).toEqual(["connected to Pomade", "Pomade went away; reconnecting", "Pomade refused the connection: unauthorized"]);
  });

  it("leaves a running scheduler in charge", async () => {
    await start();
    const second = await startScheduler({
      socketPath,
      clock: { now: () => now },
      tickMs: 1000,
      log: (message) => lines.push(message),
      linkPomade: () => {
        throw new Error("a second scheduler must not connect to Pomade");
      },
    });
    expect(second).toEqual({ status: "already-running" });
    expect((await callScheduler(socketPath, "status")).status).toBe("ok");
  });

  it("takes over the socket file a killed scheduler left behind", async () => {
    await mkdir(join(dir, "state"));
    const holder = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"))`], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await once(holder.stdout, "data");
    holder.kill("SIGKILL");
    await once(holder, "exit");
    expect((await stat(socketPath)).isSocket()).toBe(true);

    await start();
    expect((await callScheduler(socketPath, "status")).status).toBe("ok");
  });

  it("replaces a file at the socket path that is not a socket", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(socketPath, "");
    await start();
    expect((await callScheduler(socketPath, "status")).status).toBe("ok");
  });

  it("stops: no socket, no ticks, the connection to Pomade closed", async () => {
    const scheduler = await start(20);
    await scheduler.stop();
    running.length = 0;
    expect(linkStopped).toBe(true);
    expect(await callScheduler(socketPath, "status")).toEqual({ status: "not-running" });
    await expect(stat(socketPath)).rejects.toThrow();
    vi.advanceTimersByTime(100);
    expect(scheduler.status().lastTickAt).toBeNull();
    expect(lines.at(-1)).toBe("scheduler stopped");
  });

  it("refuses a socket path macOS cannot bind", async () => {
    socketPath = join(dir, "x".repeat(120), "scheduler.sock");
    const result = await startScheduler({ socketPath, clock: { now: () => now }, tickMs: 1000, log: () => undefined, linkPomade: () => ({ stop: () => undefined }) });
    expect(result.status).toBe("failed");
  });

  it("tells a caller of another protocol version so, and refuses unknown methods and non-requests", async () => {
    await start();
    expect(await exchange(socketPath, `${JSON.stringify({ protocol: CONTROL_PROTOCOL + 1, id: "a", method: "status" })}\n`)).toEqual({
      protocol: CONTROL_PROTOCOL,
      id: "a",
      ok: false,
      error: { code: "protocol-mismatch", message: `the scheduler speaks control protocol ${CONTROL_PROTOCOL}, the caller ${CONTROL_PROTOCOL + 1}` },
    });
    expect(await exchange(socketPath, `${JSON.stringify({ protocol: CONTROL_PROTOCOL, id: "b", method: "launch" })}\n`)).toMatchObject({
      id: "b",
      ok: false,
      error: { code: "unknown-method" },
    });
    expect(await exchange(socketPath, `"hello"\n`)).toMatchObject({ id: "", ok: false, error: { code: "invalid-request" } });
  });
});
