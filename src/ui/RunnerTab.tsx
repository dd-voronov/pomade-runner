import type { HostClient } from "pomade-kit/sdk";

import { APP_NAME, APP_VERSION } from "../app";
import { parseRoute } from "../integrations/runner-api";
import { ActiveRunsList } from "./ActiveRunsList";
import { EmptyState } from "./EmptyState";
import { HistoryView } from "./HistoryView";
import { JobsList } from "./JobsList";
import { OutputView, RunCard } from "./RunCard";
import styles from "./RunnerTab.module.css";
import { JobsProblem } from "./JobsProblem";
import { SettingsView } from "./SettingsView";
import { useJobs, useRoute, useRuns, useServices } from "./useRunnerApi";

/** The Runner tab: every job, the history with the runs going, a run's result and output, the
 *  settings — by its route. */
export function RunnerTab({ host }: { host: HostClient }): React.JSX.Element {
  const jobs = useJobs(host);
  const services = useServices(host);
  const runs = useRuns(host);
  const [route, open] = useRoute(host);
  const view = parseRoute(route);
  const version = (
    <span data-testid="version">
      {APP_NAME} {APP_VERSION}
    </span>
  );

  if (jobs.status === "loading") return <main className={styles.root} data-testid="tab-loading" />;
  if (jobs.status !== "ready") return <JobsProblem state={jobs} testId="tab-problem" footer={version} />;
  const report = runs.status === "ready" ? runs.value : null;
  const nav = (
    <nav className={styles.nav}>
      <button type="button" className={styles.navItem} aria-current={view.view === "jobs" ? "page" : undefined} data-testid="nav-jobs" onClick={() => open("")}>
        Jobs
      </button>
      <button type="button" className={styles.navItem} aria-current={view.view === "jobs" || view.view === "settings" ? undefined : "page"} data-testid="nav-history" onClick={() => open("history")}>
        History
      </button>
      <button type="button" className={styles.navItem} aria-current={view.view === "settings" ? "page" : undefined} data-testid="nav-settings" onClick={() => open("settings")}>
        Settings
      </button>
    </nav>
  );
  if (view.view !== "jobs") {
    return (
      <main className={styles.root} data-testid={`tab-${view.view}`}>
        <header className={styles.header}>{nav}</header>
        {view.view === "history" && (
          <>
            <ActiveRunsList host={host} runs={report?.active ?? []} open={open} />
            <HistoryView host={host} open={open} />
          </>
        )}
        {view.view === "settings" && <SettingsView host={host} />}
        {view.view === "run" && <RunCard host={host} job={view.job} run={view.run} needsYou={report?.needsYou ?? []} open={open} />}
        {view.view === "output" && <OutputView host={host} job={view.job} run={view.run} open={open} />}
        <footer className={styles.footer}>{version}</footer>
      </main>
    );
  }
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
        {nav}
        <span className={styles.count}>
          {count} {count === 1 ? "job" : "jobs"}
          {invalid > 0 && ` · ${invalid} invalid`}
        </span>
      </header>
      <JobsList host={host} jobs={jobs.value.jobs} services={services.status === "ready" ? services.value.services : []} runs={report?.jobs ?? []} />
      <footer className={styles.footer}>{version}</footer>
    </main>
  );
}
