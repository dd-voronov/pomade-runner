// The scheduler's control protocol: how the `pomade-runner` command talks to the scheduler
// directly, with Pomade open or closed. One JSON object per line over the scheduler's own unix
// socket (`schedulerSocketPath`); a request names the protocol version it speaks, and every
// response carries the scheduler's, so a command and a scheduler of different builds — an update
// replaces the command at once and the running scheduler a moment later — tell each other apart
// with a message instead of misreading each other. A method added later is answered
// `unknown-method` by an older scheduler.

import { isServicesReport, isServiceStatus, isSessionsReport, type ServicesReport, type ServiceStatus, type SessionsReport } from "../../keeper/model";
import { isActiveRun, isHistoryPage, isJobListings, isRunsReport, isSwitchState, SWITCH_POSITIONS, type ActiveRun, type HistoryPage, type JobListing, type RunsReport, type SwitchPosition, type SwitchState } from "../model";

export const CONTROL_PROTOCOL = 1;

/** Where the scheduler's connection to Pomade stands. */
export type PomadeLinkState = "connected" | "disconnected" | "rejected";

export interface SchedulerStatus {
  /** The running scheduler's build. */
  version: string;
  pid: number;
  /** ISO time the scheduler started. */
  startedAt: string;
  /** ISO time of its latest tick; `null` before the first. */
  lastTickAt: string | null;
  pomade: PomadeLinkState;
}

/** Every method, with the value it answers. */
export interface ControlMethods {
  status: SchedulerStatus;
  /** The keeper and its sessions. */
  sessions: SessionsReport;
  /** Every service and where it stands. */
  services: ServicesReport;
  /** Run a job now: a script's run (going or queued), or a service's status after Start. */
  run: RunStarted;
  /** Stop a service as stopped by you. */
  stop: ServiceStatus;
  /** Restart a service (start it when it does not run). */
  restart: ServiceStatus;
  /** Write `enabled: true` into a job's file. */
  enable: JobEnabled;
  /** Write `enabled: false` into a job's file. */
  disable: JobEnabled;
  /** Every job, with its trigger in words, next run and latest run. */
  list: JobListing[];
  /** Finished runs, newest first. */
  history: HistoryPage;
  /** The runs going and what each waits for, Next up, each job's runs, Needs you and the switch. */
  runs: RunsReport;
  /** Set the global switch, or — `position: null` — read it. */
  switch: SwitchState;
  /** Lift the loop guard's pause of a job. */
  resumeJob: JobResumed;
}

/** What Run now started: a script's run, or a service. */
export type RunStarted = { run: ActiveRun } | { service: ServiceStatus };

/** A job the loop guard paused, resumed. */
export interface JobResumed {
  job: string;
  name: string;
}

/** A job after Enable or Disable. */
export interface JobEnabled {
  job: string;
  name: string;
  enabled: boolean;
}

/** Every method's params. */
export interface ControlParams {
  status: null;
  sessions: null;
  services: null;
  /** `job`: a job's id or name. */
  run: { job: string };
  /** `job`: a service job's id or name. */
  stop: { job: string };
  restart: { job: string };
  /** `job`: a job's id or name. */
  enable: { job: string };
  disable: { job: string };
  list: null;
  /** `job`: one job's id or name, or `null` for every job's runs; `limit`: at most this many records. */
  history: { job: string | null; limit: number };
  runs: null;
  switch: { position: SwitchPosition | null };
  /** `job`: a job's id or name. */
  resumeJob: { job: string };
}

export type ControlMethod = keyof ControlMethods;

/** `refused`: the method could not do what was asked (the message says why). */
export type ControlErrorCode = "invalid-request" | "protocol-mismatch" | "unknown-method" | "invalid-params" | "refused";

export interface ControlRequest {
  protocol: number;
  /** Chosen by the caller; the response repeats it. */
  id: string;
  method: string;
  /** The method's params; `null` for a method that takes none. */
  params: unknown;
}

export interface ControlError {
  code: ControlErrorCode;
  message: string;
}

