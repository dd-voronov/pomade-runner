import { describe, expect, it } from "vitest";

import {
  gitResultPath,
  keeperOutPath,
  keeperSocketPath,
  keptOutputLogPath,
  liveOutputLogPath,
  outputLogName,
  recordsFolderOf,
  schedulerSocketPath,
  serviceHoldsPath,
  sessionsRecordPath,
  stateFolder,
  stateFolderOf,
  supervisionRecordPath,
} from "./locations";

describe("locations", () => {
  const env = { POMADE_APP_KEY_FILE: "/Users/me/Library/Application Support/pomade-dev/app-keys/pomade-runner" };

  it("finds the state folder in the user data of the Pomade that issued the key", () => {
    expect(stateFolder(env)).toBe("/Users/me/Library/Application Support/pomade-dev/app-state/pomade-runner");
  });

  it("puts the scheduler socket in the state folder", () => {
    expect(schedulerSocketPath(env)).toBe("/Users/me/Library/Application Support/pomade-dev/app-state/pomade-runner/scheduler.sock");
  });

  it("has no location outside a Pomade", () => {
    expect(stateFolder({})).toBeNull();
    expect(schedulerSocketPath({ POMADE_APP_KEY_FILE: "" })).toBeNull();
  });

  it("finds the keeper's socket where Pomade says, and nowhere when it does not", () => {
    expect(keeperSocketPath({ POMADE_KEEPER_SOCKET: "/ud/run/keepers/pomade-runner.sock" })).toBe("/ud/run/keepers/pomade-runner.sock");
    expect(keeperSocketPath({ POMADE_KEEPER_SOCKET: "" })).toBeNull();
    expect(keeperSocketPath({})).toBeNull();
  });

  it("keeps the session records, the keeper's output, the output being written and this Mac's supervision in the state folder", () => {
    const state = stateFolderOf("/ud");
    expect(sessionsRecordPath(state)).toBe("/ud/app-state/pomade-runner/sessions.json");
    expect(keeperOutPath(state)).toBe("/ud/app-state/pomade-runner/keeper/keeper.out");
    expect(supervisionRecordPath(state)).toBe("/ud/app-state/pomade-runner/services.json");
    expect(liveOutputLogPath(state, "blog/dev-server", "20261117-080000-a1b2c3")).toBe("/ud/app-state/pomade-runner/output/blog.dev-server/20261117-080000-a1b2c3.log");
    expect(liveOutputLogPath(state, "My Project/web", "20261117-080000-a1b2c3")).toBe("/ud/app-state/pomade-runner/output/My_20Project.web/20261117-080000-a1b2c3.log");
    expect(outputLogName("My Project/web", "20261117-080000-a1b2c3")).toBe("output/My_20Project.web/20261117-080000-a1b2c3.log");
    expect(gitResultPath(state, "pull", "20261117-080000-a1b2c3")).toBe("/ud/app-state/pomade-runner/output/pull/20261117-080000-a1b2c3.json");
  });

  it("keeps the records and the finished runs' output logs in the workspace, beside the jobs folder", () => {
    const records = recordsFolderOf("/ws");
    expect(records).toBe("/ws/Apps/pomade-runner/records");
    expect(keptOutputLogPath(records, "My Project/web", "20261117-080000-a1b2c3")).toBe("/ws/Apps/pomade-runner/records/output/My_20Project.web/20261117-080000-a1b2c3.log");
    expect(serviceHoldsPath(records)).toBe("/ws/Apps/pomade-runner/records/services.json");
  });
});
