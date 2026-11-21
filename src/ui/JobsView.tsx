import { Fragment, useEffect, useRef, useState } from "react";
import { WORKSPACE_PROJECT_ID, type ProjectRef } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { editRoute, RUN_NOW_METHOD, runRoute, SET_ENABLED_METHOD } from "../integrations/runner-api";
import { describeJobError } from "../jobs/format";
import { entryId, entryPath, JOBS_FOLDER, type InvalidJob, type Job, type JobEntry, type JobKind } from "../jobs/model";
import { jobTriggerWords, type WordNames } from "../jobs/words";
import type { ServiceStatus } from "../keeper/model";
import { isEnableResult, isRunActionResult, type ActiveRun, type RunsReport } from "../scheduler/model";
import { DeleteJobDialog } from "./DeleteJobDialog";
import { fallbackService, gitDetail, lastLook, nextLook } from "./jobWords";
import styles from "./JobsView.module.css";
import { Button, Chip, EmptyBlock, GroupHead, Help, Icon, IconButton, KindCell, RowActions, RowCell, RowMain, Status, TableHead, TableRow, Toggle, useToast } from "./kit";
import { useOpenServiceTab } from "./RunningNow";
import { SERVICE_RUNS } from "./serviceWords";
import { ViewFilters } from "./shell/TabShell";
import { useNow } from "./useNow";
import { useProjectList, useRepos } from "./useRunnerApi";

const KIND_LABEL: Record<JobKind, string> = { service: "Service", script: "Script", agent: "Agent", git: "Git" };

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A job file's name inside its group: `weekly-report.md`. */
const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The jobs folder's sub-folder a group's files sit in — `""` for the Workspace's. */
function subFolder(entries: readonly JobEntry[]): string {
  const [first] = entries;
  if (first === undefined) return "";
  const inside = entryPath(first).slice(JOBS_FOLDER.length + 1);
  return inside.includes("/") ? inside.slice(0, inside.lastIndexOf("/") + 1) : "";
}

const projectOf = (entry: JobEntry): string | null => (entry.valid ? entry.job.project : entry.invalid.project);

interface Group {
  /** The project id; `null` for the Workspace. */
  id: string | null;
  name: string;
  entries: JobEntry[];
}

/** Workspace jobs first, then each project's in Pomade's order (a project Pomade lacks after them,
 *  by id), each group's files by path. */
function groupsOf(entries: readonly JobEntry[], projects: readonly ProjectRef[]): Group[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const order = (id: string): number => {
    const at = projects.findIndex((project) => project.id === id);
    return at === -1 ? projects.length : at;
  };
  const ids = [...new Set(entries.map(projectOf))];
  ids.sort((a, b) => Number(a !== null) - Number(b !== null) || (a === null || b === null ? 0 : order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0)));
  return ids.map((id) => ({
    id,
    name: id === null ? "Workspace" : (names.get(id) ?? id),
    entries: entries.filter((entry) => projectOf(entry) === id).sort((a, b) => entryPath(a).localeCompare(entryPath(b))),
  }));
}

