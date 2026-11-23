// The scheduler's connection to Pomade over the Host API socket: kept up while Pomade runs,
// retried while it is closed. While connected, the scheduler serves Runner's API through the
// broker, publishes Runner's events, follows Pomade's projects, hears the header actions clicked
// on attached tabs of Runner's sessions, hears the events its hooks fire on — Pomade's: Pomade
// ready, a project's first open, the project in front changed, a project created; the Agents app's: a session finished, a
// session's status changed — and sets the badge once Pomade is ready.

import { stayConnected } from "pomade-kit/node";
import { REPO_JOBS_METHOD, type AttachedTabActionPayload, type JsonValue, type RepoJob, type RepoJobsParams, type RepoJobsResult } from "pomade-kit/protocol";
import { HostError, type HostClient } from "pomade-kit/sdk";

import type { JobsSnapshot, ProjectRecord } from "../jobs/model";
import { APP_ID } from "../app";
import { readSessionClosed, readStatusChanged, SESSION_CLOSED_EVENT, SESSION_STATUS_CHANGED_EVENT, type SessionClosed, type StatusChanged } from "./agent-events";
import type { ServiceActionResult, ServicesReport } from "../keeper/model";
import type { EnvironmentReport } from "../scheduler/environment";
import {
  SWITCH_POSITIONS,
  type DeleteResult,
  type EnableResult,
  type HistoryPage,
  type MissedChoice,
  type MissedChoiceResult,
  type ResumeResult,
  type RunActionResult,
  type RunOutput,
  type RunsReport,
  type RunStopResult,
  type RunView,
  type SwitchPosition,
  type SwitchState,
} from "../scheduler/model";
import { isSettingsField, SETTINGS_FIELDS, type SettingsField, type SettingsReport, type SettingsValue, type SettingsWriteResult } from "../scheduler/settings";
import {
  DISMISS_METHOD,
  HISTORY_LIST_METHOD,
  JOBS_CHANGED_EVENT,
  JOBS_LIST_METHOD,
  MISSED_METHOD,
  RESUME_METHOD,
  RUN_GET_METHOD,
  RUN_NOW_METHOD,
  RUN_OUTPUT_METHOD,
  RUN_STOP_METHOD,
  RUNS_CHANGED_EVENT,
  RUNS_LIST_METHOD,
  SERVICE_METHODS,
  SERVICES_CHANGED_EVENT,
  SERVICES_LIST_METHOD,
  SET_ENABLED_METHOD,
  ENVIRONMENT_GET_METHOD,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_GET_METHOD,
  SETTINGS_SET_METHOD,
  SWITCH_METHOD,
  DELETE_JOB_METHOD,
  type ServiceVerb,
} from "./runner-api";

export interface PomadeLinkHandlers {
  connected(host: HostClient): void;
  /** Pomade quit or restarted; a reconnect follows. */
  disconnected(): void;
  /** Pomade refused Runner (its key, or a Host API version mismatch); retried. */
  rejected(reason: string): void;
}

/** Starts the connection; `stop()` closes it and ends the retries. */
export type LinkPomade = (handlers: PomadeLinkHandlers) => { stop(): void };

export const linkPomade: LinkPomade = (handlers) =>
  stayConnected(
    { role: "backend" },
    {
      onConnect: (host) => handlers.connected(host),
      onDisconnect: () => handlers.disconnected(),
      onRejected: (reason) => handlers.rejected(reason),
    },
  );

/** A plain-JSON value as the broker carries it. */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Pomade's projects as the job checks need them. */
async function readProjects(host: HostClient): Promise<ProjectRecord[]> {
  const { projects } = await host.project.list();
  return projects.map(({ id, name, root }) => ({ id, name, root }));
}

