import type { HostClient } from "pomade-kit/sdk";

import { runRoute } from "../integrations/runner-api";
import { runWords, type ActiveRun } from "../scheduler/model";
import { PanelEmpty, PanelRow } from "./kit";
import { upWords } from "./serviceWords";
import { useNow } from "./useNow";
import { useProjectNames } from "./useRunnerApi";

/** Where a row's job works, as Running now says it: "Alpha · Projects/alpha", "workspace · git-base"
 *  — the workspace root by its folder's name. */
export function placeWords(project: string | null, projectName: (id: string | null) => string, folder: string, workspace: string | null): string {
  const root = workspace === null ? "workspace root" : workspace.slice(workspace.replace(/\/+$/, "").lastIndexOf("/") + 1).replace(/\/+$/, "");
  return `${project === null ? "workspace" : projectName(project)} · ${folder === "" ? root : folder}`;
}

/** One run going in Running now: running ("running 3m") or queued with what it waits for ("queued ·
 *  1 ahead"); a click opens the run's card. */
export function ActiveRunRow({
  run,
  now,
  place,
  onOpen,
}: {
  run: ActiveRun;
  now: number;
  place: string;
  onOpen: (run: ActiveRun) => void;
}): React.JSX.Element {
  const running = run.state === "running";
  return (
    <PanelRow
      name={run.name}
      tone={running ? "accent" : "hollow"}
      live={running}
      status={running ? `running ${run.startedAt === null ? "" : upWords(now - run.startedAt)}`.trim() : runWords(run)}
      statusHelp={running ? "st.running" : "st.queued"}
      place={place}
      onClick={() => onOpen(run)}
      testId="active-run"
      state={run.state}
    />
  );
}

/** The runs going — running ones, and queued ones with what each waits for — the runs `goingRuns`
 *  keeps; a row opens the run's card. */
export function ActiveRunsList({
  host,
  runs,
  open,
  workspace = null,
}: {
  host: HostClient;
  runs: readonly ActiveRun[];
  open?: (route: string) => void;
  workspace?: string | null | undefined;
}): React.JSX.Element {
  const going = goingRuns(runs);
  const now = useNow();
  const projectName = useProjectNames(host);
  const show = (run: ActiveRun): void => {
    const route = runRoute(run.job, run.run);
    if (open === undefined) void host.tabs.openApp({ route }).catch(() => undefined);
    else open(route);
  };
  return (
    <div data-testid="active-runs">
      {going.length === 0 ? (
        <PanelEmpty>Nothing is running.</PanelEmpty>
      ) : (
        going.map((run) => <ActiveRunRow key={`${run.job}/${run.run}`} run={run} now={now} place={placeWords(run.project, projectName, run.folder, workspace)} onOpen={show} />)
      )}
    </div>
  );
}

/** The runs going: missed runs waiting for the person are in Needs you, not here. */
export function goingRuns(runs: readonly ActiveRun[]): ActiveRun[] {
  return runs.filter((run) => run.state !== "missed-waiting");
}
