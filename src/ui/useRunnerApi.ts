// Runner's own API, live: the checked jobs (`jobs.list`) and the services (`services.list`), asked
// of Runner's scheduler through Pomade's broker and asked again whenever the scheduler announces a
// change (`jobs.changed`, `services.changed`) — on every change, and when it connects to Pomade, so
// a frame that found no scheduler catches up.

import { useEffect, useState } from "react";
import { HostError, type HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { isJobsSnapshot, JOBS_CHANGED_EVENT, JOBS_LIST_METHOD, SERVICES_CHANGED_EVENT, SERVICES_LIST_METHOD } from "../integrations/runner-api";
import type { JobsSnapshot } from "../jobs/model";
import { isServicesReport, type ServicesReport } from "../keeper/model";

export type LiveState<T> =
  | { status: "loading" }
  /** The scheduler does not answer: not running, or not connected to Pomade. */
  | { status: "no-scheduler" }
  | { status: "failed"; message: string }
  | { status: "ready"; value: T };

export type JobsState = LiveState<JobsSnapshot>;

function useLive<T>(host: HostClient, method: string, event: string, guard: (value: unknown) => value is T, what: string): LiveState<T> {
  const [state, setState] = useState<LiveState<T>>({ status: "loading" });

  useEffect(() => {
    let live = true;
    let asked = 0;
    const load = (): void => {
      const call = ++asked;
      host.apps.call(APP_ID, method).then(
        (value) => {
          if (!live || call !== asked) return;
          setState(guard(value) ? { status: "ready", value } : { status: "failed", message: `the scheduler answered something that is not ${what}` });
        },
        (err: unknown) => {
          if (!live || call !== asked) return;
          const absent = err instanceof HostError && (err.code === "app-absent" || err.code === "app-not-responding");
          setState(absent ? { status: "no-scheduler" } : { status: "failed", message: err instanceof Error ? err.message : String(err) });
        },
      );
    };
    // Listen first, then ask: a change between the two is heard, never lost.
    const subscription = host.events.subscribe(`${APP_ID}:${event}`, load);
    subscription.then(load, load);
    return () => {
      live = false;
      void subscription.then((s) => s.close(), () => undefined);
    };
  }, [host, method, event, guard, what]);

  return state;
}

export function useJobs(host: HostClient): JobsState {
  return useLive(host, JOBS_LIST_METHOD, JOBS_CHANGED_EVENT, isJobsSnapshot, "a jobs list");
}

export function useServices(host: HostClient): LiveState<ServicesReport> {
  return useLive(host, SERVICES_LIST_METHOD, SERVICES_CHANGED_EVENT, isServicesReport, "a services report");
}
