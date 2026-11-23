import { describe, expect, it } from "vitest";

import { isEnvironmentReport, NOTIFICATION_STATES } from "./environment";

describe("the environment report", () => {
  it("accepts every notification state with the skill's place", () => {
    for (const notifications of NOTIFICATION_STATES) expect(isEnvironmentReport({ notifications, skill: { folder: "Knowledge/_skills/apps/pomade-runner-jobs", problem: null } })).toBe(true);
    expect(isEnvironmentReport({ notifications: "allowed", skill: { folder: "skills/pomade-runner-jobs", problem: "cannot write" } })).toBe(true);
  });

  it("refuses what is not one", () => {
    for (const value of [
      null,
      [],
      { notifications: "allowed" },
      { notifications: "maybe", skill: { folder: "s", problem: null } },
      { notifications: "allowed", skill: { folder: 1, problem: null } },
      { notifications: "allowed", skill: { folder: "s" } },
      { notifications: "allowed", skill: { linked: 1, folders: 3 } },
      { notifications: "allowed", skill: null },
    ]) {
      expect(isEnvironmentReport(value)).toBe(false);
    }
  });
});
