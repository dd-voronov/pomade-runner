import { dayTime, type NextRun } from "../scheduler/model";
import styles from "./Runs.module.css";
import { aheadWords } from "./runWords";

/** How many runs Next up shows. */
const NEXT_UP = 5;

/** Next up: the next runs, soonest first. A stand-in until the panel's real design. */
export function NextUpList({ next, now }: { next: readonly NextRun[]; now: number }): React.JSX.Element {
  return (
    <section className={styles.section} data-testid="next-up">
      <h2 className={styles.heading}>Next up</h2>
      {next.length === 0 ? (
        <p className={styles.empty}>Nothing is scheduled.</p>
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
    </section>
  );
}