export interface RunnerOffer {
  /** The checked jobs now. */
  jobs(): JobsSnapshot;
  /** The services now. */
  services(): ServicesReport;
  /** Start, Stop or Restart a service (by its id or name). */
  serviceAction(verb: ServiceVerb, job: string): Promise<ServiceActionResult>;
  /** Pomade's projects, read once Pomade is ready and again when one is created or renamed. */
  projects(projects: ProjectRecord[]): void;
  /** A header action clicked on an attached tab of one of Runner's sessions (`attachedTab.action`,
   *  which Pomade delivers only to the session's owner). */
  tabAction(payload: AttachedTabActionPayload): void;
  /** The runs going, next up, each job's latest run and Needs you. */
  runs(): RunsReport;
  /** The git jobs that target a repo (`jobs.forRepo`). */
  repoJobs(repo: RepoJobsParams["repo"]): RepoJob[];
  /** A page of history. */
  history(query: { job: string | null; before: string | null; limit: number }): Promise<HistoryPage>;
  /** One run, going or finished. */
  run(job: string, run: string): Promise<RunView | null>;
  /** The end of a run's output log. */
  output(job: string, run: string): Promise<RunOutput>;
  /** Run now. */
  runNow(job: string): Promise<RunActionResult>;
  /** Enable or Disable a job. */
  setEnabled(job: string, enabled: boolean): Promise<EnableResult>;
  /** Resolve a Needs-you item. */
  dismiss(id: string): boolean;
  /** The person's choice for a missed run that waits for them. */
  missed(job: string, choice: MissedChoice): Promise<MissedChoiceResult>;
  /** Stop a running run as stopped by you. */
  stopRun(job: string, run: string): Promise<RunStopResult>;
  /** Set the global switch. */
  setSwitch(position: SwitchPosition): Promise<SwitchState>;
  /** Lift the loop guard's pause of a job. */
  resume(job: string): Promise<ResumeResult>;
  /** The workspace settings. */
  settings(): SettingsReport;
  /** What the Settings view shows read-only about the Mac. */
  environment(): Promise<EnvironmentReport>;
  /** Write one setting. */
  setSetting(field: SettingsField, value: SettingsValue): Promise<SettingsWriteResult>;
  /** Delete a job: a running service stopped first, then its file removed. */
  deleteJob(job: string): Promise<DeleteResult>;
  /** Pomade restored its tabs (`pomade.ready`, sticky: heard at once when it already did), with the
   *  project in front then; `null` for the Workspace project, or when it cannot be read. */
  ready(active: ProjectRecord | null): void;
  /** A project — not the Workspace project — became active for the first time since the workspace
   *  loaded (`project.opened`). */
  opened(project: ProjectRecord): void;
  /** The project in front changed (`project.changed`): a project, or `null` for the Workspace
   *  project; also heard when the active project is renamed or moved. */
  changed(project: ProjectRecord | null): void;
  /** A project was added to the workspace (`project.created`). */
  created(project: ProjectRecord): void;
  /** An agent session's process ended (`pomade-agents:session.closed`). */
  sessionClosed(event: SessionClosed): void;
  /** The Owner changed a session's status (`pomade-agents:session.statusChanged`). */
  statusChanged(event: StatusChanged): void;
  log(message: string): void;
}

/** A project as an event's payload names it (`ProjectRef`); `null` for the Workspace project or a
 *  payload that is not one. */
export function projectOf(payload: unknown): ProjectRecord | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { id, kind, name, root } = payload as Record<string, unknown>;
  return kind === "project" && typeof id === "string" && typeof name === "string" && typeof root === "string" ? { id, name, root } : null;
}

/** The params of a call: a mapping, or `invalid-params` with what `method` takes. */
function paramsOf(method: string, params: JsonValue, takes: string): Record<string, JsonValue | undefined> {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) return params;
  throw new HostError("invalid-params", `${method} takes ${takes}`);
}

/** A non-empty text param. */
function text(method: string, params: Record<string, JsonValue | undefined>, key: string, takes: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw new HostError("invalid-params", `${method} takes ${takes}`);
  return value;
}

/** A handler for Runner's own frames only. */
function own(method: string, handle: (params: JsonValue) => Promise<unknown> | unknown) {
  return async (params: JsonValue, { from }: { from: string }): Promise<JsonValue> => {
    if (from !== APP_ID) throw new HostError("capability-denied", `${method} is Runner's own`);
    return asJson(await handle(params));
  };
}

/** A Start, Stop or Restart handler: for Runner's own frames, with `{ job }`. */
function serviceHandler(offer: RunnerOffer, verb: ServiceVerb) {
  const method = SERVICE_METHODS[verb];
  const takes = "{ job: <a service's id or name> }";
  return own(method, (params) => offer.serviceAction(verb, text(method, paramsOf(method, params, takes), "job", takes)));
}

const RUN_TAKES = "{ job: <a job's id>, run: <a run id> }";

/** `{ job, run }`. */
function runParams(method: string, params: JsonValue): { job: string; run: string } {
  const given = paramsOf(method, params, RUN_TAKES);
  return { job: text(method, given, "job", RUN_TAKES), run: text(method, given, "run", RUN_TAKES) };
}

/** `jobs.forRepo`'s `{ repo: { name, path } }`. */
function repoParams(params: JsonValue): RepoJobsParams["repo"] {
  const takes = "{ repo: { name: <the repo's name in the Git panel>, path: <its real path> } }";
  const repo = paramsOf(REPO_JOBS_METHOD, params, takes).repo;
  if (typeof repo !== "object" || repo === null || Array.isArray(repo)) throw new HostError("invalid-params", `${REPO_JOBS_METHOD} takes ${takes}`);
  return { name: text(REPO_JOBS_METHOD, repo, "name", takes), path: text(REPO_JOBS_METHOD, repo, "path", takes) };
}

