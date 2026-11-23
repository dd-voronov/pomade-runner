// When a scheduled job runs (docs/DESIGN.md "Triggers"): on every tick the scheduler asks which of
// a schedule's occurrences fell since its previous look. The occurrences come from `pomade-kit`'s
// engine — local time, the Mac's clock, DST rules — never computed here. Pure.

import { occurrencesBetween, previousOccurrence, type Schedule } from "pomade-kit/schedule";

import type { MissedRuns } from "./model";

/** An occurrence the scheduler sees at most this late still runs on time; an older one is missed —
 *  the Mac slept through it, was off, or the clock jumped past it — and goes to its job's missed-run
 *  policy (`missed.ts`). Every occurrence the switch held is missed, however late. */
export const ON_TIME_MS = 5 * 60_000;

/** How many occurrences the engine lists at a time while they are counted. */
const PAGE = 1000;

export interface Due {
  /** The occurrence to run now; `null` when none is due on time. */
  fire: Date | null;
  /** The occurrences passed without a run: how many, the first and the latest; `null` for none. */
  missed: MissedRuns | null;
}

/** Every occurrence of a schedule in `(since, now]`, counted — however long the absence — with the
 *  first and the latest; `null` when there is none. */
export function passedOccurrences(schedule: Schedule, since: Date, now: Date): MissedRuns | null {
  let count = 0;
  let first: Date | null = null;
  let last: Date | null = null;
  let from = since;
  while (from.getTime() < now.getTime()) {
    const page = occurrencesBetween(schedule, from, now, { limit: PAGE });
    const end = page.at(-1);
    if (end === undefined) break;
    first ??= page[0] ?? end;
    last = end;
    count += page.length;
    if (page.length < PAGE) break;
    from = end;
  }
  return first === null || last === null ? null : { count, first: first.getTime(), last: last.getTime() };
}

/**
 * What a schedule asks for at `now`, given the scheduler last looked at `since`: its occurrences in
 * `(since, now]`. The latest one runs when it is at most `ON_TIME_MS` old; every other one is
 * missed. A clock set back (`now` before `since`) is a fresh start: nothing is due.
 */
export function dueOccurrences(schedule: Schedule, since: Date, now: Date): Due {
  const passed = passedOccurrences(schedule, since, now);
  if (passed === null) return { fire: null, missed: null };
  if (now.getTime() - passed.last > ON_TIME_MS) return { fire: null, missed: passed };
  const fire = new Date(passed.last);
  if (passed.count === 1) return { fire, missed: null };
  const before = previousOccurrence(schedule, fire);
  return { fire, missed: { count: passed.count - 1, first: passed.first, last: before?.getTime() ?? passed.first } };
}
