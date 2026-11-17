import { APP_NAME, APP_VERSION } from "../app";
import { EmptyState } from "./EmptyState";

/** The Runner tab: every job, its history and the services. */
export function RunnerTab(): React.JSX.Element {
  return (
    <EmptyState
      testId="tab-empty"
      title="No jobs yet"
      footer={
        <span data-testid="version">
          {APP_NAME} {APP_VERSION}
        </span>
      }
    >
      Runner keeps services up and runs scripts, git operations and agents on schedules and hooks — with Pomade open or
      closed. Its jobs show here.
    </EmptyState>
  );
}
