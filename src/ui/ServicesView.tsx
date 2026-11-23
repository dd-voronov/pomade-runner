import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { editRoute } from "../integrations/runner-api";
import { describeJobError } from "../jobs/format";
import { JOBS_FOLDER, type InvalidJob, type JobEntry, type ServiceJob } from "../jobs/model";
import type { ServiceStatus } from "../keeper/model";
import { CommandCell, CommandHead, commandVars, useCommandWidth } from "./CommandColumn";
import { Button, Chip, EmptyBlock, Help, Icon, IconButton, KindCell, RowCell, RowMain, Status, TableHead, TableRow, useToast } from "./kit";
import { fallbackService } from "./jobWords";
import { useOpenServiceTab } from "./RunningNow";
import { serviceActions, serviceLook } from "./serviceWords";
import styles from "./ServicesView.module.css";
import { ViewFilters } from "./shell/TabShell";
import { useNow } from "./useNow";
import { useActiveProject, useProjectNames } from "./useRunnerApi";
import { useServiceAction } from "./useServiceAction";

/** A service file: valid, or invalid with its error. */
type ServiceEntry = { valid: true; job: ServiceJob } | { valid: false; invalid: InvalidJob };

/** Start order, as supervision's: workspace jobs first, then each project's, each by id. */
const startOrder = (a: string, b: string): number => Number(a.includes("/")) - Number(b.includes("/")) || (a < b ? -1 : a > b ? 1 : 0);
const idOf = (entry: ServiceEntry): string => (entry.valid ? entry.job.id : entry.invalid.id);

/** Every service file — invalid ones by the kind they declare — in start order. */
function serviceEntries(jobs: readonly JobEntry[]): ServiceEntry[] {
  return jobs
    .flatMap((entry): ServiceEntry[] => (entry.valid ? (entry.job.kind === "service" ? [{ valid: true, job: entry.job }] : []) : entry.invalid.kind === "service" ? [entry] : []))
    .sort((a, b) => startOrder(idOf(a), idOf(b)));
}

/** The Services view: every service with its project and folder, its command in a column of its own
 *  (as wide as the viewer dragged it to), where it stands, Start or
 *  Restart · Stop, and its terminal (once it has a session), form and file; an invalid service file with its error. The
 *  "This project" chip keeps the services of the project Pomade has open. */
