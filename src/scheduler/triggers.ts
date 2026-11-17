// When a scheduled job runs (docs/DESIGN.md "Triggers"): on every tick the scheduler asks which of
// a schedule's occurrences fell since its previous look. The occurrences come from `pomade-kit`'s
// engine — local time, the Mac's clock, DST rules — never computed here. Pure.

import { occurrencesBetween, type Schedule } from "pomade-kit/schedule";

/** An occurrence the scheduler sees at most this late still runs; an older one is missed — the
 *  Mac slept through it, the clock jumped past it — and missed occurrences are E-003's. */
export const ON_TIME_MS = 5 * 60_000;

export interface Due {
  /** The occurrence to run now; `null` when none is due on time. */
  fire: Date | null;
  /** Occurrences passed without a run, earliest first. */
  missed: Date[];
}

/**
 * What a schedule asks for at `now`, given the scheduler last looked at `since`: its occurrences in
 * `(since, now]`. The latest one runs when it is at most `ON_TIME_MS` old; every other one is
 * missed. A clock set back (`now` before `since`) is a fresh start: nothing is due.
 */
export function dueOccurrences(schedule: Schedule, since: Date, now: Date): Due {
  if (now.getTime() <= since.getTime()) return { fire: null, missed: [] };
  const passed = occurrencesBetween(schedule, since, now);
  const latest = passed.at(-1);
  if (latest === undefined) return { fire: null, missed: [] };
  if (now.getTime() - latest.getTime() > ON_TIME_MS) return { fire: null, missed: passed };
  return { fire: latest, missed: passed.slice(0, -1) };
}
