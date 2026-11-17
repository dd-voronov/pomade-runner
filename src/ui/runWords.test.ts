import { describe, expect, it } from "vitest";

import { aheadWords, dayTime } from "./runWords";

const NOW = new Date(2026, 10, 18, 12, 20).getTime();

describe("run times in words", () => {
  it("says how far ahead", () => {
    const ahead = (minutes: number): string => aheadWords(NOW + minutes * 60_000, NOW);
    expect([-5, 0, 0.5, 40, 59, 60, 125, 23 * 60 + 59, 24 * 60, 3 * 24 * 60].map(ahead)).toEqual([
      "now",
      "now",
      "in 1 min",
      "in 40 min",
      "in 59 min",
      "in 1 h",
      "in 2 h 5 min",
      "in 23 h 59 min",
      "in 1 day",
      "in 3 days",
    ]);
  });

  it("says a moment's weekday and time", () => {
    expect(dayTime(new Date(2026, 10, 18, 13, 0).getTime())).toBe("Wed 13:00");
    expect(dayTime(new Date(2026, 10, 22, 7, 5).getTime())).toBe("Sun 07:05");
  });
});
