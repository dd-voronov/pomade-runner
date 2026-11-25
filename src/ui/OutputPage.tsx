import { Fragment, useEffect } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { lineText, outputLines } from "../scheduler/terminal-text";
import { Button, Dot, useToast } from "./kit";
import { OutputText } from "./OutputText";
import styles from "./OutputPage.module.css";
import { runTime, whenWords } from "./runLook";
import { useNow } from "./useNow";
import { useRunOutput } from "./useRunOutput";
import { useRun } from "./useRunnerApi";

/** What the page says of a run whose output log is not on this Mac: its record came with the
 *  workspace from another Mac, or the log was removed. */
export const OUTPUT_NOT_HERE = "This run's output is not on this Mac.";

/** A run's full output (the prototype's output tab, `outPane`): the run's own output tab, at the
 *  route `output/<job>/<run>`. A head with the job's name and what the log is, and Copy, which puts
 *  the log on the clipboard as plain text; then the log in the colours the program printed —
 *  followed while the run runs. A tab whose run is gone from the history (Runner pruned it, and
 *  Pomade restored the tab) closes itself. */
export function OutputPage({ host, job, run }: { host: HostClient; job: string; run: string }): React.JSX.Element {
  const view = useRun(host, job, run);
  const value = view.status === "ready" ? view.value : null;
  const running = value?.state === "running";
  const output = useRunOutput(host, job, run, running);
  const now = useNow(30_000);
  const toast = useToast();
  const lines = output.status === "ready" && !output.value.missing ? outputLines(output.value.text) : [];
  if (lineText(lines.at(-1) ?? []) === "") lines.pop();
  const gone = view.status === "ready" && view.value === null;

  useEffect(() => {
    if (gone) host.tabs.close().catch((err: unknown) => toast(`Could not close this tab: ${err instanceof Error ? err.message : String(err)}`));
  }, [host, gone, toast]);

  const copy = (): void => {
    navigator.clipboard.writeText(`${lines.map(lineText).join("\n")}\n`).then(
      () => toast("Copied the log"),
      (err: unknown) => toast(`Could not copy the log: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  return (
    <main className={styles.root} data-testid="run-output">
      <header className={styles.head}>
        <div className={styles.title}>
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
        <div className={styles.acts}>
          <Button className={styles.act} disabled={lines.length === 0} onClick={copy} data-testid="run-output-copy">
            Copy
          </Button>
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
            lines.map((line, index) => (
              <Fragment key={index}>
                <OutputText line={line} />
                {index < lines.length - 1 && "\n"}
              </Fragment>
            ))
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
