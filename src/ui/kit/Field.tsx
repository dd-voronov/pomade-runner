import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import type { HelpKey } from "../help";
import styles from "./Field.module.css";
import { Help } from "./Help";
import { Icon } from "./Icon";

const join = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(" ");

/** `text` fills its field; `time` (62 px) and `number` (56 px) are narrow and centred; `compact` is the panel's 24 px one. */
export type InputWidth = "text" | "time" | "number" | "compact";

/** A one-line text input. `mono` for paths and commands; `bad` marks it invalid (red border). */
export function TextInput({
  mono = false,
  bad = false,
  width = "text",
  className,
  ...rest
}: { mono?: boolean | undefined; bad?: boolean | undefined; width?: InputWidth | undefined } & InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={join(styles.input, mono && styles.mono, bad && styles.bad, width !== "text" && styles[width], className)}
      aria-invalid={bad || undefined}
      {...rest}
    />
  );
}

/** A multi-line text input (an agent job's prompt). */
export function TextArea({ mono = false, bad = false, className, ...rest }: { mono?: boolean | undefined; bad?: boolean | undefined } & TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea className={join(styles.input, mono && styles.mono, bad && styles.bad, className)} aria-invalid={bad || undefined} {...rest} />;
}

/** A drop-down of `options`; `auto` sizes it to its content instead of filling the field. */
export function Select({
  options,
  auto = false,
  bad = false,
  className,
  ...rest
}: { options: readonly { value: string; label: string }[]; auto?: boolean | undefined; bad?: boolean | undefined } & SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <span className={join(styles.select, auto && styles.auto, className)}>
      <select className={join(styles.input, bad && styles.bad)} aria-invalid={bad || undefined} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg className={styles.chevron} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 3.5l3 3 3-3" />
      </svg>
    </span>
  );
}

/** An inline error under a field, in the validator's words. */
export function FieldError({ children, id }: { children: ReactNode; id?: string | undefined }): React.JSX.Element {
  return (
    <div className={styles.error} id={id} role="alert">
      <Icon name="warn" size={12} />
      <span>{children}</span>
    </div>
  );
}

/** A labelled field: the label (with "· optional" and the (i) help), the control, then its error
 *  or hint. `children` receives the control's id, so the label names it. */
export function Field({
  label,
  help,
  optional = false,
  error,
  hint,
  children,
}: {
  label: ReactNode;
  help?: HelpKey | undefined;
  optional?: boolean | undefined;
  error?: ReactNode | undefined;
  hint?: ReactNode | undefined;
  children: (id: string) => ReactNode;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={styles.field}>
      <div className={styles.label}>
        <label htmlFor={id}>{label}</label>
        {optional && <span className={styles.optional}>· optional</span>}
        {help !== undefined && <Help k={help} />}
      </div>
      {children(id)}
      {error !== undefined && error !== null && error !== false && <FieldError>{error}</FieldError>}
      {hint !== undefined && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}