export function ServicesView({
  host,
  jobs,
  services,
  open,
  thisProject,
  onThisProject,
  newJob,
}: {
  host: HostClient;
  jobs: readonly JobEntry[];
  services: readonly ServiceStatus[];
  /** Navigates the tab to a route (Edit opens the job's form). */
  open: (route: string) => void;
  /** The "This project" chip, kept by the tab: it holds across the Jobs and Services views. */
  thisProject: boolean;
  onThisProject: (on: boolean) => void;
  /** The New job button the empty view offers. */
  newJob: (testId: string) => React.JSX.Element;
}): React.JSX.Element {
  const projectName = useProjectNames(host);
  const active = useActiveProject(host);
  const now = useNow();
  const toast = useToast();
  const openTab = useOpenServiceTab(host);
  const act = useServiceAction(host);
  const command = useCommandWidth();
  const all = serviceEntries(jobs);

  if (all.length === 0) {
    return (
      <EmptyBlock title="Nothing here yet" testId="services-empty" action={newJob("services-empty-new-job")}>
        <p>A service is a command Runner keeps running and restarts on a crash: from Mac startup, outliving Pomade, or only while Pomade is running.</p>
      </EmptyBlock>
    );
  }

  const activeId = active === null || active.id === WORKSPACE_PROJECT_ID ? null : active.id;
  const shown = thisProject ? all.filter((entry) => (entry.valid ? entry.job.project : entry.invalid.project) === activeId) : all;
  const openFile = (path: string): void => {
    host.tabs.openFile({ path }).catch((err: unknown) => toast(`Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`));
  };
  return (
    <section className={styles.view} style={commandVars(command.width)} data-testid="services">
      <ViewFilters summary="Services on Mac startup outlive Pomade · the switch never pauses them">
        <Chip on={thisProject} count={active?.name ?? "…"} onClick={() => onThisProject(!thisProject)} data-testid="this-project">
          This project
        </Chip>
      </ViewFilters>
      <TableHead columns={styles.cols}>
        <span />
        <span className={styles.headText}>Service · project · folder</span>
        <CommandHead width={command.width} onChange={command.set} onCommit={command.commit} />
        <span>Status</span>
        <span />
      </TableHead>
      <div>
        {shown.length === 0 && (
          <div className={styles.none} data-testid="services-none">
            No services in this project.
          </div>
        )}
        {shown.map((entry) => {
          if (!entry.valid) {
            const { invalid } = entry;
            const [first] = invalid.errors;
            return (
              <TableRow key={invalid.id} columns={styles.cols} invalid data-testid="service-invalid" data-job={invalid.id}>
                <span className={styles.warn}>
                  <Icon name="warn" />
                </span>
                <div className={styles.invalidText}>
                  <div className={styles.invalidLine}>
                    <span className={styles.file}>{invalid.path.startsWith(`${JOBS_FOLDER}/`) ? invalid.path.slice(JOBS_FOLDER.length + 1) : invalid.path}</span>
                    <Help k="jobs.invalid" />
                  </div>
                  <div className={styles.error}>
                    Invalid: {first === undefined ? "the file has an error." : `line ${first.line}: ${describeJobError(first)}`}
                    {invalid.errors.length > 1 && ` · ${invalid.errors.length - 1} more`}
                  </div>
                </div>
                <div className={styles.actions}>
                  <Button size="sm" onClick={() => openFile(invalid.path)}>
                    Open file
                  </Button>
                </div>
              </TableRow>
            );
          }
          const { job } = entry;
          const status = services.find((candidate) => candidate.job === job.id) ?? fallbackService(job);
          const look = serviceLook(status, job.ready, now, job.startProject === null ? null : projectName(job.startProject));
          const offered = serviceActions(status, job.enabled);
          return (
            <TableRow key={job.id} columns={styles.cols} className={styles.row} data-testid="service-row" data-job={job.id} data-state={status.state}>
              <KindCell icon="service" label="Service" />
              <RowMain
                name={job.name}
                sub={
                  <>
                    {projectName(job.project)} · <span className={styles.mono}>{job.folder === "" ? "." : job.folder}</span>
                  </>
                }
              />
              <CommandCell command={job.command} />
              <RowCell
                sub={
                  <span data-help={look.subHelp ?? undefined} className={look.subHelp === null ? undefined : styles.helped} data-testid="service-sub">
                    {look.sub}
                  </span>
                }
              >
                <Status tone={look.tone} live={look.live} size="sm" help={look.help ?? undefined} testId="service-status">
                  {look.words}
                </Status>
              </RowCell>
              <div className={styles.actions}>
                {offered.toggle === "stop" && (
                  <>
                    <Button size="row" icon="restart" onClick={() => act("restart", job)}>
                      Restart
                    </Button>
                    <Button size="row" icon="stop" onClick={() => act("stop", job)}>
                      Stop
                    </Button>
                  </>
                )}
                {offered.toggle === "start" && (
                  <Button size="row" variant="primary" icon="play" onClick={() => act("start", job)}>
                    Start
                  </Button>
                )}
                <span className={styles.gap} />
                {offered.terminal ? <IconButton icon="terminal" label="Open terminal" onClick={() => openTab(status)} /> : <span className={styles.slot} />}
                <IconButton icon="edit" label="Edit" onClick={() => open(editRoute(job.id))} />
                <IconButton icon="file" label="Open file" onClick={() => openFile(job.path)} />
              </div>
            </TableRow>
          );
        })}
      </div>
    </section>
  );
}
