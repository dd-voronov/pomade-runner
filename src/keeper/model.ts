// Runner's view of the keeper and its sessions: what the scheduler holds and serves to the
// `pomade-runner` command. Plain JSON. Pure: shared by the scheduler, the control protocol and the
// command.

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
  /** The keeper's session id (`svc:coda-helper.coda-web`). */
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
