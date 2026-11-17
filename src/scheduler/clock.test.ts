import { describe, expect, it } from "vitest";

import { TICK_MS, tickMs } from "./clock";

describe("tickMs", () => {
  it("is the production tick when the override is unset, empty or invalid", () => {
    for (const value of [undefined, "", "  ", "0", "-5", "1.5", "20ms", "abc", "9".repeat(30)]) {
      expect(tickMs({ POMADE_RUNNER_TICK_MS: value })).toBe(TICK_MS);
    }
  });

  it("takes a positive integer of milliseconds", () => {
    expect(tickMs({ POMADE_RUNNER_TICK_MS: "20" })).toBe(20);
    expect(tickMs({ POMADE_RUNNER_TICK_MS: " 250 " })).toBe(250);
  });
});
