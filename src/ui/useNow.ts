// This Mac's clock, read again every `everyMs`, for what counts up on screen: a service's uptime,
// a run's time running.

import { useEffect, useState } from "react";

export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
