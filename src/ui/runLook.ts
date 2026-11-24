// How a run looks in History and on its result card (the prototype's `STV`, `viewHistory`,
// `cardHtml`): its status's tone, words, help and pill; which result chip keeps it; its day, time,
// duration, and what started it. Pure.

import type { JobKind } from "../jobs/model";
import {
  ACTION_DONE_WORDS,
  caughtUpWords,
  heldRowWords,
  hookCauseWords,
  missedRunsWords,
  runWords,
  SWITCH_WORDS,
  waitingAt,
  type HeldRun,
  type RunRecord,
  type RunTrigger,
  type RunView,
  type Waits,
} from "../scheduler/model";
import type { HelpKey } from "./help";
import type { DotTone, PillTone } from "./kit";
import { shortClock } from "./serviceWords";

/** History's result chips: every run · the runs going · the failed ones · the runs that never started. */
export const HISTORY_FILTERS = ["all", "active", "failed", "missed"] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export const FILTER_WORDS: Record<HistoryFilter, string> = { all: "All", active: "Active", failed: "Failed", missed: "Skipped & missed" };

/** How a run's status looks: the dot and words of its chip, the help they explain themselves with,
 *  the card's pill and its tone, and the chip that keeps it (`null`: only All). */
export interface RunLook {
  tone: DotTone;
  live: boolean;
  /** History's result: "failed · exit 1", "done · restarted", "queued · 1 ahead". */
  words: string;
  help: HelpKey;
  /** The card's pill: "Done", "Failed", "Waiting for you", "Missed · waiting for you". */
  label: string;
  pill: PillTone;
  /** The card's head: red for a failed run, amber for one that waits for you. */
  cardTone: "danger" | "warning" | undefined;
  filter: Exclude<HistoryFilter, "all"> | null;
}

export function isRecord(view: RunView): view is RunRecord {
  return "endedAt" in view;
}

/** A History row: a run going or ended, or a job's runs the switch holds so far. */
export type HistoryItem = RunView | HeldRun;

export function isHeld(item: HistoryItem): item is HeldRun {
  return item.state === "held";
}

/** What a held row looks like: amber, as the held tag is; it keeps to Skipped & missed, where the
 *  record that takes its place on release lands. */
const HELD_LOOK = { tone: "warning", live: false, help: "sw.held", label: "Held", pill: "warning", cardTone: undefined, filter: "missed" } as const;

/** A done run's words: a chain's action on a service ("done · restarted"), a git run's commit
 *  ("done · a1b2c3d"), else "done". */
function doneWords(view: RunRecord): string {
  if (view.action !== null) return `done · ${ACTION_DONE_WORDS[view.action]}`;
  const commit = view.git?.results.find((result) => result.commit !== null)?.commit;
  return commit === undefined || commit === null ? "done" : `done · ${commit.slice(0, 7)}`;
}

/** A run's look; with `now`, a running run that has become a long-run warning says so: "running ·
 *  3h — still expected?". An agent run at a prompt waits for you: amber, "waiting for you". */
export function runLook(view: HistoryItem, now?: number): RunLook {
  if (isHeld(view)) return { ...HELD_LOOK, words: heldRowWords(view.missed) };
  if (view.state === "running" && waitingAt(view) !== null) {
    return { tone: "warning", live: false, words: "waiting for you", help: "st.waiting", label: "Waiting for you", pill: "warning", cardTone: "warning", filter: "active" };
  }
  switch (view.state) {
    case "done":
      return { tone: "ok", live: false, words: isRecord(view) ? doneWords(view) : "done", help: "st.done", label: "Done", pill: "ok", cardTone: undefined, filter: null };
    case "failed":
      // A run stopped at its time limit says so: "stopped: time limit, 45 min".
      return isRecord(view) && view.limitHit !== null
        ? { tone: "danger", live: false, words: runWords(view), help: "st.limit", label: "Stopped: time limit", pill: "danger", cardTone: "danger", filter: "failed" }
        : { tone: "danger", live: false, words: runWords(view), help: "st.failed", label: "Failed", pill: "danger", cardTone: "danger", filter: "failed" };
    case "running":
      return {
        tone: "accent",
        live: true,
        words: now === undefined ? "running" : runningWords(view, now),
        help: "st.running",
        label: "Running",
        pill: "accent",
        cardTone: undefined,
        filter: "active",
      };
    case "queued":
      return { tone: "hollow", live: false, words: runWords(view), help: "st.queued", label: "Queued", pill: "muted", cardTone: undefined, filter: "active" };
    case "missed-waiting":
      return { tone: "warning", live: false, words: runWords(view), help: "st.missed", label: "Missed · waiting for you", pill: "warning", cardTone: "warning", filter: "missed" };
    case "skipped":
      return { tone: "hollow", live: false, words: runWords(view), help: "st.skipped", label: "Skipped", pill: "muted", cardTone: undefined, filter: "missed" };
    case "missed":
      return { tone: "hollow", live: false, words: runWords(view), help: "st.missed", label: "Missed · skipped", pill: "muted", cardTone: undefined, filter: "missed" };
    case "stopped-by-you":
      return { tone: "hollow", live: false, words: runWords(view), help: "st.byyou", label: "Stopped by you", pill: "muted", cardTone: undefined, filter: null };
  }
}

