// A service's state in words for a job row: "Running · restarted 2× · last crash 14:02". Pure.

import type { ServiceState, ServiceStatus } from "../keeper/model";

const STATE_WORDS: Record<ServiceState, string> = {
  queued: "Queued to start",
  starting: "Starting",
  running: "Running",
  restarting: "Restarting",
  failed: "Failed: crashed 5 times in a minute",
  "stopped-by-you": "Stopped by you",
  waiting: "Waits for its project to open",
  disabled: "Disabled",
  invalid: "Not started: its file has errors",
  removed: "Stopping: its file is gone",
};

/** A time of day on this Mac's clock, `HH:MM`. */
export function clockTime(epochMs: number): string {
  const at = new Date(epochMs);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function serviceWords(status: ServiceStatus): string {
  return [
    STATE_WORDS[status.state],
    status.restarts > 0 ? `restarted ${status.restarts}×` : null,
    status.lastCrashAt === null ? null : `last crash ${clockTime(status.lastCrashAt)}`,
    status.needsRestart ? "restart to apply its file" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
