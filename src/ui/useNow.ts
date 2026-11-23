// This Mac's clock, read again every `everyMs`, for what counts up on screen: a service's uptime,
// a run's time running.

import { useEffect, useRef, useState } from "react";

import { wordsChangeIn } from "./runWords";

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
  const [now, setNow] = useState(Date.now);
  const key = ats.join(",");
  // New moments to count down to (a fresh report) are worded by the clock as it is, not as last read.
  const read = useRef(key);
  useEffect(() => {
    if (read.current === key) return;
    read.current = key;
    setNow(Date.now());
  }, [key]);
  useEffect(() => {
    const at = Date.now();
    const waits = ats.flatMap((moment) => wordsChangeIn(moment, at) ?? []);
    const timer = setTimeout(() => setNow(Date.now()), Math.min(everyMs, ...waits));
    return () => clearTimeout(timer);
    // `ats` is read through its `key`: a new array of the same moments schedules nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, now, everyMs]);
  return now;
}
