// What a job's missed-run policy makes of its missed occurrences (docs/DESIGN.md "Missed runs and
// load"). However many were missed, a job gets one decision, about the latest — and the decision
// keeps how many were missed and the first and last missed time (`MissedRuns`), which the run or
// record it makes carries:
//
// - **`run-on-wake`** — one caught-up run, while it is still worth it: until the job's next
//   occurrence after the missed one (`worth-until: next-run`, the default), or until a time of day
//   (`worth-until: 12:00`: the first 12:00 after the missed occurrence). Past that, or when an
//   on-time run of the job happens in the same look and covers it, it is recorded missed · skipped.
// - **`wait-for-me`** — the run waits for the person: Run now, Run at… or Skip.
// - **`skip`** — recorded missed · skipped.
//
// Pure; local time on the Mac's clock, through `pomade-kit`'s schedule engine.

import { parseDatePhrase } from "pomade-kit/dates";
import { addDays, localDateOf, nextOccurrence, parseTime, toInstant, type Schedule } from "pomade-kit/schedule";

import type { MissedPolicy } from "../jobs/model";
import { clockTime, type MissedRuns } from "./model";

/** What becomes of a job's missed runs (`missed`; its latest, `missed.last`, is the one run or
 *  recorded). */
export type MissedDecision =
  /** Run it once, as `caught-up`, no later than `deadline` (epoch ms; `null`: no such moment). */
  | { action: "catch-up"; missed: MissedRuns; deadline: number | null }
  /** Record it missed, with this reason. */
  | { action: "record"; missed: MissedRuns; reason: string }
  /** Wait for the person. */
  | { action: "wait"; missed: MissedRuns };

/** A single missed run at `at` (epoch ms). */
export const missedOnce = (at: number): MissedRuns => ({ count: 1, first: at, last: at });

/** Two counts of one job's missed runs taken together. */
export function addMissed(a: MissedRuns, b: MissedRuns): MissedRuns {
  return { count: a.count + b.count, first: Math.min(a.first, b.first), last: Math.max(a.last, b.last) };
}

/** What decides: the job's policy and its schedule. A job without a missed-run policy (a hook or a
 *  chain) runs what was held, late. */
export interface MissedJob {
  missed: MissedPolicy | null;
  /** `next-run` or a time of day (`12:00`); with `run-on-wake`. */
  worthUntil: string | null;
  schedule: Schedule | null;
}

/** The moment a catch-up of the occurrence `latest` stops being worth it: the schedule's next
 *  occurrence after it, or the first time of day `worthUntil` after it; `null` when there is none
 *  (a `once` schedule has no next run). */
export function worthDeadline(job: MissedJob, latest: Date): number | null {
  const until = job.worthUntil ?? "next-run";
  if (until === "next-run") return job.schedule === null ? null : (nextOccurrence(job.schedule, latest)?.getTime() ?? null);
  const time = parseTime(until);
  if (time === null) return null;
  const day = localDateOf(latest);
  const same = toInstant(day, time);
  return (same.getTime() > latest.getTime() ? same : toInstant(addDays(day, 1), time)).getTime();
}

/**
 * Decide on `missed` — the occurrences missed — at `now`. `firesNow` is an on-time occurrence of
 * the job in the same look, when there is one.
 */
export function decideMissed(job: MissedJob, missed: MissedRuns, now: Date, firesNow: Date | null = null): MissedDecision {
  switch (job.missed) {
    case null:
      return { action: "catch-up", missed, deadline: null };
    case "skip":
      return { action: "record", missed, reason: "skipped" };
    case "wait-for-me":
      return { action: "wait", missed };
    case "run-on-wake": {
      if (firesNow !== null) return { action: "record", missed, reason: `skipped · the ${clockTime(firesNow.getTime())} run covers it` };
      const deadline = worthDeadline(job, new Date(missed.last));
      if (deadline !== null && now.getTime() >= deadline) return { action: "record", missed, reason: pastWords(job) };
      return { action: "catch-up", missed, deadline };
    }
  }
}

/** Why a catch-up came too late: "skipped · past its next run", "skipped · past 12:00". */
export function pastWords(job: MissedJob): string {
  const until = job.worthUntil ?? "next-run";
  return until === "next-run" ? "skipped · past its next run" : `skipped · past ${until}`;
}

/** Run at…'s time, typed: a time (`23:00`, today's or tomorrow's next), a day and a time
 *  (`tomorrow 9:00`, `fri 9pm`, `2026-11-20 23:00`, `2026-11-20T23:00` as a date-time picker gives
 *  it) or elapsed time (`+2h`) — `pomade-kit`'s date phrases. The moment (epoch ms), or why it is
 *  not one. */
export function parseRunAt(text: string, now: Date): { ok: true; at: number } | { ok: false; reason: string } {
  const typed = text.trim().replace(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})$/, "$1 $2");
  const phrase = parseDatePhrase(typed, { now });
  switch (phrase.kind) {
    case "date-time":
      return phrase.at.getTime() > now.getTime() ? { ok: true, at: phrase.at.getTime() } : { ok: false, reason: `${text.trim()} has passed — pick a later time` };
    case "date":
      return { ok: false, reason: `${text.trim()} names a day — add a time, e.g. ${typed} 9:00` };
    case "invalid":
      return { ok: false, reason: phrase.message };
    case "not-a-date":
      return { ok: false, reason: `"${text.trim()}" is not a time — write e.g. 23:00, tomorrow 9:00 or +2h` };
  }
}
