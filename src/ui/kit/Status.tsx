import type { ReactNode } from "react";

import type { HelpKey } from "../help";
import styles from "./Status.module.css";

/** A status dot's tone. `hollow` is a ring: queued, skipped, missed, stopped. */
export type DotTone = "neutral" | "ok" | "danger" | "warning" | "accent" | "hollow";

/** A 7 px status dot; `live` haloes it (a run going right now). */
export function Dot({ tone = "neutral", live = false, className }: { tone?: DotTone | undefined; live?: boolean | undefined; className?: string | undefined }): React.JSX.Element {
  const names = [styles.dot, tone !== "neutral" && styles[tone], live && styles.live, className].filter(Boolean).join(" ");
  return <i className={names} aria-hidden="true" />;
}

/** The words' colour follows the dot: red for danger, amber for warning, muted for hollow ones. */
function textTone(tone: DotTone): string | undefined {
  if (tone === "danger") return styles.danger;
  if (tone === "warning") return styles.warning;
  if (tone === "hollow") return styles.muted;
  return undefined;
}

/** A status: its dot and words ("running · up 3d 4h", "failed · exit 1"). `size="xs"` is the panel's,
 *  `sm` a view column's; `help` shows that status's help text on hover and focus; `cutTip` adds the
 *  whole words to it while a column cuts them. */
export function Status({
  tone,
  live = false,
  size = "xs",
  help,
  cutTip = false,
  children,
  testId,
}: {
  tone: DotTone;
  live?: boolean | undefined;
  size?: "xs" | "sm";
  help?: HelpKey | undefined;
  cutTip?: boolean | undefined;
  children: ReactNode;
  testId?: string | undefined;
}): React.JSX.Element {
  const names = [styles.status, size === "sm" && styles.sm, textTone(tone)].filter(Boolean).join(" ");
  return (
    <span className={names} data-help={help} data-tip-cut={cutTip ? "" : undefined} data-testid={testId}>
      <Dot tone={tone} live={live} />
      <span className={styles.words}>{children}</span>
    </span>
  );
}
