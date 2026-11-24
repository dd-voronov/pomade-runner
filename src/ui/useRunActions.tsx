import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { RUN_STOP_METHOD } from "../integrations/runner-api";
import { isRunStopResult } from "../scheduler/model";
import { useToast } from "./kit";

/** Stops a run as its result card's Stop run does: the toast says "stopped by you" or why the
 *  scheduler refused; `onStopped` runs once it is stopped. The card and the Jobs row share it. */
export function useStopRun(host: HostClient): (run: { job: string; run: string; name: string }, onStopped?: () => void) => void {
  const toast = useToast();
  return (run, onStopped) => {
    host.apps.call(APP_ID, RUN_STOP_METHOD, { job: run.job, run: run.run }).then(
      (answer: unknown) => {
        if (isRunStopResult(answer) && !answer.ok) return toast(`Could not stop ${run.name}: ${answer.reason}`);
        toast(
          <>
            <b>{run.name}</b> stopped by you
          </>,
        );
        onStopped?.();
      },
      (err: unknown) => toast(`Could not stop ${run.name}: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
}

/** Opens a run's terminal in an attached tab — Pomade focuses the one already open — titled with the
 *  job's name. The card and the Jobs row share it. */
export function useOpenRunTerminal(host: HostClient): (run: { name: string }, session: string) => void {
  const toast = useToast();
  return (run, session) => {
    host.tabs.openAttached({ session: { app: APP_ID, session }, title: run.name }).catch((err: unknown) => {
      toast(`Could not open ${run.name}'s terminal: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}
