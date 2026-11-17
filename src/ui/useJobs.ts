// The checked jobs, live: asked of Runner's scheduler through Pomade's broker (`jobs.list` on
// Runner itself) and asked again whenever the scheduler announces `jobs.changed` — on every
// change, and when it connects to Pomade, so a frame that found no scheduler catches up.

import { useEffect, useState } from "react";
import { HostError, type HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { isJobsSnapshot, JOBS_CHANGED_EVENT, JOBS_LIST_METHOD } from "../integrations/runner-api";
import type { JobsSnapshot } from "../jobs/model";

export type JobsState =
  | { status: "loading" }
  /** The scheduler does not answer: not running, or not connected to Pomade. */
  | { status: "no-scheduler" }
  | { status: "failed"; message: string }
  | { status: "ready"; snapshot: JobsSnapshot };

export function useJobs(host: HostClient): JobsState {
  const [state, setState] = useState<JobsState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    let asked = 0;
    const load = (): void => {
      const call = ++asked;
      host.apps.call(APP_ID, JOBS_LIST_METHOD).then(
        (value) => {
          if (!live || call !== asked) return;
          setState(isJobsSnapshot(value) ? { status: "ready", snapshot: value } : { status: "failed", message: "the scheduler answered something that is not a jobs list" });
        },
        (err: unknown) => {
          if (!live || call !== asked) return;
          const absent = err instanceof HostError && (err.code === "app-absent" || err.code === "app-not-responding");
          setState(absent ? { status: "no-scheduler" } : { status: "failed", message: err instanceof Error ? err.message : String(err) });
        },
      );
    };
    // Listen first, then ask: a change between the two is heard, never lost.
    const subscription = host.events.subscribe(`${APP_ID}:${JOBS_CHANGED_EVENT}`, load);
    subscription.then(load, load);
    return () => {
      live = false;
      void subscription.then((s) => s.close(), () => undefined);
    };
  }, [host]);

  return state;
}
