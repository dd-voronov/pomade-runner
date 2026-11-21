// A job row's two status cells in words: Last result and Next run (`lastLook`, `nextLook`), the
// git detail its trigger line carries as a tooltip, and where New job starts. Pure.

import { WORKSPACE_PROJECT_ID, type ProjectRef } from "pomade-kit/protocol";

import { newRoute } from "../integrations/runner-api";
import type { Job, ServiceJob } from "../jobs/model";
import { GIT_OPERATION_WORDS } from "../jobs/words";
import type { ServiceStatus } from "../keeper/model";
import { runWords, waitsWords, type ActiveRun, type JobRuns, type RunRecord } from "../scheduler/model";
import type { HelpKey } from "./help";
import type { DotTone } from "./kit";
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

const finished = (record: RunRecord, now: number): Pick<LastLook, "sub" | "subHelp"> => ({
  sub: [whenWords(record.endedAt, now), record.durationMs === null ? null : upWords(record.durationMs)].filter((part) => part !== null).join(" · "),
  subHelp: null,
});

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
    case "running":
      return { ...base, tone: "accent", live: true, words: "running", help: "st.running", sub: `started ${shortClock(run.startedAt ?? run.dueAt)} · ${upWords(now - (run.startedAt ?? run.dueAt))}` };
    case "queued":
      return { ...base, tone: "hollow", live: false, words: "queued", help: "st.queued", sub: waitsWords(run.waits) };
    case "missed-waiting":
      return { ...base, tone: "warning", live: false, words: "missed · waiting for you", help: "st.missed", sub: whenWords(run.dueAt, now) };
  }
}

/** The run a row shows: the one running, else the first of the rest. */
function shownRun(active: readonly ActiveRun[]): ActiveRun | undefined {
  return active.find((run) => run.state === "running") ?? active[0];
}

/** A job's Last result: a service's state (`serviceLook`); for any other job the run going — or
 *  queued, or missed and waiting — else its latest finished one, else "never ran". */
export function lastLook(job: Job, parts: { runs: JobRuns | undefined; active: readonly ActiveRun[]; service: ServiceStatus | undefined }, now: number): LastLook {
  if (job.kind === "service") {
    const look = serviceLook(parts.service ?? fallbackService(job), job.ready, now);
    return { tone: look.tone, live: look.live, words: look.words, help: look.help, sub: look.sub, subHelp: look.subHelp, run: null };
  }
  const going = shownRun(parts.active);
  if (going !== undefined) return activeLook(going, now);
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
