// A service's state in words: for a job row ("Running · restarted 2× · last crash 14:02"), and its
// look in the Services view and Running now (`serviceLook`). Pure.

import type { Readiness } from "../jobs/model";
import type { ServiceState, ServiceStatus } from "../keeper/model";
import { clockTime } from "../scheduler/model";
import type { HelpKey } from "./help";
import type { DotTone } from "./kit";

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

/** The states of a service with a session going or about to: what Delete stops first. */
export const SERVICE_RUNS: readonly ServiceState[] = ["starting", "running", "restarting"];

/** What a service's row offers, so that no action is a no-op: **Stop** while it runs or starts,
 *  **Start** while it does not and Start would start it (not disabled, invalid or gone), and **Open
 *  terminal** once it has a session — the running one, or the last that ended with its output. */
export function serviceActions(status: ServiceStatus): { toggle: "start" | "stop" | null; terminal: boolean } {
  const toggle = status.state === "running" || status.state === "starting" ? "stop" : status.state === "disabled" || status.state === "invalid" || status.state === "removed" ? null : "start";
  return { toggle, terminal: status.session !== null };
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

/** A time of day as the prototype writes it: "9:02", "14:02". */
export function shortClock(epochMs: number): string {
  const at = new Date(epochMs);
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A past moment from `now`'s day: "today 11:20", "yesterday 18:10", "Mon 9:02" within the week,
 *  else "12 Nov 16:20". */
export function whenWords(epochMs: number, now: number): string {
  const at = new Date(epochMs);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(epochMs).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? DAY_NAMES[at.getDay()] : `${at.getDate()} ${MONTH_NAMES[at.getMonth()]}`;
  return `${day} ${shortClock(epochMs)}`;
}

/** How long something has run, in its two largest units: "12s", "3m", "2h 05m", "3d 4h". */
export function upWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How a service looks in the Services view's Status column and in the panel's Running now. */
export interface ServiceLook {
  /** Running or starting: its actions are Restart · Stop; otherwise Start. In Running now. */
  on: boolean;
  tone: DotTone;
  live: boolean;
  /** The status's help key. */
  help: HelpKey | null;
  /** The Status column: "running · up 3d 4h". */
  words: string;
  /** The Status column's second line: "restarted 3× · last crash 14:02", "no crashes". */
  sub: string;
  /** The help of a second line that reports crashes. */
  subHelp: HelpKey | null;
  /** The panel's words at a row's end: "up 3d 4h", "starting". */
  short: string;
  /** The panel's third line, only for news: "waiting for port 5173", "restarted 3× · last crash 14:02". */
  news: string | null;
  newsHelp: HelpKey | null;
}

function readyWords(ready: Readiness): string {
  switch (ready.kind) {
    case "port":
      return `waiting for port ${ready.port}`;
    case "url":
      return `waiting for ${ready.url}`;
    case "alive":
      return "up once it has run 5 s";
  }
}

/** Where a service stands, for the Services view and Running now; `ready` is its job's readiness,
 *  `now` this Mac's clock — the keeper's, which stamped its session's start and end. */
export function serviceLook(status: ServiceStatus, ready: Readiness | null, now: number, startsOn: string | null = null): ServiceLook {
  const crashes = status.restarts > 0 && status.lastCrashAt !== null ? `restarted ${status.restarts}× · last crash ${shortClock(status.lastCrashAt)}` : null;
  const apply = status.needsRestart ? "restart to apply its file" : null;
  const look = (tone: DotTone, words: string, help: HelpKey | null, sub: string, subHelp: HelpKey | null = null): ServiceLook => ({
    on: false,
    tone,
    live: false,
    help,
    words,
    sub,
    subHelp,
    short: words,
    news: null,
    newsHelp: null,
  });
  const ended = status.session?.info.exit?.at ?? null;
  switch (status.state) {
    case "running": {
      const up = `up ${upWords(now - (status.session?.info.startedAt ?? now))}`;
      const sub = [crashes ?? "no crashes", apply].filter((part) => part !== null).join(" · ");
      return { ...look("ok", `running · ${up}`, "st.up", sub, crashes === null ? null : "st.restarted"), on: true, short: up, news: crashes ?? apply, newsHelp: crashes === null ? null : "st.restarted" };
    }
    case "starting": {
      const waits = ready === null ? "" : readyWords(ready);
      return { ...look("accent", "starting", "st.starting", waits), on: true, live: true, news: waits === "" ? null : waits };
    }
    case "queued":
      return look("hollow", "queued", "st.svcqueued", "starts when the one before it is up");
    case "restarting":
      return look("warning", "restarting", "st.restarted", crashes ?? (status.retryAt === null ? "" : `again at ${shortClock(status.retryAt)}`), crashes === null ? null : "st.restarted");
    case "failed":
      return look("danger", "failed · gave up", "st.svcfailed", status.problem ?? `crashed 5× in 1 min${status.lastCrashAt === null ? "" : ` · ${whenWords(status.lastCrashAt, now)}`}`);
    case "stopped-by-you":
      return look("hollow", "stopped by you", "st.stopped", ended === null ? "" : whenWords(ended, now));
    case "waiting":
      return look("hollow", "waiting for first open", "st.svcwaiting", startsOn === null ? "starts on first open" : `starts on first open of ${startsOn}`);
    case "disabled":
      return look("hollow", "disabled", "st.disabled", "");
    case "invalid":
      return look("danger", "invalid", "jobs.invalid", "its file has errors");
    case "removed":
      return look("hollow", "stopping", null, "its file is gone");
  }
}
