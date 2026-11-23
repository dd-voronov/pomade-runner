// A Pomade start, named by its socket, and the start each workspace's Pomade started hooks fired for.

import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateFolderOf } from "../locations";
import { pomadeStartOf, pomadeStarts } from "./pomade-start";

const listen = (path: string): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe("pomade start", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names a Pomade start by its socket: the same while it runs, another once Pomade starts again", async () => {
    const socket = join(dir, "pomade.sock");
    const env = { POMADE_SOCKET: socket };
    expect(await pomadeStartOf(env)).toBeNull();
    let server = await listen(socket);
    const first = await pomadeStartOf(env);
    expect(first).toMatch(/^\d+:\d+:\d+$/);
    expect(await pomadeStartOf(env)).toBe(first);
    // Pomade quits (the socket goes) and starts again.
    await close(server);
    await unlink(socket).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    server = await listen(socket);
    const second = await pomadeStartOf(env);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await close(server);
  });

  it("names no start for a socket nothing listens on: a crashed Pomade's left behind", async () => {
    const socket = join(dir, "stale.sock");
    const server = await listen(socket);
    expect(await pomadeStartOf({ POMADE_SOCKET: socket })).not.toBeNull();
    // Closing the server keeps no listener; a plain file where the socket was is no Pomade either.
    await close(server);
    await writeFile(socket, "");
    expect(await pomadeStartOf({ POMADE_SOCKET: socket })).toBeNull();
  });

  it("finds the socket in the host record when POMADE_SOCKET is not set", async () => {
    const socket = join(dir, "s.sock");
    const server = await listen(socket);
    await writeFile(join(dir, "host.json"), JSON.stringify({ socket, launch: { argv: ["/x"], env: {} } }));
    expect(await pomadeStartOf({ POMADE_HOME: dir })).toBe(await pomadeStartOf({ POMADE_SOCKET: socket }));
    await close(server);
  });

  it("says a start is new for a workspace once, and keeps that across schedulers", async () => {
    const state = stateFolderOf(join(dir, "ud"));
    const starts = pomadeStarts(state, () => undefined);
    expect(await starts.firstReady("/ws", "a")).toBe(true);
    expect(await starts.firstReady("/ws", "a")).toBe(false);
    // Another workspace on the same Pomade start has its own.
    expect(await starts.firstReady("/other", "a")).toBe(true);
    await starts.flush();
    const again = pomadeStarts(state, () => undefined);
    expect(await again.firstReady("/ws", "a")).toBe(false);
    expect(await again.firstReady("/ws", "b")).toBe(true);
  });

  it("keeps the projects opened in a workspace's start across schedulers, and forgets them at the next start", async () => {
    const state = stateFolderOf(join(dir, "ud"));
    const starts = pomadeStarts(state, () => undefined);
    expect(await starts.firstReady("/ws", "a")).toBe(true);
    await starts.open("/ws", "a", "p1");
    await starts.open("/ws", "a", "p1");
    await starts.open("/ws", "a", "p2");
    // A start not kept for the workspace keeps nothing.
    await starts.open("/ws", "z", "p3");
    await starts.open("/other", "a", "p4");
    expect(await starts.opened("/ws", "a")).toEqual(["p1", "p2"]);
    expect(await starts.opened("/ws", "z")).toEqual([]);
    await starts.flush();

    const again = pomadeStarts(state, () => undefined);
    expect(await again.opened("/ws", "a")).toEqual(["p1", "p2"]);
    expect(await again.opened("/other", "a")).toEqual([]);
    expect(await again.firstReady("/ws", "b")).toBe(true);
    expect(await again.opened("/ws", "b")).toEqual([]);
    expect(await again.opened("/ws", "a")).toEqual([]);
  });

  it("reads a record without a list of opened projects as none opened", async () => {
    const state = stateFolderOf(join(dir, "ud"));
    const starts = pomadeStarts(state, () => undefined);
    await starts.firstReady("/ws", "a");
    await starts.flush();
    await writeFile(join(dir, "ud/app-state/pomade-runner/pomade-started.json"), JSON.stringify({ fired: { "/ws": "a" }, opened: { "/ws": "not a list" } }));
    const again = pomadeStarts(state, () => undefined);
    expect(await again.opened("/ws", "a")).toEqual([]);
    expect(await again.firstReady("/ws", "a")).toBe(false);
  });
});
