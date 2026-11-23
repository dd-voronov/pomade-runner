import { describe, expect, it } from "vitest";

import { aheadWords, soonWords, wordsChangeIn } from "./runWords";

const NOW = new Date(2026, 10, 18, 12, 20).getTime();
const second = (seconds: number): number => NOW + seconds * 1000;

describe("run times in words", () => {
  it("says how far ahead", () => {
    const ahead = (minutes: number): string => aheadWords(NOW + minutes * 60_000, NOW);
    expect([-5, 0, 40, 59, 60, 125, 23 * 60 + 59, 24 * 60, 3 * 24 * 60].map(ahead)).toEqual([
      "now",
      "now",
      "in 40 min",
      "in 59 min",
      "in 1 h",
      "in 2 h 5 min",
      "in 23 h 59 min",
      "in 1 day",
      "in 3 days",
    ]);
  });

  it("counts seconds under a minute, minutes as a clock reader does from there", () => {
    const at = (seconds: number): string => aheadWords(second(seconds), NOW);
    expect([-1, 0, 0.4, 1, 30, 56, 59, 59.5, 60, 61, 90, 119, 120, 121, 3599].map(at)).toEqual([
      "now",
      "now",
      "in 1 s",
      "in 1 s",
      "in 30 s",
      "in 56 s",
      "in 59 s",
      "in 1 min",
      "in 1 min",
      "in 2 min",
      "in 2 min",
      "in 2 min",
      "in 2 min",
      "in 3 min",
      "in 1 h",
    ]);
  });

  it("reads a run due at 17:51 as 2 min from 17:49:00 to 17:50:00, as the clock does", () => {
    const due = new Date(2026, 10, 18, 17, 51).getTime();
    const from = (minute: number, seconds: number): string => aheadWords(due, new Date(2026, 10, 18, 17, minute, seconds).getTime());
    expect([from(49, 0), from(49, 10), from(49, 59), from(50, 0)]).toEqual(["in 2 min", "in 2 min", "in 2 min", "in 1 min"]);
    expect([from(50, 4), from(50, 59), from(51, 0), from(51, 1)]).toEqual(["in 56 s", "in 1 s", "now", "now"]);
  });
});

describe("the countdown within the hour", () => {
  it("is the same words from either place, and none from an hour out", () => {
    expect(soonWords(second(90), NOW)).toBe("in 2 min");
    expect(soonWords(second(3599), NOW)).toBe("in 1 h");
    expect(soonWords(second(3600), NOW)).toBeNull();
    expect(soonWords(second(-3), NOW)).toBe("now");
  });

  it("knows when its words next change", () => {
    const wait = (seconds: number): number | null => wordsChangeIn(second(seconds), NOW);
    expect([wait(0), wait(-4), wait(0.5), wait(30), wait(59.5), wait(60), wait(61), wait(90), wait(120), wait(3599), wait(3600), wait(7200)]).toEqual([
      null,
      null,
      500,
      1000,
      500,
      1000,
      1000,
      30_000,
      60_000,
      59_000,
      1,
      3_600_001,
    ]);
  });

  it("changes its words exactly when it says so", () => {
    for (const seconds of [0.5, 17.3, 59, 60, 61, 100, 119.9, 120, 600, 3599]) {
      const at = second(seconds);
      const before = aheadWords(at, NOW);
      const wait = wordsChangeIn(at, NOW) ?? 0;
      expect(aheadWords(at, NOW + wait - 1)).toBe(before);
      expect(aheadWords(at, NOW + wait)).not.toBe(before);
    }
  });
});
