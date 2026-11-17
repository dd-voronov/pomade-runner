import type { HostClient } from "pomade-kit/sdk";

import { runRoute } from "../integrations/runner-api";
import { durationWords, runWords } from "../scheduler/model";
import styles from "./Runs.module.css";
import { dayTime } from "./runWords";
import { useHistory } from "./useRunnerApi";

/** How many runs the History view lists. */
const HISTORY_ROWS = 100;

/** History: every finished run, newest first; a row opens its result. A stand-in until the tab's
 *  real design. */
export function HistoryView({ host, open }: { host: HostClient; open: (route: string) => void }): React.JSX.Element {
  const history = useHistory(host, HISTORY_ROWS);
  if (history.status === "loading") return <section data-testid="history-loading" />;
  if (history.status !== "ready") {
    return (
      <p className={styles.error} role="alert" data-testid="history-problem">
        {history.status === "failed" ? history.message : "Runner's scheduler is not running."}
      </p>
    );
  }
  const { records } = history.value;
  return (
    <section className={styles.section} data-testid="history">
      {records.length === 0 ? (
        <p className={styles.empty}>No runs yet.</p>
      ) : (
        <ul className={styles.list}>
          {records.map((record) => (
            <li key={`${record.job}/${record.run}`}>
              <button type="button" className={styles.rowButton} data-testid="history-row" data-state={record.state} onClick={() => open(runRoute(record.job, record.run))}>
                <span className={styles.when}>{dayTime(record.endedAt)}</span>
                <span className={styles.name}>{record.name}</span>
                <span className={`${styles.meta} ${record.state === "failed" ? styles.failed : ""}`}>{runWords(record)}</span>
                <span className={styles.meta}>{record.durationMs === null ? "" : durationWords(record.durationMs)}</span>
                <span className={styles.meta}>{record.trigger}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
