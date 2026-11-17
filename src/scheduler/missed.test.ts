// The missed-run policies on Madrid's clock: one decision however many runs were missed, the
// worth-until edges, DST, schedules with no next run.

process.env.TZ = "Europe/Madrid";

import { parseSchedule, type Schedule } from "pomade-kit/schedule";
import { describe, expect, it } from "vitest";

import { decideMissed, parseRunAt, worthDeadline, type MissedJob } from "./missed";

function schedule(value: unknown): Schedule {
  const result = parseSchedule(value, { resolution: "time" });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.schedule;
}

const at = (text: string): Date => new Date(text);
const ms = (text: string): number => at(text).getTime();

const DAILY_7 = schedule({ daily: { at: "7:00" } });
const job = (missed: MissedJob["missed"], worthUntil: string | null = missed === "run-on-wake" ? "next-run" : null, s: Schedule = DAILY_7): MissedJob => ({ missed, worthUntil, schedule: s });

describe("missed-run policies", () => {
  it("run on wake: one catch-up for the latest missed run, however many were missed, until the next run", () => {
    expect(decideMissed(job("run-on-wake"), [at("2026-11-18T07:00:00")], at("2026-11-18T08:30:00"))).toEqual({ action: "catch-up", dueAt: at("2026-11-18T07:00:00"), deadline: ms("2026-11-19T07:00:00") });
    const hourly = job("run-on-wake", "next-run", schedule({ every: { hours: 1 } }));
    const missed = ["05:00", "06:00", "07:00", "08:00"].map((time) => at(`2026-11-18T${time}:00`));
    expect(decideMissed(hourly, missed, at("2026-11-18T08:20:00"))).toEqual({ action: "catch-up", dueAt: at("2026-11-18T08:00:00"), deadline: ms("2026-11-18T09:00:00") });
    expect(decideMissed(hourly, missed, at("2026-11-18T09:00:00"))).toEqual({ action: "record", dueAt: at("2026-11-18T08:00:00"), reason: "skipped · past its next run" });
  });

  it("run on wake until a time of day: worth it before that time, skipped from it on", () => {
    const morning = job("run-on-wake", "12:00");
    const seven = [at("2026-11-18T07:00:00")];
    expect(decideMissed(morning, seven, at("2026-11-18T08:30:00"))).toEqual({ action: "catch-up", dueAt: seven[0], deadline: ms("2026-11-18T12:00:00") });
    expect(decideMissed(morning, seven, at("2026-11-18T11:59:59"))).toMatchObject({ action: "catch-up" });
    expect(decideMissed(morning, seven, at("2026-11-18T12:00:00"))).toEqual({ action: "record", dueAt: seven[0], reason: "skipped · past 12:00" });
    expect(decideMissed(morning, seven, at("2026-11-18T15:00:00"))).toEqual({ action: "record", dueAt: seven[0], reason: "skipped · past 12:00" });
    // A day later, it is still past.
    expect(decideMissed(morning, seven, at("2026-11-19T09:00:00"))).toMatchObject({ action: "record" });
  });

  it("the time of day is the first one after the missed run", () => {
    const night = job("run-on-wake", "2:00", schedule({ daily: { at: "22:00" } }));
    expect(worthDeadline(night, at("2026-11-18T22:00:00"))).toBe(ms("2026-11-19T02:00:00"));
    expect(worthDeadline(job("run-on-wake", "12:00", schedule({ daily: { at: "12:00" } })), at("2026-11-18T12:00:00"))).toBe(ms("2026-11-19T12:00:00"));
    expect(worthDeadline(job("run-on-wake", "7:30"), at("2026-11-18T07:00:00"))).toBe(ms("2026-11-18T07:30:00"));
  });

  it("follows DST: a worth-until skipped by spring-forward is later by the gap; the next run across fall-back is the next 7:00", () => {
    const early = job("run-on-wake", "2:30", schedule({ daily: { at: "1:00" } }));
    expect(worthDeadline(early, at("2027-03-28T01:00:00"))).toBe(ms("2027-03-28T03:30:00"));
    expect(decideMissed(early, [at("2027-03-28T01:00:00")], at("2027-03-28T03:29:00"))).toMatchObject({ action: "catch-up" });
    expect(worthDeadline(job("run-on-wake"), at("2026-10-24T07:00:00"))).toBe(ms("2026-10-25T07:00:00"));
    expect(ms("2026-10-25T07:00:00") - ms("2026-10-24T07:00:00")).toBe(25 * 3_600_000);
  });

  it("a schedule with no next run has no deadline: a missed once-at catches up whenever", () => {
    const once = job("run-on-wake", "next-run", schedule({ once: "2026-11-18 23:00" }));
    expect(decideMissed(once, [at("2026-11-18T23:00:00")], at("2026-11-25T09:00:00"))).toEqual({ action: "catch-up", dueAt: at("2026-11-18T23:00:00"), deadline: null });
  });

  it("an on-time run in the same look covers the missed ones of a run-on-wake job", () => {
    const hourly = job("run-on-wake", "12:00", schedule({ every: { hours: 1 } }));
    expect(decideMissed(hourly, [at("2026-11-18T07:00:00"), at("2026-11-18T08:00:00")], at("2026-11-18T09:02:00"), at("2026-11-18T09:00:00"))).toEqual({
      action: "record",
      dueAt: at("2026-11-18T08:00:00"),
      reason: "skipped · the 09:00 run covers it",
    });
  });

  it("wait for me waits, skip records, for the latest missed run; no policy runs it late", () => {
    const missed = [at("2026-11-15T03:00:00"), at("2026-11-16T03:00:00")];
    expect(decideMissed(job("wait-for-me"), missed, at("2026-11-17T09:00:00"))).toEqual({ action: "wait", dueAt: at("2026-11-16T03:00:00") });
    expect(decideMissed(job("wait-for-me"), missed, at("2026-11-17T09:00:00"), at("2026-11-17T09:00:00"))).toEqual({ action: "wait", dueAt: at("2026-11-16T03:00:00") });
    expect(decideMissed(job("skip"), missed, at("2026-11-17T09:00:00"))).toEqual({ action: "record", dueAt: at("2026-11-16T03:00:00"), reason: "skipped" });
    expect(decideMissed({ missed: null, worthUntil: null, schedule: null }, missed, at("2026-11-17T09:00:00"))).toEqual({ action: "catch-up", dueAt: at("2026-11-16T03:00:00"), deadline: null });
    expect(() => decideMissed(job("skip"), [], at("2026-11-17T09:00:00"))).toThrow();
  });
});

