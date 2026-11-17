import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { DISMISS_METHOD, RUN_NOW_METHOD, runRoute, SERVICE_ACTION_TIMEOUT_MS, SERVICE_METHODS } from "../integrations/runner-api";
import type { NeedsYouItem } from "../scheduler/model";
import styles from "./Runs.module.css";
import { dayTime } from "./runWords";
import { useAction } from "./useAction";

/** Needs you: each item with its actions inline. A stand-in until the panel's real design. */
export function NeedsYouList({ host, items }: { host: HostClient; items: readonly NeedsYouItem[] }): React.JSX.Element {
  const action = useAction();
  const call = (method: string, params: Record<string, string>, timeoutMs?: number) => () =>
    action.run(() => host.apps.call(APP_ID, method, params, timeoutMs === undefined ? {} : { timeoutMs }));

  return (
    <section className={styles.section} data-testid="needs-you">
      <h2 className={styles.heading}>Needs you</h2>
      {items.length === 0 ? (
        <p className={styles.empty}>Nothing needs you.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.row} data-testid="needs-you-item" data-kind={item.kind}>
              <span className={styles.line}>
                <span className={styles.name}>{item.name}</span>
                <span className={styles.meta}>{dayTime(item.at)}</span>
              </span>
              <span className={`${styles.meta} ${styles.failed}`}>
                {item.kind === "run-failed" ? `Failed: ${item.detail}${item.count > 1 ? ` · ${item.count}×` : ""}` : `Gave up: ${item.detail}`}
              </span>
              <span className={styles.actions}>
                {item.kind === "run-failed" ? (
                  <>
                    <button type="button" className={styles.button} onClick={() => action.run(() => host.tabs.openApp({ route: runRoute(item.job, item.run) }))}>
                      Open
                    </button>
                    <button type="button" className={styles.button} onClick={call(RUN_NOW_METHOD, { job: item.job })}>
                      Run now
                    </button>
                    <button type="button" className={styles.button} onClick={call(DISMISS_METHOD, { id: item.id })}>
                      Dismiss
                    </button>
                  </>
                ) : (
                  <button type="button" className={styles.button} onClick={call(SERVICE_METHODS.start, { job: item.job }, SERVICE_ACTION_TIMEOUT_MS)}>
                    Start
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {action.error !== null && (
        <p className={styles.error} role="alert">
          {action.error}
        </p>
      )}
    </section>
  );
}
