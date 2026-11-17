import { describe, expect, it } from "vitest";

import { keeperOutPath, keeperSocketPath, outputLogPath, schedulerSocketPath, sessionsRecordPath, stateDir } from "./locations";

describe("locations", () => {
  const env = { POMADE_APP_KEY_FILE: "/Users/me/Library/Application Support/pomade-dev/app-keys/pomade-runner" };

  it("finds the state folder in the user data of the Pomade that issued the key", () => {
    expect(stateDir(env)).toBe("/Users/me/Library/Application Support/pomade-dev/app-state/pomade-runner");
  });

  it("puts the scheduler socket in the state folder", () => {
    expect(schedulerSocketPath(env)).toBe("/Users/me/Library/Application Support/pomade-dev/app-state/pomade-runner/scheduler.sock");
  });

  it("has no location outside a Pomade", () => {
    expect(stateDir({})).toBeNull();
    expect(schedulerSocketPath({ POMADE_APP_KEY_FILE: "" })).toBeNull();
  });

  it("finds the keeper's socket where Pomade says, and nowhere when it does not", () => {
    expect(keeperSocketPath({ POMADE_KEEPER_SOCKET: "/ud/run/keepers/pomade-runner.sock" })).toBe("/ud/run/keepers/pomade-runner.sock");
    expect(keeperSocketPath({ POMADE_KEEPER_SOCKET: "" })).toBeNull();
    expect(keeperSocketPath({})).toBeNull();
  });

  it("keeps the session records, the keeper's output and each run's output log in the state folder", () => {
    const state = "/ud/app-state/pomade-runner";
    expect(sessionsRecordPath(state)).toBe("/ud/app-state/pomade-runner/sessions.json");
    expect(keeperOutPath(state)).toBe("/ud/app-state/pomade-runner/keeper/keeper.out");
    expect(outputLogPath(state, "coda-helper/coda-web", "20261117-080000-a1b2c3")).toBe(
      "/ud/app-state/pomade-runner/output/coda-helper.coda-web/20261117-080000-a1b2c3.log",
    );
    expect(outputLogPath(state, "My Project/web", "20261117-080000-a1b2c3")).toBe("/ud/app-state/pomade-runner/output/My_20Project.web/20261117-080000-a1b2c3.log");
  });
});
