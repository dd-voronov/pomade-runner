// A run's output (`runs.output`), asked again whenever the scheduler announces `runs.changed` — and,
// while the run runs, every `FOLLOW_MS`, since its output grows with no event of its own.

import { useEffect, useState } from "react";
import { HostError, type HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { RUN_OUTPUT_METHOD, RUNS_CHANGED_EVENT } from "../integrations/runner-api";
import { isRunOutput, type RunOutput } from "../scheduler/model";
import type { LiveState } from "./useRunnerApi";

/** How often a running run's output is asked again. */
export const FOLLOW_MS = 2000;

export function useRunOutput(host: HostClient, job: string, run: string, following: boolean): LiveState<RunOutput> {
  const [state, setState] = useState<LiveState<RunOutput>>({ status: "loading" });

  useEffect(() => {
    let live = true;
    let asked = 0;
    const load = (): void => {
      const call = ++asked;
      host.apps.call(APP_ID, RUN_OUTPUT_METHOD, { job, run }).then(
        (value) => {
          if (!live || call !== asked) return;
          setState(isRunOutput(value) ? { status: "ready", value } : { status: "failed", message: "the scheduler answered something that is not a run's output" });
        },
        (err: unknown) => {
          if (!live || call !== asked) return;
          const absent = err instanceof HostError && (err.code === "app-absent" || err.code === "app-not-responding");
          setState(absent ? { status: "no-scheduler" } : { status: "failed", message: err instanceof Error ? err.message : String(err) });
        },
      );
    };
    // Listen first, then ask: a change between the two is heard, never lost.
    const subscription = host.events.subscribe(`${APP_ID}:${RUNS_CHANGED_EVENT}`, load);
    subscription.then(load, load);
    const timer = following ? setInterval(load, FOLLOW_MS) : null;
    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
      void subscription.then(
        (s) => s.close(),
        () => undefined,
      );
    };
  }, [host, job, run, following]);

  return state;
}
