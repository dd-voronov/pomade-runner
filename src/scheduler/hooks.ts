// Hooks (docs/DESIGN.md "Hooks"): an event fires every job whose `hook` names it and whose filters
// it passes — a filter left out takes any value. Runner's own event is `login`; Pomade's and
// `pomade-agents`' events (E-007) come in through the same firing path (`Runs.hook`). Pure.

import type { GitJob, HookEvent, JobsSnapshot, ScriptJob, SessionStatus } from "../jobs/model";

/** One event, as the firing path takes it: what the filters look at, and the context its runs get
 *  in their environment. */
export interface HookFiring {
  event: HookEvent;
  /** The project's stable id; `null` when the event has none. */
  project: string | null;
  /** The agent's roster id; `null` when the event has none. */
  agent: string | null;
  /** `session-status`: the status the session changed to. */
  status: SessionStatus | null;
  /** Environment variables for the runs it fires (`POMADE_PROJECT`, `POMADE_SESSION_ID`…). */
  context: Record<string, string>;
}

/** Mac login: the scheduler's start (the scheduler is the login item). */
export const LOGIN: HookFiring = { event: "login", project: null, agent: null, status: null, context: {} };

/** The jobs an event fires: valid, enabled scripts and git jobs whose hook it matches. Agent jobs
 *  fire with their epic (E-004). */
export function hooked(snapshot: JobsSnapshot, firing: HookFiring): (ScriptJob | GitJob)[] {
  return snapshot.jobs.flatMap((entry) => {
    if (!entry.valid || (entry.job.kind !== "script" && entry.job.kind !== "git") || !entry.job.enabled || entry.job.trigger.kind !== "hook") return [];
    const { hook } = entry.job.trigger;
    const passes = hook.event === firing.event && (hook.project === null || hook.project === firing.project) && (hook.agent === null || hook.agent === firing.agent) && (hook.status === null || hook.status === firing.status);
    return passes ? [entry.job] : [];
  });
}
