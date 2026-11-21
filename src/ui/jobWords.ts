// A job row's two status cells in words: Last result and Next run (`lastLook`, `nextLook`), the
// git detail its trigger line carries as a tooltip, and where New job starts. Pure.

import { WORKSPACE_PROJECT_ID, type ProjectRef } from "pomade-kit/protocol";

import { newRoute } from "../integrations/runner-api";
import type { Job, ServiceJob } from "../jobs/model";
import { GIT_OPERATION_WORDS } from "../jobs/words";
import type { ServiceStatus } from "../keeper/model";
import { FIRING_LIMIT, FIRING_WINDOW_MS } from "../scheduler/loop-guard";
import { runWords, TRIGGER_WORDS, waitingAt, type ActiveRun, type JobRuns, type RunRecord, type RunTrigger } from "../scheduler/model";
import type { HelpKey } from "./help";
import type { DotTone } from "./kit";
import { shortDuration } from "./runLook";
import { serviceLook, shortClock, upWords, whenWords } from "./serviceWords";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A job row's Last result cell. */
export interface LastLook {
  tone: DotTone;
  live: boolean;
  /** The chip's words: "done", "failed · exit 1", "running · up 3d 4h", "never ran". */
  words: string;
  help: HelpKey | null;
  /** The line under it: "today 11:20 · 3s", "no crashes". */
  sub: string;
  /** The help of a sub line that reports crashes. */
  subHelp: HelpKey | null;
  /** The run its click opens; `null` for a service and for a job that never ran. */
  run: string | null;
}

/** A job row's Next run cell. */
export interface NextLook {
  /** "Today 13:00", "always on", "on event", "disabled". */
  words: string;
  /** "in 12 min" under an hour away. */
  sub: string | null;
  /** Nothing is scheduled: shown faint. */
  none: boolean;
}

/** What started a run, said on the row only when it is not the job's own trigger: "caught up", "manual". */
function offTrigger(trigger: RunTrigger): string | null {
  return trigger === "caught-up" || trigger === "manual" ? TRIGGER_WORDS[trigger] : null;
}

/** A finished run's line: when it started (or was due), then how long it took — a done git run's
 *  commit instead, as History's result says it ("yesterday 20:00 · a1b2c3d") — then a trigger that
 *  is not the job's own ("today 8:32 · 4m 12s · caught up"). */
function finished(record: RunRecord, now: number): Pick<LastLook, "sub" | "subHelp"> {
  const commit = record.state === "done" ? record.git?.results.find((result) => result.commit !== null)?.commit : undefined;
  const after = typeof commit === "string" ? commit.slice(0, 7) : record.durationMs === null ? null : shortDuration(record.durationMs);
  return { sub: [whenWords(record.startedAt ?? record.dueAt, now), after, offTrigger(record.trigger)].filter((part) => part !== null).join(" · "), subHelp: null };
}

/** A finished run's chip: the status of its result, its words as History says them. */
function recordLook(record: RunRecord, now: number): LastLook {
  const base = { live: false, run: record.run, ...finished(record, now) };
  switch (record.state) {
    case "done":
      return { ...base, tone: "ok", words: "done", help: "st.done" };
    case "failed":
      // A run stopped at its time limit says so: "stopped: time limit, 45 min".
      return record.limitHit !== null
        ? { ...base, tone: "danger", words: runWords(record), help: "st.limit" }
        : { ...base, tone: "danger", words: runWords(record), help: "st.failed" };
    case "skipped":
      return { ...base, tone: "hollow", words: runWords(record), help: "st.skipped" };
    case "missed":
      return { ...base, tone: "hollow", words: runWords(record), help: "st.missed" };
    case "stopped-by-you":
      return { ...base, tone: "hollow", words: "stopped by you", help: "st.byyou" };
  }
}

/** A run that has not ended: the row shows it ahead of the last finished one. */
function activeLook(run: ActiveRun, now: number): LastLook {
  const base = { subHelp: null, run: run.run };
  switch (run.state) {
    case "running": {
      // Running: how long so far ("3h 02m · manual"); waiting for you: since when it waits on you.
      const going = upWords(now - (run.startedAt ?? run.dueAt));
      return waitingAt(run) === null
        ? { ...base, tone: "accent", live: true, words: "running", help: "st.running", sub: [going, offTrigger(run.trigger)].filter((part) => part !== null).join(" · ") }
        : { ...base, tone: "warning", live: false, words: "waiting for you", help: "st.waiting", sub: `started ${shortClock(run.startedAt ?? run.dueAt)} · ${going}` };
    }
    case "queued":
      return { ...base, tone: "hollow", live: false, words: runWords(run), help: "st.queued", sub: `since ${shortClock(run.dueAt)}` };
    case "missed-waiting":
      return { ...base, tone: "warning", live: false, words: "missed · waiting for you", help: "st.missed", sub: whenWords(run.dueAt, now) };
  }
}

