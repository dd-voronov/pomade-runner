import { useEffect } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { DISMISS_METHOD, outputRoute, RUN_NOW_METHOD, RUN_STOP_METHOD, runRoute } from "../integrations/runner-api";
import { dayTime, durationWords, plainLines, runWords, type NeedsYouItem } from "../scheduler/model";
import { MissedActions } from "./MissedActions";
import styles from "./Runs.module.css";
import { useAction } from "./useAction";
import { useOutput, useRun } from "./useRunnerApi";

/** A run's result: its state, exit code, when and how long, the last lines; View output. Opening a
 *  failed run that is a Needs-you item resolves the item. A missed run that waits for the person
 *  offers Run now · Run at… · Skip; a running one, Stop. A stand-in until the real result card. */
export function RunCard({ host, job, run, needsYou, open }: { host: HostClient; job: string; run: string; needsYou: readonly NeedsYouItem[]; open: (route: string) => void }): React.JSX.Element {
  const view = useRun(host, job, run);
  const action = useAction();
  const item = needsYou.find((candidate) => candidate.kind === "run-failed" && candidate.job === job && candidate.run === run);

  useEffect(() => {
    if (item !== undefined) host.apps.call(APP_ID, DISMISS_METHOD, { id: item.id }).catch(() => undefined);
  }, [host, item]);

  if (view.status === "loading") return <section data-testid="run-loading" />;
  if (view.status !== "ready" || view.value === null) {
    return (
      <p className={styles.error} role="alert" data-testid="run-missing">
        {view.status === "ready" ? "This run is not in the history any more." : view.status === "failed" ? view.message : "Runner's scheduler is not running."}
      </p>
    );
  }
  const value = view.value;
  const failed = value.state === "failed";
  const session = value.state === "running" ? value.session : null;
  return (
    <section className={styles.card} data-testid="run-card" data-state={value.state}>
      <h2 className={styles.cardTitle}>{value.name}</h2>
      <span className={`${styles.meta} ${failed ? styles.failed : ""}`} data-testid="run-result">
        {runWords(value)}
      </span>
      <span className={styles.meta}>
        {value.trigger} · due {dayTime(value.dueAt)}
        {value.startedAt !== null && ` · started ${dayTime(value.startedAt)}`}
        {"durationMs" in value && value.durationMs !== null && ` · took ${durationWords(value.durationMs)}`}
      </span>
      {"exitCode" in value && value.exitCode !== null && (
        <span className={styles.meta} data-testid="run-exit">
          Exit code {value.exitCode}
        </span>
      )}
      {"lastLines" in value && value.lastLines.length > 0 && (
        <pre className={styles.output} data-testid="run-last-lines">
          {value.lastLines.join("\n")}
        </pre>
      )}
      {value.state === "missed-waiting" && <MissedActions host={host} job={job} />}
      <span className={styles.actions}>
        {value.log !== null && (
          <button type="button" className={styles.button} onClick={() => open(outputRoute(job, run))}>
            View output
          </button>
        )}
        {session !== null && (
          <button type="button" className={styles.button} onClick={() => action.run(() => host.tabs.openAttached({ session: { app: APP_ID, session }, title: value.name }))}>
            Open session
          </button>
        )}
        {session !== null && (
          <button type="button" className={styles.button} onClick={() => action.run(() => host.apps.call(APP_ID, RUN_STOP_METHOD, { job, run }))}>
            Stop
          </button>
        )}
        {value.kind === "script" && value.state !== "missed-waiting" && (
          <button type="button" className={styles.button} onClick={() => action.run(() => host.apps.call(APP_ID, RUN_NOW_METHOD, { job }))}>
            Run now
          </button>
        )}
      </span>
      {action.error !== null && (
        <p className={styles.error} role="alert">
          {action.error}
        </p>
      )}
    </section>
  );
}

/** A run's full output, as plain text. A stand-in until the real output view. */
export function OutputView({ host, job, run, open }: { host: HostClient; job: string; run: string; open: (route: string) => void }): React.JSX.Element {
  const output = useOutput(host, job, run);
  return (
    <section className={styles.card} data-testid="run-output">
      <span className={styles.actions}>
        <button type="button" className={styles.button} onClick={() => open(runRoute(job, run))}>
          Back to the result
        </button>
      </span>
      {output.status === "ready" ? (
        <pre className={styles.output} data-testid="run-output-text">
          {output.value.truncated && "…\n"}
          {plainLines(output.value.text).join("\n")}
        </pre>
      ) : (
        output.status !== "loading" && (
          <p className={styles.error} role="alert">
            {output.status === "failed" ? output.message : "Runner's scheduler is not running."}
          </p>
        )
      )}
    </section>
  );
}
