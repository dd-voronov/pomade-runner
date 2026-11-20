import type { HostClient } from "pomade-kit/sdk";

import { jobsRoute } from "../integrations/runner-api";
import type { JobEntry } from "../jobs/model";
import type { NextRun } from "../scheduler/model";
import { Icon, PanelEmpty, useToast } from "./kit";
import styles from "./NextUp.module.css";
import { nextUpTip, nextUpWords } from "./panelWords";
import { useNow } from "./useNow";

/** How many runs Next up shows. */
const NEXT_UP = 5;

/** Next up's content: the next runs, soonest first — when ("in 40 min", "13:00"), the job's kind,
 *  its name. A row opens the job in the Jobs view. */
export function NextUp({ host, next, jobs }: { host: HostClient; next: readonly NextRun[]; jobs: readonly JobEntry[] }): React.JSX.Element {
  const now = useNow();
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
        next.slice(0, NEXT_UP).map((run) => {
          const kind = kindOf(run.job);
          return (
            <button
              key={`${run.job}@${run.at}`}
              type="button"
              className={styles.row}
              data-testid="next-up-item"
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
            </button>
          );
        })
      )}
    </div>
  );
}
