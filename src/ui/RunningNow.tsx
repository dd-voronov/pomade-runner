import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { runRoute } from "../integrations/runner-api";
import type { JobEntry, Readiness } from "../jobs/model";
import { sessionIdOf } from "../keeper/ids";
import type { ServiceStatus } from "../keeper/model";
import type { ActiveRun } from "../scheduler/model";
import { ActiveRunRow, goingRuns, placeWords } from "./ActiveRunsList";
import { PanelEmpty, PanelRow, useToast } from "./kit";
import { runningSince } from "./runLook";
import { serviceLook } from "./serviceWords";
import { useOpenRunTerminal } from "./useRunActions";
import { useRunningNow } from "./useNow";
import { useProjectNames } from "./useRunnerApi";

/** The services that run now — up or starting — in start order. */
export function runningServices(services: readonly ServiceStatus[]): ServiceStatus[] {
  return services.filter((status) => status.state === "running" || status.state === "starting");
}

/** A service's session id: its session's, else the one it gets (`svc:<job>`). */
export function serviceSession(status: ServiceStatus): string {
  return status.session?.id ?? sessionIdOf({ kind: "service", job: status.job }) ?? "";
}

/** Opens a service's attached tab — Pomade focuses the one already open — titled with its name. */
export function useOpenServiceTab(host: HostClient): (status: ServiceStatus) => void {
  const toast = useToast();
  return (status) => {
    host.tabs.openAttached({ session: { app: APP_ID, session: serviceSession(status) }, title: status.name }).catch((err: unknown) => {
      toast(`Could not open ${status.name}'s terminal: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}

/** Opens a run's tab: a running run's terminal (`useOpenRunTerminal`), a queued run's result card,
 *  which has no session yet. */
export function useOpenRun(host: HostClient): (run: ActiveRun) => void {
  const toast = useToast();
  const openTerminal = useOpenRunTerminal(host);
  return (run) => {
    if (run.state === "running") {
      openTerminal(run, run.session ?? sessionIdOf({ kind: "run", job: run.job, run: run.run }) ?? "");
    } else {
      host.tabs.openApp({ route: runRoute(run.job, run.run) }).catch((err: unknown) => toast(`Could not open ${run.name}: ${err instanceof Error ? err.message : String(err)}`));
    }
  };
}

/** The panel's Running now: the services that run, then the runs going, as one list; a service's row
 *  opens its attached tab, a running run's its terminal, a queued run's its card. */
export function RunningNow({
  host,
  services,
  jobs,
  workspace,
  runs,
}: {
  host: HostClient;
  services: readonly ServiceStatus[];
  jobs: readonly JobEntry[];
  workspace: string | null;
  runs: readonly ActiveRun[];
}): React.JSX.Element {
  const now = useRunningNow(runningSince(runs));
  const projectName = useProjectNames(host);
  const openTab = useOpenServiceTab(host);
  const openRun = useOpenRun(host);
  const up = runningServices(services);
  const going = goingRuns(runs);
  const jobOf = (id: string): { folder: string; ready: Readiness | null } => {
    const entry = jobs.find((candidate) => candidate.valid && candidate.job.id === id);
    return entry?.valid === true && entry.job.kind === "service" ? { folder: entry.job.folder, ready: entry.job.ready } : { folder: "", ready: null };
  };
  if (up.length === 0 && going.length === 0) {
    return (
      <div data-testid="active-runs">
        <PanelEmpty>Nothing is running.</PanelEmpty>
      </div>
    );
  }
  return (
    <div data-testid="active-runs">
      {up.map((status) => {
        const { folder, ready } = jobOf(status.job);
        const look = serviceLook(status, ready, now);
        return (
          <PanelRow
            key={status.job}
            name={status.name}
            tone={look.tone}
            live={look.live}
            status={look.short}
            statusHelp={look.help}
            place={placeWords(status.project, projectName, folder, workspace)}
            news={look.news}
            newsHelp={look.newsHelp}
            onClick={() => openTab(status)}
            testId="running-service"
            state={status.state}
          />
        );
      })}
      {going.map((run) => (
        <ActiveRunRow
          key={`${run.job}/${run.run}`}
          run={run}
          now={now}
          place={placeWords(run.project, projectName, run.folder, workspace)}
          onOpen={openRun}
        />
      ))}
    </div>
  );
}
