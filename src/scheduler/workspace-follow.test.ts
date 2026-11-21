// The scheduler on the workspace Pomade records: waiting while there is none, starting on one,
// starting again on another, and the starts that do not happen.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Scheduler, StartResult } from "./scheduler";
import { followWorkspace, type Following } from "./workspace-follow";

describe("following the workspace", () => {
  let workspace: string | null;
  let lines: string[];
  let events: string[];
  let following: Following | null = null;

  function scheduler(on: string): Scheduler {
    return {
      status: () => ({ version: "0", pid: 1, startedAt: "", lastTickAt: null, pomade: "disconnected" }),
      jobs: () => ({ workspace: on, projectsChecked: false, jobs: [] }),
      stop: () => {
        events.push(`stop ${on}`);
        return Promise.resolve();
      },
    };
  }

  function follow(start: (on: string) => StartResult = (on) => ({ status: "started", scheduler: scheduler(on) })): Following {
    following = followWorkspace({
      workspace: () => workspace,
      start: (on) => {
        events.push(`start ${on}`);
        return Promise.resolve(start(on));
      },
      pollMs: 5,
      log: (line) => lines.push(line),
    });
    return following;
  }

  const reset = (): void => {
    workspace = null;
    lines = [];
    events = [];
  };
  reset();

  afterEach(async () => {
    await following?.stop();
    following = null;
    reset();
  });

  it("waits while no workspace is known, says so once, and starts once one is", async () => {
    const run = follow();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(events).toEqual([]);
    expect(run.scheduler()).toBeNull();
    expect(lines).toEqual(["waiting for a workspace: Pomade has not recorded one — the scheduler starts once it does"]);
    workspace = "/ws";
    await vi.waitFor(() => expect(events).toEqual(["start /ws"]));
    expect(run.scheduler()?.jobs().workspace).toBe("/ws");
  });

  it("starts again on another workspace, and stays on the last one when none is recorded", async () => {
    workspace = "/ws";
    const run = follow();
    await vi.waitFor(() => expect(events).toEqual(["start /ws"]));
    workspace = null;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(["start /ws"]);
    workspace = "/other";
    await vi.waitFor(() => expect(events).toEqual(["start /ws", "stop /ws", "start /other"]));
    expect(lines).toEqual(["workspace: /other — the scheduler starts again on it"]);
    expect(run.scheduler()?.jobs().workspace).toBe("/other");
    await run.stop();
    expect(events.at(-1)).toBe("stop /other");
    expect(await run.ended).toEqual({ status: "stopped" });
  });

  it("ends when another scheduler is in charge, or the start fails", async () => {
    workspace = "/ws";
    expect(await follow(() => ({ status: "already-running" })).ended).toEqual({ status: "already-running" });
    expect(await follow(() => ({ status: "failed", reason: "no socket" })).ended).toEqual({ status: "failed", reason: "no socket" });
  });

  it("stops while it waits", async () => {
    const run = follow();
    await run.stop();
    expect(await run.ended).toEqual({ status: "stopped" });
    expect(events).toEqual([]);
  });
});
