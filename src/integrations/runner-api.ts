// Runner's own API through Pomade's broker, and its events: what the scheduler serves and the UI
// calls. The scheduler holds the checked jobs; a frame asks for them with `apps.call` to Runner
// itself and hears `jobs.changed` when they change. Pure: shared by the scheduler and the UI.

import type { JobsSnapshot } from "../jobs/model";

/** `apps.call("pomade-runner", JOBS_LIST_METHOD)` → `JobsSnapshot`. */
export const JOBS_LIST_METHOD = "jobs.list";

/** Published by the scheduler when the checked jobs change, and when it (re)connects to Pomade. */
export const JOBS_CHANGED_EVENT = "jobs.changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shape check a caller runs on a `jobs.list` answer before trusting it. */
export function isJobsSnapshot(value: unknown): value is JobsSnapshot {
  if (!isRecord(value)) return false;
  const { workspace, projectsChecked, jobs } = value;
  if ((workspace !== null && typeof workspace !== "string") || typeof projectsChecked !== "boolean" || !Array.isArray(jobs)) return false;
  return jobs.every(
    (entry: unknown) =>
      isRecord(entry) &&
      ((entry.valid === true && isRecord(entry.job) && typeof entry.job.id === "string" && typeof entry.job.path === "string") ||
        (entry.valid === false && isRecord(entry.invalid) && typeof entry.invalid.path === "string" && Array.isArray(entry.invalid.errors))),
  );
}
