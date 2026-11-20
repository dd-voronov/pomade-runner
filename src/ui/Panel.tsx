import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { newRoute } from "../integrations/runner-api";
import { goingRuns } from "./ActiveRunsList";
import { JobsProblem } from "./JobsProblem";
import { Button, PanelCard, PanelSection } from "./kit";
import { NeedsYou } from "./NeedsYou";
import { NextUp } from "./NextUp";
import styles from "./Panel.module.css";
import { RunningNow, runningServices } from "./RunningNow";
import { PanelShell } from "./shell/PanelShell";
import { SwitchControl } from "./SwitchControl";
import { useJobs, useRuns, useServices } from "./useRunnerApi";

/** The side panel: the switch pinned on top; Needs you, Running now — the services that run and the
 *  runs going — and Next up, each collapsible; Open Runner pinned at the bottom. With no jobs yet, it
 *  says what a service is. */
export function Panel({ host }: { host: HostClient }): React.JSX.Element {
  const jobs = useJobs(host);
  const runs = useRuns(host);
  const services = useServices(host);
  const [error, setError] = useState<string | null>(null);

  const openRunner = (): void => {
    setError(null);
    host.tabs.openApp().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const newJob = (): void => {
    setError(null);
    host.tabs.openApp({ route: newRoute() }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const open = (
    <>
      <Button wide data-testid="open-runner" onClick={openRunner}>
        Open Runner
      </Button>
      {error !== null && (
        <p className={styles.error} role="alert" data-testid="open-runner-error">
          Could not open Runner: {error}
        </p>
      )}
    </>
  );

  if (jobs.status === "loading") return <PanelShell testId="panel-loading" foot={open} />;
  if (jobs.status !== "ready") return <JobsProblem state={jobs} testId="panel-problem" action={open} />;
  const report = runs.status === "ready" ? runs.value : null;
  const top = report === null ? undefined : <SwitchControl host={host} state={report.switch} />;
  const serviceStates = services.status === "ready" ? services.value.services : [];
  const active = report?.active ?? [];
  const running = <RunningNow host={host} services={serviceStates} jobs={jobs.value.jobs} workspace={jobs.value.workspace} runs={active} />;
  const runningCount = runningServices(serviceStates).length + goingRuns(active).length;

  if (jobs.value.jobs.length === 0) {
    return (
      <PanelShell testId="panel-empty" top={top} foot={open}>
        <PanelSection title="Running now" count={0} testId="section-running">
          {running}
        </PanelSection>
        <div className={styles.emptyCard}>
          <PanelCard
            title="No jobs yet"
            actions={
              <Button size="sm" variant="primary" onClick={newJob} data-testid="panel-new-job">
                New job
              </Button>
            }
          >
            A <b>service</b> is a command Runner keeps running: it starts at login, restarts on a crash and outlives Pomade — like a project's web server. Scripts, agents
            and git operations run on schedules and hooks.
          </PanelCard>
        </div>
      </PanelShell>
    );
  }
  const needs = report?.needsYou ?? [];
  return (
    <PanelShell testId="panel-jobs" top={top} foot={open}>
      <PanelSection title="Needs you" count={needs.length} urgent={needs.length > 0} testId="section-needs-you">
        <NeedsYou host={host} items={needs} />
      </PanelSection>
      <PanelSection title="Running now" count={runningCount} testId="section-running">
        {running}
      </PanelSection>
      <PanelSection title="Next up" testId="section-next-up">
        <NextUp host={host} next={report?.nextUp ?? []} jobs={jobs.value.jobs} />
      </PanelSection>
    </PanelShell>
  );
}