function runningWords(view: RunView, now: number): string {
  if (isRecord(view) || view.warnedAt === null || view.warningDismissed || view.startedAt === null) return "running";
  return `running · ${Math.floor((now - view.startedAt) / 3_600_000)}h — still expected?`;
}

/** Whether the chip `filter` keeps the run. */
export function keeps(filter: HistoryFilter, view: HistoryItem): boolean {
  return filter === "all" || runLook(view).filter === filter;
}

/** How many runs each chip but All keeps. */
export function filterCounts(views: readonly HistoryItem[]): Record<Exclude<HistoryFilter, "all">, number> {
  const counts = { active: 0, failed: 0, missed: 0 };
  for (const view of views) {
    const filter = runLook(view).filter;
    if (filter !== null) counts[filter] += 1;
  }
  return counts;
}

/** When a run shows in History: when it started, or — one that has not — when it was due; a held
 *  row, at its latest held run, as the record that takes its place does. */
export function runTime(view: HistoryItem): number {
  return isHeld(view) ? view.missed.last : (view.startedAt ?? view.dueAt);
}

/** A History row's key among the rows: a run's job and run id; a held row's job, once. */
export function itemKey(view: HistoryItem): string {
  return `${view.job}/${isHeld(view) ? "held" : view.run}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const midnight = (epochMs: number): number => new Date(epochMs).setHours(0, 0, 0, 0);

/** A History day's head: "Today", "Yesterday", "Sun 15 Nov". A day ahead (a Run at… time) is its date. */
export function dayWords(epochMs: number, now: number): string {
  const days = Math.round((midnight(now) - midnight(epochMs)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const at = new Date(epochMs);
  return `${DAY_NAMES[at.getDay()] ?? ""} ${at.getDate()} ${MONTH_NAMES[at.getMonth()] ?? ""}`;
}

/** A moment as the card's meta says it: "Today 8:32", "Sun 15 Nov 3:00". */
export function whenWords(epochMs: number, now: number): string {
  return `${dayWords(epochMs, now)} ${shortClock(epochMs)}`;
}

/** The runs in History's order — newest first by `runTime` — in their days. */
export function byDay<T extends HistoryItem>(views: readonly T[], now: number): { day: string; key: number; runs: T[] }[] {
  const days: { day: string; key: number; runs: T[] }[] = [];
  const order = (view: HistoryItem): string => (isHeld(view) ? "~" : view.run);
  for (const view of [...views].sort((a, b) => runTime(b) - runTime(a) || (order(b) < order(a) ? -1 : order(b) > order(a) ? 1 : 0))) {
    const key = midnight(runTime(view));
    const last = days[days.length - 1];
    if (last !== undefined && last.key === key) last.runs.push(view);
    else days.push({ day: dayWords(key, now), key, runs: [view] });
  }
  return days;
}

/** How long, as History's Duration column says it: "2s", "4m 12s", "45m", "3h 02m". */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A run's duration: a finished one's run time, a running one's so far; `null` for one that never
 *  started or has not yet. */
export function runDuration(view: HistoryItem, now: number): number | null {
  if (isHeld(view)) return null;
  if (isRecord(view)) return view.durationMs;
  return view.state === "running" && view.startedAt !== null ? Math.max(0, now - view.startedAt) : null;
}

/** When the runs going among `views` started: what `useRunningNow` counts their time from. */
export function runningSince(views: readonly RunView[]): number[] {
  return views.flatMap((view) => (!isRecord(view) && view.state === "running" && view.startedAt !== null ? view.startedAt : []));
}

/** The help of what started a run: `tr.scheduled`, `tr.caught up`… */
export const TRIGGER_HELP: Record<RunTrigger, HelpKey> = { scheduled: "tr.scheduled", "caught-up": "tr.caught up", manual: "tr.manual", hook: "tr.hook", chain: "tr.chain" };

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The card's why line under its meta: what fired a hook run ("Mac login"), a caught-up run's
 *  missed time — how many runs and when, for more than one ("Missed 4 runs, 17:40–17:46 — caught
 *  up once", "… — caught up 2 of 4" for a run of a Run all); `null` when the trigger says it all,
 *  and for a single caught-up run that never started — its body says why. A chain's is the card's
 *  own (it links the run it followed). */
export function whyWords(view: RunView, now: number): string | null {
  if (view.cause?.kind === "hook") return capital(hookCauseWords(view.cause));
  if (view.trigger !== "caught-up") return null;
  const missed = missedRunsWords(view.missed);
  if (missed !== null) return `${capital(missed)} — ${caughtUpWords(view.series)}`;
  if (isRecord(view) && view.startedAt === null) return null;
  return `Missed ${whenWords(view.dueAt, now).replace(/^Today /, "").replace(/^Yesterday/, "yesterday")} — caught up after wake`;
}

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"] as const;

/** The low-priority runs holding the slots, as a queued run's card names them: those running, not
 *  waiting at a prompt (a run waiting for you gives up its slot). */
export function slotHolders(active: readonly RunView[]): string[] {
  return active.filter((view) => !isRecord(view) && view.state === "running" && view.lowPriority && waitingAt(view) === null).map((view) => view.name);
}

/** What a queued run waits for, as its card says it; `going` names the low-priority runs holding
 *  the slots ("Two low-priority runs are going (Wiki lint, Photo backup). …"). */
export function waitsSentence(waits: Waits | null, now: number, going: readonly string[] = []): string {
  if (waits === null) return "It is about to start.";
  switch (waits.kind) {
    case "time":
      return `It runs at the time you picked: ${whenWords(waits.at, now).replace(/^Today/, "today")}.`;
    case "switch":
      return `The switch is at ${SWITCH_WORDS[waits.position]}, so it waits. It runs once the switch is back at Running.`;
    case "warm-up":
      return waits.until === null ? "It waits for the warm-up after login or wake: the services start first." : `It waits for the warm-up after login or wake, until ${shortClock(waits.until)}.`;
    case "previous-run":
      return "The job's previous run is still going. This one starts when it finishes.";
    case "pomade":
      return "An agent run needs Pomade, so Runner is opening it. The run starts once Pomade and the Agents app are ready.";
    case "keeper":
      return "The keeper cannot reach the macOS keychain, so an agent started there would have no login. Runner starts a fresh keeper once the runs going have finished, then this run.";
    case "slot": {
      const starts = waits.ahead === 1 ? "This one starts when one of them finishes." : `This one starts once ${waits.ahead} runs ahead of it have finished.`;
      if (going.length === 0) return `Low-priority runs are going in every free slot — ${waits.ahead} ${waits.ahead === 1 ? "run" : "runs"} ahead. ${starts}`;
      const count = COUNT_WORDS[going.length] ?? String(going.length);
      const after = going.length === 1 && waits.ahead === 1 ? "This one starts when it finishes." : starts;
      return `${count} low-priority ${going.length === 1 ? "run is" : "runs are"} going (${going.join(", ")}). ${after}`;
    }
  }
}

/** A job kind's name: the card icon's tooltip. */
export const KIND_WORDS: Record<JobKind, string> = { service: "Service", script: "Script", agent: "Agent", git: "Git" };

/** How many lines from the end of an agent run's output its waiting card looks at for the prompt. */
const PROMPT_LINES = 14;

/** The step an agent CLI marks with its bullet ("● Moving 14 notes…"): the one that asked. */
const AGENT_STEP = /^\s*[●⏺•]/;

/** What a waiting card shows of an agent's output (plain lines): of the last `PROMPT_LINES`, from
 *  the last step the agent marked — the one that asks — else from the first that is not blank. */
export function promptLines(lines: readonly string[]): string[] {
  const end = lines.slice(-PROMPT_LINES);
  while (end.length > 0 && (end.at(-1) ?? "").trim() === "") end.pop();
  let first = -1;
  for (let i = end.length - 1; i >= 0 && first === -1; i--) if (AGENT_STEP.test(end[i] ?? "")) first = i;
  if (first === -1) first = end.findIndex((line) => line.trim() !== "");
  return first === -1 ? [] : end.slice(first);
}
