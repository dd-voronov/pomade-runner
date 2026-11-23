// How far ahead a run is, in words, for the panel and the Jobs view: "in 40 min", "in 56 s". Pure.
// Both places read `soonWords`, so they always agree.

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** How far ahead `at` is: "now" from the run's moment on, "in 56 s" under a minute, then "in 40 min",
 *  "in 2 h 5 min", "in 3 days". Minutes are those a clock reader counts — at 17:49:10 a 17:51:00 run
 *  is "in 2 min" until 17:50:00 — seconds are whole seconds left, rounded up. */
export function aheadWords(at: number, now: number): string {
  const seconds = Math.ceil((at - now) / SECOND);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `in ${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `in ${hours} h` : `in ${hours} h ${minutes % 60} min`;
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

/** The countdown a run within the hour shows, in the panel's Next up and the Jobs view's Next run
 *  alike; `null` when `at` is an hour or more ahead and a place names its time instead. */
export function soonWords(at: number, now: number): string | null {
  return at - now < HOUR ? aheadWords(at, now) : null;
}

/** Milliseconds until `soonWords(at, …)` reads differently — the next second under a minute, else
 *  the next minute, else the hour mark; `null` once it reads "now". What a clock waits for to redraw. */
export function wordsChangeIn(at: number, now: number): number | null {
  const left = at - now;
  if (left <= 0) return null;
  if (left >= HOUR) return left - HOUR + 1;
  if (left > MINUTE) return left - MINUTE * (Math.ceil(left / MINUTE) - 1);
  return left - SECOND * (Math.ceil(left / SECOND) - 1);
}
