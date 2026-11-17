// A job's trigger in words, as `pomade-runner list` and the Jobs view show it: "weekdays at 7:00",
// "at Mac login", "after backup is done", "always on, from login; restarts after git-pull is done".
// Pure.

import type { Chain, GitOperation, Hook, Job, ServiceAction } from "./model";

/** A git operation as the Git panel and the job form name it. */
export const GIT_OPERATION_WORDS: Record<GitOperation, string> = { "commit-push": "Commit & push", pull: "Pull", push: "Push", fetch: "Fetch" };

const HOOK_TRIGGER_WORDS: Record<Hook["event"], (hook: Hook) => string> = {
  login: () => "at Mac login",
  "pomade-started": () => "when Pomade starts",
  "project-first-open": (hook) => `on the first open of ${hook.project === null ? "a project" : `project ${hook.project}`}`,
  "project-created": () => "when a project is created",
  "session-finished": () => "when an agent session finishes",
  "session-status": (hook) => `when a session's status changes to ${hook.status ?? "any"}`,
};

const RESULT_WORDS: Record<Chain["result"], string> = { done: "is done", failed: "fails", any: "finishes" };
const ACTION_WORDS: Record<ServiceAction, string> = { restart: "restarts", start: "starts", stop: "stops" };

/** A chain in words: "after backup is done". */
export function chainWords(chain: Chain): string {
  return `after ${chain.job} ${RESULT_WORDS[chain.result]}`;
}

/** A job's trigger in words. */
export function jobTriggerWords(job: Job): string {
  if (job.kind === "service") {
    const start = job.start === "login" ? "always on, from login" : "always on, from its project's first open";
    return job.after === null ? start : `${start}; ${ACTION_WORDS[job.after.action]} ${chainWords(job.after)}`;
  }
  switch (job.trigger.kind) {
    case "schedule":
      return job.trigger.words;
    case "hook":
      return HOOK_TRIGGER_WORDS[job.trigger.hook.event](job.trigger.hook);
    case "chain":
      return chainWords(job.trigger.chain);
  }
}
