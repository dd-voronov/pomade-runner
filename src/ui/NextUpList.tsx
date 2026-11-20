import { dayTime, type NextRun } from "../scheduler/model";
import styles from "./Runs.module.css";
import { PanelEmpty } from "./kit";
import { aheadWords } from "./runWords";

/** How many runs Next up shows. */
const NEXT_UP = 5;

/** Next up's content: the next runs, soonest first. A stand-in until the panel's real design. */
export function NextUpList({ next, now }: { next: readonly NextRun[]; now: number }): React.JSX.Element {
  return (
    <div data-testid="next-up">
      {next.length === 0 ? (
        <PanelEmpty>Nothing is scheduled.</PanelEmpty>
      ) : (
        <ul className={styles.list}>
          {next.slice(0, NEXT_UP).map((run) => (
            <li key={run.job} className={styles.row} data-testid="next-up-item">
              <span className={styles.line}>
                <span className={styles.when} title={dayTime(run.at)}>
                  {aheadWords(run.at, now)}
                </span>
                <span className={styles.name}>{run.name}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
