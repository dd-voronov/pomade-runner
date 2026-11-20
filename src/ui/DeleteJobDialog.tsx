import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { DELETE_JOB_METHOD, DELETE_JOB_TIMEOUT_MS } from "../integrations/runner-api";
import { isDeleteResult } from "../scheduler/model";
import styles from "./DeleteJobDialog.module.css";
import { ConfirmDialog, useToast } from "./kit";

/** The confirm before a job is deleted — a job's row in the Jobs view, the job form: it names the
 *  file, says a running service is stopped first, and calls `jobs.delete`. A refusal stays in the
 *  dialog in the scheduler's words; a deletion toasts the file and calls `onDeleted`, then the
 *  caller closes the dialog. `onCancel` closes it. */
export function DeleteJobDialog({
  host,
  job,
  serviceRunning,
  onDeleted,
  onCancel,
}: {
  host: HostClient;
  job: { id: string; name: string; path: string };
  /** Whether the job's service runs now: the confirm says Delete stops it first. */
  serviceRunning: boolean;
  onDeleted: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const confirm = (): void => {
    setState({ busy: true, error: null });
    host.apps.call(APP_ID, DELETE_JOB_METHOD, { job: job.id }, { timeoutMs: DELETE_JOB_TIMEOUT_MS }).then(
      (result) => {
        if (!isDeleteResult(result)) return setState({ busy: false, error: "the scheduler answered something that is not a delete result" });
        if (!result.ok) return setState({ busy: false, error: result.reason });
        toast(
          <>
            Deleted <span className={styles.mono}>{result.path}</span>
            {result.stopped ? " · stopped first" : ""}
          </>,
        );
        onDeleted();
      },
      (err: unknown) => setState({ busy: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <ConfirmDialog
      title={`Delete “${job.name || "this job"}”?`}
      confirm="Delete job"
      danger
      busy={state.busy ? "Deleting…" : undefined}
      error={state.error ?? undefined}
      onConfirm={confirm}
      onCancel={onCancel}
      testId="delete-confirm"
    >
      <p>Runner removes the job's file:</p>
      <p className={styles.path} data-testid="delete-path">
        {job.path}
      </p>
      <p>{serviceRunning ? "The service is running: Runner stops it first, then removes the file. This can't be undone." : "This can't be undone."}</p>
    </ConfirmDialog>
  );
}
