import type { HTMLAttributes, ReactNode, Ref } from "react";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { useSized } from "./ResizableTable";
import styles from "./Table.module.css";

const join = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(" ");

/** A view table's head row. `columns` is the view's class that sets `grid-template-columns`; inside
 *  a `ResizableTable` the table's tracks lay it out. */
export function TableHead({ columns, children }: { columns: string | undefined; children: ReactNode }): React.JSX.Element {
  const sized = useSized();
  return <div className={join(styles.cols, styles.head, sized && styles.sized, columns)}>{children}</div>;
}

/** A view table's row: 44 px, hover tint, a hairline between rows. `off` greys a disabled job's
 *  name; `invalid` is an invalid file's red row; `onClick` makes the whole row a click target; `ref`
 *  is the row's element. Inside a `ResizableTable` the table's tracks lay it out. */
export function TableRow({
  columns,
  off = false,
  invalid = false,
  className,
  children,
  ...rest
}: { columns: string | undefined; off?: boolean | undefined; invalid?: boolean | undefined; children: ReactNode; ref?: Ref<HTMLDivElement> | undefined } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const sized = useSized();
  return (
    <div className={join(styles.cols, styles.row, sized && styles.sized, off && styles.off, invalid && styles.invalid, rest.onClick !== undefined && styles.click, columns, className)} {...rest}>
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
export function RowMain({
  name,
  tags,
  sub,
  subTip,
  subTestId,
}: {
  name: ReactNode;
  tags?: ReactNode | undefined;
  sub?: ReactNode | undefined;
  subTip?: string | undefined;
  subTestId?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={styles.main}>
      <div className={styles.line}>
        <span className={styles.name}>{name}</span>
        {tags}
      </div>
      {sub !== undefined && (
        <div className={styles.sub} data-tip={subTip} data-testid={subTestId}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** A column cell with a faint second line: Last result, Next run, Status. With `onActivate` the whole
 *  cell is a button (a click, Enter or Space) — Last result opens the run's card. */
export function RowCell({
  children,
  sub,
  className,
  onActivate,
  label,
  testId,
}: {
  children: ReactNode;
  sub?: ReactNode | undefined;
  className?: string | undefined;
  onActivate?: (() => void) | undefined;
  /** The button's accessible name, with `onActivate`. */
  label?: string | undefined;
  testId?: string | undefined;
}): React.JSX.Element {
  const content = (
    <>
      {children}
      {sub !== undefined && <div className={styles.cellSub}>{sub}</div>}
    </>
  );
  if (onActivate === undefined) {
    return (
      <div className={join(styles.cell, className)} data-testid={testId}>
        {content}
      </div>
    );
  }
  return (
    <div
      className={join(styles.cell, styles.cellButton, className)}
      role="button"
      tabIndex={0}
      aria-label={label}
      data-testid={testId}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onActivate();
      }}
    >
      {content}
    </div>
  );
}

/** A row's actions at its end, right-aligned. */
export function RowActions({ children, className }: { children: ReactNode; className?: string | undefined }): React.JSX.Element {
  return <div className={join(styles.actions, className)}>{children}</div>;
}
