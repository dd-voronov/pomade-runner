// The job model: what a job file says once it is read and checked (docs/DESIGN.md "Job files").
// Plain JSON throughout, so the scheduler serves it to the UI unchanged. Pure: no I/O.

import { GIT_RUN_OPS, type GitRunOp } from "pomade-kit/protocol";
import type { Schedule } from "pomade-kit/schedule";

/** Where job files live, workspace-relative. */
export const JOBS_FOLDER = "Apps/pomade-runner/jobs";

export const JOB_KINDS = ["service", "script", "agent", "git"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const NOTIFY_VALUES = ["always", "on-failure", "never"] as const;
export type Notify = (typeof NOTIFY_VALUES)[number];

/** When a service starts, and with it how long it lives: `login` on Mac startup, outliving Pomade;
 *  `pomade-started` when Pomade starts, `project-first-open` on its start project's first open since
 *  then — both stop when Pomade quits. */
export const SERVICE_STARTS = ["login", "pomade-started", "project-first-open"] as const;
export type ServiceStart = (typeof SERVICE_STARTS)[number];

/** Whether a service's start binds it to Pomade: it runs only while Pomade runs. */
export const pomadeBound = (start: ServiceStart): boolean => start !== "login";

export const CHAIN_RESULTS = ["done", "failed", "any"] as const;
export type ChainResult = (typeof CHAIN_RESULTS)[number];

export const SERVICE_ACTIONS = ["restart", "start", "stop"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export const MISSED_POLICIES = ["run-on-wake", "wait-for-me", "skip"] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];

export const OVERLAP_POLICIES = ["skip", "parallel", "queue"] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

/** The operations a git job runs: `pomade-git`'s. */
export const GIT_OPERATIONS = GIT_RUN_OPS;
export type GitOperation = GitRunOp;

export const HOOK_EVENTS = ["login", "pomade-started", "project-first-open", "project-opened", "project-created", "session-finished", "session-status"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The session statuses `pomade-agents` keeps; the `session-status` hook fires on a change to one. */
export const SESSION_STATUSES = ["active", "on-hold", "done", "done-skip"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** A session status as the Agents app names it. */
export const SESSION_STATUS_WORDS: Record<SessionStatus, string> = { active: "Active", "on-hold": "On hold", done: "Done", "done-skip": "Done–skip/Failed" };

/** Which filters each hook event takes; `required` ones must be given. */
export const HOOK_FILTERS: Record<HookEvent, { optional: readonly HookFilter[]; required: readonly HookFilter[] }> = {
  login: { optional: [], required: [] },
  "pomade-started": { optional: [], required: [] },
  "project-first-open": { optional: ["project"], required: [] },
  "project-opened": { optional: ["project"], required: [] },
  "project-created": { optional: [], required: [] },
  "session-finished": { optional: ["project", "agent"], required: [] },
  "session-status": { optional: ["project", "agent"], required: ["status"] },
};
export type HookFilter = "project" | "agent" | "status";

export interface Hook {
  event: HookEvent;
  /** A stable project id; `null` = any project. */
  project: string | null;
  /** An agent's roster id; `null` = any agent. */
  agent: string | null;
  /** `session-status` only. */
  status: SessionStatus | null;
}

/** A chain: run when another job finishes. `job` is that job's id. */
export interface Chain {
  job: string;
  result: ChainResult;
}

export type Trigger =
  | { kind: "schedule"; schedule: Schedule; /** In words: "weekdays at 7:00". */ words: string }
  | { kind: "hook"; hook: Hook }
  | { kind: "chain"; chain: Chain };

/** How a service tells it is up: alive after 5 s, a port that accepts connections, or a URL that answers. */
export type Readiness = { kind: "alive" } | { kind: "port"; port: number } | { kind: "url"; url: string };

/** The policies of a job that runs once per trigger. */
export interface RunPolicies {
  /** Scheduled jobs only; `null` for a hook or a chain. */
  missed: MissedPolicy | null;
  /** With `missed: run-on-wake`: `"next-run"` or a time of day (`"12:00"`); else `null`. */
  worthUntil: string | null;
  overlap: OverlapPolicy;
  /** `null` = no limit. */
  timeLimitMinutes: number | null;
}

interface JobCommon {
  /** The job's id: its path inside the jobs folder without `.md` — `backup`, `coda-helper/coda-web`. */
  id: string;
  /** The file, workspace-relative. */
  path: string;
  name: string;
  /** The stable project id; `null` for a workspace job. */
  project: string | null;
  enabled: boolean;
  notify: Notify;
  lowPriority: boolean;
  /** Everything after the frontmatter block: notes, or an agent job's prompt. */
  body: string;
}

export interface ServiceJob extends JobCommon {
  kind: "service";
  /** Workspace-relative; `""` is the workspace root. */
  folder: string;
  command: string;
  start: ServiceStart;
  /** `start: project-first-open`: the project whose first open starts it — `start-project`, else
   *  the job's own; `null` for the other starts. */
  startProject: string | null;
  ready: Readiness;
  /** A chain that acts on the service. */
  after: (Chain & { action: ServiceAction }) | null;
}

export interface ScriptJob extends JobCommon, RunPolicies {
  kind: "script";
  folder: string;
  command: string;
  trigger: Trigger;
}

export interface AgentJob extends JobCommon, RunPolicies {
  kind: "agent";
  folder: string;
  /** The agent's roster id in `pomade-agents`. */
  agent: string;
  /** One of the agent's modes. */
  mode: string;
  /** The body, trimmed. */
  prompt: string;
  trigger: Trigger;
}

export interface GitJob extends JobCommon, RunPolicies {
  kind: "git";
  git: { operation: GitOperation; repos: string[] };
  trigger: Trigger;
}

export type Job = ServiceJob | ScriptJob | AgentJob | GitJob;

/** One problem in a job file: where it is and what to do about it. */
export interface JobError {
  /** The file, workspace-relative. */
  path: string;
  /** 1-based line in the file. */
  line: number;
  /** The field it is about, as a path (`schedule.weekly.days[1]`); `"body"` for what follows the
   *  frontmatter (an agent job's prompt); `""` for the file as a whole. */
  field: string;
  problem: string;
  fix: string;
}

/** What is known of an invalid job, for listing it and for checking another file among it. */
export interface InvalidJob {
  id: string;
  path: string;
  name: string | null;
  kind: JobKind | null;
  project: string | null;
  /** The id of the job its `after:` names, as written; `null` for none. A chain that loops back
   *  makes every job in the loop invalid, and the job form's check still sees the loop by it. */
  after: string | null;
  errors: JobError[];
}

export type JobEntry = { valid: true; job: Job } | { valid: false; invalid: InvalidJob };

/** A project as the checks need it: `ProjectRef` from the Host API. */
export interface ProjectRecord {
  id: string;
  name: string;
  /** Workspace-relative. */
  root: string;
}

/** Every job file of a workspace, checked. Served to the UI as `jobs.list`. */
export interface JobsSnapshot {
  /** The workspace root (absolute); `null` when none is known. */
  workspace: string | null;
  /** Whether project ids were checked against Pomade's projects. */
  projectsChecked: boolean;
  /** Valid and invalid jobs, by path. */
  jobs: JobEntry[];
}

export function entryId(entry: JobEntry): string {
  return entry.valid ? entry.job.id : entry.invalid.id;
}

export function entryPath(entry: JobEntry): string {
  return entry.valid ? entry.job.path : entry.invalid.path;
}

/** A job file's path inside the workspace, from its path inside the jobs folder. */
export function workspacePath(jobsRelative: string): string {
  return `${JOBS_FOLDER}/${jobsRelative}`;
}
