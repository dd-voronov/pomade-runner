import { createContext, useCallback, useContext, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import {
  clampWidth,
  COLUMN_MAX,
  COLUMN_STEP,
  COLUMN_STEP_LARGE,
  isSized,
  loadWidths,
  saveWidths,
  tableMinWidth,
  trackList,
  viewerStorage,
  type Column,
  type SizedColumn,
  type Widths,
} from "./columnWidths";
import styles from "./ResizableTable.module.css";

const join = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(" ");

/** A table's column sizing: its columns, the widths kept on this Mac (`null` while it is at its
 *  default layout), and the two ways to change them — `preview` shows widths live, without a render
 *  (a drag), `commit` shows and keeps them (`null` goes back to the default layout). */
export interface ColumnSizing {
  readonly columns: readonly Column[];
  readonly widths: Widths | null;
  readonly root: RefObject<HTMLDivElement | null>;
  preview: (widths: Widths | null) => void;
  commit: (widths: Widths | null) => void;
}

/** The CSS variables a table's layout reads: its tracks and the least width they need. */
const tableVars = (columns: readonly Column[], widths: Widths | null): Record<string, string> => ({ "--sized-cols": trackList(columns, widths), "--sized-min": tableMinWidth(columns, widths) });

/** A resizable table's sizing, kept under `key` on this Mac. `columns` is the one constant of the view. */
export function useColumnSizing(key: string, columns: readonly Column[]): ColumnSizing {
  const [widths, setWidths] = useState(() => loadWidths(viewerStorage(), key, columns));
  const root = useRef<HTMLDivElement>(null);
  const preview = useCallback(
    (next: Widths | null) => {
      for (const [name, value] of Object.entries(tableVars(columns, next))) root.current?.style.setProperty(name, value);
    },
    [columns],
  );
  const commit = useCallback(
    (next: Widths | null) => {
      preview(next);
      setWidths(next);
      saveWidths(viewerStorage(), key, next);
    },
    [key, preview],
  );
  return useMemo(() => ({ columns, widths, root, preview, commit }), [columns, widths, preview, commit]);
}

const SizingContext = createContext<ColumnSizing | null>(null);

/** Whether the table around is a resizable one: its head and rows lay out by its tracks. */
export const useSized = (): boolean => useContext(SizingContext) !== null;

/** A view's table whose every column with a grip is resized by the viewer, in its own scroll area:
 *  the last thing of a view whose page fills the tab (`TabShell`'s `fill`), it is as tall as its
 *  rows, at most what the view leaves, and scrolls down and sideways inside it — the head stays at
 *  its top, the sideways scrollbar at the view's bottom, and the columns together may be wider than
 *  the view. The head and rows inside (`TableHead`, `TableRow`) take their tracks from it; a view's
 *  `className` may set `--cols` (other tracks), `--table-min` (another least width),
 *  `--grip-display` for a width where the table cannot be resized and `--table-pinned-h`, the
 *  height of its pinned rows (`GroupHead`'s `pinned`). */
export function ResizableTable({ sizing, className, children }: { sizing: ColumnSizing; className?: string | undefined; children: ReactNode }): React.JSX.Element {
  return (
    <SizingContext value={sizing}>
      <div
        ref={sizing.root}
        className={join(styles.scroller, className)}
        style={tableVars(sizing.columns, sizing.widths) as CSSProperties}
        data-testid="resizable-table"
        onScroll={(event) => event.currentTarget.toggleAttribute("data-scrolled", event.currentTarget.scrollTop > 0)}
      >
        <div className={styles.inner}>{children}</div>
      </div>
    </SizingContext>
  );
}

/** A head cell of a sized column: its label (`after` follows it, an (i) say) and, on its right
 *  edge, the grip. `id` is the column's, `label` names it for assistive technology. A label too
 *  long for the column ends in "…", unless `whole`: then it keeps its length. */
export function ColumnHead({
  id,
  label,
  className,
  after,
  whole = false,
  children,
}: {
  id: string;
  label: string;
  className?: string | undefined;
  after?: ReactNode;
  whole?: boolean | undefined;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span className={join(styles.cell, className)} data-col={id}>
      <span className={join(styles.label, whole && styles.whole)}>
        <span className={styles.text}>{children}</span>
        {after}
      </span>
      <Grip id={id} label={label} />
    </span>
  );
}

/** Every sized column's width as the head renders it now — the first resize starts from these. */
function rendered(sizing: ColumnSizing, head: HTMLElement | null): Widths {
  if (sizing.widths !== null) return sizing.widths;
  const widths: Record<string, number> = {};
  for (const column of sizing.columns) {
    if (!isSized(column)) continue;
    const cell = head?.querySelector<HTMLElement>(`:scope > [data-col="${column.id}"]`);
    widths[column.id] = clampWidth(column, cell === null || cell === undefined ? column.min : cell.getBoundingClientRect().width);
  }
  return widths;
}

/** The grip on a head cell's right edge: drag it, or use Left and Right (Shift for the larger step),
 *  to change that column's width and no other's; a double click puts the table back to its default
 *  layout. */
function Grip({ id, label }: { id: string; label: string }): React.JSX.Element {
  const sizing = useContext(SizingContext);
  const drag = useRef<{ x: number; start: Widths; widths: Widths; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [seen, setSeen] = useState<number | undefined>(undefined);
  const column = sizing?.columns.find((candidate): candidate is SizedColumn => candidate.id === id && isSized(candidate));
  if (sizing === null || column === undefined) throw new Error(`ColumnHead "${id}" is not a sized column of a ResizableTable`);
  const head = (target: HTMLElement): HTMLElement | null => target.parentElement?.parentElement ?? null;

  return (
    <span
      className={join(styles.grip, dragging && styles.dragging)}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label} column width`}
      aria-valuemin={column.min}
      aria-valuemax={COLUMN_MAX}
      aria-valuenow={sizing.widths?.[id] ?? seen}
      tabIndex={0}
      data-testid="column-grip"
      data-grip={id}
      onFocus={(event) => setSeen(rendered(sizing, head(event.currentTarget))[id])}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = rendered(sizing, head(event.currentTarget));
        drag.current = { x: event.clientX, start, widths: start, moved: false };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (state === null) return;
        const width = clampWidth(column, (state.start[id] ?? column.min) + event.clientX - state.x);
        if (width === state.widths[id] && !state.moved) return;
        state.widths = { ...state.start, [id]: width };
        state.moved = true;
        sizing.preview(state.widths);
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (state?.moved === true) {
          sizing.commit(state.widths);
          setSeen(state.widths[id]);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        sizing.preview(sizing.widths);
      }}
      onDoubleClick={() => sizing.commit(null)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const start = rendered(sizing, head(event.currentTarget));
        const step = event.shiftKey ? COLUMN_STEP_LARGE : COLUMN_STEP;
        const width = clampWidth(column, (start[id] ?? column.min) + (event.key === "ArrowRight" ? step : -step));
        sizing.commit({ ...start, [id]: width });
        setSeen(width);
      }}
    />
  );
}
