import { useEffect, useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { describeJobError } from "../jobs/format";
import { entryId, entryPath, type JobEntry, type JobKind } from "../jobs/model";
import styles from "./JobsList.module.css";

const KIND_LABEL: Record<JobKind, string> = { service: "Service", script: "Script", agent: "Agent", git: "Git" };

function Row({ entry, projectName, onOpen }: { entry: JobEntry; projectName: (id: string | null) => string; onOpen: (path: string) => void }): React.JSX.Element {
  if (entry.valid) {
    const { job } = entry;
    return (
      <li className={styles.row} data-testid="job-row">
        <span className={styles.name}>{job.name}</span>
        <span className={styles.meta}>
          {KIND_LABEL[job.kind]} · {projectName(job.project)}
        </span>
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

/** Every job file, valid ones by name, kind and project, invalid ones with their first error. */
export function JobsList({ host, jobs }: { host: HostClient; jobs: readonly JobEntry[] }): React.JSX.Element {
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
          <Row key={entryId(entry)} entry={entry} projectName={projectName} onOpen={open} />
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
