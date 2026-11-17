import type { ReactNode } from "react";

import styles from "./EmptyState.module.css";

/** A centred message for a surface with nothing to list: the Runner mark, a title, a sentence or
 *  two, and optionally what to do next. */
export function EmptyState({
  testId,
  title,
  children,
  action,
  footer,
}: {
  testId: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}): React.JSX.Element {
  return (
    <main className={styles.root} data-testid={testId}>
      <div className={styles.message}>
        <span className={styles.mark} aria-hidden="true" />
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.text}>{children}</p>
        {action !== undefined && <div className={styles.action}>{action}</div>}
      </div>
      {footer !== undefined && <footer className={styles.footer}>{footer}</footer>}
    </main>
  );
}
