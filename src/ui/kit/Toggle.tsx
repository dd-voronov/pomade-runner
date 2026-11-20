import type { ButtonHTMLAttributes } from "react";

import styles from "./Toggle.module.css";

/** The on/off switch at a row's end (a job's Enabled). `label` names what it switches; its tooltip
 *  says what a click does ("Disable" / "Enable") unless `tip` says otherwise. */
export function Toggle({
  on,
  onChange,
  label,
  tip,
  ...rest
}: { on: boolean; onChange: (on: boolean) => void; label: string; tip?: string | undefined } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "role" | "aria-checked" | "children"
>): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      className={styles.root}
      aria-checked={on}
      aria-label={label}
      data-tip={tip ?? (on ? "Disable" : "Enable")}
      onClick={() => onChange(!on)}
      {...rest}
    />
  );
}