export type ControlResponse =
  | { protocol: number; id: string; ok: true; value: unknown }
  | { protocol: number; id: string; ok: false; error: ControlError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ERROR_CODES: readonly string[] = ["invalid-request", "protocol-mismatch", "unknown-method", "invalid-params", "refused"] satisfies ControlErrorCode[];
const LINK_STATES: readonly string[] = ["connected", "disconnected", "rejected"] satisfies PomadeLinkState[];

export function parseControlRequest(data: unknown): ControlRequest | null {
  if (!isRecord(data)) return null;
  const { protocol, id, method } = data;
  if (typeof protocol !== "number" || !Number.isInteger(protocol)) return null;
  if (typeof id !== "string" || typeof method !== "string") return null;
  return { protocol, id, method, params: data.params ?? null };
}

function parseControlError(data: unknown): ControlError | null {
  if (!isRecord(data)) return null;
  const { code, message } = data;
  if (typeof code !== "string" || !ERROR_CODES.includes(code) || typeof message !== "string") return null;
  return { code: code as ControlErrorCode, message };
}

export function parseControlResponse(data: unknown): ControlResponse | null {
  if (!isRecord(data)) return null;
  const { protocol, id, ok } = data;
  if (typeof protocol !== "number" || !Number.isInteger(protocol) || typeof id !== "string") return null;
  if (ok === true) return { protocol, id, ok, value: data.value };
  if (ok !== false) return null;
  const error = parseControlError(data.error);
  return error === null ? null : { protocol, id, ok, error };
}

export function isSchedulerStatus(value: unknown): value is SchedulerStatus {
  if (!isRecord(value)) return false;
  const { version, pid, startedAt, lastTickAt, pomade } = value;
  return (
    typeof version === "string" &&
    typeof pid === "number" &&
    typeof startedAt === "string" &&
    (lastTickAt === null || typeof lastTickAt === "string") &&
    typeof pomade === "string" &&
    LINK_STATES.includes(pomade)
  );
}

/** The check a caller runs on each method's answer before trusting its shape. */
function isRunStarted(value: unknown): value is RunStarted {
  return isRecord(value) && (isActiveRun(value.run) || isServiceStatus(value.service));
}

function isJobResumed(value: unknown): value is JobResumed {
  return isRecord(value) && typeof value.job === "string" && typeof value.name === "string";
}

function isJobEnabled(value: unknown): value is JobEnabled {
  return isRecord(value) && typeof value.job === "string" && typeof value.name === "string" && typeof value.enabled === "boolean";
}

export const RESULT_GUARDS: { [M in ControlMethod]: (value: unknown) => value is ControlMethods[M] } = {
  status: isSchedulerStatus,
  sessions: isSessionsReport,
  services: isServicesReport,
  run: isRunStarted,
  stop: isServiceStatus,
  restart: isServiceStatus,
  enable: isJobEnabled,
  disable: isJobEnabled,
  list: isJobListings,
  history: isHistoryPage,
  runs: isRunsReport,
  switch: isSwitchState,
  resumeJob: isJobResumed,
};

const noParams = (params: unknown): null | undefined => (params === null ? null : undefined);
const jobParams = (params: unknown): { job: string } | undefined => (isRecord(params) && typeof params.job === "string" && params.job !== "" ? { job: params.job } : undefined);
const historyParams = (params: unknown): { job: string | null; limit: number } | undefined => {
  if (!isRecord(params)) return undefined;
  const { job, limit } = params;
  if ((job !== null && (typeof job !== "string" || job === "")) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) return undefined;
  return { job, limit };
};

/** Each method's params check: the params, or `undefined` when they are not the method's. */
export const PARAMS_PARSERS: { [M in ControlMethod]: (params: unknown) => ControlParams[M] | undefined } = {
  status: noParams,
  sessions: noParams,
  services: noParams,
  run: jobParams,
  stop: jobParams,
  restart: jobParams,
  enable: jobParams,
  disable: jobParams,
  list: noParams,
  history: historyParams,
  runs: noParams,
  switch: (params) => {
    if (!isRecord(params)) return undefined;
    const { position } = params;
    if (position === null) return { position };
    return typeof position === "string" && (SWITCH_POSITIONS as readonly string[]).includes(position) ? { position: position as SwitchPosition } : undefined;
  },
  resumeJob: jobParams,
};

/** What each method's params look like, for the error that refuses others. */
export const PARAMS_SHAPES: { [M in ControlMethod]: string } = {
  status: "none",
  sessions: "none",
  services: "none",
  run: "{ job: <a job's id or name> }",
  stop: "{ job: <a service's id or name> }",
  restart: "{ job: <a service's id or name> }",
  enable: "{ job: <a job's id or name> }",
  disable: "{ job: <a job's id or name> }",
  list: "none",
  history: "{ job: <a job's id or name> | null, limit: <a whole number ≥ 1> }",
  runs: "none",
  switch: '{ position: "running" | "pause-low" | "pause-all" | null }',
  resumeJob: "{ job: <a job's id or name> }",
};

export function isControlMethod(method: string): method is ControlMethod {
  return Object.hasOwn(RESULT_GUARDS, method);
}
