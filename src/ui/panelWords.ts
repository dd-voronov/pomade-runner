// The panel's cards and rows in words, as the prototype writes them: a Needs-you card's look (dot
// tone, help, time, text) and Next up's "in 40 min". Pure.

import { FIRING_LIMIT, FIRING_WINDOW_MS } from "../scheduler/loop-guard";
import { missedRunsWords, type AgentWait, type NeedsYouItem } from "../scheduler/model";
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

/** A waiting run's Needs-you line, by what it waits at. */
const WAITING_TEXT: Record<AgentWait["prompt"], string> = {
  permission: "Waiting for approval at a permission prompt.",
  trust: "Waiting for you to trust its folder.",
  question: "Waiting for your answer to its question.",
  unknown: "Waiting at a screen Runner does not know.",
  "not-started": "Has not started — look at its terminal.",
};

/** A waiting run's Needs-you (i) help, by what it waits at. */
const WAITING_HELP: Record<AgentWait["prompt"], HelpKey> = {
  permission: "need.approval",
  trust: "need.approval",
  question: "need.question",
  unknown: "need.unknown",
  "not-started": "need.notstarted",
};

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function needLook(item: NeedsYouItem, now: number): NeedLook {
  switch (item.kind) {
    case "run-failed":
      return { tone: "danger", help: "need.failed", when: pastWhen(item.at, now), text: `Failed: ${item.detail}${item.count > 1 ? ` · ${item.count}×` : ""}` };
    case "service-failed":
      return { tone: "danger", help: "need.crashloop", when: pastWhen(item.at, now), text: item.problem === null ? "Crashed 5× in 1 min — gave up." : `Gave up — could not start: ${item.problem}` };
    case "missed":
      // One run: "Missed — …"; more: "Missed 4 runs, 17:40–17:46 — …".
      return { tone: "warning", help: "need.waitforme", when: pastWhen(item.at, now), text: `${capital(missedRunsWords(item.missed) ?? "missed")} — it waits for you to pick a time.` };
    case "waiting":
      return { tone: "warning", help: WAITING_HELP[item.prompt], when: upWords(now - item.at), text: WAITING_TEXT[item.prompt] };
    case "long-run": {
      const ran = now - item.startedAt;
      const hours = Math.floor(ran / 3_600_000);
      return { tone: "accent", help: "need.longrun", when: goneWords(ran), text: `Running ${hours >= 1 ? `${hours}h` : goneWords(ran)} — still expected?` };
    }
    case "loop-paused":
      return { tone: "warning", help: "need.loopguard", when: pastWhen(item.at, now), text: `Paused: triggered ${FIRING_LIMIT}× in ${FIRING_WINDOW_MS / 60_000} min.` };
  }
}
