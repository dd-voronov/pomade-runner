// A job's trigger in words, as `pomade-runner list` and the Jobs view show it: "weekdays at 7:00",
// "at Mac login", "after backup is done", "always on · starts at login · restarts after git-pull is
// done".
// Pure.

import { addDays, describeDate, describeSchedule, localDateOf, type Schedule } from "pomade-kit/schedule";

import { SESSION_STATUS_WORDS, type Chain, type GitOperation, type Hook, type Job, type ServiceAction } from "./model";

/** A git operation as the Git panel and the job form name it. */
export const GIT_OPERATION_WORDS: Record<GitOperation, string> = { "commit-push": "Commit & push", pull: "Pull", push: "Push", fetch: "Fetch" };

/** How a job or a project is named in words: by its id unless a caller knows its name. */
export interface WordNames {
  job?: (id: string) => string;
  project?: (id: string) => string;
}

const HOOK_TRIGGER_WORDS: Record<Hook["event"], (hook: Hook, names: WordNames) => string> = {
  login: () => "at Mac login",
  "pomade-started": () => "when Pomade starts",
  "project-first-open": (hook, names) => `on first open of ${projectWords(hook.project, names)}`,
  "project-created": () => "when a project is created",
  "session-finished": (hook, names) => `after ${sessionWords(hook.agent, "an agent")} session finishes${inProject(hook.project, names)}`,
  "session-status": (hook, names) => `when ${sessionWords(hook.agent, "a")} session is marked ${hook.status === null ? "any status" : SESSION_STATUS_WORDS[hook.status]}${inProject(hook.project, names)}`,
};

/** A hook in words: "at Mac login", "after a claude session finishes in Pomade". */
export function hookWords(hook: Hook, names: WordNames = {}): string {
  return HOOK_TRIGGER_WORDS[hook.event](hook, names);
}

/** "a claude", "an agent" — an agent filter's article and id; `none` without one. */
function sessionWords(agent: string | null, none: string): string {
  return agent === null ? none : `${/^[aeiou]/i.test(agent) ? "an" : "a"} ${agent}`;
}

/** " in Pomade" — a project filter in words; nothing without one. */
function inProject(project: string | null, names: WordNames): string {
  return project === null ? "" : ` in ${projectWords(project, names)}`;
}

/** A project in words: its name when the caller knows it, else its id; "a project" for none. */
function projectWords(project: string | null, names: WordNames): string {
  return project === null ? "a project" : (names.project?.(project) ?? project);
}

const RESULT_WORDS: Record<Chain["result"], string> = { done: "is done", failed: "fails", any: "finishes" };
const ACTION_WORDS: Record<ServiceAction, string> = { restart: "restarts", start: "starts", stop: "stops" };

/** A chain in words: "after backup is done". */
export function chainWords(chain: Chain, names: WordNames = {}): string {
  return `after ${names.job?.(chain.job) ?? chain.job} ${RESULT_WORDS[chain.result]}`;
}

/** A schedule in words, the kit's — except a `once` on today's or tomorrow's date, which reads
 *  "once, today at 23:00" / "once, tomorrow at 7:00": the day as the Owner would say it, on `now`'s
 *  local calendar. */
export function scheduleWords(schedule: Schedule, now: Date = new Date()): string {
  const words = describeSchedule(schedule);
  const { rule } = schedule;
  if (rule.kind !== "once") return words;
  const today = localDateOf(now);
  const day = rule.date === today ? "today" : rule.date === addDays(today, 1) ? "tomorrow" : null;
  return day === null ? words : words.replace(`once on ${describeDate(rule.date)}`, `once, ${day}`);
}

/** A job's trigger in words; `names` says a job or a project by its name instead of its id, `now`
 *  is the day a once schedule is said against. */
export function jobTriggerWords(job: Job, names: WordNames = {}, now: Date = new Date()): string {
  if (job.kind === "service") {
    const start = job.start === "login" ? "always on · starts at login" : `always on · starts on first open of ${projectWords(job.startProject, names)}`;
    return job.after === null ? start : `${start} · ${ACTION_WORDS[job.after.action]} ${chainWords(job.after, names)}`;
  }
  switch (job.trigger.kind) {
    case "schedule":
      return scheduleWords(job.trigger.schedule, now);
    case "hook":
      return hookWords(job.trigger.hook, names);
    case "chain":
      return chainWords(job.trigger.chain, names);
  }
}
