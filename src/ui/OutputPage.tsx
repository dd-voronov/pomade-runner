import type { HostClient } from "pomade-kit/sdk";

import { runRoute } from "../integrations/runner-api";
import { plainLines } from "../scheduler/model";
import { Dot, IconButton } from "./kit";
import styles from "./OutputPage.module.css";
import { runTime, whenWords } from "./runLook";
import { useNow } from "./useNow";
import { useRunOutput } from "./useRunOutput";
import { useRun } from "./useRunnerApi";

/** What the page says of a run whose output log is not on this Mac: its record came with the
 *  workspace from another Mac, or the log was removed. */
export const OUTPUT_NOT_HERE = "This run's output is not on this Mac.";

/** A run's full output (the prototype's output tab, `outPane`), the whole Runner tab at the route
 *  `output/<job>/<run>`: a head with the way back to the result card, the job's name and what the
 *  log is, then the log as plain text — followed while the run runs. */
export function OutputPage({ host, job, run, open }: { host: HostClient; job: string; run: string; open: (route: string) => void }): React.JSX.Element {
  const view = useRun(host, job, run);
  const value = view.status === "ready" ? view.value : null;
  const running = value?.state === "running";
  const output = useRunOutput(host, job, run, running);
  const now = useNow(30_000);
  const lines = output.status === "ready" ? plainLines(output.value.text) : [];
  if (lines.at(-1) === "") lines.pop();

  return (
    <main className={styles.root} data-testid="run-output">
      <header className={styles.head}>
        <div className={styles.title}>
          <IconButton icon="back" label="Back to the result" onClick={() => open(runRoute(job, run))} />
          <b className={styles.name}>{value?.name ?? job}</b>
          <span className={styles.owner}>· output</span>
          {value !== null && (
            <span className={styles.badge} data-help="c.output" data-testid="run-output-badge">
              <Dot tone={running ? "accent" : "hollow"} live={running} />
              Captured log · {whenWords(runTime(value), now).replace(/^(Today|Yesterday)/, (day) => day.toLowerCase())}
              {running ? " · still running" : ""} · read-only
            </span>
          )}
        </div>
      </header>
      {output.status === "ready" ? (
        <pre className={styles.term} data-testid="run-output-text">
          {output.value.truncated && <span className={styles.dim}>{"… only the end of a longer log is shown\n"}</span>}
          {output.value.missing ? (
            <span className={styles.dim} data-testid="run-output-missing">
              {OUTPUT_NOT_HERE}
            </span>
          ) : lines.length === 0 ? (
            <span className={styles.dim}>(no output)</span>
          ) : (
            lines.join("\n")
          )}
        </pre>
      ) : (
        output.status !== "loading" && (
          <p className={styles.problem} role="alert">
            {output.status === "failed" ? output.message : "Runner's scheduler is not running."}
          </p>
        )
      )}
    </main>
  );
}
