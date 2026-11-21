// The Agents app's (`pomade-agents`) session events as Runner hears them on Pomade's bus: B
// `session.closed` (an agent session's process ended) and C `session.statusChanged` (the Owner
// changed a session's status). The contract is the Agents app's — `../pomade-agents/docs/CONTRACTS.md`
// "Published events": names, payloads, and that a `reason` a subscriber does not know is an end too.
// Every payload is checked here before Runner trusts it; one that is not the contract's shape is
// `null`, which the caller logs and ignores. Pure.

import { SESSION_STATUSES, type SessionStatus } from "../jobs/model";
import { AGENTS_APP_ID } from "./agents";

/** B, as a subscriber names it. */
export const SESSION_CLOSED_EVENT = `${AGENTS_APP_ID}:session.closed`;
/** C, as a subscriber names it. */
export const SESSION_STATUS_CHANGED_EVENT = `${AGENTS_APP_ID}:session.statusChanged`;

/** What both events carry about the session. */
export interface SessionEvent {
  sessionId: string;
  /** "claude-code" or "codex" today; any other is taken as it is. */
  provider: string;
  /** The agent's roster id. */
  agent: string;
  /** The project it shows in: its stable id and folder, workspace-relative; `null` for the
   *  Workspace bucket. */
  project: { id: string; root: string } | null;
  /** The start folder, absolute; `null` when the transcript records none. */
  cwd: string | null;
  /** The session's latest transcript file, absolute. */
  transcript: string;
  name: string | null;
  status: SessionStatus;
  /** Runner started it — an agent run; then `job` is the job's name. */
  startedByRunner: boolean;
  job: string | null;
  /** When it happened, ISO 8601. */
  at: string;
}

/** B: `reason` is `exit`, `tab-closed`, `crash` or `run-finished` — or one Runner does not know,
 *  which is an end too. */
export interface SessionClosed extends SessionEvent {
  reason: string;
}

/** C: the status before the first change of its window and after the last (`status` = `to`). */
export interface StatusChanged extends SessionEvent {
  from: SessionStatus;
  to: SessionStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFilled = (value: unknown): value is string => typeof value === "string" && value !== "";
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isStatus = (value: unknown): value is SessionStatus => (SESSION_STATUSES as readonly unknown[]).includes(value);

function sessionEventOf(value: Record<string, unknown>): SessionEvent | null {
  const { sessionId, provider, agent, project, cwd, transcript, name, status, startedByRunner, job, at } = value;
  const projectOk = project === null || (isRecord(project) && isFilled(project.id) && typeof project.root === "string");
  if (!isFilled(sessionId) || !isFilled(provider) || !isFilled(agent) || !projectOk || !isTextOrNull(cwd) || !isFilled(transcript) || !isTextOrNull(name) || !isStatus(status) || typeof startedByRunner !== "boolean" || !isTextOrNull(job) || !isFilled(at)) return null;
  return {
    sessionId,
    provider,
    agent,
    project: project === null ? null : { id: project.id as string, root: project.root as string },
    cwd,
    transcript,
    name,
    status,
    startedByRunner,
    job,
    at,
  };
}

/** B's payload; `null` when it is not the contract's. */
export function readSessionClosed(payload: unknown): SessionClosed | null {
  if (!isRecord(payload) || !isFilled(payload.reason)) return null;
  const base = sessionEventOf(payload);
  return base === null ? null : { ...base, reason: payload.reason };
}

/** C's payload; `null` when it is not the contract's. */
export function readStatusChanged(payload: unknown): StatusChanged | null {
  if (!isRecord(payload) || !isStatus(payload.from) || !isStatus(payload.to)) return null;
  const base = sessionEventOf(payload);
  if (base === null || base.status !== payload.to) return null;
  return { ...base, from: payload.from, to: payload.to };
}
