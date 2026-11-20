import type { ReactNode } from "react";

import type { HelpKey } from "../help";
import styles from "./PanelRow.module.css";
import { Dot, type DotTone } from "./Status";

/** A row of the panel's Running now — a service or a run: the status dot, the name and, at its end,
 *  where it stands ("up 3d 4h", "starting", "queued · 1 ahead") with that status's help; then its
 *  project · folder; then a third line only for news ("waiting for port 5173", "restarted 3× · last
 *  crash 14:02"). The whole row is one button: it opens the session's tab or the run's card. */
export function PanelRow({
  name,
  tone,
  live = false,
  status,
  statusHelp,
  statusTone,
  place,
  news,
  newsHelp,
  onClick,
  testId,
  state,
}: {
  name: string;
  tone: DotTone;
  live?: boolean | undefined;
  status: ReactNode;
  statusHelp?: HelpKey | null | undefined;
  /** `warning` colours the status words (a run waiting for you). */
  statusTone?: "warning" | undefined;
  /** "Alpha · Projects/alpha". */
  place: ReactNode;
  news?: ReactNode | undefined;
  newsHelp?: HelpKey | null | undefined;
  onClick: () => void;
  testId?: string | undefined;
  /** Its state, for the tests (`data-state`). */
  state?: string | undefined;
}): React.JSX.Element {
  return (
    <button type="button" className={styles.row} onClick={onClick} data-testid={testId} data-state={state}>
      <span className={styles.line}>
        <Dot tone={tone} live={live} />
        <span className={styles.name}>{name}</span>
        <span className={statusTone === "warning" ? `${styles.status} ${styles.warning}` : styles.status} data-help={statusHelp ?? undefined}>
          {status}
        </span>
      </span>
      <span className={`${styles.line} ${styles.place}`}>
        <span className={styles.trunc}>{place}</span>
      </span>
      {news !== undefined && news !== null && (
        <span className={styles.news}>
          <span className={styles.trunc} data-help={newsHelp ?? undefined}>
            {news}
          </span>
        </span>
      )}
    </button>
  );
}
