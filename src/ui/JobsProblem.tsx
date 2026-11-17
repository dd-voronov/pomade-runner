import type { ReactNode } from "react";

import { EmptyState } from "./EmptyState";
import type { JobsState } from "./useJobs";

/** Why there are no jobs to show: the scheduler does not answer, or answered with an error. */
export function JobsProblem({
  state,
  testId,
  action,
  footer,
}: {
  state: Extract<JobsState, { status: "no-scheduler" | "failed" }>;
  testId: string;
  action?: ReactNode;
  footer?: ReactNode;
}): React.JSX.Element {
  return state.status === "no-scheduler" ? (
    <EmptyState testId={testId} title="Runner's scheduler is not running" action={action} footer={footer}>
      The scheduler is Runner's background part: it reads the job files and runs them. It starts at login and after
      ./install; until then, no job runs.
    </EmptyState>
  ) : (
    <EmptyState testId={testId} title="Could not read the jobs" action={action} footer={footer}>
      {state.message}
    </EmptyState>
  );
}
