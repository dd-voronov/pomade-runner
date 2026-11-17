// The loop safety net (docs/DESIGN.md "Loop guards"): a job fired more than `FIRING_LIMIT` times
// within `FIRING_WINDOW_MS` by hooks or chains is paused — that firing and every later one by a hook
// or a chain is dropped — until the person resumes it. Run now is the person's and never counts.
// What it keeps is plain JSON, kept with the runs in `runs.json`, so a pause survives restarts.
// Pure: the time is given.

/** More firings than this within the window pause the job. */
export const FIRING_LIMIT = 10;
export const FIRING_WINDOW_MS = 10 * 60_000;

/** A job the guard paused. */
export interface LoopPause {
  /** The job's name and project when it was paused. */
  name: string;
  project: string | null;
  /** When (epoch ms). */
  at: number;
}

/** What the guard keeps. */
export interface LoopGuardRecords {
  /** The firings of each job within the window (epoch ms), by job id. */
  fired: Record<string, number[]>;
  /** The paused jobs, by job id. */
  paused: Record<string, LoopPause>;
}

/** A firing's verdict: it fires · it is the one too many, and pauses the job · the job is paused. */
export type FiringVerdict = "fire" | "pause" | "paused";

export interface LoopGuard {
  /** Count a firing of `job` by a hook or a chain at `at`. */
  fire(job: { id: string; name: string; project: string | null }, at: number): FiringVerdict;
  /** Lift a pause, with a fresh count; whether the job was paused. */
  resume(job: string): boolean;
  paused(): ReadonlyMap<string, LoopPause>;
  /** What to keep: the firings still within the window as of `at`. */
  records(at: number): LoopGuardRecords;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The guard's records as a file keeps them; anything unreadable is left out. */
export function parseLoopGuard(value: unknown): LoopGuardRecords {
  const records: LoopGuardRecords = { fired: {}, paused: {} };
  if (!isRecord(value)) return records;
  if (isRecord(value.fired)) {
    for (const [job, times] of Object.entries(value.fired)) if (Array.isArray(times)) records.fired[job] = times.filter(finite);
  }
  if (isRecord(value.paused)) {
    for (const [job, pause] of Object.entries(value.paused)) {
      if (!isRecord(pause) || typeof pause.name !== "string" || (pause.project !== null && typeof pause.project !== "string") || !finite(pause.at)) continue;
      records.paused[job] = { name: pause.name, project: pause.project, at: pause.at };
    }
  }
  return records;
}

export function createLoopGuard(records: LoopGuardRecords = { fired: {}, paused: {} }): LoopGuard {
  const fired = new Map(Object.entries(records.fired).map(([job, times]) => [job, [...times]]));
  const paused = new Map(Object.entries(records.paused));
  const within = (times: readonly number[], at: number): number[] => times.filter((time) => time > at - FIRING_WINDOW_MS && time <= at);

  return {
    fire(job, at) {
      if (paused.has(job.id)) return "paused";
      const times = [...within(fired.get(job.id) ?? [], at), at];
      if (times.length <= FIRING_LIMIT) {
        fired.set(job.id, times);
        return "fire";
      }
      fired.delete(job.id);
      paused.set(job.id, { name: job.name, project: job.project, at });
      return "pause";
    },

    resume(job) {
      if (!paused.delete(job)) return false;
      fired.delete(job);
      return true;
    },

    paused: () => paused,

    records(at) {
      const kept: Record<string, number[]> = {};
      for (const [job, times] of fired) {
        const recent = within(times, at);
        if (recent.length > 0) kept[job] = recent;
      }
      return { fired: kept, paused: Object.fromEntries(paused) };
    },
  };
}
