// The scheduler's hold on the keeper, against a real keeper (`pomade-kit/keeper`) in this process,
// with real PTYs. Sessions run `/bin/sh` as the login shell, so no test reads the user's profile.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runKeeper, type Keeper } from "pomade-kit/keeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_ID } from "../app";
import { liveOutputLogPath, stateFolderOf, type StateFolder } from "../locations";
import type { RunnerSession } from "./model";
import { createSessions, type SessionCommand, type Sessions } from "./sessions";

const VERSION = "v1";
const KEY = "owner-key";

/** The program a session's shim runs: the login shell, or what it `exec`ed — once the shim has
 *  started it (a spawn answers before the shim's fork is always done). */
function childOf(pid: number | null): Promise<number> {
  return vi.waitFor(() => Number(execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n")[0]));
}

describe("sessions", () => {
  let dir: string;
  let keeper: Keeper;
  let socketPath: string;
  let state: StateFolder;
  let lines: string[];
  const opened: Sessions[] = [];

  function open(key = KEY): { sessions: Sessions; ended: RunnerSession[] } {
    const sessions = createSessions({
      socketPath,
      key,
      keeper: { entry: join(dir, "keeper.mjs"), version: VERSION },
      state,
      clock: { now: () => new Date("2026-11-17T08:00:00.000Z") },
      log: (line) => lines.push(line),
    });
    opened.push(sessions);
    const ended: RunnerSession[] = [];
    sessions.onExit((session) => ended.push(session));
    return { sessions, ended };
  }

  async function connected(key = KEY): Promise<{ sessions: Sessions; ended: RunnerSession[] }> {
    const s = open(key);
    expect(s.sessions.followed()).toBe(false);
    await s.sessions.refresh();
    expect(s.sessions.keeper()).toEqual({ state: "connected", version: VERSION, pid: process.pid });
    expect(s.sessions.followed()).toBe(true);
    return s;
  }

  const command = (line: string, extra: Partial<SessionCommand> = {}): SessionCommand => ({ title: "Web", command: line, cwd: dir, background: false, ...extra });
  let runs = 0;
  /** One run of `job`, under a run id of its own. */
  const runOf = (job: string): { kind: "run"; job: string; run: string } => ({ kind: "run", job, run: `20261117-080000-${String(++runs).padStart(6, "0")}` });

  /** Refresh until `probe` holds. */
  async function until(sessions: Sessions, probe: () => boolean): Promise<void> {
    await vi.waitFor(
      async () => {
        await sessions.refresh();
        expect(probe()).toBe(true);
      },
      { timeout: 8000, interval: 20 },
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/prs-");
    socketPath = join(dir, "k.sock");
    state = stateFolderOf(join(dir, "ud"));
    lines = [];
    keeper = await runKeeper({
      app: APP_ID,
      socketPath,
      stateDir: join(state, "keeper"),
      ownerKey: KEY,
      version: VERSION,
      env: { ...process.env, SHELL: "/bin/sh", HOME: dir },
      log: () => undefined,
    });
  });

  afterEach(async () => {
    for (const sessions of opened.splice(0)) await sessions.close();
    await keeper.close();
    // The keeper still records the ends of the sessions its close killed.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("starts a service under its job's session id, with its run's output log, and records whose it is", async () => {
    const { sessions } = await connected();
    const web = await sessions.spawn({ kind: "service", job: "coda/web" }, command("echo hello from web; exec sleep 30", { actions: [{ id: "restart", title: "Restart" }] }));
    expect(web).toMatchObject({
      id: "svc:coda.web",
      job: "coda/web",
      kind: "service",
      run: expect.stringMatching(/^20261117-080000-[0-9a-f]{6}$/) as string,
      info: { title: "Web", cwd: dir, state: "running", actions: [{ id: "restart", title: "Restart" }] },
    });
    expect(web.log).toBe(join(dir, "ud/app-state/pomade-runner/output/coda.web", `${web.run ?? ""}.log`));
    await vi.waitFor(async () => expect(await readFile(web.log ?? "", "utf8")).toContain("hello from web"));
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(join(state, "sessions.json"), "utf8"))).toEqual({
        sessions: { "svc:coda.web": { job: "coda/web", kind: "service", run: web.run, log: web.log, exit: null } },
      }),
    );
    await expect(sessions.spawn({ kind: "service", job: "coda/web" }, command("true"))).rejects.toThrow("session svc:coda.web is running");
    const owner = runOf("coda/web");
    const run = await sessions.spawn(owner, command("exit 0"));
    expect(run).toMatchObject({ id: `run:coda.web:${owner.run}`, run: owner.run, log: liveOutputLogPath(state, "coda/web", owner.run) });
    expect(lines).toContain(`session svc:coda.web: started — pid ${web.info.pid ?? ""}, in ${dir}`);
  });

  it("runs low-priority sessions with background priority", async () => {
    const { sessions } = await connected();
    const low = await sessions.spawn({ kind: "service", job: "low" }, command("exec sleep 30", { background: true }));
    await vi.waitFor(() => expect(execFileSync("ps", ["-o", "command=", "-p", String(low.info.pid)], { encoding: "utf8" })).toContain("taskpolicy -b"));
  });

  it("reports each end once, with the keeper's reason: exited, crashed (kill -9), stopped, time-limit, stopped-by-you", async () => {
    const { sessions, ended } = await connected();
    await sessions.spawn(runOf("done"), command("exit 0"));
    const crash = await sessions.spawn({ kind: "service", job: "crash" }, command("exec sleep 30"));
    const stop = await sessions.spawn({ kind: "service", job: "stop" }, command("exec sleep 30"));
    const limit = await sessions.spawn({ kind: "service", job: "limit" }, command("trap '' TERM; while :; do sleep 0.05; done"));
    const you = await sessions.spawn({ kind: "service", job: "you" }, command("exec sleep 30"));

    process.kill(await childOf(crash.info.pid), "SIGKILL");
    await sessions.stop(stop.id, "stopped");
    await sessions.stop(limit.id, "time-limit", 200);
    await sessions.stop(you.id, "stopped-by-you");
    await until(sessions, () => ended.length === 5);
    const reasons = Object.fromEntries(ended.map((session) => [session.job, session.info.exit]));
    expect(reasons).toEqual({
      done: expect.objectContaining({ reason: "exited", code: 0 }) as unknown,
      crash: expect.objectContaining({ reason: "crashed", code: 137, signal: "SIGKILL" }) as unknown,
      stop: expect.objectContaining({ reason: "stopped" }) as unknown,
      limit: expect.objectContaining({ reason: "time-limit" }) as unknown,
      you: expect.objectContaining({ reason: "stopped-by-you" }) as unknown,
    });
    await sessions.refresh();
    expect(ended).toHaveLength(5);
  });

  it("a restarted scheduler rebuilds its view from the keeper and its records, and reports only the ends it missed", async () => {
    const first = await connected();
    const web = await first.sessions.spawn({ kind: "service", job: "coda/web" }, command("exec sleep 30"));
    const gone = await first.sessions.spawn({ kind: "service", job: "gone" }, command("exit 3"));
    await until(first.sessions, () => first.ended.length === 1);
    await first.sessions.close();

    // While no scheduler runs: a session ends, and one Runner did not start appears.
    process.kill(await childOf(web.info.pid), "SIGKILL");
    await vi.waitFor(() => expect(keeper.sessions().find((info) => info.id === web.id)?.state).toBe("exited"));
    expect(keeper.sessions().find((info) => info.id === gone.id)?.exit?.reason).toBe("crashed");

    const second = await connected();
    expect(second.sessions.list().map(({ id, job, run, log }) => ({ id, job, run, log }))).toEqual([
      { id: web.id, job: "coda/web", run: web.run, log: web.log },
      { id: gone.id, job: "gone", run: gone.run, log: gone.log },
    ]);
    expect(second.ended.map((session) => [session.id, session.info.exit?.reason])).toEqual([[web.id, "crashed"]]);
    await vi.waitFor(async () => {
      const { sessions } = JSON.parse(await readFile(join(state, "sessions.json"), "utf8")) as { sessions: Record<string, { exit: { reason: string } | null }> };
      expect([sessions[web.id]?.exit?.reason, sessions[gone.id]?.exit?.reason]).toEqual(["crashed", "crashed"]);
    });
  });

  it("reads a session it has no record of from its id; skips ids it does not make", async () => {
    await rm(join(state, "sessions.json"), { force: true });
    const owner = await connected();
    await owner.sessions.spawn({ kind: "service", job: "coda/web" }, command("exec sleep 30"));
    await owner.sessions.close();
    await rm(join(state, "sessions.json"), { force: true });
    await writeFile(join(state, "sessions.json"), "{ not json");

    const { sessions } = await connected();
    expect(sessions.list()).toEqual([expect.objectContaining({ id: "svc:coda.web", job: "coda/web", kind: "service", run: null, log: null })]);
    expect(lines).toContain(`keeper: ${join(state, "sessions.json")} is not readable JSON; starting from the keeper's list alone`);
  });

  it("restarts a service under the same id: the old session ends as stopped, the new one runs with a new run and log", async () => {
    const { sessions, ended } = await connected();
    const before = await sessions.spawn({ kind: "service", job: "web" }, command("exec sleep 30"));
    const after = await sessions.restartService("web", command("echo second; exec sleep 30"));
    expect(after.id).toBe(before.id);
    expect(after.run).not.toBe(before.run);
    expect(after.log).not.toBe(before.log);
    expect(after.info.pid).not.toBe(before.info.pid);
    expect(after.info.state).toBe("running");
    expect(ended.map((session) => [session.id, session.run, session.info.exit?.reason])).toEqual([[before.id, before.run, "stopped"]]);
    // A service that is not running just starts.
    await sessions.stop(after.id, "stopped-by-you");
    await until(sessions, () => ended.length === 2);
    expect((await sessions.restartService("web", command("exec sleep 30"))).info.state).toBe("running");
  });

  it("forgets an ended session in the keeper and in its records; refuses to forget a running one", async () => {
    const { sessions, ended } = await connected();
    const done = await sessions.spawn(runOf("once"), command("exit 0"));
    const running = await sessions.spawn({ kind: "service", job: "web" }, command("exec sleep 30"));
    await until(sessions, () => ended.length === 1);
    await sessions.forget(done.id);
    await expect(sessions.forget(running.id)).rejects.toThrow("is running");
    expect(sessions.list().map((session) => session.id)).toEqual([running.id]);
    expect(keeper.sessions().map((info) => info.id)).toEqual([running.id]);
    await vi.waitFor(async () => expect(Object.keys((JSON.parse(await readFile(join(state, "sessions.json"), "utf8")) as { sessions: object }).sessions)).toEqual([running.id]));
  });

  it("keeps a run's whole output in its log, past the keeper's scrollback", async () => {
    const { sessions, ended } = await connected();
    const loud = await sessions.spawn(runOf("loud"), command("i=1; while [ $i -le 3000 ]; do echo line $i; i=$((i+1)); done"));
    await until(sessions, () => ended.length === 1);
    const lines = (await readFile(loud.log ?? "", "utf8")).split(/\r?\n/).filter((line) => line.startsWith("line "));
    expect(lines).toHaveLength(3000);
    expect(lines.at(-1)).toBe("line 3000");
  });

  it("is refused by a keeper that does not take its key, and says so", async () => {
    const { sessions } = open("wrong-key");
    await sessions.refresh();
    expect(sessions.keeper()).toEqual({ state: "rejected", reason: `not the owner of ${APP_ID}'s keeper` });
    expect(sessions.followed()).toBe(false);
    await expect(sessions.spawn({ kind: "service", job: "web" }, command("true"))).rejects.toThrow(`the keeper is not connected (not the owner of ${APP_ID}'s keeper)`);
    expect(lines).toContain(`keeper: refused the scheduler — not the owner of ${APP_ID}'s keeper`);
  });

  it("a keeper found running means no login: the scheduler did not start it", async () => {
    const s = open();
    expect(s.sessions.startedKeeper()).toBe(false);
    await s.sessions.refresh();
    expect(s.sessions.startedKeeper()).toBe(false);
    expect(lines.some((line) => line.startsWith("keeper: started"))).toBe(false);
  });

  it("reconnects when the connection to the keeper ends", async () => {
    const { sessions } = await connected();
    await keeper.close();
    keeper = await runKeeper({ app: APP_ID, socketPath, stateDir: join(state, "keeper"), ownerKey: KEY, version: VERSION, env: { ...process.env, SHELL: "/bin/sh", HOME: dir }, log: () => undefined });
    await vi.waitFor(() => expect(lines).toContain("keeper: connection closed; reconnecting"));
    expect(sessions.followed()).toBe(false);
    await sessions.refresh();
    expect(sessions.followed()).toBe(true);
    expect(sessions.keeper()).toMatchObject({ state: "connected" });
  });
});
