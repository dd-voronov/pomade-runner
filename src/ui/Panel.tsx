import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { EmptyState } from "./EmptyState";
import { JobsList } from "./JobsList";
import { NeedsYouList } from "./NeedsYouList";
import { NextUpList } from "./NextUpList";
import styles from "./Panel.module.css";
import { JobsProblem } from "./JobsProblem";
import { useJobs, useRuns, useServices } from "./useRunnerApi";

/** The side panel: what needs the user, what runs next and every job, with the way into the Runner
 *  tab. */
export function Panel({ host }: { host: HostClient }): React.JSX.Element {
  const jobs = useJobs(host);
  const services = useServices(host);
  const runs = useRuns(host);
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
  if (jobs.value.jobs.length === 0) {
    return (
      <EmptyState testId="panel-empty" title="No jobs yet" action={open}>
        Services and runs show here once Runner has jobs.
      </EmptyState>
    );
  }
  const report = runs.status === "ready" ? runs.value : null;
  return (
    <main className={styles.root} data-testid="panel-jobs">
      {report !== null && (
        <>
          <NeedsYouList host={host} items={report.needsYou} />
          <NextUpList next={report.nextUp} now={Date.now()} />
        </>
      )}
      <h2 className={styles.heading}>Jobs</h2>
      <JobsList host={host} jobs={jobs.value.jobs} services={services.status === "ready" ? services.value.services : []} runs={report?.jobs ?? []} />
      <footer className={styles.footer}>{open}</footer>
    </main>
  );
}
