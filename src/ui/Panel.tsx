import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { EmptyState } from "./EmptyState";
import { JobsList } from "./JobsList";
import styles from "./Panel.module.css";
import { JobsProblem } from "./JobsProblem";
import { useJobs } from "./useJobs";

/** The side panel: what runs now and what needs the user, with the way into the Runner tab. */
export function Panel({ host }: { host: HostClient }): React.JSX.Element {
  const jobs = useJobs(host);
  const [error, setError] = useState<string | null>(null);

  const openRunner = (): void => {
    setError(null);
    host.tabs.openApp().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const open = (
    <>
      <button type="button" className={styles.open} data-testid="open-runner" onClick={openRunner}>
        Open Runner
      </button>
      {error !== null && (
        <p className={styles.error} role="alert" data-testid="open-runner-error">
          Could not open Runner: {error}
        </p>
      )}
    </>
  );

  if (jobs.status === "loading") return <main className={styles.root} data-testid="panel-loading" />;
  if (jobs.status !== "ready") return <JobsProblem state={jobs} testId="panel-problem" action={open} />;
  if (jobs.snapshot.jobs.length === 0) {
    return (
      <EmptyState testId="panel-empty" title="No jobs yet" action={open}>
        Services and runs show here once Runner has jobs.
      </EmptyState>
    );
  }
  return (
    <main className={styles.root} data-testid="panel-jobs">
      <h2 className={styles.heading}>Jobs</h2>
      <JobsList host={host} jobs={jobs.snapshot.jobs} />
      <footer className={styles.footer}>{open}</footer>
    </main>
  );
}
