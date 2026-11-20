import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { HelpKey } from "../help";
import styles from "./Segmented.module.css";
import { Dot, type DotTone } from "./Status";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** The `switch` variant's label in a narrow panel; `label` when absent. */
  short?: ReactNode | undefined;
  /** The accessible name, when `label` is not plain words. */
  name?: string | undefined;
  disabled?: boolean | undefined;
  /** Shown faded and never chosen, its tip and help still working on hover and focus (a choice
   *  this build's form does not make). */
  unavailable?: boolean | undefined;
  /** A plain tooltip, or a help text. */
  tip?: string | undefined;
  help?: HelpKey | undefined;
  /** Marks the default choice with a faint "default". */
  isDefault?: boolean | undefined;
  /** The `switch` variant's dot beside the chosen position. */
  tone?: DotTone | undefined;
}

/** One choice of a few, as pressed buttons in a group: `seg` — the form's choices — or `switch`, the
 *  panel's three-position switch with its sliding thumb. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = "seg",
  testId,
  optionTestId,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name. */
  label: string;
  variant?: "seg" | "switch";
  testId?: string | undefined;
  /** Each option's test id, from its value. */
  optionTestId?: (value: T) => string;
}): React.JSX.Element {
  const group = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (variant !== "switch") return;
    const root = group.current;
    if (root === null) return;
    const place = (): void => {
      const on = root.querySelector<HTMLElement>('[aria-pressed="true"]');
      setThumb(on === null ? null : { left: on.offsetLeft, width: on.offsetWidth });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [variant, value]);

  return (
    <div ref={group} className={variant === "switch" ? styles.switch : styles.seg} role="group" aria-label={label} data-testid={testId}>
      {variant === "switch" && thumb !== null && <span className={styles.thumb} style={{ left: thumb.left, width: thumb.width }} />}
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={styles.option}
            aria-pressed={on}
            aria-label={option.name}
            aria-disabled={option.unavailable === true ? true : undefined}
            disabled={option.disabled}
            data-tip={option.tip}
            data-help={option.help}
            data-testid={optionTestId?.(option.value)}
            onClick={() => {
              if (!on && option.unavailable !== true) onChange(option.value);
            }}
          >
            {variant === "switch" ? (
              <>
                {on && option.tone !== undefined && <Dot tone={option.tone} className={styles.dot} />}
                <span className={styles.long}>{option.label}</span>
                <span className={styles.short}>{option.short ?? option.label}</span>
              </>
            ) : (
              <>
                {option.label}
                {option.isDefault === true && <span className={styles.default}>default</span>}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
