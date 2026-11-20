import { WORKSPACE_PROJECT_ID } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { editRoute, SERVICE_ACTION_TIMEOUT_MS, SERVICE_METHODS, type ServiceVerb } from "../integrations/runner-api";
import { describeJobError } from "../jobs/format";
import { JOBS_FOLDER, type InvalidJob, type JobEntry, type ServiceJob } from "../jobs/model";
import { isServiceActionResult, type ServiceStatus } from "../keeper/model";
import { Button, Chip, EmptyBlock, Help, Icon, IconButton, KindCell, RowCell, RowMain, Status, TableHead, TableRow, useToast } from "./kit";
import { fallbackService } from "./jobWords";
import { useOpenServiceTab } from "./RunningNow";
import { serviceLook } from "./serviceWords";
import styles from "./ServicesView.module.css";
import { ViewFilters } from "./shell/TabShell";
import { useNow } from "./useNow";
import { useActiveProject, useProjectNames } from "./useRunnerApi";

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

const DONE: Record<ServiceVerb, string> = { start: "started", restart: "restarted", stop: "stopped by you — it stays stopped until Start" };

/** The Services view: every service with its project, folder and command, where it stands, Start or
 *  Restart · Stop, and its terminal, form and file; an invalid service file with its error. The
 *  "This project" chip keeps the services of the project Pomade has open. */
export function ServicesView({
  host,
  jobs,
  services,
  open,
  thisProject,
  onThisProject,
}: {
  host: HostClient;
  jobs: readonly JobEntry[];
  services: readonly ServiceStatus[];
  /** Navigates the tab to a route (Edit opens the job's form). */
  open: (route: string) => void;
  /** The "This project" chip, kept by the tab: it holds across the Jobs and Services views. */
  thisProject: boolean;
  onThisProject: (on: boolean) => void;
}): React.JSX.Element {
  const projectName = useProjectNames(host);
  const active = useActiveProject(host);
  const now = useNow();
  const toast = useToast();
  const openTab = useOpenServiceTab(host);
  const all = serviceEntries(jobs);

  if (all.length === 0) {
    return (
      <EmptyBlock title="Nothing here yet" testId="services-empty">
        <p>A service is a command Runner keeps running: it starts at login, restarts on a crash and outlives Pomade.</p>
      </EmptyBlock>
    );
  }

  const activeId = active === null || active.id === WORKSPACE_PROJECT_ID ? null : active.id;
  const shown = thisProject ? all.filter((entry) => (entry.valid ? entry.job.project : entry.invalid.project) === activeId) : all;
  const openFile = (path: string): void => {
    host.tabs.openFile({ path }).catch((err: unknown) => toast(`Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`));
  };
  const act = (verb: ServiceVerb, job: ServiceJob): void => {
    host.apps.call(APP_ID, SERVICE_METHODS[verb], { job: job.id }, { timeoutMs: SERVICE_ACTION_TIMEOUT_MS }).then(
      (answer: unknown) => {
        if (!isServiceActionResult(answer)) toast(`Could not ${verb} ${job.name}: the scheduler answered something else`);
        else if (answer.ok)
          toast(
            <>
              <b>{job.name}</b> {DONE[verb]}
            </>,
          );
        else toast(`Could not ${verb} ${job.name}: ${answer.reason}`);
      },
      (err: unknown) => toast(`Could not ${verb} ${job.name}: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  return (
    <section data-testid="services">
      <ViewFilters summary="Services keep running when Pomade quits · the switch never pauses them">
        <Chip on={thisProject} count={active?.name ?? "…"} onClick={() => onThisProject(!thisProject)} data-testid="this-project">
          This project
        </Chip>
      </ViewFilters>
      <TableHead columns={styles.cols}>
        <span />
        <span>Service · project · folder · command</span>
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
          const look = serviceLook(status, job.ready, now);
          return (
            <TableRow key={job.id} columns={styles.cols} className={styles.row} data-testid="service-row" data-job={job.id} data-state={status.state}>
              <KindCell icon="service" label="Service" />
              <RowMain
                name={job.name}
                sub={
                  <>
                    {projectName(job.project)} · <span className={styles.mono}>{job.folder === "" ? "." : job.folder}</span> · <span className={styles.mono}>{job.command}</span>
                  </>
                }
              />
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
                {look.on ? (
                  <>
                    <Button size="row" icon="restart" onClick={() => act("restart", job)}>
                      Restart
                    </Button>
                    <Button size="row" icon="stop" onClick={() => act("stop", job)}>
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button size="row" variant="primary" icon="play" onClick={() => act("start", job)}>
                    Start
                  </Button>
                )}
                <span className={styles.gap} />
                <IconButton icon="terminal" label="Open terminal (log)" onClick={() => openTab(status)} />
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
