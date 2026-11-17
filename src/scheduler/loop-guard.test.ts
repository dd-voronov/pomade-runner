// The loop safety net on a clock the tests set: the 11th firing within 10 minutes pauses, the window
// slides, a pause holds until Resume, and what is kept survives a file.

import { describe, expect, it } from "vitest";

import { createLoopGuard, FIRING_LIMIT, FIRING_WINDOW_MS, parseLoopGuard } from "./loop-guard";

const MIN = 60_000;
const job = { id: "b", name: "B", project: "p1" };
const T0 = Date.parse("2026-11-18T12:00:00.000Z");

describe("the loop guard", () => {
  it("is 10 firings in 10 minutes", () => {
    expect([FIRING_LIMIT, FIRING_WINDOW_MS]).toEqual([10, 10 * MIN]);
  });

  it("fires 10 times; the 11th within the window pauses the job, and every later firing finds it paused", () => {
    const guard = createLoopGuard();
    const verdicts = Array.from({ length: 13 }, (_, i) => guard.fire(job, T0 + i * 30_000));
    expect(verdicts).toEqual([...Array<string>(10).fill("fire"), "pause", "paused", "paused"]);
    expect([...guard.paused()]).toEqual([["b", { name: "B", project: "p1", at: T0 + 10 * 30_000 }]]);
  });

  it("11 firings at the same moment pause too", () => {
    const guard = createLoopGuard();
    for (let i = 0; i < 10; i++) expect(guard.fire(job, T0)).toBe("fire");
    expect(guard.fire(job, T0)).toBe("pause");
  });

  it("the window slides: a firing 10 minutes old no longer counts", () => {
    const guard = createLoopGuard();
    for (let i = 0; i < 10; i++) guard.fire(job, T0 + i * MIN);
    // The first firing (T0) is exactly 10 minutes old at T0 + 10 min: out of the window.
    expect(guard.fire(job, T0 + 10 * MIN)).toBe("fire");
    // T0 + 1 min is 9 min 59.999 s old here: 11 in the window.
    expect(guard.fire(job, T0 + 11 * MIN - 1)).toBe("pause");
  });

  it("one firing a minute never pauses; jobs are counted apart", () => {
    const guard = createLoopGuard();
    for (let i = 0; i < 100; i++) expect(guard.fire(job, T0 + i * (MIN + 1))).toBe("fire");
    const other = { id: "c", name: "C", project: null };
    for (let i = 0; i < 10; i++) {
      expect(guard.fire(job, T0 + 200 * MIN)).toBe("fire");
      expect(guard.fire(other, T0 + 200 * MIN)).toBe("fire");
    }
  });

  it("Resume lifts a pause with a fresh count; resuming a job that is not paused says so", () => {
    const guard = createLoopGuard();
    for (let i = 0; i <= FIRING_LIMIT; i++) guard.fire(job, T0);
    expect(guard.resume("b")).toBe(true);
    expect(guard.paused().size).toBe(0);
    for (let i = 0; i < 10; i++) expect(guard.fire(job, T0 + 1)).toBe("fire");
    expect(guard.resume("b")).toBe(false);
    expect(guard.fire(job, T0 + 2)).toBe("pause");
  });

  it("keeps only the firings within the window, and every pause; a guard made from them goes on where it was", () => {
    const guard = createLoopGuard();
    guard.fire({ id: "old", name: "Old", project: null }, T0);
    for (let i = 0; i < 9; i++) guard.fire(job, T0 + 5 * MIN);
    for (let i = 0; i <= FIRING_LIMIT; i++) guard.fire({ id: "x", name: "X", project: null }, T0);
    const kept = guard.records(T0 + 12 * MIN);
    expect(kept).toEqual({ fired: { b: Array<number>(9).fill(T0 + 5 * MIN) }, paused: { x: { name: "X", project: null, at: T0 } } });
    const again = createLoopGuard(parseLoopGuard(JSON.parse(JSON.stringify(kept))));
    expect(again.fire({ id: "x", name: "X", project: null }, T0 + 12 * MIN)).toBe("paused");
    expect(again.fire(job, T0 + 12 * MIN)).toBe("fire");
    expect(again.fire(job, T0 + 12 * MIN)).toBe("pause");
  });

  it("reads only what is readable", () => {
    expect(parseLoopGuard(undefined)).toEqual({ fired: {}, paused: {} });
    expect(parseLoopGuard({ fired: { a: [1, "x", null, 2], b: "no" }, paused: { a: { name: "A", project: null, at: 5 }, b: { name: "B" }, c: null, d: { name: "D", project: 3, at: 1 } } })).toEqual({
      fired: { a: [1, 2] },
      paused: { a: { name: "A", project: null, at: 5 } },
    });
  });
});
