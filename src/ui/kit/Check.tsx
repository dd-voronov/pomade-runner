import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./Check.module.css";
import { Icon } from "./Icon";

/** A checkbox as a chip: a box with a check, then its label — one of a set of picks ("the first
 *  Monday", a repository). */
export function Check({ on, children, className, ...rest }: { on: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "aria-checked">): React.JSX.Element {
  return (
    <button type="button" role="checkbox" aria-checked={on} className={className === undefined ? styles.root : `${styles.root} ${className}`} {...rest}>
      <i className={styles.box}>
        <Icon name="check" size={10} />
      </i>
      {children}
    </button>
  );
}

/** Checks in a wrapping row. */
export function Checks({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className={styles.checks}>{children}</div>;
}
