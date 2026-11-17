import { describe, expect, it } from "vitest";

import { clockFrom, systemClock, TICK_MS, tickMs } from "./clock";

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

describe("clockFrom", () => {
  it("is the system clock when POMADE_RUNNER_CLOCK is unset, empty or not a time", () => {
    for (const value of [undefined, "", " ", "tomorrow"]) expect(clockFrom({ POMADE_RUNNER_CLOCK: value })).toBe(systemClock);
  });

  it("starts at the time given and runs at the rate given", () => {
    let elapsed = 1000;
    const clock = clockFrom({ POMADE_RUNNER_CLOCK: "2026-11-18T12:59:58.000Z", POMADE_RUNNER_CLOCK_RATE: "60" }, () => elapsed);
    expect(clock.now().toISOString()).toBe("2026-11-18T12:59:58.000Z");
    elapsed += 2000;
    expect(clock.now().toISOString()).toBe("2026-11-18T13:01:58.000Z");
  });

  it("runs at rate 1 when the rate is unset or not a positive number", () => {
    for (const rate of [undefined, "", "0", "-2", "fast"]) {
      let elapsed = 0;
      const clock = clockFrom({ POMADE_RUNNER_CLOCK: "2026-11-18T12:00:00.000Z", POMADE_RUNNER_CLOCK_RATE: rate }, () => elapsed);
      elapsed = 1500;
      expect(clock.now().toISOString()).toBe("2026-11-18T12:00:01.500Z");
    }
  });
});
