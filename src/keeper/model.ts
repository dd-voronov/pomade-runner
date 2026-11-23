// Runner's view of the keeper, its sessions and the services it supervises: what the scheduler
// holds and serves to the `pomade-runner` command and to Runner's frames. Plain JSON. Pure: shared
// by the scheduler, the control protocol, the command and the UI.

import { EXIT_REASONS, type SessionExit, type SessionInfo } from "pomade-kit/protocol";

/** Where the scheduler's connection to the keeper stands. */
export type KeeperLink =
  | { state: "connecting" }
  /** Connected as the owner; `version` is the running keeper's. */
  | { state: "connected"; version: string; pid: number }
  /** No keeper answers, and starting one failed; retried every tick. */
  | { state: "unreachable"; reason: string }
  /** The keeper refused the scheduler as its owner; retried every tick. */
  | { state: "rejected"; reason: string };

/** One keeper session, with what Runner knows of it beyond the keeper's own `SessionInfo`. */
export interface RunnerSession {
  /** The keeper's session id (`svc:blog.dev-server`). */
  id: string;
  /** The job it belongs to. */
  job: string;
  /** `service`: a service's one session, restarted under the same id · `run`: one run of a job. */
  kind: "service" | "run";
  /** The run it is — a service's current start; `null` when Runner did not start it this way. */
  run: string | null;
  /** The run's output log (absolute); `null` when unknown. */
  log: string | null;
  info: SessionInfo;
}

/** What `pomade-runner sessions` shows. */
export interface SessionsReport {
  keeper: KeeperLink;
  sessions: RunnerSession[];
}

/** How a session ended, in a line: `crashed — code 137, SIGKILL`. */
export function exitWords(exit: SessionExit): string {
  const details = [exit.code === null ? null : `code ${exit.code}`, exit.signal].filter((detail) => detail !== null);
  return details.length > 0 ? `${exit.reason} — ${details.join(", ")}` : exit.reason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const REASONS: readonly string[] = EXIT_REASONS;

function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isRecord(value)) return false;
  const { id, title, command, cwd, pid, startedAt, state, exit } = value;
  return (
    typeof id === "string" &&
    typeof title === "string" &&
    typeof command === "string" &&
    typeof cwd === "string" &&
    (pid === null || typeof pid === "number") &&
    typeof startedAt === "number" &&
    (state === "running" || state === "exited") &&
    (exit === null ||
      (isRecord(exit) &&
        (exit.code === null || typeof exit.code === "number") &&
        nullableString(exit.signal) &&
        typeof exit.reason === "string" &&
        REASONS.includes(exit.reason) &&
        typeof exit.at === "number"))
  );
}

export function isRunnerSession(value: unknown): value is RunnerSession {
  if (!isRecord(value)) return false;
  const { id, job, kind, run, log, info } = value;
  return typeof id === "string" && typeof job === "string" && (kind === "service" || kind === "run") && nullableString(run) && nullableString(log) && isSessionInfo(info);
}

function isKeeperLink(value: unknown): value is KeeperLink {
  if (!isRecord(value)) return false;
  switch (value.state) {
    case "connecting":
      return true;
    case "connected":
      return typeof value.version === "string" && typeof value.pid === "number";
    case "unreachable":
    case "rejected":
      return typeof value.reason === "string";
    default:
      return false;
  }
}

export function isSessionsReport(value: unknown): value is SessionsReport {
  return isRecord(value) && isKeeperLink(value.keeper) && Array.isArray(value.sessions) && value.sessions.every(isRunnerSession);
}

