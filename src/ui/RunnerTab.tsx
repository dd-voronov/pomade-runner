import type { HostClient } from "pomade-kit/sdk";

import { APP_NAME, APP_VERSION } from "../app";
import { EmptyState } from "./EmptyState";
import { JobsList } from "./JobsList";
import styles from "./RunnerTab.module.css";
import { JobsProblem } from "./JobsProblem";
import { useJobs, useServices } from "./useRunnerApi";

/** The Runner tab: every job, its history and the services. */
export function RunnerTab({ host }: { host: HostClient }): React.JSX.Element {
  const jobs = useJobs(host);
  const services = useServices(host);
  const version = (
    <span data-testid="version">
      {APP_NAME} {APP_VERSION}
    </span>
  );

  if (jobs.status === "loading") return <main className={styles.root} data-testid="tab-loading" />;
  if (jobs.status !== "ready") return <JobsProblem state={jobs} testId="tab-problem" footer={version} />;
  const count = jobs.value.jobs.length;
  if (count === 0) {
    return (
      <EmptyState testId="tab-empty" title="No jobs yet" footer={version}>
        Runner keeps services up and runs scripts, git operations and agents on schedules and hooks — with Pomade open or
        closed. Its jobs show here.
      </EmptyState>
    );
  }
  const invalid = jobs.value.jobs.filter((entry) => !entry.valid).length;
  return (
    <main className={styles.root} data-testid="tab-jobs">
      <header className={styles.header}>
        <h1 className={styles.title}>Jobs</h1>
        <span className={styles.count}>
          {count} {count === 1 ? "job" : "jobs"}
          {invalid > 0 && ` · ${invalid} invalid`}
        </span>
      </header>
      <JobsList host={host} jobs={jobs.value.jobs} services={services.status === "ready" ? services.value.services : []} />
      <footer className={styles.footer}>{version}</footer>
    </main>
  );
}
