// The keeper a spec's scheduler started: asked over its socket as a viewer, as Pomade asks it, and
// stopped in teardown with everything it runs — a keeper outlives the scheduler by design. Its
// sessions are read through the scheduler's control socket.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { expect } from "@playwright/test";
import { connectKeeper } from "pomade-kit/node";
import type { SessionInfo } from "pomade-kit/protocol";

import type { RunnerSession, SessionsReport } from "../../src/keeper/model";
import { callScheduler } from "../../src/scheduler/control/client";

/** The keeper's pid and version, or `null` when none answers. */
export async function keeperAt(socketPath: string): Promise<{ pid: number; version: string } | null> {
  const result = await connectKeeper({ socketPath, app: "pomade", timeoutMs: 1000 });
  if (result.status !== "connected") return null;
  const { pid, version } = result.keeper.keeper;
  result.keeper.close();
  return { pid, version };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Kill process group `pgid`, if any of it is left. */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // None of it is left.
  }
}

/** Stop the keeper at `socketPath` with every session it holds: each session's process group — its
 *  shim and what the shim runs — is killed, as a next keeper kills what outlived a crash; a hang-up
 *  alone leaves a program that ignores it, or a shim waiting on one. `pids` are processes it ran,
 *  killed too. */
export async function stopKeeper(socketPath: string, pids: readonly number[] = []): Promise<void> {
  const connected = await connectKeeper({ socketPath, app: "pomade", timeoutMs: 1000 });
  if (connected.status === "connected") {
    const { keeper } = connected;
    // A session's shim leads its own process group (the keeper's setsid).
    const groups = (await keeper.list().catch(() => [])).flatMap((session) => (session.pid === null ? [] : [session.pid]));
    keeper.close();
    process.kill(keeper.keeper.pid, "SIGKILL");
    await gone(keeper.keeper.pid);
    for (const group of groups) killGroup(group);
  }
  // A pid that is not a process's (`?? 0` for a session that had none) would name the process group.
  for (const pid of pids.filter((candidate) => candidate > 0)) {
    if (alive(pid)) process.kill(pid, "SIGKILL");
    await gone(pid);
  }
}

/** What the scheduler reports of the keeper and its sessions. */
export async function sessionsReport(schedulerSocket: string): Promise<SessionsReport> {
  const result = await callScheduler(schedulerSocket, "sessions", null);
  if (result.status !== "ok") throw new Error(`sessions: ${result.status === "failed" ? result.message : result.status}`);
  return result.value;
}

/** The keeper's view of session `id`, as the scheduler reports it. */
export async function sessionInfo(schedulerSocket: string, id: string): Promise<SessionInfo | undefined> {
  return (await sessionsReport(schedulerSocket)).sessions.find((session) => session.id === id)?.info;
}

/** Wait until session `id` runs — another start than `not`, when given — and return it. The wait
 *  covers a service's turn in the staged start: up to two services ahead, 5 s each. */
export async function runningSession(schedulerSocket: string, id: string, not?: RunnerSession): Promise<RunnerSession> {
  let found: RunnerSession | undefined;
  await expect
    .poll(
      async () => {
        found = (await sessionsReport(schedulerSocket)).sessions.find((session) => session.id === id);
        return found?.info.state === "running" && (not === undefined || found.info.startedAt !== not.info.startedAt);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  if (found === undefined) throw new Error(`no session ${id}`);
  return found;
}

/** The processes whose command line names `dir` — a world's keeper, its sessions' shims (their status
 *  files are under it), its fake agents — and every process in their groups. */
export function processesOf(dir: string): { pid: number; pgid: number; command: string }[] {
  const names = [dir, realpathSync(dir)];
  const rows = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match === null ? [] : [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] ?? "" }];
    })
    .filter((row) => row.pid !== process.pid);
  const groups = new Set(rows.filter((row) => names.some((name) => row.command.includes(name))).map((row) => row.pgid));
  return rows.filter((row) => groups.has(row.pgid) && row.pgid > 1).map((row) => ({ pid: row.pid, pgid: row.pgid, command: row.command.replace(/\n/g, " ").slice(0, 160) }));
}

/** The end of a world's teardown: no process of `dir` may be left. One that is gets killed with its
 *  group, and the teardown fails naming it. */
export async function expectNothingLeft(dir: string): Promise<void> {
  let left = processesOf(dir);
  for (let i = 0; i < 50 && left.length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = processesOf(dir);
  }
  if (left.length === 0) return;
  for (const row of left) killGroup(row.pgid);
  throw new Error(`processes of ${dir} outlived its teardown:\n${left.map((row) => `${row.pid} ${row.command}`).join("\n")}`);
}
