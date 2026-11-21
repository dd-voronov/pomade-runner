import type { HostClient } from "pomade-kit/sdk";

import { runRoute } from "../integrations/runner-api";
import { runWords, waitingAt, type ActiveRun } from "../scheduler/model";
import { PanelEmpty, PanelRow, useToast } from "./kit";
import { upWords } from "./serviceWords";
import { useNow } from "./useNow";
import { useProjectNames } from "./useRunnerApi";

/** Where a row's job works, as Running now says it: "Alpha · Projects/alpha", "workspace · git-base"
 *  — the workspace root by its folder's name. */
export function placeWords(project: string | null, projectName: (id: string | null) => string, folder: string, workspace: string | null): string {
  const root = workspace === null ? "workspace root" : workspace.slice(workspace.replace(/\/+$/, "").lastIndexOf("/") + 1).replace(/\/+$/, "");
  return `${project === null ? "workspace" : projectName(project)} · ${folder === "" ? root : folder}`;
}

/** One run going in Running now: running ("running 3m"), an agent run waiting for you at a prompt
 *  ("waiting for you · 17m", amber), or queued with what it waits for ("queued · 1 ahead"); a click
 *  opens what `onOpen` opens for it. */
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
  const waiting = running && waitingAt(run) !== null;
  const ran = run.startedAt === null ? "" : upWords(now - run.startedAt);
  return (
    <PanelRow
      name={run.name}
      tone={waiting ? "warning" : running ? "accent" : "hollow"}
      live={running && !waiting}
      status={waiting ? `waiting for you${ran === "" ? "" : ` · ${ran}`}` : running ? `running ${ran}`.trim() : runWords(run)}
      statusHelp={waiting ? "st.waiting" : running ? "st.running" : "st.queued"}
      statusTone={waiting ? "warning" : undefined}
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
  const toast = useToast();
  const show = (run: ActiveRun): void => {
    const route = runRoute(run.job, run.run);
    if (open === undefined) host.tabs.openApp({ route }).catch((err: unknown) => toast(`Could not open ${run.name}: ${err instanceof Error ? err.message : String(err)}`));
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
