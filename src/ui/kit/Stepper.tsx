import { useEffect, useRef, type KeyboardEvent } from "react";

import styles from "./Stepper.module.css";

/** How long a button is held before it repeats, and the gap between repeats. */
const HOLD_MS = 450;
const REPEAT_MS = 70;

/** How long after its last step a stepper counts as settled — longer than the hold delay, so a held
 *  button's run of steps, and a run of clicks, are one change. */
export const STEPPER_SETTLED_MS = HOLD_MS + 150;

/** A held button: one step at the press, then — after a moment — a step every `REPEAT_MS` until it is
 *  released. A keyboard activation (a click with no pointer) is one step. `step` returns whether it
 *  could still go on; a repeat stops when it could not. */
function useHold(step: () => boolean): { onPointerDown: (event: React.PointerEvent) => void; onClick: (event: React.MouseEvent) => void } {
  const latest = useRef(step);
  useEffect(() => {
    latest.current = step;
  });
  const timers = useRef<{ wait: number | null; repeat: number | null }>({ wait: null, repeat: null });
  const stop = (): void => {
    if (timers.current.wait !== null) window.clearTimeout(timers.current.wait);
    if (timers.current.repeat !== null) window.clearInterval(timers.current.repeat);
    timers.current = { wait: null, repeat: null };
  };
  useEffect(() => stop, []);
  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      stop();
      latest.current();
      timers.current.wait = window.setTimeout(() => {
        timers.current.repeat = window.setInterval(() => {
          if (!latest.current()) stop();
        }, REPEAT_MS);
      }, HOLD_MS);
      document.addEventListener("pointerup", stop, { once: true });
      document.addEventListener("pointercancel", stop, { once: true });
    },
    onClick: (event) => {
      if (event.detail === 0) latest.current();
    },
  };
}

/** A number with a − and a + at its ends, for a setting that moves by small steps. Holding a button
 *  repeats; the value takes ArrowUp and ArrowDown. `onStep(-1 | 1)` moves it and returns whether it
 *  could (false at an end). */
export function Stepper({
  value,
  valueText,
  label,
  canDecrease,
  canIncrease,
  onStep,
  testId,
}: {
  value: number;
  /** The value in words for assistive technology ("3 hours"). */
  valueText: string;
  /** What it sets, for assistive technology. */
  label: string;
  canDecrease: boolean;
  canIncrease: boolean;
  onStep: (direction: -1 | 1) => boolean;
  testId?: string | undefined;
}): React.JSX.Element {
  const less = useHold(() => onStep(-1));
  const more = useHold(() => onStep(1));
  const keys = (event: KeyboardEvent): void => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onStep(event.key === "ArrowUp" ? 1 : -1);
    }
  };
  return (
    <span className={styles.root} role="group" aria-label={label} data-testid={testId}>
      <button type="button" className={styles.button} aria-label={`Decrease ${label}`} disabled={!canDecrease} data-testid={testId === undefined ? undefined : `${testId}-less`} {...less}>
        −
      </button>
      <span className={styles.value} role="spinbutton" tabIndex={0} aria-label={label} aria-valuenow={value} aria-valuetext={valueText} onKeyDown={keys} data-testid={testId === undefined ? undefined : `${testId}-value`}>
        {value}
      </span>
      <button type="button" className={styles.button} aria-label={`Increase ${label}`} disabled={!canIncrease} data-testid={testId === undefined ? undefined : `${testId}-more`} {...more}>
        +
      </button>
    </span>
  );
}
