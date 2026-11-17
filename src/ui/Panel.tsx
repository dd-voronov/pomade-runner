import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { EmptyState } from "./EmptyState";
import styles from "./Panel.module.css";

/** The side panel: what runs now and what needs the user, with the way into the Runner tab. */
export function Panel({ host }: { host: HostClient }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  const openRunner = (): void => {
    setError(null);
    host.tabs.openApp().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <EmptyState
      testId="panel-empty"
      title="No jobs yet"
      action={
        <>
          <button type="button" className={styles.open} data-testid="open-runner" onClick={openRunner}>
            Open Runner
          </button>
          {error !== null && (
            <p className={styles.error} role="alert" data-testid="open-runner-error">
              Could not open Runner: {error}
            </p>
          )}
        </>
      }
    >
      Services and runs show here once Runner has jobs.
    </EmptyState>
  );
}
