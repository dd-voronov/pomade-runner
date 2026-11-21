import { describe, expect, it } from "vitest";

import { isEnvironmentReport, NOTIFICATION_STATES } from "./environment";

describe("the environment report", () => {
  it("accepts every notification state with the skill's links", () => {
    for (const notifications of NOTIFICATION_STATES) expect(isEnvironmentReport({ notifications, skill: { linked: 1, folders: 3 } })).toBe(true);
  });

  it("refuses what is not one", () => {
    for (const value of [
      null,
      [],
      { notifications: "allowed" },
      { notifications: "maybe", skill: { linked: 1, folders: 3 } },
      { notifications: "allowed", skill: { linked: "1", folders: 3 } },
      { notifications: "allowed", skill: null },
    ]) {
      expect(isEnvironmentReport(value)).toBe(false);
    }
  });
});