/** Where a service stands (docs/DESIGN.md "Services"):
 *  - `queued`: due to start, waiting its turn in the staged start;
 *  - `starting`: runs, not up yet (its readiness check);
 *  - `running`: up;
 *  - `restarting`: ended on its own; starts again after its back-off (`retryAt`);
 *  - `failed`: 5 crashes within a minute; no restarts until Start;
 *  - `stopped-by-you`: Ctrl+C in its tab, or Stop; stays stopped until Start;
 *  - `waiting`: `start: project-first-open`, its start project not opened since Pomade started —
 *    the open starts it, Start runs it now;
 *  - `waiting-for-pomade`: `start: pomade-started` or `project-first-open` while Pomade is not
 *    running, or not ready yet — Pomade's start starts it; Start is refused;
 *  - `disabled`: `enabled: false` in its file;
 *  - `invalid`: its file has errors — nothing starts or stops it until the file is fixed;
 *  - `removed`: its file is gone; its session is stopped, and the service leaves the list once it ends. */
export const SERVICE_STATES = ["queued", "starting", "running", "restarting", "failed", "stopped-by-you", "waiting", "waiting-for-pomade", "disabled", "invalid", "removed"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** One service as supervision sees it. */
export interface ServiceStatus {
  /** The job's id (`blog/dev-server`). */
  job: string;
  /** The job's name; for a service whose file is invalid or gone, its session's title or the id. */
  name: string;
  /** The stable project id; `null` for a workspace job or when the file does not say. */
  project: string | null;
  state: ServiceState;
  /** Its session: the running one, or the last that ended; `null` when it never ran. */
  session: RunnerSession | null;
  /** Restarts after a crash since the count last reset (10 minutes of uptime, or Start). */
  restarts: number;
  /** When it last crashed (epoch ms); `null` since the count last reset. */
  lastCrashAt: number | null;
  /** `restarting`: when it starts again (epoch ms); else `null`. */
  retryAt: number | null;
  /** It runs with a command or folder other than its file's now: a restart applies the file. */
  needsRestart: boolean;
  /** Why its last start failed (the keeper refused it), or `null`. */
  problem: string | null;
}

/** What the services view, `pomade-runner services` and the control methods show. */
export interface ServicesReport {
  keeper: KeeperLink;
  /** In start order: workspace jobs first, then by project, each by id. */
  services: ServiceStatus[];
  /** The projects opened since Pomade started (ids), as Runner heard them: a first-open service of
   *  one of them starts at once. */
  openedProjects: string[];
}

const STATES: readonly string[] = SERVICE_STATES;
const nullableNumber = (value: unknown): boolean => value === null || typeof value === "number";

export function isServiceStatus(value: unknown): value is ServiceStatus {
  if (!isRecord(value)) return false;
  const { job, name, project, state, session, restarts, lastCrashAt, retryAt, needsRestart, problem } = value;
  return (
    typeof job === "string" &&
    typeof name === "string" &&
    nullableString(project) &&
    typeof state === "string" &&
    STATES.includes(state) &&
    (session === null || isRunnerSession(session)) &&
    typeof restarts === "number" &&
    nullableNumber(lastCrashAt) &&
    nullableNumber(retryAt) &&
    typeof needsRestart === "boolean" &&
    nullableString(problem)
  );
}

/** The answer to Start, Stop or Restart: where the service stands after it, or why it was refused. */
export type ServiceActionResult = { ok: true; service: ServiceStatus } | { ok: false; reason: string };

/** What a chain's action did to a service: `done`, or `skipped` (nothing to do: "it is not
 *  running") or `failed` (the keeper refused) with the reason. */
export type ChainActionOutcome = { result: "done" } | { result: "skipped" | "failed"; reason: string };

export function isServiceActionResult(value: unknown): value is ServiceActionResult {
  if (!isRecord(value)) return false;
  return value.ok === true ? isServiceStatus(value.service) : value.ok === false && typeof value.reason === "string";
}

export function isServicesReport(value: unknown): value is ServicesReport {
  return (
    isRecord(value) &&
    isKeeperLink(value.keeper) &&
    Array.isArray(value.services) &&
    value.services.every(isServiceStatus) &&
    Array.isArray(value.openedProjects) &&
    value.openedProjects.every((project) => typeof project === "string")
  );
}
