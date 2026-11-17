// Runner's own API, live: the checked jobs (`jobs.list`), the services (`services.list`), the runs
// (`runs.list`), the history (`history.list`), one run (`runs.get`) and its output (`runs.output`),
// asked of Runner's scheduler through Pomade's broker and asked again whenever the scheduler
// announces a change (`jobs.changed`, `services.changed`, `runs.changed`) — on every change, and
// when it connects to Pomade, so a frame that found no scheduler catches up. And Runner's own tab
// route, which Pomade sets when it opens or navigates the tab.

import { useEffect, useState } from "react";
import type { JsonValue } from "pomade-kit/protocol";
import { HostError, type HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import {
  HISTORY_LIST_METHOD,
  isJobsSnapshot,
  JOBS_CHANGED_EVENT,
  JOBS_LIST_METHOD,
  RUN_GET_METHOD,
  RUN_OUTPUT_METHOD,
  RUNS_CHANGED_EVENT,
  RUNS_LIST_METHOD,
  SERVICES_CHANGED_EVENT,
  SERVICES_LIST_METHOD,
} from "../integrations/runner-api";
import type { JobsSnapshot } from "../jobs/model";
import { isServicesReport, type ServicesReport } from "../keeper/model";
import { isHistoryPage, isRunOutput, isRunsReport, isRunView, type HistoryPage, type RunOutput, type RunsReport, type RunView } from "../scheduler/model";

export type LiveState<T> =
  | { status: "loading" }
  /** The scheduler does not answer: not running, or not connected to Pomade. */
  | { status: "no-scheduler" }
  | { status: "failed"; message: string }
  | { status: "ready"; value: T };

export type JobsState = LiveState<JobsSnapshot>;

function useLive<T>(host: HostClient, method: string, event: string, guard: (value: unknown) => value is T, what: string, params: JsonValue = null): LiveState<T> {
  const [state, setState] = useState<LiveState<T>>({ status: "loading" });
  const asking = JSON.stringify(params);

  useEffect(() => {
    let live = true;
    let asked = 0;
    const load = (): void => {
      const call = ++asked;
      host.apps.call(APP_ID, method, JSON.parse(asking) as JsonValue).then(
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
  }, [host, method, event, guard, what, asking]);

  return state;
}

export function useJobs(host: HostClient): JobsState {
  return useLive(host, JOBS_LIST_METHOD, JOBS_CHANGED_EVENT, isJobsSnapshot, "a jobs list");
}

export function useServices(host: HostClient): LiveState<ServicesReport> {
  return useLive(host, SERVICES_LIST_METHOD, SERVICES_CHANGED_EVENT, isServicesReport, "a services report");
}

export function useRuns(host: HostClient): LiveState<RunsReport> {
  return useLive(host, RUNS_LIST_METHOD, RUNS_CHANGED_EVENT, isRunsReport, "a runs report");
}

/** The latest finished runs, newest first. */
export function useHistory(host: HostClient, limit: number): LiveState<HistoryPage> {
  return useLive(host, HISTORY_LIST_METHOD, RUNS_CHANGED_EVENT, isHistoryPage, "a history page", { limit });
}

const isRunOrNone = (value: unknown): value is RunView | null => value === null || isRunView(value);

/** One run, going or finished; `null` when there is none. */
export function useRun(host: HostClient, job: string, run: string): LiveState<RunView | null> {
  return useLive(host, RUN_GET_METHOD, RUNS_CHANGED_EVENT, isRunOrNone, "a run", { job, run });
}

/** The end of a run's output, asked again as runs change. */
export function useOutput(host: HostClient, job: string, run: string): LiveState<RunOutput> {
  return useLive(host, RUN_OUTPUT_METHOD, RUNS_CHANGED_EVENT, isRunOutput, "a run's output", { job, run });
}

/** The tab's route: the one it opened with, then each one Pomade navigates it to. */
export function useRoute(host: HostClient): [string, (route: string) => void] {
  const [route, setRoute] = useState(host.welcome.route);
  useEffect(() => host.onRouteChange(setRoute), [host]);
  return [route, setRoute];
}
