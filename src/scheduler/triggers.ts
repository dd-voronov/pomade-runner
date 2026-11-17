// When a scheduled job runs (docs/DESIGN.md "Triggers"): on every tick the scheduler asks which of
// a schedule's occurrences fell since its previous look. The occurrences come from `pomade-kit`'s
// engine — local time, the Mac's clock, DST rules — never computed here. Pure.

import { occurrencesBetween, previousOccurrence, type Schedule } from "pomade-kit/schedule";

/** An occurrence the scheduler sees at most this late still runs on time; an older one is missed —
 *  the Mac slept through it, was off, the clock jumped past it, or the switch held it — and goes to
 *  its job's missed-run policy (`missed.ts`). */
export const ON_TIME_MS = 5 * 60_000;

/** The most occurrences one look lists; a longer absence keeps the earliest and the latest. */
export const MISSED_LIST_MAX = 1000;

export interface Due {
  /** The occurrence to run now; `null` when none is due on time. */
  fire: Date | null;
  /** Occurrences passed without a run, earliest first; the last one is always the latest missed. */
  missed: Date[];
}

/**
 * What a schedule asks for at `now`, given the scheduler last looked at `since`: its occurrences in
 * `(since, now]`. The latest one runs when it is at most `ON_TIME_MS` old; every other one is
 * missed. A clock set back (`now` before `since`) is a fresh start: nothing is due.
 */
export function dueOccurrences(schedule: Schedule, since: Date, now: Date): Due {
  if (now.getTime() <= since.getTime()) return { fire: null, missed: [] };
  let passed = occurrencesBetween(schedule, since, now, { limit: MISSED_LIST_MAX });
  if (passed.length === MISSED_LIST_MAX) {
    // More than the list holds: the earliest ones, then the latest two — what is on time, and the
    // latest missed.
    const latest = previousOccurrence(schedule, new Date(now.getTime() + 1));
    const before = latest === null ? null : previousOccurrence(schedule, latest);
    const kept = passed.slice(0, MISSED_LIST_MAX - 2);
    const floor = kept.at(-1)?.getTime() ?? since.getTime();
    passed = [...kept, ...[before, latest].filter((date): date is Date => date !== null && date.getTime() > floor)];
  }
  const latest = passed.at(-1);
  if (latest === undefined) return { fire: null, missed: [] };
  if (now.getTime() - latest.getTime() > ON_TIME_MS) return { fire: null, missed: passed };
  return { fire: latest, missed: passed.slice(0, -1) };
}
