import { useEffect } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { DISMISS_METHOD, outputRoute, RUN_NOW_METHOD, RUN_STOP_METHOD, runRoute } from "../integrations/runner-api";
import { gitRepoLine } from "../scheduler/git-runs";
import { dayTime, durationWords, plainLines, runTriggerWords, runWords, type NeedsYouItem } from "../scheduler/model";
import { MissedActions } from "./MissedActions";
import styles from "./Runs.module.css";
import { useAction } from "./useAction";
import { useOutput, useRun } from "./useRunnerApi";
import { Button, Dialog, DialogBody, DialogHead } from "./kit";

/** A run's result card, in the dialog over History that Esc, the close button or a click outside
 *  closes back to History. */
export function RunDialog(props: { host: HostClient; job: string; run: string; needsYou: readonly NeedsYouItem[]; open: (route: string) => void }): React.JSX.Element {
  const close = (): void => props.open("history");
  return (
    <Dialog onClose={close} testId="run-dialog">
      <RunCard {...props} close={close} />
    </Dialog>
  );
}

/** A run's result: its state, what started it, exit code, when and how long, the last lines — a git
 *  run's result per repo; View output. Opening a failed run that is a Needs-you item resolves the item. A chain run opens the
 *  run it followed. A missed run that waits for the person offers Run now · Run at… · Skip; a running
 *  one, Stop. A stand-in until the real result card. */
function RunCard({
  host,
  job,
  run,
  needsYou,
  open,
  close,
}: {
  host: HostClient;
  job: string;
  run: string;
  needsYou: readonly NeedsYouItem[];
  open: (route: string) => void;
  close: () => void;
}): React.JSX.Element {
  const view = useRun(host, job, run);
  const action = useAction();
  const item = needsYou.find((candidate) => candidate.kind === "run-failed" && candidate.job === job && candidate.run === run);

  useEffect(() => {
    if (item !== undefined) host.apps.call(APP_ID, DISMISS_METHOD, { id: item.id }).catch(() => undefined);
  }, [host, item]);

  if (view.status === "loading") return <DialogHead title="" onClose={close} />;
  if (view.status !== "ready" || view.value === null) {
    return (
      <>
        <DialogHead title="Result" onClose={close} />
        <DialogBody>
          <p className={styles.error} role="alert" data-testid="run-missing">
            {view.status === "ready" ? "This run is not in the history any more." : view.status === "failed" ? view.message : "Runner's scheduler is not running."}
          </p>
        </DialogBody>
      </>
    );
  }
  const value = view.value;
  const failed = value.state === "failed";
  const session = value.state === "running" ? value.session : null;
  const parent = value.cause?.kind === "chain" ? value.cause : null;
  return (
    <>
    <DialogHead title={value.name} onClose={close} />
    <DialogBody>
    <section className={styles.card} data-testid="run-card" data-state={value.state}>
      <span className={`${styles.meta} ${failed ? styles.failed : ""}`} data-testid="run-result">
        {runWords(value)}
      </span>
      <span className={styles.meta} data-testid="run-trigger">
        {runTriggerWords(value)} · due {dayTime(value.dueAt)}
        {value.startedAt !== null && ` · started ${dayTime(value.startedAt)}`}
        {"durationMs" in value && value.durationMs !== null && ` · took ${durationWords(value.durationMs)}`}
      </span>
      {"exitCode" in value && value.exitCode !== null && (
        <span className={styles.meta} data-testid="run-exit">
          Exit code {value.exitCode}
        </span>
      )}
      {"git" in value && value.git !== null ? (
        <ul className={styles.list} data-testid="run-git-repos">
          {value.git.results.map((result, index) => (
            <li key={`${index}:${result.repo}`} className={`${styles.meta} ${result.status === "failed" ? styles.failed : ""}`} data-testid="run-git-repo" data-status={result.status}>
              {gitRepoLine(result)}
            </li>
          ))}
        </ul>
      ) : (
        "lastLines" in value &&
        value.lastLines.length > 0 && (
          <pre className={styles.output} data-testid="run-last-lines">
            {value.lastLines.join("\n")}
          </pre>
        )
      )}
      {value.state === "missed-waiting" && <MissedActions host={host} job={job} />}
      <span className={styles.actions}>
        {value.log !== null && (
          <Button onClick={() => open(outputRoute(job, run))}>
            View output
          </Button>
        )}
        {parent !== null && (
          <Button onClick={() => open(runRoute(parent.job, parent.run))}>
            Open {parent.name}'s run
          </Button>
        )}
        {session !== null && (
          <Button onClick={() => action.run(() => host.tabs.openAttached({ session: { app: APP_ID, session }, title: value.name }))}>
            Open session
          </Button>
        )}
        {session !== null && (
          <Button onClick={() => action.run(() => host.apps.call(APP_ID, RUN_STOP_METHOD, { job, run }))}>
            Stop
          </Button>
        )}
        {(value.kind === "script" || value.kind === "git") && value.state !== "missed-waiting" && (
          <Button onClick={() => action.run(() => host.apps.call(APP_ID, RUN_NOW_METHOD, { job }))}>
            Run now
          </Button>
        )}
      </span>
      {action.error !== null && (
        <p className={styles.error} role="alert">
          {action.error}
        </p>
      )}
    </section>
    </DialogBody>
    </>
  );
}

/** A run's full output, as plain text. A stand-in until the real output view. */
export function OutputView({ host, job, run, open }: { host: HostClient; job: string; run: string; open: (route: string) => void }): React.JSX.Element {
  const output = useOutput(host, job, run);
  return (
    <section className={styles.card} data-testid="run-output">
      <span className={styles.actions}>
        <Button onClick={() => open(runRoute(job, run))}>
          Back to the result
        </Button>
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
