// The panel's cards and rows in words, as the prototype writes them: a Needs-you card's look (dot
// tone, help, time, text) and Next up's "in 40 min". Pure.

import { FIRING_LIMIT, FIRING_WINDOW_MS } from "../scheduler/loop-guard";
import type { NeedsYouItem } from "../scheduler/model";
import type { HelpKey } from "./help";
import type { DotTone } from "./kit";
import { soonWords } from "./runWords";
import { shortClock, upWords } from "./serviceWords";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Whole calendar days from `now`'s day to `epochMs`'s: 0 today, 1 tomorrow, -1 yesterday. */
function dayOffset(epochMs: number, now: number): number {
  return Math.round((new Date(epochMs).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
}

/** A moment ahead as a day and a time: "today 23:00", "tomorrow 7:00", "Thu 7:00" within the week,
 *  else "Mon 23 Nov 7:00". */
export function aheadMoment(epochMs: number, now: number): string {
  const at = new Date(epochMs);
  const days = dayOffset(epochMs, now);
  const day = days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? DAY_NAMES[at.getDay()] : `${DAY_NAMES[at.getDay()]} ${at.getDate()} ${MONTH_NAMES[at.getMonth()]}`;
  return `${day} ${shortClock(epochMs)}`;
}

/** A Next up row's time: "in 40 min" ("in 56 s" under a minute) within the hour, else the time
 *  ("13:00", "tmrw 7:00", "Thu 7:00"). */
export function nextUpWords(at: number, now: number): string {
  return soonWords(at, now) ?? aheadMoment(at, now).replace(/^today /, "").replace(/^tomorrow /, "tmrw ");
}

/** A Next up row's full time, for its tooltip: "Today 13:00". */
export function nextUpTip(at: number, now: number): string {
  const words = aheadMoment(at, now);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** When something past happened, at a card's end: "11:20" today, "yesterday", "Sun 3:00" within the
 *  week, else "13 Nov". */
export function pastWhen(epochMs: number, now: number): string {
  const days = dayOffset(epochMs, now);
  if (days >= 0) return shortClock(epochMs);
  if (days === -1) return "yesterday";
  const at = new Date(epochMs);
  return days > -7 ? `${DAY_NAMES[at.getDay()]} ${shortClock(epochMs)}` : `${at.getDate()} ${MONTH_NAMES[at.getMonth()]}`;
}

/** How long a run has gone, short: "45m", "3h 02m". */
export function goneWords(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** What a Needs-you card shows: its dot, its (i) help, the time at its end and its line of text. */
export interface NeedLook {
  tone: DotTone;
  help: HelpKey;
  when: string;
  text: string;
}

export function needLook(item: NeedsYouItem, now: number): NeedLook {
  switch (item.kind) {
    case "run-failed":
      return { tone: "danger", help: "need.failed", when: pastWhen(item.at, now), text: `Failed: ${item.detail}${item.count > 1 ? ` · ${item.count}×` : ""}` };
    case "service-failed":
      return { tone: "danger", help: "need.crashloop", when: pastWhen(item.at, now), text: "Crashed 5× in 1 min — gave up." };
    case "missed":
      return { tone: "warning", help: "need.waitforme", when: pastWhen(item.at, now), text: "Missed — it waits for you to pick a time." };
    case "waiting":
      return { tone: "warning", help: "need.approval", when: upWords(now - item.at), text: item.prompt === "permission" ? "Waiting for approval at a permission prompt." : "Waiting for you to trust its folder." };
    case "long-run": {
      const ran = now - item.startedAt;
      const hours = Math.floor(ran / 3_600_000);
      return { tone: "accent", help: "need.longrun", when: goneWords(ran), text: `Running ${hours >= 1 ? `${hours}h` : goneWords(ran)} — still expected?` };
    }
    case "loop-paused":
      return { tone: "warning", help: "need.loopguard", when: pastWhen(item.at, now), text: `Paused: triggered ${FIRING_LIMIT}× in ${FIRING_WINDOW_MS / 60_000} min.` };
  }
}