describe("Run at…", () => {
  const now = at("2026-11-18T08:30:00");

  it("takes a time, a day and a time, a date-time picker's value, or elapsed time", () => {
    expect(parseRunAt("23:00", now)).toEqual({ ok: true, at: ms("2026-11-18T23:00:00") });
    expect(parseRunAt("7:00", now)).toEqual({ ok: true, at: ms("2026-11-19T07:00:00") });
    expect(parseRunAt(" tomorrow 9:00 ", now)).toEqual({ ok: true, at: ms("2026-11-19T09:00:00") });
    expect(parseRunAt("2026-11-20 23:00", now)).toEqual({ ok: true, at: ms("2026-11-20T23:00:00") });
    expect(parseRunAt("2026-11-20T23:00", now)).toEqual({ ok: true, at: ms("2026-11-20T23:00:00") });
    expect(parseRunAt("+2h", now)).toEqual({ ok: true, at: ms("2026-11-18T10:30:00") });
  });

  it("says why it is not a time to run at", () => {
    expect(parseRunAt("2026-11-17 23:00", now)).toEqual({ ok: false, reason: "2026-11-17 23:00 has passed — pick a later time" });
    expect(parseRunAt("friday", now)).toEqual({ ok: false, reason: "friday names a day — add a time, e.g. friday 9:00" });
    expect(parseRunAt("tomorrow 25:00", now)).toMatchObject({ ok: false });
    expect(parseRunAt("soonish", now)).toEqual({ ok: false, reason: '"soonish" is not a time — write e.g. 23:00, tomorrow 9:00 or +2h' });
  });
});
