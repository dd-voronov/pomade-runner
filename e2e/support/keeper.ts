// The keeper a spec's scheduler started: asked over its socket as a viewer, as Pomade asks it, and
// stopped in teardown with everything it runs — a keeper outlives the scheduler by design. Its
// sessions are started and read through the scheduler's control socket.

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

/** Stop the keeper at `socketPath`: its sessions end with it (the kernel hangs up their terminals).
 *  `pids` are processes it ran, killed too should one outlive the hang-up. */
export async function stopKeeper(socketPath: string, pids: readonly number[] = []): Promise<void> {
  const keeper = await keeperAt(socketPath);
  if (keeper !== null) {
    process.kill(keeper.pid, "SIGKILL");
    await gone(keeper.pid);
  }
  for (const pid of pids) {
    if (alive(pid)) process.kill(pid, "SIGKILL");
    await gone(pid);
  }
}

/** Start a service job's session through the scheduler's control socket. */
export async function startService(schedulerSocket: string, job: string): Promise<RunnerSession> {
  const result = await callScheduler(schedulerSocket, "start", { job });
  if (result.status !== "ok") throw new Error(`start ${job}: ${result.status === "failed" ? result.message : result.status}`);
  return result.value;
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
