import { useCallback, useEffect, useRef, useState } from "react";

import { COMMAND_MAX, COMMAND_MIN, COMMAND_RESERVED, COMMAND_STEP, COMMAND_STEP_LARGE, clampCommandWidth, commandRoom, loadCommandWidth, saveCommandWidth, viewerStorage } from "./commandWidth";
import styles from "./CommandColumn.module.css";

/** The Command column's width: the one kept on this Mac, changed live while dragging (`set`) and
 *  kept with `commit`. */
export function useCommandWidth(): { width: number; set: (width: number) => void; commit: (width: number) => void } {
  const [width, setWidth] = useState(() => loadCommandWidth(viewerStorage()));
  const commit = useCallback((next: number) => {
    setWidth(next);
    saveCommandWidth(viewerStorage(), next);
  }, []);
  return { width, set: setWidth, commit };
}

/** The columns' CSS variables on the view: the width asked for and what the other columns reserve. */
export const commandVars = (width: number): React.CSSProperties => ({ "--cmd-w": `${width}px`, "--cmd-reserved": `${COMMAND_RESERVED}px` }) as React.CSSProperties;

/** The head's Command label with the grip on its right edge: drag it, or use Left and Right
 *  (Shift for a larger step), to change the column's width. */
export function CommandHead({ width, onChange, onCommit }: { width: number; onChange: (width: number) => void; onCommit: (width: number) => void }): React.JSX.Element {
  const label = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** The widest the head's row lets the column be, and the width it has now. */
  const measure = (): { room: number; rendered: number } => {
    const head = label.current?.parentElement;
    if (head === null || head === undefined || label.current === null) return { room: COMMAND_MAX, rendered: width };
    const style = getComputedStyle(head);
    const content = head.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { room: commandRoom(content), rendered: label.current.getBoundingClientRect().width };
  };

  return (
    <span ref={label} className={styles.head}>
      Command
      <span
        className={`${styles.grip}${dragging ? ` ${styles.dragging}` : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Command column width"
        aria-valuemin={COMMAND_MIN}
        aria-valuemax={COMMAND_MAX}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="command-grip"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const { rendered } = measure();
          drag.current = { startX: event.clientX, startWidth: rendered, width: rendered };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (state === null) return;
          state.width = clampCommandWidth(state.startWidth + event.clientX - state.startX, measure().room);
          onChange(state.width);
        }}
        onPointerUp={(event) => {
          const state = drag.current;
          drag.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (state !== null) onCommit(state.width);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const { room, rendered } = measure();
          const step = event.shiftKey ? COMMAND_STEP_LARGE : COMMAND_STEP;
          onCommit(clampCommandWidth(rendered + (event.key === "ArrowRight" ? step : -step), room));
        }}
      />
    </span>
  );
}

/** A service's command in the Command column: one line cut with "…". Only a cut one is focusable
 *  and carries the whole command as its tooltip (measured, and again whenever the column or the tab
 *  changes size). */
export function CommandCell({ command }: { command: string }): React.JSX.Element {
  const cell = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = cell.current;
    if (el === null) return;
    const measure = (): void => setCut(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [command]);
  return (
    <div className={styles.cell}>
      <span ref={cell} className={styles.command} data-tip={cut ? command : undefined} data-tip-code={cut ? "" : undefined} tabIndex={cut ? 0 : undefined} data-cut={cut} data-testid="service-command">
        {command}
      </span>
    </div>
  );
}
