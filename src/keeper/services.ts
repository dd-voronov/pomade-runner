// A service job as a keeper session: what it runs, its Restart header action, and starting and
// restarting it from the loaded jobs. Supervision — when to start, restart or give up — builds on
// these.

import { join } from "node:path";

import type { SessionAction } from "pomade-kit/protocol";

import { entryId, type JobsSnapshot, type ServiceJob } from "../jobs/model";
import { sessionOwner } from "./ids";
import type { RunnerSession } from "./model";
import type { SessionCommand, Sessions } from "./sessions";

/** The header action every service's attached tab carries; a click arrives as `attachedTab.action`. */
export const RESTART_ACTION: SessionAction = { id: "restart", title: "Restart" };

/** What a service's session runs: its command in its folder, titled with its name. */
export function serviceCommand(job: ServiceJob, workspace: string): SessionCommand {
  return { title: job.name, command: job.command, cwd: join(workspace, job.folder), background: job.lowPriority, actions: [RESTART_ACTION] };
}

export type ServiceLookup = { ok: true; job: ServiceJob; workspace: string } | { ok: false; reason: string };

/** The valid service job `id` in the loaded jobs. */
export function findService(snapshot: JobsSnapshot, id: string): ServiceLookup {
  const { workspace } = snapshot;
  if (workspace === null) return { ok: false, reason: "no workspace is known" };
  const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
  if (entry === undefined) return { ok: false, reason: `no job "${id}"` };
  if (!entry.valid) return { ok: false, reason: `the job "${id}" is invalid: ${entry.invalid.errors[0]?.problem ?? "see pomade-runner check"}` };
  if (entry.job.kind !== "service") return { ok: false, reason: `"${id}" is a ${entry.job.kind} job, not a service` };
  return { ok: true, job: entry.job, workspace };
}

export type ServiceAction = { ok: true; session: RunnerSession } | { ok: false; reason: string };

const failed = (err: unknown): ServiceAction => ({ ok: false, reason: err instanceof Error ? err.message : String(err) });

/** Start a service's session; refused while it runs. */
export async function startService(sessions: Sessions, snapshot: JobsSnapshot, id: string): Promise<ServiceAction> {
  const found = findService(snapshot, id);
  if (!found.ok) return found;
  try {
    return { ok: true, session: await sessions.spawn({ kind: "service", job: id }, serviceCommand(found.job, found.workspace)) };
  } catch (err) {
    return failed(err);
  }
}

/** Restart the service whose session is `sessionId`, with its job file as it is now. */
export async function restartServiceSession(sessions: Sessions, snapshot: JobsSnapshot, sessionId: string): Promise<ServiceAction> {
  const owner = sessionOwner(sessionId);
  if (owner?.kind !== "service") return { ok: false, reason: `${sessionId} is not a service's session` };
  const found = findService(snapshot, owner.job);
  if (!found.ok) return found;
  try {
    return { ok: true, session: await sessions.restartService(owner.job, serviceCommand(found.job, found.workspace)) };
  } catch (err) {
    return failed(err);
  }
}
