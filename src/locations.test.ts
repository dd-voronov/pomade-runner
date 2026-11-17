import { describe, expect, it } from "vitest";

import { schedulerSocketPath, stateDir } from "./locations";

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
});
