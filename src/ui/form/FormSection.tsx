import type { ReactNode } from "react";

import styles from "./JobForm.module.css";

/** One of the form's sections: its heading (and a faint line under it) beside its fields. */
export function FormSection({ title, sub, children, testId }: { title: string; sub?: string | undefined; children: ReactNode; testId?: string | undefined }): React.JSX.Element {
  return (
    <section className={styles.section} aria-label={title} data-testid={testId}>
      <h4 className={styles.sectionTitle}>
        {title}
        {sub !== undefined && <small>{sub}</small>}
      </h4>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}
