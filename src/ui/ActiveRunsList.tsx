import type { HostClient } from "pomade-kit/sdk";

import { runRoute } from "../integrations/runner-api";
import { dayTime, runWords, type ActiveRun } from "../scheduler/model";
import { PanelEmpty } from "./kit";
import styles from "./Runs.module.css";

/** The runs going — running ones, and queued ones with what each waits for ("queued · 1 ahead") —
 *  the runs `goingRuns` keeps; a row opens the run's card. A stand-in until the real Running now. */
export function ActiveRunsList({ host, runs, open }: { host: HostClient; runs: readonly ActiveRun[]; open?: (route: string) => void }): React.JSX.Element {
  const going = goingRuns(runs);
  const show = (run: ActiveRun): void => {
    const route = runRoute(run.job, run.run);
    if (open === undefined) void host.tabs.openApp({ route }).catch(() => undefined);
    else open(route);
  };
  return (
    <div data-testid="active-runs">
      {going.length === 0 ? (
        <PanelEmpty>Nothing is running.</PanelEmpty>
      ) : (
        <ul className={styles.list}>
          {going.map((run) => (
            <li key={`${run.job}/${run.run}`}>
              <button type="button" className={`${styles.rowButton} ${styles.stacked}`} data-testid="active-run" data-state={run.state} onClick={() => show(run)}>
                <span className={styles.line}>
                  <span className={styles.name}>{run.name}</span>
                  <span className={styles.meta}>{dayTime(run.startedAt ?? run.dueAt)}</span>
                </span>
                <span className={styles.meta}>{runWords(run)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The runs going: missed runs waiting for the person are in Needs you, not here. */
export function goingRuns(runs: readonly ActiveRun[]): ActiveRun[] {
  return runs.filter((run) => run.state !== "missed-waiting");
}
