import { useEffect, useRef, useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { RUN_NOW_METHOD, SET_ENABLED_METHOD } from "../integrations/runner-api";
import { describeJobError } from "../jobs/format";
import { entryId, entryPath, type Job, type JobEntry, type JobKind } from "../jobs/model";
import { GIT_OPERATION_WORDS, jobTriggerWords } from "../jobs/words";
import type { ServiceStatus } from "../keeper/model";
import { dayTime, runWords, type JobRuns } from "../scheduler/model";
import styles from "./JobsList.module.css";
import { serviceWords } from "./serviceWords";
import { useAction } from "./useAction";
import { useProjectNames, useRepos } from "./useRunnerApi";
import { Button, LinkButton } from "./kit";

const KIND_LABEL: Record<JobKind, string> = { service: "Service", script: "Script", agent: "Agent", git: "Git" };

/** A run job's next and last run in words. */
function runsWords(job: Exclude<Job, { kind: "service" }>, runs: JobRuns | undefined): string {
  const next = !job.enabled ? "disabled" : runs?.finished === true ? "finished" : runs?.next != null ? `next ${dayTime(runs.next)}` : null;
  const last = runs?.last == null ? "never ran" : `last ${runWords(runs.last)}`;
  return [jobTriggerWords(job), next, last].filter((part) => part !== null).join(" · ");
}

/** A git job's operation and repos: "Commit & push · Knowledge, coda-helper"; a repo the workspace
 *  does not have is said, once the workspace's repos are known (`known`). */
function gitWords(job: Extract<Job, { kind: "git" }>, known: ReadonlySet<string> | null): string {
  const repos = job.git.repos.map((repo) => (known === null || known.has(repo) || repo.startsWith("/") ? repo : `${repo} (not in this workspace)`));
  return `${GIT_OPERATION_WORDS[job.git.operation]} · ${repos.join(", ")}`;
}

function Row({
  host,
  entry,
  service,
  runs,
  repos,
  selected,
  projectName,
  onOpen,
}: {
  host: HostClient;
  entry: JobEntry;
  service: ServiceStatus | undefined;
  runs: JobRuns | undefined;
  /** The workspace's repo names; `null` while they are not known. */
  repos: ReadonlySet<string> | null;
  /** The row the route opens. */
  selected: boolean;
  projectName: (id: string | null) => string;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  const action = useAction();
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  if (entry.valid) {
    const { job } = entry;
    const call = (method: string, params: Record<string, string | boolean>) => () => action.run(() => host.apps.call(APP_ID, method, params));
    return (
      <li ref={row} className={`${styles.row} ${selected ? styles.selected : ""}`} data-testid="job-row" data-job={job.id} aria-current={selected ? "true" : undefined}>
        <span className={styles.name}>{job.name}</span>
        <span className={styles.meta}>
          {KIND_LABEL[job.kind]} · {projectName(job.project)}
        </span>
        {service !== undefined && (
          <span className={`${styles.meta} ${service.state === "failed" ? styles.failed : ""}`} data-testid="service-state">
            {serviceWords(service)}
          </span>
        )}
        {job.kind === "service" && job.after !== null && (
          <span className={styles.meta} data-testid="service-chain">
            {jobTriggerWords(job)}
          </span>
        )}
        {job.kind === "git" && (
          <span className={styles.meta} data-testid="job-git">
            {gitWords(job, repos)}
          </span>
        )}
        {job.kind !== "service" && (
          <span className={`${styles.meta} ${runs?.last?.state === "failed" ? styles.failed : ""}`} data-testid="job-runs">
            {runsWords(job, runs)}
          </span>
        )}
        <span className={styles.actions}>
          {(job.kind === "script" || job.kind === "git") && (
            <Button size="sm" onClick={call(RUN_NOW_METHOD, { job: job.id })}>
              Run now
            </Button>
          )}
          <Button size="sm" onClick={call(SET_ENABLED_METHOD, { job: job.id, enabled: !job.enabled })}>
            {job.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" onClick={() => onOpen(job.path)}>
            Open file
          </Button>
        </span>
        {action.error !== null && (
          <span className={styles.failure} role="alert">
            {action.error}
          </span>
        )}
      </li>
    );
  }
  const { invalid } = entry;
  const [first] = invalid.errors;
  return (
    <li ref={row} className={`${styles.row} ${styles.invalid} ${selected ? styles.selected : ""}`} data-testid="job-invalid" aria-current={selected ? "true" : undefined}>
      <span className={styles.name}>{invalid.name ?? invalid.path.slice(invalid.path.lastIndexOf("/") + 1)}</span>
      <span className={styles.error}>
        Invalid: {first === undefined ? "the file has an error." : `line ${first.line}: ${describeJobError(first)}`}
        {invalid.errors.length > 1 && ` · ${invalid.errors.length - 1} more`}
        {" · "}
        <LinkButton onClick={() => onOpen(invalid.path)}>Open file</LinkButton>
      </span>
    </li>
  );
}

/** Every job file, valid ones by name, kind and project — a service with where it stands, a run job
 *  with its trigger, next and last run, a git job with its operation and repos — with Run now,
 *  Enable / Disable and Open file; invalid ones with their first error. `selected` is the job the
 *  route opens: its row is marked and scrolled to. */
export function JobsList({
  host,
  jobs,
  services,
  runs,
  selected = null,
}: {
  host: HostClient;
  jobs: readonly JobEntry[];
  services: readonly ServiceStatus[];
  runs: readonly JobRuns[];
  selected?: string | null;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const repos = useRepos(host);
  const known = repos.status === "ready" ? new Set(repos.value.map((repo) => repo.name)) : null;
  const projectName = useProjectNames(host);
  const open = (path: string): void => {
    setError(null);
    host.tabs.openFile({ path }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const project = (entry: JobEntry): string | null => (entry.valid ? entry.job.project : entry.invalid.project);
  // Workspace jobs first, then each project's, each group by path.
  const ordered = [...jobs].sort((a, b) => Number(project(a) !== null) - Number(project(b) !== null) || entryPath(a).localeCompare(entryPath(b)));

  return (
    <section className={styles.root} data-testid="jobs">
      <ul className={styles.list}>
        {ordered.map((entry) => (
          <Row
            key={entryId(entry)}
            host={host}
            entry={entry}
            service={services.find((status) => status.job === entryId(entry))}
            runs={runs.find((info) => info.job === entryId(entry))}
            repos={known}
            selected={entryId(entry) === selected}
            projectName={projectName}
            onOpen={open}
          />
        ))}
      </ul>
      {error !== null && (
        <p className={styles.failure} role="alert">
          Could not open the file: {error}
        </p>
      )}
    </section>
  );
}
