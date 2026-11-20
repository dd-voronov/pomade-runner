import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_NAME, APP_VERSION } from "../app";
import { parseRoute, type RunnerRoute } from "../integrations/runner-api";
import { ActiveRunsList, goingRuns } from "./ActiveRunsList";
import { JobForm } from "./form/JobForm";
import { HistoryView } from "./HistoryView";
import { newJobRoute } from "./jobWords";
import { JobsView } from "./JobsView";
import { JobsProblem } from "./JobsProblem";
import { Button, EmptyBlock, GroupHead } from "./kit";
import { OutputView, RunDialog } from "./RunCard";
import styles from "./RunnerTab.module.css";
import { ServicesView } from "./ServicesView";
import { SettingsView } from "./SettingsView";
import { TabShell, type TabView } from "./shell/TabShell";
import { SERVICE_RUNS } from "./serviceWords";
import { useActiveProject, useJobs, useRoute, useRuns, useServices } from "./useRunnerApi";

/** The header's view for a route: a run's card and its output belong to History; the job form, to Jobs. */
function tabView(route: RunnerRoute): TabView {
  if (route.view === "new" || route.view === "edit") return "jobs";
  return route.view === "run" || route.view === "output" ? "history" : route.view;
}

/** The Runner tab: the shell's four views by its route — every job (at one job, from a repo row's
 *  Scheduled line), the history with the runs going — a run's result card over it — a run's output,
 *  the services, the settings with Runner's version. */
export function RunnerTab({ host }: { host: HostClient }): React.JSX.Element {
  const jobs = useJobs(host);
  const services = useServices(host);
  const runs = useRuns(host);
  const [route, open] = useRoute(host);
  const active = useActiveProject(host);
  // The "This project" chip is the tab's: on in Jobs, it is on in Services, and New job starts in the open project.
  const [thisProject, setThisProject] = useState(false);
  const view = parseRoute(route);
  const version = (
    <span data-testid="version">
      {APP_NAME} {APP_VERSION}
    </span>
  );

  if (jobs.status === "no-scheduler" || jobs.status === "failed") return <JobsProblem state={jobs} testId="tab-problem" footer={version} />;
  const entries = jobs.status === "ready" ? jobs.value.jobs : [];
  const report = runs.status === "ready" ? runs.value : null;
  const serviceStates = services.status === "ready" ? services.value.services : [];
  const counts = jobs.status === "ready" ? { jobs: entries.length, services: entries.filter((entry) => entry.valid && entry.job.kind === "service").length } : {};
  const newJob = (testId: string): React.JSX.Element => (
    <Button variant="primary" icon="plus" onClick={() => open(newJobRoute(thisProject, active))} data-testid={testId}>
      New job
    </Button>
  );
  const shell = (testId: string, children: React.ReactNode): React.JSX.Element => (
    <TabShell current={tabView(view)} counts={counts} open={open} testId={testId} actions={newJob("new-job")}>
      {children}
    </TabShell>
  );

  const history = (
    <>
      {goingRuns(report?.active ?? []).length > 0 && (
        <div className={styles.going}>
          <GroupHead title="Running now" />
          <ActiveRunsList host={host} runs={report?.active ?? []} open={open} />
        </div>
      )}
      <HistoryView host={host} open={open} />
    </>
  );

  if (jobs.status === "loading") return shell("tab-loading", null);
  if (view.view === "new" || view.view === "edit") {
    const target = view.view === "new" ? ({ kind: "new", project: view.project } as const) : ({ kind: "edit", job: view.job } as const);
    const running = view.view === "edit" && serviceStates.some((service) => service.job === view.job && SERVICE_RUNS.includes(service.state));
    return <JobForm host={host} target={target} jobs={jobs.value} serviceRunning={running} open={open} />;
  }
  switch (view.view) {
    case "jobs": {
      if (entries.length === 0) {
        return shell(
          "tab-jobs",
          <EmptyBlock title="No jobs yet" testId="tab-empty" action={newJob("empty-new-job")}>
            <p>
              A job is something Runner does without you. A <b>service</b> keeps a command running — it starts at login, restarts on a crash and outlives Pomade. A{" "}
              <b>script</b>, an <b>agent</b> or a <b>git</b> operation runs on a schedule, on a hook, or after another job.
            </p>
            <p>You can also ask an agent: “add a job that runs inbox triage every Sunday at 3:00”.</p>
          </EmptyBlock>,
        );
      }
      return shell(
        "tab-jobs",
        <JobsView
          host={host}
          jobs={entries}
          services={serviceStates}
          report={report}
          marked={view.job}
          active={active}
          thisProject={thisProject}
          onThisProject={setThisProject}
          open={open}
          newJob={newJob}
        />,
      );
    }
    case "history":
    case "run":
      // One tree for both, so History stays mounted under the card and focus returns to its row.
      return shell(
        `tab-${view.view}`,
        <>
          {history}
          {view.view === "run" && <RunDialog key={`${view.job}/${view.run}`} host={host} job={view.job} run={view.run} needsYou={report?.needsYou ?? []} open={open} />}
        </>,
      );
    case "services":
      return shell("tab-services", <ServicesView host={host} jobs={entries} services={serviceStates} open={open} thisProject={thisProject} onThisProject={setThisProject} />);
    case "settings":
      return shell(
        "tab-settings",
        <>
          <SettingsView host={host} />
          <p className={styles.version}>{version}</p>
        </>,
      );
    case "output":
      return shell("tab-output", <OutputView host={host} job={view.job} run={view.run} open={open} />);
  }
}
