// Hooks (docs/DESIGN.md "Hooks"): an event fires every job whose `hook` names it and whose filters
// it passes — a filter left out takes any value. Runner's own event is `login`; Pomade's —
// `pomade-started`, `project-first-open`, `project-created` — and `pomade-agents`' come in through
// the same firing path (`Runs.hook`). Pure.

import { join } from "node:path";

import type { AgentJob, GitJob, HookEvent, JobsSnapshot, ProjectRecord, ScriptJob, SessionStatus } from "../jobs/model";

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
  /** The event's project's name, as its runs' cause keeps it; absent when the event has none. */
  projectName?: string;
}

/** Mac login: the scheduler's start (the scheduler is the login item). */
export const LOGIN: HookFiring = { event: "login", project: null, agent: null, status: null, context: {} };

/** Pomade started: Pomade restored its tabs, once per Pomade start. */
export const POMADE_STARTED: HookFiring = { event: "pomade-started", project: null, agent: null, status: null, context: {} };

/** A project's event — its first open since Pomade started, or its creation: the project filter
 *  looks at its id; its runs get `POMADE_PROJECT` and, with the workspace known,
 *  `POMADE_PROJECT_PATH` (absolute). */
export function projectFiring(event: "project-first-open" | "project-created", project: ProjectRecord, workspace: string | null): HookFiring {
  const context: Record<string, string> = { POMADE_PROJECT: project.id };
  if (workspace !== null) context.POMADE_PROJECT_PATH = join(workspace, project.root);
  return { event, project: project.id, agent: null, status: null, context, projectName: project.name };
}

/** The jobs an event fires: valid, enabled scripts, git and agent jobs whose hook it matches. */
export function hooked(snapshot: JobsSnapshot, firing: HookFiring): (ScriptJob | GitJob | AgentJob)[] {
  return snapshot.jobs.flatMap((entry) => {
    if (!entry.valid || entry.job.kind === "service" || !entry.job.enabled || entry.job.trigger.kind !== "hook") return [];
    const { hook } = entry.job.trigger;
    const passes = hook.event === firing.event && (hook.project === null || hook.project === firing.project) && (hook.agent === null || hook.agent === firing.agent) && (hook.status === null || hook.status === firing.status);
    return passes ? [entry.job] : [];
  });
}
