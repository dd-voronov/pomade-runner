// Delete on a job (`jobs.delete`): its file removed, safely. A running service is stopped first, as
// Stop does, and its session's end waited for, so a deleted service never leaves its process
// behind; a run of the job that is going refuses the delete, so a run is never cut off and its
// result is never lost — stop it first. Queued runs and missed runs waiting for you settle on their
// own once the file is gone ("its job file is gone").

import { entryId, entryPath, type JobsSnapshot } from "../jobs/model";
import type { ServiceActionResult } from "../keeper/model";
import { jobIdOf } from "../keeper/services";
import type { ActiveRun, DeleteResult } from "./model";

/** How long a stopped service's session may take to end: the keeper's 3 s before SIGKILL, and a margin. */
export const STOP_WAIT_MS = 8_000;
const POLL_MS = 100;

export interface DeleteJobDeps {
  jobs(): JobsSnapshot;
  /** The runs going. */
  active(): readonly ActiveRun[];
  /** Whether the job's service session runs, as of the latest refresh of the sessions. */
  serviceRunning(job: string): boolean;
  /** Stop the job's service as stopped by you. */
  stopService(job: string): Promise<ServiceActionResult>;
  /** Read the keeper's sessions again. */
  refreshSessions(): Promise<void>;
  /** Remove the job's file; `path` is workspace-relative. */
  removeFile(workspace: string, path: string): Promise<void>;
  /** Read the jobs folder again. */
  refreshJobs(): Promise<void>;
  log(message: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Delete the job `ref` names (its id or its name). */
export async function deleteJob(ref: string, deps: DeleteJobDeps): Promise<DeleteResult> {
  const snapshot = deps.jobs();
  if (snapshot.workspace === null) return { ok: false, reason: "no workspace is known" };
  const id = jobIdOf(snapshot, ref);
  const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
  if (entry === undefined) return { ok: false, reason: `no job "${ref}"` };
  const job = entryId(entry);
  const name = entry.valid ? entry.job.name : (entry.invalid.name ?? job);
  const path = entryPath(entry);
  if (deps.active().some((run) => run.job === job && run.state === "running")) {
    return { ok: false, reason: `a run of "${name}" is going; stop it first, then delete the job` };
  }
  let stopped = false;
  if (deps.serviceRunning(job)) {
    const result = await deps.stopService(job);
    if (!result.ok) return { ok: false, reason: `cannot stop "${name}": ${result.reason}` };
    stopped = true;
    const deadline = deps.now() + STOP_WAIT_MS;
    for (;;) {
      await deps.refreshSessions();
      if (!deps.serviceRunning(job)) break;
      if (deps.now() > deadline) return { ok: false, reason: `"${name}" did not stop, so its file is kept` };
      await deps.sleep(POLL_MS);
    }
  }
  try {
    await deps.removeFile(snapshot.workspace, path);
  } catch (err) {
    return { ok: false, reason: `cannot remove ${path}: ${errorText(err)}` };
  }
  deps.log(`job ${job}: deleted${stopped ? ", its service stopped first" : ""}`);
  await deps.refreshJobs();
  return { ok: true, job, path, stopped };
}
