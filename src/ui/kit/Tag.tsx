import type { HTMLAttributes, ReactNode } from "react";

import type { HelpKey } from "../help";
import styles from "./Tag.module.css";

export type TagTone = "accent" | "warn" | "muted";
export type PillTone = "ok" | "danger" | "warning" | "muted" | "accent";

/** A small label beside a name: "Full autonomy" (warn), a count or a kind (accent, muted). `help`
 *  shows that help text on hover and focus. */
export function Tag({ tone = "accent", help, className, children, ...rest }: { tone?: TagTone | undefined; help?: HelpKey | undefined; children: ReactNode } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span className={[styles.tag, tone === "accent" ? null : styles[tone], className].filter(Boolean).join(" ")} data-help={help} {...rest}>
      {children}
    </span>
  );
}

/** A result pill: a result card's outcome ("Done", "Failed"), filled in its tone. */
export function Pill({ tone, help, children, ...rest }: { tone: PillTone; help?: HelpKey | undefined; children: ReactNode } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span className={`${styles.pill} ${styles[tone]}`} data-help={help} {...rest}>
      {children}
    </span>
  );
}
