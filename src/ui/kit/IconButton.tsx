import type { ButtonHTMLAttributes } from "react";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import styles from "./IconButton.module.css";

/** A 24 px square button with one icon; `label` is its accessible name and its tooltip. */
export function IconButton({
  icon,
  label,
  iconSize = 16,
  className,
  ...rest
}: { icon: IconName; label: string; iconSize?: number | undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label">): React.JSX.Element {
  return (
    <button type="button" className={className === undefined ? styles.root : `${styles.root} ${className}`} aria-label={label} data-tip={label} {...rest}>
      <Icon name={icon} size={iconSize} />
    </button>
  );
}
