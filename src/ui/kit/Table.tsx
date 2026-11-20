import type { HTMLAttributes, ReactNode } from "react";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import styles from "./Table.module.css";

const join = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(" ");

/** A view table's head row. `columns` is the view's class that sets `grid-template-columns`. */
export function TableHead({ columns, children }: { columns: string | undefined; children: ReactNode }): React.JSX.Element {
  return <div className={join(styles.cols, styles.head, columns)}>{children}</div>;
}

/** A view table's row: 44 px, hover tint, a hairline between rows. `off` greys a disabled job's
 *  name; `invalid` is an invalid file's red row; `onClick` makes the whole row a click target. */
export function TableRow({
  columns,
  off = false,
  invalid = false,
  className,
  children,
  ...rest
}: { columns: string | undefined; off?: boolean | undefined; invalid?: boolean | undefined; children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={join(styles.cols, styles.row, off && styles.off, invalid && styles.invalid, rest.onClick !== undefined && styles.click, columns, className)} {...rest}>
      {children}
    </div>
  );
}

/** A row's kind icon, with the kind as its tooltip. */
export function KindCell({ icon, label }: { icon: IconName; label: string }): React.JSX.Element {
  return (
    <span className={styles.kind} data-tip={label}>
      <Icon name={icon} />
    </span>
  );
}

/** A row's main cell: the name (tags beside it) over a muted line (trigger, project · folder · command). */
export function RowMain({ name, tags, sub, subTip }: { name: ReactNode; tags?: ReactNode | undefined; sub?: ReactNode | undefined; subTip?: string | undefined }): React.JSX.Element {
  return (
    <div className={styles.main}>
      <div className={styles.line}>
        <span className={styles.name}>{name}</span>
        {tags}
      </div>
      {sub !== undefined && (
        <div className={styles.sub} data-tip={subTip}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** A column cell with a faint second line: Last result, Next run, Status. */
export function RowCell({ children, sub, className }: { children: ReactNode; sub?: ReactNode | undefined; className?: string | undefined }): React.JSX.Element {
  return (
    <div className={join(styles.cell, className)}>
      {children}
      {sub !== undefined && <div className={styles.cellSub}>{sub}</div>}
    </div>
  );
}

/** A row's actions at its end, right-aligned. */
export function RowActions({ children, className }: { children: ReactNode; className?: string | undefined }): React.JSX.Element {
  return <div className={join(styles.actions, className)}>{children}</div>;
}