/** The run a row shows: the one running, else the first of the rest. */
function shownRun(active: readonly ActiveRun[]): ActiveRun | undefined {
  return active.find((run) => run.state === "running") ?? active[0];
}

/** A job's Last result: a service's state (`serviceLook`); for any other job the run going — or
 *  queued, or missed and waiting — else the loop guard's pause (`pausedAt`, when it paused the job),
 *  else its latest finished run, else "never ran". */
export function lastLook(job: Job, parts: { runs: JobRuns | undefined; active: readonly ActiveRun[]; service: ServiceStatus | undefined; pausedAt?: number | null }, now: number): LastLook {
  if (job.kind === "service") {
    const look = serviceLook(parts.service ?? fallbackService(job), job.ready, now);
    return { tone: look.tone, live: look.live, words: look.words, help: look.help, sub: look.sub, subHelp: look.subHelp, run: null };
  }
  const going = shownRun(parts.active);
  if (going !== undefined) return activeLook(going, now);
  if (parts.pausedAt !== undefined && parts.pausedAt !== null) {
    const sub = `${whenWords(parts.pausedAt, now)} · ${FIRING_LIMIT}× in ${FIRING_WINDOW_MS / 60_000} min`;
    return { tone: "warning", live: false, words: "paused · looks like a loop", help: "st.paused", sub, subHelp: null, run: null };
  }
  const last = parts.runs?.last ?? null;
  if (last === null) return { tone: "hollow", live: false, words: "never ran", help: null, sub: "", subHelp: null, run: null };
  return recordLook(last, now);
}

/** What a service's row says before the scheduler reports it. */
export function fallbackService(job: ServiceJob): ServiceStatus {
  return {
    job: job.id,
    name: job.name,
    project: job.project,
    state: job.enabled ? "queued" : "disabled",
    session: null,
    restarts: 0,
    lastCrashAt: null,
    retryAt: null,
    needsRestart: false,
    problem: null,
  };
}

/** A moment ahead as the prototype writes it: "today 13:00", "tomorrow 7:00", "Wed 7:00" within the
 *  week, else "Wed 25 Nov 7:00". */
export function aheadWhen(at: number, now: number): string {
  const when = new Date(at);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? DAY_NAMES[when.getDay()] : `${DAY_NAMES[when.getDay()]} ${when.getDate()} ${MONTH_NAMES[when.getMonth()]}`;
  return `${day} ${shortClock(at)}`;
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A job's Next run: disabled, paused by the loop guard, a service's "always on", a hook's or chain's
 *  "on event", else its schedule's next time — "in N min" under it within the hour — or "finished". */
export function nextLook(job: Job, runs: JobRuns | undefined, paused: boolean, now: number): NextLook {
  if (!job.enabled) return { words: "disabled", sub: null, none: true };
  if (paused) return { words: "paused", sub: null, none: true };
  if (job.kind === "service") return { words: "always on", sub: null, none: true };
  if (job.trigger.kind !== "schedule") return { words: "on event", sub: null, none: true };
  if (runs === undefined) return { words: "—", sub: null, none: true };
  if (runs.next === null) return { words: runs.finished ? "finished" : "—", sub: null, none: true };
  const minutes = Math.round((runs.next - now) / 60_000);
  return { words: capitalized(aheadWhen(runs.next, now)), sub: minutes < 60 ? (minutes <= 0 ? "now" : `in ${minutes} min`) : null, none: false };
}

/** A git job's operation and repos: "Commit & push · Knowledge, coda-helper"; a repo the workspace
 *  does not have is said, once the workspace's repos are known (`known`). `missing` lists those. */
export function gitDetail(job: Extract<Job, { kind: "git" }>, known: ReadonlySet<string> | null): { text: string; missing: string[] } {
  const missing = job.git.repos.filter((repo) => known !== null && !known.has(repo) && !repo.startsWith("/"));
  const repos = job.git.repos.map((repo) => (missing.includes(repo) ? `${repo} (not in this workspace)` : repo));
  return { text: `${GIT_OPERATION_WORDS[job.git.operation]} · ${repos.join(", ")}`, missing };
}

/** What New job opens: the job form, starting in the open project while the "This project" chip is
 *  on — never in the Workspace, which is no project. */
export function newJobRoute(thisProject: boolean, active: ProjectRef | null): string {
  return newRoute(thisProject && active !== null && active.id !== WORKSPACE_PROJECT_ID ? active.id : null);
}