/** `history.list`'s `{ job?, before?, limit? }`. */
function historyParams(params: JsonValue): { job: string | null; before: string | null; limit: number } {
  const takes = "{ job?: <a job's id>, before?: <a page's next>, limit?: <1–200> }";
  const given = params === null ? {} : paramsOf(HISTORY_LIST_METHOD, params, takes);
  const { job = null, before = null, limit = 50 } = given;
  if ((job !== null && typeof job !== "string") || (before !== null && typeof before !== "string") || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new HostError("invalid-params", `${HISTORY_LIST_METHOD} takes ${takes}`);
  }
  return { job, before, limit };
}

/**
 * On a new connection: serve Runner's API — the jobs, the git jobs that target a repo (to Pomade),
 * the services and their Start, Stop and Restart, the runs, the history, Run now, Enable / Disable, Needs you and a missed run's choice,
 * Stop on a run, the switch, Resume on a job the loop guard paused, the settings — follow the projects, hear tab actions,
 * `pomade.ready`, `project.opened`, `project.changed` and `project.created`, the Agents app's `session.closed` and
 * `session.statusChanged` — a payload that is not the contract's is logged and ignored — and announce the jobs, the services, the runs and the settings: a frame that
 * found no scheduler before asks again when it hears `jobs.changed`, `services.changed`,
 * `runs.changed` or `settings.changed`.
 */
