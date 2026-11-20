import type { ReactNode } from "react";

import type { HelpKey } from "../help";
import { Help } from "./Help";
import styles from "./PanelCard.module.css";
import { Dot, type DotTone } from "./Status";

/** A card in the side panel — a Needs-you item, the no-jobs explanation: the head (a dot, the
 *  title, its help, `when` at the end), a line or two of text, then the actions. */
export function PanelCard({
  title,
  dot,
  help,
  when,
  children,
  actions,
  testId,
}: {
  title: ReactNode;
  dot?: DotTone | undefined;
  help?: HelpKey | undefined;
  when?: ReactNode | undefined;
  children?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  testId?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={dot === undefined ? styles.card : `${styles.card} ${styles.dotted}`} data-testid={testId}>
      <div className={styles.top}>
        {dot !== undefined && <Dot tone={dot} />}
        <h2 className={styles.name}>{title}</h2>
        {help !== undefined && <Help k={help} className={styles.help} />}
        {when !== undefined && <span className={styles.when}>{when}</span>}
      </div>
      {children !== undefined && <div className={styles.text}>{children}</div>}
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
