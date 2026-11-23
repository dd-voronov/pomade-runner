import type { HostClient } from "pomade-kit/sdk";

import { jobsRoute } from "../integrations/runner-api";
import type { JobEntry } from "../jobs/model";
import { NEXT_UP_RUNS, type NextRun } from "../scheduler/model";
import { Icon, PanelEmpty, Tag, useToast } from "./kit";
import styles from "./NextUp.module.css";
import { nextUpTip, nextUpWords } from "./panelWords";
import { useCountdownNow } from "./useNow";

/** Next up's content: the next runs, soonest first — when ("in 40 min", "13:00"), the job's kind,
 *  its name, and "held" on a run the switch holds. A row opens the job in the Jobs view. */
export function NextUp({ host, next, jobs }: { host: HostClient; next: readonly NextRun[]; jobs: readonly JobEntry[] }): React.JSX.Element {
  const now = useCountdownNow(next.map((run) => run.at));
  const toast = useToast();
  const kindOf = (id: string): "service" | "script" | "agent" | "git" | null => {
    const entry = jobs.find((candidate) => candidate.valid && candidate.job.id === id);
    return entry?.valid === true ? entry.job.kind : null;
  };
  return (
    <div data-testid="next-up">
      {next.length === 0 ? (
        <PanelEmpty>Nothing is scheduled.</PanelEmpty>
      ) : (
        next.slice(0, NEXT_UP_RUNS).map((run) => {
          const kind = kindOf(run.job);
          return (
            <button
              key={`${run.job}@${run.at}`}
              type="button"
              className={run.held ? `${styles.row} ${styles.held}` : styles.row}
              data-testid="next-up-item"
              data-held={run.held}
              onClick={() => {
                host.tabs.openApp({ route: jobsRoute(run.job) }).catch((err: unknown) => toast(`Could not open ${run.name}: ${err instanceof Error ? err.message : String(err)}`));
              }}
            >
              <span className={styles.when} data-tip={nextUpTip(run.at, now)}>
                {nextUpWords(run.at, now)}
              </span>
              {kind !== null && (
                <span className={styles.kind}>
                  <Icon name={kind} size={14} />
                </span>
              )}
              <span className={styles.name}>{run.name}</span>
              {run.held && (
                <Tag tone="warn" help="sw.held" className={styles.heldTag} data-testid="next-up-held">
                  held
                </Tag>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
