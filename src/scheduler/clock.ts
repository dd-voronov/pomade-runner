// The scheduler's time source and tick length. Every part of the scheduler reads the time from the
// `Clock` it is given, so tests run it on a clock they set; for a run of the real process,
// `POMADE_RUNNER_TICK_MS` shortens the tick and `POMADE_RUNNER_CLOCK` sets the clock.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** How often the scheduler ticks in production. */
export const TICK_MS = 1000;

/** The env var that overrides `TICK_MS` (tests). */
export const TICK_ENV = "POMADE_RUNNER_TICK_MS";

/** The tick length: `POMADE_RUNNER_TICK_MS` when it is a positive integer of milliseconds; unset,
 *  empty or invalid means the production value. */
export function tickMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[TICK_ENV]?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(raw)) return TICK_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : TICK_MS;
}

/** The env vars that start the clock at another time (an ISO date-time; without an offset, local
 *  time) and make it run faster (a positive number; default 1) — tests of the real process. */
export const CLOCK_ENV = "POMADE_RUNNER_CLOCK";
export const CLOCK_RATE_ENV = "POMADE_RUNNER_CLOCK_RATE";

/** The scheduler's clock: the system's, or — with `POMADE_RUNNER_CLOCK` — one that starts at that
 *  time and runs `POMADE_RUNNER_CLOCK_RATE` times as fast. An unset, empty or invalid value means
 *  the system clock (rate 1). `elapsed` is milliseconds since an arbitrary start. */
export function clockFrom(env: Readonly<Record<string, string | undefined>>, elapsed: () => number = () => performance.now()): Clock {
  const start = Date.parse(env[CLOCK_ENV]?.trim() ?? "");
  if (Number.isNaN(start)) return systemClock;
  const rawRate = Number(env[CLOCK_RATE_ENV]?.trim() || "1");
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
  const origin = elapsed();
  return { now: () => new Date(start + (elapsed() - origin) * rate) };
}
