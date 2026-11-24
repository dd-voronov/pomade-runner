import { describe, expect, it } from "vitest";

import { wordsChangeIn } from "./runWords";
import { upChangeIn } from "./serviceWords";
import { clockWait } from "./useNow";

const NOW = 5_000_000;

describe("how long a clock waits to be read again", () => {
  it("is the slow cadence when no moment is being counted", () => {
    expect(clockWait([], upChangeIn, NOW, 30_000)).toBe(30_000);
    expect(clockWait([], wordsChangeIn, NOW, 10_000)).toBe(10_000);
    // A moment that changes no more (a countdown that reads "now") adds nothing.
    expect(clockWait([NOW - 4000], wordsChangeIn, NOW, 30_000)).toBe(30_000);
  });

  it("is the next second of the soonest run while one has run under a minute", () => {
    expect(clockWait([NOW - 20_300], upChangeIn, NOW, 30_000)).toBe(700);
    expect(clockWait([NOW - 20_300, NOW - 90_000, NOW - 45_800], upChangeIn, NOW, 30_000)).toBe(200);
  });

  it("is at most 10 s while the runs have run a minute or more, whatever the slow cadence", () => {
    expect(clockWait([NOW - 61_000, NOW - 3_600_000], upChangeIn, NOW, 30_000)).toBe(9000);
    expect(clockWait([NOW - 600_000], upChangeIn, NOW, 30_000)).toBe(10_000);
    expect(clockWait([NOW - 600_000], upChangeIn, NOW, 5000)).toBe(5000);
  });
});
