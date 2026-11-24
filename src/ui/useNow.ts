// This Mac's clock, read again every `everyMs`, for what counts up on screen: a service's uptime,
// a run's time running.

import { useEffect, useRef, useState } from "react";

import { wordsChangeIn } from "./runWords";
import { upChangeIn } from "./serviceWords";

export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** This Mac's clock, read again the moment a countdown to one of `ats` reads differently — each
 *  second while one is under a minute, else each minute — and at least every `everyMs`. A view with
 *  no run under a minute ahead never redraws per second. */
export function useCountdownNow(ats: readonly number[], everyMs = 30_000): number {
  return useClockAt(ats, wordsChangeIn, everyMs);
}

/** This Mac's clock, read again the moment the time one of the runs started at `startedAts` has been
 *  going reads differently — each second while one is under a minute, then every 10 s — and at least
 *  every `everyMs`. Every view of a run reads the same ticks, since they are the run's own seconds;
 *  a view with no run going never redraws per second. */
export function useRunningNow(startedAts: readonly number[], everyMs = 30_000): number {
  return useClockAt(startedAts, upChangeIn, everyMs);
}

/** How long a clock of `moments` waits to be read again: until the soonest `changeIn(moment, now)`
 *  (`null` for a moment that changes no more), and no longer than `everyMs`; with no moments, `everyMs`. */
export function clockWait(moments: readonly number[], changeIn: (moment: number, now: number) => number | null, now: number, everyMs: number): number {
  return Math.min(everyMs, ...moments.flatMap((moment) => changeIn(moment, now) ?? []));
}

/** The clock of `moments`: read again `changeIn(moment, now)` ms ahead for the soonest of them (that
 *  returns `null` for one that changes no more), and at least every `everyMs`. */
function useClockAt(moments: readonly number[], changeIn: (moment: number, now: number) => number | null, everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  const key = moments.join(",");
  // New moments (a fresh report) are worded by the clock as it is, not as last read.
  const read = useRef(key);
  useEffect(() => {
    if (read.current === key) return;
    read.current = key;
    setNow(Date.now());
  }, [key]);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), clockWait(moments, changeIn, Date.now(), everyMs));
    return () => clearTimeout(timer);
    // `moments` is read through its `key`: a new array of the same moments schedules nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, now, everyMs]);
  return now;
}
