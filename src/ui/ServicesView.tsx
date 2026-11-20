import type { HostClient } from "pomade-kit/sdk";

import type { JobEntry, ServiceJob } from "../jobs/model";
import type { ServiceStatus } from "../keeper/model";
import { EmptyBlock, KindCell, RowCell, RowMain, TableHead, TableRow } from "./kit";
import { serviceWords } from "./serviceWords";
import styles from "./ServicesView.module.css";
import { ViewFilters } from "./shell/TabShell";
import { useProjectNames } from "./useRunnerApi";

/** The Services view: every service with its project, folder and command, and where it stands.
 *  A placeholder on the shell's table until the view's own slice. */
export function ServicesView({ host, jobs, services }: { host: HostClient; jobs: readonly JobEntry[]; services: readonly ServiceStatus[] }): React.JSX.Element {
  const projectName = useProjectNames(host);
  const list = jobs.flatMap((entry): ServiceJob[] => (entry.valid && entry.job.kind === "service" ? [entry.job] : []));
  if (list.length === 0) {
    return (
      <EmptyBlock title="Nothing here yet" testId="services-empty">
        <p>A service is a command Runner keeps running: it starts at login, restarts on a crash and outlives Pomade.</p>
      </EmptyBlock>
    );
  }
  return (
    <section data-testid="services">
      <ViewFilters summary="Services keep running when Pomade quits · the switch never pauses them" />
      <TableHead columns={styles.cols}>
        <span />
        <span>Service · project · folder · command</span>
        <span>Status</span>
        <span />
      </TableHead>
      {list.map((job) => {
        const status = services.find((candidate) => candidate.job === job.id);
        return (
          <TableRow key={job.id} columns={styles.cols} className={styles.row} data-testid="service-row" data-job={job.id}>
            <KindCell icon="service" label="Service" />
            <RowMain
              name={job.name}
              sub={
                <>
                  {projectName(job.project)} · <span className={styles.mono}>{job.folder === "" ? "." : job.folder}</span> · <span className={styles.mono}>{job.command}</span>
                </>
              }
            />
            <RowCell>{status === undefined ? "—" : serviceWords(status)}</RowCell>
            <span />
          </TableRow>
        );
      })}
    </section>
  );
}
