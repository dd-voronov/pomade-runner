import { useEffect, useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { RUN_NOW_METHOD, SET_ENABLED_METHOD } from "../integrations/runner-api";
import { describeJobError } from "../jobs/format";
import { entryId, entryPath, type Job, type JobEntry, type JobKind } from "../jobs/model";
import type { ServiceStatus } from "../keeper/model";
import { runWords, type JobRuns } from "../scheduler/model";
import styles from "./JobsList.module.css";
import { dayTime } from "./runWords";
import { serviceWords } from "./serviceWords";
import { useAction } from "./useAction";

const KIND_LABEL: Record<JobKind, string> = { service: "Service", script: "Script", agent: "Agent", git: "Git" };

/** A run job's trigger in words. */
function triggerWords(job: Exclude<Job, { kind: "service" }>): string {
  switch (job.trigger.kind) {
    case "schedule":
      return job.trigger.words;
    case "hook":
      return `on ${job.trigger.hook.event}`;
    case "chain":
      return `after ${job.trigger.chain.job}`;
  }
}

/** A run job's next and last run in words. */
function runsWords(job: Exclude<Job, { kind: "service" }>, runs: JobRuns | undefined): string {
  const next = !job.enabled ? "disabled" : runs?.finished === true ? "finished" : runs?.next != null ? `next ${dayTime(runs.next)}` : null;
  const last = runs?.last == null ? "never ran" : `last ${runWords(runs.last)}`;
  return [triggerWords(job), next, last].filter((part) => part !== null).join(" · ");
}

function Row({
  host,
  entry,
  service,
  runs,
  projectName,
  onOpen,
}: {
  host: HostClient;
  entry: JobEntry;
  service: ServiceStatus | undefined;
  runs: JobRuns | undefined;
  projectName: (id: string | null) => string;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  const action = useAction();
  if (entry.valid) {
    const { job } = entry;
    const call = (method: string, params: Record<string, string | boolean>) => () => action.run(() => host.apps.call(APP_ID, method, params));
    return (
      <li className={styles.row} data-testid="job-row">
        <span className={styles.name}>{job.name}</span>
        <span className={styles.meta}>
          {KIND_LABEL[job.kind]} · {projectName(job.project)}
        </span>
        {service !== undefined && (
          <span className={`${styles.meta} ${service.state === "failed" ? styles.failed : ""}`} data-testid="service-state">
            {serviceWords(service)}
          </span>
        )}
        {job.kind !== "service" && (
          <span className={`${styles.meta} ${runs?.last?.state === "failed" ? styles.failed : ""}`} data-testid="job-runs">
            {runsWords(job, runs)}
          </span>
        )}
        <span className={styles.actions}>
          {job.kind === "script" && (
            <button type="button" className={styles.button} onClick={call(RUN_NOW_METHOD, { job: job.id })}>
              Run now
            </button>
          )}
          <button type="button" className={styles.button} onClick={call(SET_ENABLED_METHOD, { job: job.id, enabled: !job.enabled })}>
            {job.enabled ? "Disable" : "Enable"}
          </button>
          <button type="button" className={styles.button} onClick={() => onOpen(job.path)}>
            Open file
          </button>
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
    <li className={`${styles.row} ${styles.invalid}`} data-testid="job-invalid">
      <span className={styles.name}>{invalid.name ?? invalid.path.slice(invalid.path.lastIndexOf("/") + 1)}</span>
      <span className={styles.error}>
        Invalid: {first === undefined ? "the file has an error." : `line ${first.line}: ${describeJobError(first)}`}
        {invalid.errors.length > 1 && ` · ${invalid.errors.length - 1} more`}
        {" · "}
        <button type="button" className={styles.link} onClick={() => onOpen(invalid.path)}>
          Open file
        </button>
      </span>
    </li>
  );
}

/** Every job file, valid ones by name, kind and project — a service with where it stands, a run job
 *  with its trigger, next and last run — with Run now, Enable / Disable and Open file; invalid ones
 *  with their first error. */
export function JobsList({ host, jobs, services, runs }: { host: HostClient; jobs: readonly JobEntry[]; services: readonly ServiceStatus[]; runs: readonly JobRuns[] }): React.JSX.Element {
  const [projects, setProjects] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    host.project.list().then(
      ({ projects: list }) => {
        if (live) setProjects(new Map(list.map((p) => [p.id, p.name])));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host]);

  const projectName = (id: string | null): string => (id === null ? "Workspace" : (projects.get(id) ?? id));
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