/** What a row's actions do, each reporting its outcome as a toast. */
function useRowActions(host: HostClient): {
  runNow: (job: Job) => void;
  setEnabled: (job: Job, enabled: boolean) => void;
  openFile: (path: string) => void;
} {
  const toast = useToast();
  const failure = (what: string, err: unknown): void => toast(`Could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
  return {
    runNow: (job) => {
      host.apps.call(APP_ID, RUN_NOW_METHOD, { job: job.id }).then(
        (answer: unknown) => {
          if (!isRunActionResult(answer)) return toast(`Could not run ${job.name}: the scheduler answered something else`);
          if (!answer.ok) return toast(`Could not run ${job.name}: ${answer.reason}`);
          const queued = "run" in answer && answer.run.state === "queued";
          toast(
            <>
              <b>{job.name}</b> {queued ? "queued" : "started"}
            </>,
          );
        },
        (err: unknown) => failure(`run ${job.name}`, err),
      );
    },
    setEnabled: (job, enabled) => {
      host.apps.call(APP_ID, SET_ENABLED_METHOD, { job: job.id, enabled }).then(
        (answer: unknown) => {
          if (!isEnableResult(answer)) toast(`Could not ${enabled ? "enable" : "disable"} ${job.name}: the scheduler answered something else`);
          else if (!answer.ok) toast(`Could not ${enabled ? "enable" : "disable"} ${job.name}: ${answer.reason}`);
        },
        (err: unknown) => failure(`${enabled ? "enable" : "disable"} ${job.name}`, err),
      );
    },
    openFile: (path) => {
      host.tabs.openFile({ path }).catch((err: unknown) => failure(`open ${path}`, err));
    },
  };
}

function InvalidRow({ invalid, onOpenFile, marked }: { invalid: InvalidJob; onOpenFile: (path: string) => void; marked: boolean }): React.JSX.Element {
  const [first] = invalid.errors;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (marked) row.current?.scrollIntoView({ block: "nearest" });
  }, [marked]);
  return (
    <TableRow ref={row} columns={styles.cols} invalid aria-current={marked ? "true" : undefined} data-testid="job-invalid" data-job={invalid.id}>
      <span className={styles.warn}>
        <Icon name="warn" />
      </span>
      <div className={styles.invalidText}>
        <div className={styles.invalidLine}>
          <span className={styles.file}>{fileName(invalid.path)}</span>
          <Help k="jobs.invalid" />
        </div>
        <div className={styles.error}>
          Invalid: {first === undefined ? "the file has an error." : `line ${first.line}: ${describeJobError(first)}`}
          {invalid.errors.length > 1 && ` · ${invalid.errors.length - 1} more`}
        </div>
      </div>
      <RowActions className={styles.invalidActions}>
        <Button size="sm" onClick={() => onOpenFile(invalid.path)}>
          Open file
        </Button>
      </RowActions>
    </TableRow>
  );
}

function JobRow({
  host,
  open,
  job,
  names,
  service,
  report,
  active,
  paused,
  repos,
  marked,
  now,
  actions,
  onDelete,
}: {
  host: HostClient;
  open: (route: string) => void;
  job: Job;
  /** Names for the jobs and projects a trigger refers to. */
  names: WordNames;
  service: ServiceStatus | undefined;
  report: RunsReport | null;
  active: readonly ActiveRun[];
  paused: boolean;
  /** The workspace's repo names; `null` while they are not known. */
  repos: ReadonlySet<string> | null;
  /** The row the route marks. */
  marked: boolean;
  now: number;
  actions: ReturnType<typeof useRowActions>;
  onDelete: (job: Job, running: boolean) => void;
}): React.JSX.Element {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (marked) row.current?.scrollIntoView({ block: "nearest" });
  }, [marked]);
  const openTab = useOpenServiceTab(host);
  const runs = report?.jobs.find((info) => info.job === job.id);
  const last = lastLook(job, { runs, active, service }, now);
  const next = nextLook(job, runs, paused, now);
  const trigger = jobTriggerWords(job, names, new Date(now));
  const git = job.kind === "git" ? gitDetail(job, repos) : null;
  const status = job.kind === "service" ? (service ?? fallbackService(job)) : null;
  return (
    <TableRow
      ref={row}
      columns={styles.cols}
      off={!job.enabled}
     
      aria-current={marked ? "true" : undefined}
      data-testid="job-row"
      data-job={job.id}
      data-kind={job.kind}
    >
      <KindCell icon={job.kind} label={KIND_LABEL[job.kind]} />
      <RowMain
        name={<span data-testid="job-name">{job.name}</span>}
        sub={
          <>
            {trigger}
            {git !== null && git.missing.length > 0 && <span className={styles.problem}> · {git.missing.length === 1 ? `${git.missing[0] ?? ""} is not in this workspace` : "repos not in this workspace"}</span>}
          </>
        }
        subTip={git === null ? capitalized(trigger) : `${capitalized(trigger)} · ${git.text}`}
        subTestId="job-trigger"
      />
      <RowCell
        sub={
          <span data-help={last.subHelp ?? undefined} className={last.subHelp === null ? undefined : styles.helped} data-testid="job-last-sub">
            {last.sub}
          </span>
        }
        {...(last.run === null ? {} : { onActivate: () => open(runRoute(job.id, last.run ?? "")), label: `Open ${job.name}'s latest run` })}
        testId="job-last"
      >
        <Status tone={last.tone} live={last.live} size="sm" help={last.help ?? undefined} testId="job-status">
          {last.words}
        </Status>
      </RowCell>
      <RowCell sub={next.sub ?? undefined} className={next.none ? styles.none : undefined} testId="job-next">
        {next.words}
      </RowCell>
      <RowActions>
        {status !== null ? (
          <IconButton icon="terminal" label="Open terminal" onClick={() => openTab(status)} />
        ) : (
          <IconButton icon="play" label="Run now" onClick={() => actions.runNow(job)} />
        )}
        <IconButton icon="edit" label="Edit" onClick={() => open(editRoute(job.id))} />
        <IconButton icon="trash" label="Delete" className={styles.delete} onClick={() => onDelete(job, status !== null && SERVICE_RUNS.includes(status.state))} />
      </RowActions>
      <Toggle on={job.enabled} onChange={(on) => actions.setEnabled(job, on)} label="Enabled" />
    </TableRow>
  );
}

