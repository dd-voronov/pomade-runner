// The scheduler on the workspace Pomade records (docs/ARCHITECTURE.md "Data and locations"): Runner's
// records are in the workspace, so the scheduler runs on one workspace at a time.
//
// - **No workspace known** — Pomade never recorded one: the scheduler waits. It looks again every
//   `pollMs`, serves nothing, starts no keeper and writes nothing anywhere; the log says once that it
//   waits. With no workspace there are no jobs to run, so waiting loses nothing.
// - **A workspace known**: the scheduler starts on it.
// - **The workspace changes** (another one recorded): the scheduler stops — the keeper and its
//   sessions keep running — and starts on the new one, with that workspace's records. One no longer
//   recorded leaves the scheduler where it is.

import type { Log } from "./log";
import type { Scheduler, StartResult } from "./scheduler";

export interface FollowOptions {
  /** The workspace root Pomade records now (absolute), or `null`. */
  workspace(): string | null;
  /** Start the scheduler on a workspace. */
  start(workspace: string): Promise<StartResult>;
  /** How often the workspace is looked at again. */
  pollMs: number;
  log: Log;
}

export type FollowEnd =
  /** Another scheduler serves the control socket; it stays in charge. */
  | { status: "already-running" }
  | { status: "failed"; reason: string }
  | { status: "stopped" };

export interface Following {
  /** Resolves when following ends: a start that did not happen, or `stop()`. */
  ended: Promise<FollowEnd>;
  /** The scheduler running now, or `null` while it waits for a workspace or between two. */
  scheduler(): Scheduler | null;
  /** Stop following, and the scheduler running. */
  stop(): Promise<void>;
}

export function followWorkspace(options: FollowOptions): Following {
  const { log } = options;
  let current: Scheduler | null = null;
  let stopped = false;
  /** Read afresh after every wait: `stop()` sets it meanwhile. */
  const ending = (): boolean => stopped;
  let wake: (() => void) | null = null;

  const pause = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, options.pollMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  async function follow(): Promise<FollowEnd> {
    let waiting = false;
    while (!ending()) {
      const workspace = options.workspace();
      if (workspace === null) {
        if (!waiting) log("waiting for a workspace: Pomade has not recorded one — the scheduler starts once it does");
        waiting = true;
        await pause();
        continue;
      }
      waiting = false;
      const result = await options.start(workspace);
      if (result.status !== "started") return result;
      current = result.scheduler;
      let next = workspace;
      while (!ending() && next === workspace) {
        await pause();
        next = options.workspace() ?? workspace;
      }
      const running = current;
      current = null;
      if (!ending()) log(`workspace: ${next} — the scheduler starts again on it`);
      await running.stop();
    }
    return { status: "stopped" };
  }

  let stopping: Promise<void> | null = null;
  const ended = follow();
  return {
    ended,
    scheduler: () => current,
    stop() {
      stopping ??= (async () => {
        stopped = true;
        wake?.();
        await ended;
      })();
      return stopping;
    },
  };
}
