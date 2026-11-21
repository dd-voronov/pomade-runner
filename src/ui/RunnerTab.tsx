import { useEffect, useRef, useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID, APP_NAME, APP_VERSION } from "../app";
import { parseRoute, runRoute, type RunnerRoute } from "../integrations/runner-api";
import { JobForm } from "./form/JobForm";
import { HistoryView } from "./HistoryView";
import { newJobRoute } from "./jobWords";
import { JobsView } from "./JobsView";
import { JobsProblem } from "./JobsProblem";
import { Button, EmptyBlock, useToast } from "./kit";
import { OutputPage } from "./OutputPage";
import { RunDialog } from "./RunCard";
import styles from "./RunnerTab.module.css";
import { ServicesView } from "./ServicesView";
import { SettingsView } from "./SettingsView";
import { TabShell, type TabView } from "./shell/TabShell";
import { SERVICE_RUNS } from "./serviceWords";
import { useActiveProject, useJobs, useRoute, useRun, useRuns, useServices } from "./useRunnerApi";

/** The header's view for a route: a run's card belongs to History; the job form, to Jobs. */
function tabView(route: Exclude<RunnerRoute, { view: "output" }>): TabView {
  if (route.view === "new" || route.view === "edit") return "jobs";
  return route.view === "run" || route.view === "prompt" ? "history" : route.view;
}

/** At `prompt/<job>/<run>` — a waiting run's notice — the run's terminal tab opens at the prompt
 *  while the run still runs; the Runner tab goes to the run's card either way. */
function PromptOpener({ host, job, run, open }: { host: HostClient; job: string; run: string; open: (route: string) => void }): null {
  const view = useRun(host, job, run);
  const toast = useToast();
  const value = view.status === "ready" ? view.value : null;
  const settled = view.status !== "loading";
  // Once per arrival at the route: the route moves on to the card at once.
  const fired = useRef(false);
  useEffect(() => {
    if (!settled || fired.current) return;
    fired.current = true;
    if (value !== null && value.state === "running" && value.session !== null) {
      host.tabs.openAttached({ session: { app: APP_ID, session: value.session }, title: value.name }).catch((err: unknown) => toast(`Could not open ${value.name}'s terminal: ${err instanceof Error ? err.message : String(err)}`));
    }
    open(runRoute(job, run));
  }, [settled, value, host, job, run, open, toast]);
  return null;
}

/** A Runner tab frame by its route: the Runner tab — the shell's four views: every job (at one job,
 *  from a repo row's Scheduled line), the history with the runs going — a run's result card over
 *  it, or a waiting run's at `prompt/<job>/<run>` with its terminal tab opened at the prompt — the
 *  services, the settings with Runner's version — or, at `output/<job>/<run>`, a run's output tab
 *  (View output opens it, keyed by the run). */
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

  if (view.view === "output") return <OutputPage host={host} job={view.job} run={view.run} />;
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

  const history = <HistoryView host={host} active={report?.active ?? []} open={open} thisProject={thisProject} onThisProject={setThisProject} newJob={newJob} />;

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
    case "prompt":
      // One tree for all three, so History stays mounted under the card and focus returns to its row.
      return shell(
        `tab-${view.view === "prompt" ? "run" : view.view}`,
        <>
          {history}
          {view.view !== "history" && <RunDialog key={`${view.job}/${view.run}`} host={host} job={view.job} run={view.run} needsYou={report?.needsYou ?? []} active={report?.active ?? []} open={open} />}
          {view.view === "prompt" && <PromptOpener key={`${view.job}/${view.run}`} host={host} job={view.job} run={view.run} open={open} />}
        </>,
      );
    case "services":
      return shell("tab-services", <ServicesView host={host} jobs={entries} services={serviceStates} open={open} thisProject={thisProject} onThisProject={setThisProject} newJob={newJob} />);
    case "settings":
      return shell(
        "tab-settings",
        <>
          <SettingsView host={host} />
          <p className={styles.version}>{version}</p>
        </>,
      );
  }
}