/** The Jobs view: every job file grouped by project — workspace jobs first — each row with its kind,
 *  name and trigger in words, last result, next run, its actions (Run now or Open terminal · Edit ·
 *  Delete) and the Disable toggle; an invalid file a red row with its error and Open file. The "This
 *  project" chip keeps the jobs of the project Pomade has open. `marked` is the job the route opens:
 *  its row is marked and scrolled to. */
export function JobsView({
  host,
  jobs,
  services,
  report,
  marked,
  active,
  thisProject,
  onThisProject,
  open,
  newJob,
}: {
  host: HostClient;
  jobs: readonly JobEntry[];
  services: readonly ServiceStatus[];
  /** The runs report; `null` until the scheduler gives one. */
  report: RunsReport | null;
  marked: string | null;
  /** The project Pomade has open; `null` until it answers. */
  active: ProjectRef | null;
  thisProject: boolean;
  onThisProject: (on: boolean) => void;
  /** Navigates the tab to a route. */
  open: (route: string) => void;
  /** The New job button, as the tab's header has it. */
  newJob: (testId: string) => React.JSX.Element;
}): React.JSX.Element {
  const now = useNow();
  const projects = useProjectList(host);
  const repos = useRepos(host);
  const known = repos.status === "ready" ? new Set(repos.value.map((repo) => repo.name)) : null;
  const actions = useRowActions(host);
  const [deleting, setDeleting] = useState<{ job: Job; running: boolean } | null>(null);

  const activeId = active === null || active.id === WORKSPACE_PROJECT_ID ? null : active.id;
  const shown = thisProject ? jobs.filter((entry) => projectOf(entry) === activeId) : jobs;
  const groups = groupsOf(shown, projects);
  const invalid = shown.filter((entry) => !entry.valid).length;
  const paused = new Set((report?.needsYou ?? []).flatMap((item) => (item.kind === "loop-paused" ? [item.job] : [])));
  const jobNames = new Map(jobs.flatMap((entry) => (entry.valid ? [[entry.job.id, entry.job.name] as const] : [])));
  const names: WordNames = { job: (id) => jobNames.get(id) ?? id, project: (id) => projects.find((project) => project.id === id)?.name ?? id };
  const activeRuns = (id: string): ActiveRun[] => (report?.active ?? []).filter((run) => run.job === id);

  return (
    <section data-testid="jobs">
      <ViewFilters summary={`${shown.length} ${shown.length === 1 ? "job" : "jobs"}${invalid > 0 ? ` · ${invalid} invalid` : ""}`}>
        <Chip on={thisProject} count={active?.name ?? "…"} onClick={() => onThisProject(!thisProject)} data-testid="this-project">
          This project
        </Chip>
        <Help k="jobs.this" />
      </ViewFilters>
      <TableHead columns={styles.cols}>
        <span />
        <span>Job · trigger</span>
        <span>
          Last result <Help k="jobs.last" />
        </span>
        <span>
          Next run <Help k="jobs.next" />
        </span>
        <span />
        <span />
      </TableHead>
      {shown.length === 0 ? (
        <EmptyBlock title={`No jobs in ${active?.name ?? "this project"}`} testId="jobs-none" action={newJob("jobs-none-new-job")}>
          <p>This project has no jobs yet. Jobs of other projects are hidden by the “This project” filter.</p>
        </EmptyBlock>
      ) : (
        groups.map((group) => (
          <Fragment key={group.id ?? ""}>
            <GroupHead title={group.name} help={group.id === null ? "jobs.workspace" : undefined} path={`jobs/${subFolder(group.entries)}`} count={group.entries.length} testId="job-group" />
            {group.entries.map((entry) =>
              entry.valid ? (
                <JobRow
                  key={entryId(entry)}
                  host={host}
                  open={open}
                  job={entry.job}
                  names={names}
                  service={services.find((status) => status.job === entry.job.id)}
                  report={report}
                  active={activeRuns(entry.job.id)}
                  paused={paused.has(entry.job.id)}
                  repos={known}
                  marked={entry.job.id === marked}
                  now={now}
                  actions={actions}
                  onDelete={(job, running) => setDeleting({ job, running })}
                />
              ) : (
                <InvalidRow key={entryId(entry)} invalid={entry.invalid} onOpenFile={actions.openFile} marked={entry.invalid.id === marked} />
              ),
            )}
          </Fragment>
        ))
      )}
      {deleting !== null && (
        <DeleteJobDialog host={host} job={deleting.job} serviceRunning={deleting.running} onDeleted={() => setDeleting(null)} onCancel={() => setDeleting(null)} />
      )}
    </section>
  );
}
