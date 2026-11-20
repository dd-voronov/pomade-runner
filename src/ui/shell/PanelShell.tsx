import type { ReactNode } from "react";

import styles from "./PanelShell.module.css";

/** The Runner side panel's frame, below Pomade's own header: `top` pinned (the switch), the
 *  sections in the scroll region, `foot` pinned at the bottom (Open Runner). */
export function PanelShell({ top, foot, children, testId }: { top?: ReactNode | undefined; foot: ReactNode; children?: ReactNode; testId: string }): React.JSX.Element {
  return (
    <main className={styles.root} data-testid={testId}>
      {top !== undefined && <div className={styles.top}>{top}</div>}
      <div className={styles.body}>{children}</div>
      <div className={styles.foot}>{foot}</div>
    </main>
  );
}
