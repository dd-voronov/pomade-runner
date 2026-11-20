import { useId, useState, type ReactNode } from "react";

import type { HelpKey } from "../help";
import { Help } from "./Help";
import { Icon } from "./Icon";
import styles from "./Section.module.css";

/** A panel section's head: the chevron, the small-caps title and, at its end, the count — a red
 *  badge when `urgent`. A button that opens and closes the section. */
export function SectionHead({
  title,
  count,
  urgent = false,
  open,
  onToggle,
  controls,
  testId,
}: {
  title: string;
  count?: number | undefined;
  urgent?: boolean | undefined;
  open: boolean;
  onToggle: () => void;
  /** The id of the content it opens and closes. */
  controls?: string | undefined;
  testId?: string | undefined;
}): React.JSX.Element {
  return (
    <button type="button" className={styles.head} aria-expanded={open} aria-controls={controls} onClick={onToggle} data-testid={testId}>
      <span className={styles.chevron}>
        <Icon name="chevron" size={10} />
      </span>
      <span className={styles.title}>{title}</span>
      {count !== undefined && (
        <span className={urgent ? `${styles.count} ${styles.urgent}` : styles.count} data-testid={testId === undefined ? undefined : `${testId}-count`}>
          {count}
        </span>
      )}
    </button>
  );
}

/** A collapsible section of the side panel (Needs you · Running now · Next up): its head and, while
 *  open, its content. Open at first. */
export function PanelSection({ title, count, urgent, children, testId }: { title: string; count?: number | undefined; urgent?: boolean | undefined; children: ReactNode; testId?: string | undefined }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <section className={styles.section} aria-label={title} data-testid={testId}>
      <SectionHead
        title={title}
        open={open}
        onToggle={() => setOpen(!open)}
        controls={id}
        count={count}
        urgent={urgent}
        testId={testId === undefined ? undefined : `${testId}-head`}
      />
      <div id={id} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** The faint line of a panel section with nothing in it ("Nothing is running."). */
export function PanelEmpty({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className={styles.empty}>{children}</div>;
}

/** A view's group head: a project's jobs, a History day — the title (help beside it), a faint path
 *  and a count at its end. */
export function GroupHead({ title, help, path, count }: { title: string; help?: HelpKey | undefined; path?: string | undefined; count?: number | undefined }): React.JSX.Element {
  return (
    <div className={styles.group}>
      <span className={styles.title}>{title}</span>
      {help !== undefined && <Help k={help} />}
      {path !== undefined && <span className={styles.path}>{path}</span>}
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </div>
  );
}
