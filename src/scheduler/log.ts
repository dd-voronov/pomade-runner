// The scheduler's log: one timestamped line per event on stdout, which Pomade's login item sends to
// `<userData>/app-logs/pomade-runner/backend.log`.

import type { Clock } from "./clock";

export type Log = (message: string) => void;

export function createLog(clock: Clock, write: (line: string) => void): Log {
  return (message) => write(`${clock.now().toISOString()} ${message}\n`);
}
