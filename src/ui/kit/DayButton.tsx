import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./DayButton.module.css";

/** A day a schedule runs on, pressed or not: a weekday in the week row ("Mon"), a day of the month
 *  in the month grid ("15"), or a `wide` one spanning four cells ("Last day"); `compact` is the
 *  month grid's 32 px cell. */
export function DayButton({
  on,
  compact = false,
  wide = false,
  children,
  className,
  ...rest
}: { on: boolean; compact?: boolean | undefined; wide?: boolean | undefined; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed">): React.JSX.Element {
  const names = [styles.root, compact && styles.compact, wide && styles.wide, className].filter(Boolean).join(" ");
  return (
    <button type="button" className={names} aria-pressed={on} {...rest}>
      {children}
    </button>
  );
}
