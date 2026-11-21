// Which queued runs start now, and what each of the others waits for (docs/DESIGN.md "Missed runs
// and load"). The queue is the runs going, oldest first; each queued run waits for the first of:
//
// 1. **its time** — Run at… sets one;
// 2. **the switch** — Pause all holds every run but Run now; Pause low-priority holds the runs of
//    low-priority jobs but Run now;
// 3. **the warm-up** — a caught-up run and a hook run wait until the staged start after login or
//    wake is over;
// 4. **the job's previous run** — unless the job's overlap is `parallel`;
// 5. **Pomade** — an agent run starts only while Pomade is up for it (connected, ready, and no
//    launch of it under way); until then it waits while Runner opens Pomade, holding no slot;
// 6. **a slot** — at most `maxLowPriority` low-priority runs go at once. A low-priority run that finds
//    them taken waits, first come first served, as "N ahead": the slot-waiting runs ahead of it, and
//    the run whose slot it takes. Runs of jobs that are not low-priority (git, by default) never
//    take or wait for a slot; nor does an agent run waiting for you at a prompt — it is idle, and a
//    forgotten prompt must not hold back every low-priority job.
//
// Pure.

import type { OverlapPolicy } from "../jobs/model";
import { waitingAt, type ActiveRun, type RunTrigger, type SwitchPosition, type Waits } from "./model";

/** Whether the switch at `position` holds a run: Run now never; the rest by the run's priority. */
export function holds(position: SwitchPosition, run: { trigger: RunTrigger; lowPriority: boolean }): boolean {
  if (run.trigger === "manual") return false;
  return position === "pause-all" || (position === "pause-low" && run.lowPriority);
}

export interface QueueState {
  /** Epoch ms. */
  now: number;
  /** The low-priority slots. */
  maxLowPriority: number;
  position: SwitchPosition;
  /** The staged start after login or wake: over, or not yet — `until` is when it ends, `null` while
   *  the services still start. */
  warmUp: { over: true } | { over: false; until: number | null };
  /** A job's overlap policy now; `undefined` for a job that is gone or invalid (its run starts, and
   *  is skipped there). */
  overlap(job: string): OverlapPolicy | undefined;
  /** Whether an agent run can start now: Pomade is up for it. */
  pomadeUp: boolean;
}

export interface QueuePlan {
  /** The queued runs to start now, in queue order. */
  start: ActiveRun[];
  /** What every other queued run waits for. */
  waits: Map<ActiveRun, Waits>;
}

export function planQueue(active: readonly ActiveRun[], state: QueueState): QueuePlan {
  const running = active.filter((run) => run.state === "running");
  let taken = running.filter((run) => run.lowPriority && waitingAt(run) === null).length;
  const busy = new Set(running.map((run) => run.job));
  const start: ActiveRun[] = [];
  const waits = new Map<ActiveRun, Waits>();
  let ahead = 0;
  for (const run of active) {
    if (run.state !== "queued") continue;
    if (run.runAt !== null && run.runAt > state.now) {
      waits.set(run, { kind: "time", at: run.runAt });
    } else if (state.position !== "running" && holds(state.position, run)) {
      waits.set(run, { kind: "switch", position: state.position });
    } else if ((run.trigger === "caught-up" || run.trigger === "hook") && !state.warmUp.over) {
      waits.set(run, { kind: "warm-up", until: state.warmUp.until });
    } else if (busy.has(run.job) && state.overlap(run.job) !== "parallel" && state.overlap(run.job) !== undefined) {
      waits.set(run, { kind: "previous-run" });
    } else if (run.kind === "agent" && !state.pomadeUp) {
      waits.set(run, { kind: "pomade" });
    } else if (run.lowPriority && taken >= state.maxLowPriority) {
      ahead++;
      waits.set(run, { kind: "slot", ahead });
    } else {
      start.push(run);
      if (run.lowPriority) taken++;
      busy.add(run.job);
    }
  }
  return { start, waits };
}
