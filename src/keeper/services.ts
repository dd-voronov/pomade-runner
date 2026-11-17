// A service job as a keeper session: what it runs, its Restart header action, and finding a
// service by what a person or a command calls it. Supervision (`supervisor.ts`) builds on these.

import { join } from "node:path";

import type { SessionAction } from "pomade-kit/protocol";

import { entryId, type JobsSnapshot, type ServiceJob } from "../jobs/model";
import type { SessionCommand } from "./sessions";

/** The header action every service's attached tab carries; a click arrives as `attachedTab.action`. */
export const RESTART_ACTION: SessionAction = { id: "restart", title: "Restart" };

/** What a service's session runs: its command in its folder, titled with its name. */
export function serviceCommand(job: ServiceJob, workspace: string): SessionCommand {
  return { title: job.name, command: job.command, cwd: join(workspace, job.folder), background: job.lowPriority, actions: [RESTART_ACTION] };
}

export type ServiceLookup = { ok: true; job: ServiceJob; workspace: string } | { ok: false; reason: string };

/** The id of the job `ref` names — its id, or else its name, ignoring case; `null` when none does. */
export function jobIdOf(snapshot: JobsSnapshot, ref: string): string | null {
  const byId = snapshot.jobs.find((entry) => entryId(entry) === ref);
  if (byId !== undefined) return entryId(byId);
  const name = ref.toLowerCase();
  const byName = snapshot.jobs.find((entry) => (entry.valid ? entry.job.name : entry.invalid.name)?.toLowerCase() === name);
  return byName === undefined ? null : entryId(byName);
}

/** The valid service job `ref` names (its id or its name). */
export function findService(snapshot: JobsSnapshot, ref: string): ServiceLookup {
  const { workspace } = snapshot;
  if (workspace === null) return { ok: false, reason: "no workspace is known" };
  const id = jobIdOf(snapshot, ref);
  const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
  if (entry === undefined) return { ok: false, reason: `no job "${ref}"` };
  if (!entry.valid) return { ok: false, reason: `the job "${entryId(entry)}" is invalid: ${entry.invalid.errors[0]?.problem ?? "see pomade-runner check"}` };
  if (entry.job.kind !== "service") return { ok: false, reason: `"${entry.job.id}" is a ${entry.job.kind} job, not a service` };
  return { ok: true, job: entry.job, workspace };
}
