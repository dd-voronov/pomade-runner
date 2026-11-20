import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import styles from "./Button.module.css";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
/** `md` 28 px · `row` 24 px (a row's actions) · `sm` 22 px (a panel card's actions). */
export type ButtonSize = "md" | "row" | "sm";

const join = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(" ");

/** The text button: `default` (bordered), `primary` (accent fill), `danger` (red text), `ghost`
 *  (borderless); an optional leading icon at 14 px; `wide` fills its container. */
export function Button({
  variant = "default",
  size = "md",
  icon,
  wide = false,
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  icon?: IconName | undefined;
  wide?: boolean | undefined;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement> | undefined;
} & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      className={join(styles.root, variant !== "default" && styles[variant], size !== "md" && styles[size], wide && styles.wide, className)}
      {...rest}
    >
      {icon !== undefined && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}

/** A button that reads as a link, inline in text. */
export function LinkButton({ className, children, ...rest }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button type="button" className={join(styles.link, className)} {...rest}>
      {children}
    </button>
  );
}
