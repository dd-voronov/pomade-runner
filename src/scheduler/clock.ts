// The scheduler's time source and tick length. Every part of the scheduler reads the time from the
// `Clock` it is given, so tests run it on a clock they set; `POMADE_RUNNER_TICK_MS` shortens the
// tick for a run of the real process.

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
