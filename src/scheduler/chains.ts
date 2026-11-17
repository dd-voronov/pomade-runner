// Chains (docs/DESIGN.md "Chains"): when a run of a job ends, the jobs that follow it fire. A run
// that ended `done` or `failed` is a parent — a failure of any kind: an exit code, a signal, a time
// limit, a start the keeper refused, a session lost. A run stopped by the person, skipped or missed
// is none: the person stepped in, or nothing ran. A follower fires when its `after.result` is the
// parent's result or `any`. A service follows with its `after.action`. Pure.

import type { GitJob, JobsSnapshot, ScriptJob, ServiceJob } from "../jobs/model";
import type { ParentResult, RunCause, RunRecord } from "./model";

/** The result a chain sees in a finished run; `null` when the run fires no chain. */
export function parentResult(record: RunRecord): ParentResult | null {
  if (record.action !== null) return null;
  return record.state === "done" || record.state === "failed" ? record.state : null;
}

/** A chain run's cause, from its parent's record. */
export function chainCause(record: RunRecord, result: ParentResult): Extract<RunCause, { kind: "chain" }> {
  return { kind: "chain", job: record.job, name: record.name, run: record.run, result };
}

/** The jobs a finished run fires, by id: valid, enabled scripts, git jobs and services whose
 *  `after` names its job and takes its result. Agent jobs fire with their epic (E-004). */
export function followers(snapshot: JobsSnapshot, record: RunRecord): (ScriptJob | GitJob | ServiceJob)[] {
  const result = parentResult(record);
  if (result === null) return [];
  const fired: (ScriptJob | GitJob | ServiceJob)[] = [];
  for (const entry of snapshot.jobs) {
    if (!entry.valid || !entry.job.enabled) continue;
    const { job } = entry;
    const chain = job.kind === "service" ? job.after : job.trigger.kind === "chain" ? job.trigger.chain : null;
    if (chain === null || chain.job !== record.job || (chain.result !== "any" && chain.result !== result)) continue;
    if (job.kind !== "agent") fired.push(job);
  }
  return fired.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
