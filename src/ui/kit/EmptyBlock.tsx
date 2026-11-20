import type { ReactNode } from "react";

import styles from "./EmptyBlock.module.css";

/** A view with nothing to show: a card with the title, a paragraph or two (`<p>`s in `children`)
 *  and what to do next. */
export function EmptyBlock({ title, children, action, testId }: { title: string; children: ReactNode; action?: ReactNode | undefined; testId?: string | undefined }): React.JSX.Element {
  return (
    <div className={styles.root} data-testid={testId}>
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.text}>{children}</div>
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}
