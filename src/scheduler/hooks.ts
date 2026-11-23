// Hooks (docs/DESIGN.md "Hooks"): an event fires every job whose `hook` names it and whose filters
// it passes — a filter left out takes any value. Runner's own event is `login`; Pomade's —
// `pomade-started`, `project-first-open`, `project-opened`, `project-created` — and `pomade-agents`' —
// `session-finished`, `session-status` — come in through the same firing path (`Runs.hook`). Pure.

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

/** A project's event — its first open since Pomade started, any open, or its creation: the project filter
 *  looks at its id; its runs get `POMADE_PROJECT` and, with the workspace known,
 *  `POMADE_PROJECT_PATH` (absolute). */
export function projectFiring(event: "project-first-open" | "project-opened" | "project-created", project: ProjectRecord, workspace: string | null): HookFiring {
  const context: Record<string, string> = { POMADE_PROJECT: project.id };
  if (workspace !== null) context.POMADE_PROJECT_PATH = join(workspace, project.root);
  return { event, project: project.id, agent: null, status: null, context, projectName: project.name };
}

/** An agent session as its event tells of it (`src/integrations/agent-events.ts`). */
export interface SessionOfEvent {
  sessionId: string;
  agent: string;
  /** Its project's stable id and folder, workspace-relative; `null` for the Workspace bucket. */
  project: { id: string; root: string } | null;
  transcript: string;
  status: SessionStatus;
}

/** An agent session's event — it finished, or its status changed (to `session.status`): the
 *  project and agent filters look at the session's, the status filter at its new status; its runs
 *  get `POMADE_SESSION_ID`, `POMADE_AGENT`, `POMADE_SESSION_STATUS`, `POMADE_SESSION_TRANSCRIPT`
 *  and, in a project, `POMADE_PROJECT` and, with the workspace known, `POMADE_PROJECT_PATH`
 *  (absolute). `projectName` is the project's name as Runner last heard it. */
export function sessionFiring(event: "session-finished" | "session-status", session: SessionOfEvent, workspace: string | null, projectName: string | null): HookFiring {
  const context: Record<string, string> = {
    POMADE_SESSION_ID: session.sessionId,
    POMADE_AGENT: session.agent,
    POMADE_SESSION_STATUS: session.status,
    POMADE_SESSION_TRANSCRIPT: session.transcript,
  };
  if (session.project !== null) {
    context.POMADE_PROJECT = session.project.id;
    if (workspace !== null) context.POMADE_PROJECT_PATH = join(workspace, session.project.root);
  }
  const firing: HookFiring = { event, project: session.project?.id ?? null, agent: session.agent, status: event === "session-status" ? session.status : null, context };
  if (session.project !== null && projectName !== null) firing.projectName = projectName;
  return firing;
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
