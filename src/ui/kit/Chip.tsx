import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./Chip.module.css";
import { Icon } from "./Icon";

/** A filter chip — a toggle in a view's filter row ("This project", History's All · Active · Failed…).
 *  `on` presses it and shows the check; `count` follows the label, faint. */
export function Chip({
  on,
  count,
  children,
  className,
  ...rest
}: { on: boolean; count?: ReactNode | undefined; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed">): React.JSX.Element {
  return (
    <button type="button" className={className === undefined ? styles.root : `${styles.root} ${className}`} aria-pressed={on} {...rest}>
      {on && <Icon name="check" size={12} />}
      {children}
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </button>
  );
}
