import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { DISMISS_METHOD, RESUME_METHOD, RUN_NOW_METHOD, RUN_STOP_METHOD, runRoute, SERVICE_ACTION_TIMEOUT_MS, SERVICE_METHODS } from "../integrations/runner-api";
import { sessionIdOf } from "../keeper/ids";
import { dayTime, type NeedsYouItem } from "../scheduler/model";
import { MissedActions } from "./MissedActions";
import styles from "./Runs.module.css";
import { useAction } from "./useAction";
import { Button, PanelEmpty } from "./kit";

/** An item's line under its name. */
function itemWords(item: NeedsYouItem): string {
  switch (item.kind) {
    case "run-failed":
      return `Failed: ${item.detail}${item.count > 1 ? ` · ${item.count}×` : ""}`;
    case "service-failed":
      return `Gave up: ${item.detail}`;
    case "missed":
      return `Missed ${dayTime(item.at)} — it waits for you to pick a time.`;
    case "long-run":
      return `Has been ${item.detail}`;
    case "loop-paused":
      return `Paused: ${item.detail}`;
  }
}

function Item({ host, item }: { host: HostClient; item: NeedsYouItem }): React.JSX.Element {
  const action = useAction();
  const call = (method: string, params: Record<string, string>, timeoutMs?: number) => () =>
    action.run(() => host.apps.call(APP_ID, method, params, timeoutMs === undefined ? {} : { timeoutMs }));
  const button = (label: string, onClick: () => void): React.JSX.Element => (
    <Button size="sm" onClick={onClick}>
      {label}
    </Button>
  );
  let actions: React.JSX.Element;
  switch (item.kind) {
    case "run-failed":
      actions = (
        <span className={styles.actions}>
          {button("Open", () => action.run(() => host.tabs.openApp({ route: runRoute(item.job, item.run) })))}
          {button("Run now", call(RUN_NOW_METHOD, { job: item.job }))}
          {button("Dismiss", call(DISMISS_METHOD, { id: item.id }))}
        </span>
      );
      break;
    case "service-failed":
      actions = <span className={styles.actions}>{button("Start", call(SERVICE_METHODS.start, { job: item.job }, SERVICE_ACTION_TIMEOUT_MS))}</span>;
      break;
    case "missed":
      actions = <MissedActions host={host} job={item.job} />;
      break;
    case "long-run": {
      const session = sessionIdOf({ kind: "run", job: item.job, run: item.run }) ?? "";
      actions = (
        <span className={styles.actions}>
          {button("Open", () => action.run(() => host.tabs.openAttached({ session: { app: APP_ID, session }, title: item.name })))}
          {button("Stop", call(RUN_STOP_METHOD, { job: item.job, run: item.run }))}
          {button("Dismiss", call(DISMISS_METHOD, { id: item.id }))}
        </span>
      );
      break;
    }
    case "loop-paused":
      actions = <span className={styles.actions}>{button("Resume", call(RESUME_METHOD, { job: item.job }))}</span>;
      break;
  }
  return (
    <li className={styles.row} data-testid="needs-you-item" data-kind={item.kind}>
      <span className={styles.line}>
        <span className={styles.name}>{item.name}</span>
        <span className={styles.meta}>{dayTime(item.at)}</span>
      </span>
      <span className={`${styles.meta} ${item.kind === "run-failed" || item.kind === "service-failed" || item.kind === "loop-paused" ? styles.failed : ""}`} data-testid="needs-you-words">
        {itemWords(item)}
      </span>
      {actions}
      {action.error !== null && (
        <p className={styles.error} role="alert">
          {action.error}
        </p>
      )}
    </li>
  );
}

/** Needs you's content: each item with its actions inline. A stand-in until the panel's real design. */
export function NeedsYouList({ host, items }: { host: HostClient; items: readonly NeedsYouItem[] }): React.JSX.Element {
  return (
    <div data-testid="needs-you">
      {items.length === 0 ? (
        <PanelEmpty>Nothing needs you.</PanelEmpty>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <Item key={item.id} host={host} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
