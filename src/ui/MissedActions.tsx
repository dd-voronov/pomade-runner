import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { MISSED_METHOD } from "../integrations/runner-api";
import styles from "./Runs.module.css";
import { useAction } from "./useAction";
import { Button, TextInput } from "./kit";

/** A missed run's choices: Run now · Run at… (a time or a phrase: `23:00`, `tomorrow 9:00`) · Skip.
 *  A stand-in until the real card. */
export function MissedActions({ host, job }: { host: HostClient; job: string }): React.JSX.Element {
  const action = useAction();
  const [at, setAt] = useState<string | null>(null);
  const choose = (params: Record<string, string>) => () => action.run(() => host.apps.call(APP_ID, MISSED_METHOD, { job, ...params }));
  return (
    <>
      <span className={styles.actions}>
        <Button size="sm" onClick={choose({ choice: "run-now" })}>
          Run now
        </Button>
        <Button size="sm" aria-expanded={at !== null} onClick={() => setAt(at === null ? "" : null)}>
          Run at…
        </Button>
        <Button size="sm" onClick={choose({ choice: "skip" })}>
          Skip
        </Button>
      </span>
      {at !== null && (
        <form
          className={styles.actions}
          onSubmit={(event) => {
            event.preventDefault();
            choose({ choice: "run-at", at })();
          }}
        >
          <TextInput width="compact" aria-label="Run at" placeholder="23:00 · tomorrow 9:00 · +2h" value={at} onChange={(event) => setAt(event.target.value)} />
          <Button type="submit" size="sm">
            Set
          </Button>
        </form>
      )}
      {action.error !== null && (
        <p className={styles.error} role="alert">
          {action.error}
        </p>
      )}
    </>
  );
}
