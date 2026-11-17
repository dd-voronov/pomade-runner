// When a schedule fires, tick by tick, on Madrid's clock: every shape, the weekday filter, DST, a
// clock set back or jumping ahead, and occurrences missed.

process.env.TZ = "Europe/Madrid";

import { parseSchedule, type Schedule } from "pomade-kit/schedule";
import { describe, expect, it } from "vitest";

import { dueOccurrences, ON_TIME_MS } from "./triggers";

function schedule(value: unknown): Schedule {
  const result = parseSchedule(value, { resolution: "time" });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.schedule;
}

/** A local time on Madrid's clock. */
const at = (text: string): Date => new Date(text);
/** `HH:MM` of a local time. */
const hm = (date: Date): string => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** Tick from `from` to `to` every `stepMs`, as the scheduler does; the local times fired. */
function fired(s: Schedule, from: string, to: string, stepMs = 1000): string[] {
  const runs: string[] = [];
  let since = at(from);
  for (let now = since.getTime() + stepMs; now <= at(to).getTime(); now += stepMs) {
    const due = dueOccurrences(s, since, new Date(now));
    expect(due.missed).toEqual([]);
    if (due.fire !== null) runs.push(`${due.fire.toDateString().slice(0, 3)} ${hm(due.fire)}`);
    since = new Date(now);
  }
  return runs;
}

describe("dueOccurrences", () => {
  it("a daily 13:00 fires once, at 13:00, on the tick that passes it", () => {
    const daily = schedule({ daily: { at: "13:00" } });
    expect(fired(daily, "2026-11-18T12:59:00", "2026-11-18T13:01:00")).toEqual(["Wed 13:00"]);
    expect(dueOccurrences(daily, at("2026-11-18T12:59:59"), at("2026-11-18T13:00:00")).fire).toEqual(at("2026-11-18T13:00:00"));
    expect(dueOccurrences(daily, at("2026-11-18T13:00:00"), at("2026-11-18T13:00:01")).fire).toBeNull();
    expect(fired(daily, "2026-11-18T13:00:00", "2026-11-19T13:00:00", 60_000)).toEqual(["Thu 13:00"]);
  });

  it("several times a day fire each", () => {
    expect(fired(schedule({ daily: { at: ["13:00", "20:00"] } }), "2026-11-18T00:00:00", "2026-11-19T00:00:00", 60_000)).toEqual(["Wed 13:00", "Wed 20:00"]);
  });

  it("every 30 min, 9:00–19:00, weekdays only: a Wednesday from 9:00 to 19:00; nothing on a Saturday", () => {
    const every = schedule({ every: { minutes: 30, from: "9:00", to: "19:00" }, only: "weekdays" });
    const wednesday = fired(every, "2026-11-18T00:00:00", "2026-11-19T00:00:00", 60_000);
    expect(wednesday.slice(0, 3)).toEqual(["Wed 09:00", "Wed 09:30", "Wed 10:00"]);
    expect(wednesday.at(-1)).toBe("Wed 19:00");
    expect(wednesday).toHaveLength(21);
    expect(fired(every, "2026-11-21T00:00:00", "2026-11-23T00:00:00", 60_000)).toEqual([]);
    expect(fired(every, "2026-11-22T23:00:00", "2026-11-23T09:31:00", 60_000)).toEqual(["Mon 09:00", "Mon 09:30"]);
  });

  it("weekly on chosen days, and monthly on the last day and the first Monday", () => {
    expect(fired(schedule({ weekly: { days: ["mon", "fri"], at: "7:00" } }), "2026-11-16T00:00:00", "2026-11-23T00:00:00", 60_000)).toEqual(["Mon 07:00", "Fri 07:00"]);
    const monthly = schedule({ monthly: { days: ["last", "first mon"], at: "9:00" } });
    expect(fired(monthly, "2026-11-25T00:00:00", "2026-12-08T00:00:00", 60_000)).toEqual(["Mon 09:00", "Mon 09:00"]);
  });

  it("once at fires once; after it the schedule has nothing due", () => {
    const once = schedule({ once: "2026-11-18 23:00" });
    expect(fired(once, "2026-11-18T22:59:00", "2026-11-19T01:00:00")).toEqual(["Wed 23:00"]);
    expect(dueOccurrences(once, at("2026-11-19T01:00:00"), at("2026-11-30T01:00:00"))).toEqual({ fire: null, missed: [] });
  });

  it("follows DST: a time skipped by spring-forward runs once, later by the gap; a repeated time runs once", () => {
    const skipped = schedule({ daily: { at: "2:30" } });
    expect(fired(skipped, "2026-03-29T00:00:00", "2026-03-29T05:00:00", 60_000)).toEqual(["Sun 03:30"]);
    const repeated = schedule({ daily: { at: "2:30" } });
    expect(fired(repeated, "2026-10-25T00:00:00", "2026-10-25T05:00:00", 60_000)).toEqual(["Sun 02:30"]);
    const hourly = schedule({ every: { hours: 1 } });
    const fall = fired(hourly, "2026-10-25T00:30:00", "2026-10-25T04:30:00", 60_000);
    expect(fall).toEqual(["Sun 01:00", "Sun 02:00", "Sun 03:00", "Sun 04:00"]);
  });

  it("an occurrence seen up to ON_TIME_MS late still runs; a later one is missed, with the others passed", () => {
    const daily = schedule({ daily: { at: ["7:00", "8:00"] } });
    const late = new Date(at("2026-11-18T08:00:00").getTime() + ON_TIME_MS);
    expect(dueOccurrences(daily, at("2026-11-18T07:30:00"), late)).toEqual({ fire: at("2026-11-18T08:00:00"), missed: [] });
    expect(dueOccurrences(daily, at("2026-11-18T06:00:00"), late)).toEqual({ fire: at("2026-11-18T08:00:00"), missed: [at("2026-11-18T07:00:00")] });
    const tooLate = new Date(late.getTime() + 1);
    expect(dueOccurrences(daily, at("2026-11-18T06:00:00"), tooLate)).toEqual({ fire: null, missed: [at("2026-11-18T07:00:00"), at("2026-11-18T08:00:00")] });
  });

  it("a clock set back is a fresh start: nothing is due, and the next look goes on from there", () => {
    const daily = schedule({ daily: { at: "13:00" } });
    expect(dueOccurrences(daily, at("2026-11-18T14:00:00"), at("2026-11-18T12:00:00"))).toEqual({ fire: null, missed: [] });
    expect(dueOccurrences(daily, at("2026-11-18T12:59:59"), at("2026-11-18T13:00:00")).fire).toEqual(at("2026-11-18T13:00:00"));
    expect(dueOccurrences(daily, at("2026-11-18T13:00:00"), at("2026-11-18T13:00:00"))).toEqual({ fire: null, missed: [] });
  });

  it("a clock moved ahead past an occurrence misses it", () => {
    const daily = schedule({ daily: { at: "13:00" } });
    expect(dueOccurrences(daily, at("2026-11-18T12:00:00"), at("2026-11-18T15:00:00"))).toEqual({ fire: null, missed: [at("2026-11-18T13:00:00")] });
  });
});