export async function offerRunner(host: HostClient, offer: RunnerOffer): Promise<void> {
  const reloadProjects = (): void => {
    readProjects(host).then(offer.projects, (err: unknown) => offer.log(`cannot read Pomade's projects: ${String(err)}`));
  };
  try {
    await host.api.serve({
      [JOBS_LIST_METHOD]: () => asJson(offer.jobs()),
      [SERVICES_LIST_METHOD]: () => asJson(offer.services()),
      [SERVICE_METHODS.start]: serviceHandler(offer, "start"),
      [SERVICE_METHODS.stop]: serviceHandler(offer, "stop"),
      [SERVICE_METHODS.restart]: serviceHandler(offer, "restart"),
      [RUNS_LIST_METHOD]: () => asJson(offer.runs()),
      // Pomade's repo rows ask, as the caller `pomade` (PLATFORM rule 7).
      [REPO_JOBS_METHOD]: (params) => {
        const result: RepoJobsResult = { jobs: offer.repoJobs(repoParams(params)) };
        return asJson(result);
      },
      [HISTORY_LIST_METHOD]: async (params) => asJson(await offer.history(historyParams(params))),
      [RUN_GET_METHOD]: async (params) => {
        const { job, run } = runParams(RUN_GET_METHOD, params);
        return asJson(await offer.run(job, run));
      },
      [RUN_OUTPUT_METHOD]: async (params) => {
        const { job, run } = runParams(RUN_OUTPUT_METHOD, params);
        return asJson(await offer.output(job, run));
      },
      [RUN_NOW_METHOD]: own(RUN_NOW_METHOD, (params) => {
        const takes = "{ job: <a job's id or name> }";
        return offer.runNow(text(RUN_NOW_METHOD, paramsOf(RUN_NOW_METHOD, params, takes), "job", takes));
      }),
      [SET_ENABLED_METHOD]: own(SET_ENABLED_METHOD, (params) => {
        const takes = "{ job: <a job's id or name>, enabled: true | false }";
        const given = paramsOf(SET_ENABLED_METHOD, params, takes);
        if (typeof given.enabled !== "boolean") throw new HostError("invalid-params", `${SET_ENABLED_METHOD} takes ${takes}`);
        return offer.setEnabled(text(SET_ENABLED_METHOD, given, "job", takes), given.enabled);
      }),
      [DISMISS_METHOD]: own(DISMISS_METHOD, (params) => {
        const takes = "{ id: <a Needs-you item's id> }";
        return { resolved: offer.dismiss(text(DISMISS_METHOD, paramsOf(DISMISS_METHOD, params, takes), "id", takes)) };
      }),
      [MISSED_METHOD]: own(MISSED_METHOD, (params) => {
        const takes = '{ job: <a job\'s id>, choice: "run-now" | "run-at" | "skip" | "run-all" | "run-others", at?: <a time>, run?: <a run id> }';
        const given = paramsOf(MISSED_METHOD, params, takes);
        const job = text(MISSED_METHOD, given, "job", takes);
        const { choice } = given;
        if (choice === "run-now" || choice === "skip" || choice === "run-all") return offer.missed(job, { kind: choice });
        if (choice === "run-at") return offer.missed(job, { kind: "run-at", at: text(MISSED_METHOD, given, "at", takes) });
        if (choice === "run-others") return offer.missed(job, { kind: "run-others", run: text(MISSED_METHOD, given, "run", takes) });
        throw new HostError("invalid-params", `${MISSED_METHOD} takes ${takes}`);
      }),
      [RUN_STOP_METHOD]: own(RUN_STOP_METHOD, (params) => {
        const { job, run } = runParams(RUN_STOP_METHOD, params);
        return offer.stopRun(job, run);
      }),
      [SWITCH_METHOD]: own(SWITCH_METHOD, (params) => {
        const takes = '{ position: "running" | "pause-low" | "pause-all" }';
        const position = paramsOf(SWITCH_METHOD, params, takes).position;
        if (typeof position !== "string" || !(SWITCH_POSITIONS as readonly string[]).includes(position)) throw new HostError("invalid-params", `${SWITCH_METHOD} takes ${takes}`);
        return offer.setSwitch(position as SwitchPosition);
      }),
      [RESUME_METHOD]: own(RESUME_METHOD, (params) => {
        const takes = "{ job: <a job's id or name> }";
        return offer.resume(text(RESUME_METHOD, paramsOf(RESUME_METHOD, params, takes), "job", takes));
      }),
      [SETTINGS_GET_METHOD]: () => asJson(offer.settings()),
      [ENVIRONMENT_GET_METHOD]: async () => asJson(await offer.environment()),
      [SETTINGS_SET_METHOD]: own(SETTINGS_SET_METHOD, (params) => {
        const takes = "{ field: <a setting>, value: <a number — a folder for skills-folder — or null for its default> }";
        const given = paramsOf(SETTINGS_SET_METHOD, params, takes);
        const { field, value } = given;
        if (typeof field !== "string" || !isSettingsField(field)) throw new HostError("invalid-params", `${SETTINGS_SET_METHOD} takes ${takes}`);
        const path = SETTINGS_FIELDS[field].kind === "path";
        if (value === null || (path && typeof value === "string") || (!path && typeof value === "number")) return offer.setSetting(field, value);
        throw new HostError("invalid-params", `${SETTINGS_SET_METHOD} takes ${takes}`);
      }),
      [DELETE_JOB_METHOD]: own(DELETE_JOB_METHOD, (params) => {
        const takes = "{ job: <a job's id or name> }";
        return offer.deleteJob(text(DELETE_JOB_METHOD, paramsOf(DELETE_JOB_METHOD, params, takes), "job", takes));
      }),
    });
    await host.events.subscribe("project.created", (payload) => {
      reloadProjects();
      const project = projectOf(payload);
      if (project !== null) offer.created(project);
    });
    await host.events.subscribe("project.renamed", reloadProjects);
    await host.events.subscribe("project.opened", (payload) => {
      const project = projectOf(payload);
      if (project !== null) offer.opened(project);
    });
    await host.events.subscribe("project.changed", (payload) => offer.changed(projectOf(payload)));
    await host.events.subscribe("attachedTab.action", offer.tabAction);
    await host.events.subscribe(SESSION_CLOSED_EVENT, (payload) => {
      const event = readSessionClosed(payload);
      if (event === null) offer.log(`ignored a ${SESSION_CLOSED_EVENT} that is not the Agents app's contract: ${JSON.stringify(payload)}`);
      else offer.sessionClosed(event);
    });
    await host.events.subscribe(SESSION_STATUS_CHANGED_EVENT, (payload) => {
      const event = readStatusChanged(payload);
      if (event === null) offer.log(`ignored a ${SESSION_STATUS_CHANGED_EVENT} that is not the Agents app's contract: ${JSON.stringify(payload)}`);
      else offer.statusChanged(event);
    });
    // Pomade's projects are read once it is ready: before, its workspace may not be loaded, and the
    // list it gives may miss projects.
    await host.events.subscribe("pomade.ready", () => {
      void (async () => {
        try {
          offer.projects(await readProjects(host));
        } catch (err) {
          offer.log(`cannot read Pomade's projects: ${String(err)}`);
        }
        let active: ProjectRecord | null = null;
        try {
          active = projectOf(await host.project.getActive());
        } catch (err) {
          offer.log(`cannot read the project in front: ${String(err)}`);
        }
        offer.ready(active);
      })();
    });
    await host.events.publish(JOBS_CHANGED_EVENT);
    await host.events.publish(SERVICES_CHANGED_EVENT);
    await host.events.publish(RUNS_CHANGED_EVENT);
    await host.events.publish(SETTINGS_CHANGED_EVENT);
  } catch (err) {
    offer.log(`cannot offer Runner's API to Pomade: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Publish one of Runner's events: a change its frames ask again on (`jobs.changed`,
 *  `services.changed`, `runs.changed`, `settings.changed`), or a run's start or end with its payload. */
export function announce(host: HostClient, event: string, log: (message: string) => void, payload?: unknown): void {
  host.events.publish(event, payload === undefined ? null : asJson(payload)).catch((err: unknown) => log(`cannot publish ${event}: ${String(err)}`));
}
