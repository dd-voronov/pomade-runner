import { describe, expect, it } from "vitest";

import type { NeedsYouItem } from "../scheduler/model";
import { aheadMoment, goneWords, needLook, nextUpTip, nextUpWords, pastWhen } from "./panelWords";

const NOW = new Date(2026, 10, 18, 12, 20).getTime();
const at = (day: number, hours: number, minutes = 0): number => new Date(2026, 10, day, hours, minutes).getTime();

describe("Next up's time", () => {
  it("counts the minutes within the hour, then names the time", () => {
    expect([NOW + 40 * 60_000, NOW + 59 * 60_000, at(18, 13, 20), at(18, 20), at(19, 7), at(21, 7), at(30, 7)].map((when) => nextUpWords(when, NOW))).toEqual([
      "in 40 min",
      "in 59 min",
      "13:20",
      "20:00",
      "tmrw 7:00",
      "Sat 7:00",
      "Mon 30 Nov 7:00",
    ]);
  });

  it("counts seconds under a minute and says now from the run's moment", () => {
    expect([NOW + 56_000, NOW + 59_000, NOW + 60_000, NOW + 61_000, NOW + 119_000, NOW + 120_000, NOW, NOW - 4000].map((when) => nextUpWords(when, NOW))).toEqual([
      "in 56 s",
      "in 59 s",
      "in 1 min",
      "in 2 min",
      "in 2 min",
      "in 2 min",
      "now",
      "now",
    ]);
  });

  it("says the full moment in its tooltip", () => {
    expect(nextUpTip(at(18, 13, 20), NOW)).toBe("Today 13:20");
    expect(nextUpTip(at(19, 7), NOW)).toBe("Tomorrow 7:00");
    expect(aheadMoment(at(18, 23), NOW)).toBe("today 23:00");
  });
});

describe("a card's time", () => {
  it("names today by its clock, yesterday, the week by its day and older days by date", () => {
    expect([at(18, 11, 20), at(17, 18), at(15, 3), at(10, 9)].map((when) => pastWhen(when, NOW))).toEqual(["11:20", "yesterday", "Sun 3:00", "10 Nov"]);
  });

  it("counts a run's time in hours and minutes", () => {
    expect([0, 59_000, 45 * 60_000, 60 * 60_000, (3 * 60 + 2) * 60_000].map(goneWords)).toEqual(["0m", "0m", "45m", "1h 00m", "3h 02m"]);
  });
});

describe("a Needs-you card's look", () => {
  const base = { name: "Job", project: null, job: "job" };
  const look = (item: NeedsYouItem) => needLook(item, NOW);

  it("is red for a failed run and a service that gave up, amber for what waits for you", () => {
    const failed: NeedsYouItem = { ...base, id: "run-failed:job", kind: "run-failed", run: "r", at: at(18, 11, 20), count: 2, detail: "exit 1" };
    expect(look(failed)).toEqual({ tone: "danger", help: "need.failed", when: "11:20", text: "Failed: exit 1 · 2×" });
    expect(look({ ...failed, count: 1 }).text).toBe("Failed: exit 1");
    expect(look({ ...base, id: "service-failed:job", kind: "service-failed", at: at(18, 11, 20), detail: "x" })).toEqual({
      tone: "danger",
      help: "need.crashloop",
      when: "11:20",
      text: "Crashed 5× in 1 min — gave up.",
    });
    expect(look({ ...base, id: "missed:job", kind: "missed", run: "r", at: at(15, 3), detail: "x" })).toEqual({
      tone: "warning",
      help: "need.waitforme",
      when: "Sun 3:00",
      text: "Missed — it waits for you to pick a time.",
    });
    expect(look({ ...base, id: "loop-paused:job", kind: "loop-paused", at: at(17, 18), detail: "x" })).toEqual({
      tone: "warning",
      help: "need.loopguard",
      when: "yesterday",
      text: "Paused: triggered 10× in 10 min.",
    });
  });

  it("says what an agent run waits at, and how long it has waited", () => {
    const item: NeedsYouItem = { ...base, id: "waiting:job:r", kind: "waiting", run: "r", prompt: "permission", at: NOW - 17 * 60_000, detail: "waiting for approval" };
    expect(look(item)).toEqual({ tone: "warning", help: "need.approval", when: "17m", text: "Waiting for approval at a permission prompt." });
    expect(look({ ...item, prompt: "trust", at: NOW - 12_000 })).toEqual({ tone: "warning", help: "need.approval", when: "12s", text: "Waiting for you to trust its folder." });
  });

  it("counts a long run's time and says it in hours", () => {
    const item: NeedsYouItem = { ...base, id: "long-run:job:r", kind: "long-run", run: "r", at: NOW, startedAt: NOW - (3 * 60 + 2) * 60_000, detail: "x" };
    expect(look(item)).toEqual({ tone: "accent", help: "need.longrun", when: "3h 02m", text: "Running 3h — still expected?" });
    expect(look({ ...item, startedAt: NOW - 45 * 60_000 }).text).toBe("Running 45m — still expected?");
  });
});
