import { waitingAt, type ActiveRun } from "../scheduler/model";

/** The run a job's row acts on: the latest of its runs that has a terminal going (`running`), by the
 *  moment it started; `null` while none does. A queued run has no terminal and nothing to stop. */
export function latestGoing(runs: readonly ActiveRun[]): ActiveRun | null {
  let latest: ActiveRun | null = null;
  for (const run of runs) {
    if (run.state !== "running") continue;
    const at = run.startedAt ?? run.dueAt;
    const best = latest === null ? null : (latest.startedAt ?? latest.dueAt);
    if (latest === null || best === null || at > best || (at === best && run.run > latest.run)) latest = run;
  }
  return latest;
}

/** What opening a running run's terminal is called — the one label of the card's button and the
 *  row's icon: an agent run waiting at a prompt is opened "at the prompt". */
export const terminalLabel = (run: ActiveRun): string => (waitingAt(run) === null ? "Open terminal" : "Open at the prompt");
