// The widths of a view table's columns: the column set, the clamp, the CSS the widths become, and
// the widths kept on this Mac (`localStorage`, per viewer, one JSON object per table). Storage that
// is missing or refuses leaves the table at its default layout.

/** A column no one resizes (an icon, the row's buttons): `width` px. */
export interface FixedColumn {
  readonly id: string;
  readonly width: number;
}

/** A column with a grip: never narrower than `min` px; `track` is its CSS track while the table is
 *  at its default layout (a flexible one included). */
export interface SizedColumn {
  readonly id: string;
  readonly min: number;
  readonly track: string;
}

export type Column = FixedColumn | SizedColumn;

export const isSized = (column: Column): column is SizedColumn => "track" in column;

/** Every sized column's width in px, by id. */
export type Widths = Readonly<Record<string, number>>;

/** The widest a column is dragged to; an arrow key moves a grip by the step, with Shift by the larger one. */
export const COLUMN_MAX = 2000;
export const COLUMN_STEP = 16;
export const COLUMN_STEP_LARGE = 64;

/** `width` as a whole number of px within the column's limits; a number that is not one gives the minimum. */
export function clampWidth(column: SizedColumn, width: number): number {
  if (!Number.isFinite(width)) return column.min;
  return Math.round(Math.min(Math.max(width, column.min), COLUMN_MAX));
}

/** The table's `grid-template-columns`: the default tracks while no column was resized, else a
 *  fixed track per column. */
export function trackList(columns: readonly Column[], widths: Widths | null): string {
  return columns.map((column) => (isSized(column) ? (widths === null ? column.track : `${widths[column.id] ?? column.min}px`) : `${column.width}px`)).join(" ");
}

/** The least width a table with `widths` needs, as a CSS length: its columns, the gaps between them
 *  and the row's padding. With no column resized the layout is the default one and needs none. */
export function tableMinWidth(columns: readonly Column[], widths: Widths | null): string {
  if (widths === null) return "0px";
  const sum = columns.reduce((total, column) => total + (isSized(column) ? (widths[column.id] ?? column.min) : column.width), 0);
  return `calc(${sum}px + ${columns.length - 1} * var(--space-3) + 2 * var(--space-2))`;
}

/** The browser's `localStorage`, or `null` where it is blocked. */
export function viewerStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The widths kept under `key`; `null` (the default layout) when none are kept, they are not
 *  readable, or they miss a sized column. */
export function loadWidths(storage: Pick<Storage, "getItem"> | null, key: string, columns: readonly Column[]): Widths | null {
  try {
    const kept = storage?.getItem(key);
    if (kept === null || kept === undefined || kept === "") return null;
    const parsed: unknown = JSON.parse(kept);
    if (typeof parsed !== "object" || parsed === null) return null;
    const widths: Record<string, number> = {};
    for (const column of columns) {
      if (!isSized(column)) continue;
      const width = (parsed as Record<string, unknown>)[column.id];
      if (typeof width !== "number" || !Number.isFinite(width)) return null;
      widths[column.id] = clampWidth(column, width);
    }
    return widths;
  } catch {
    return null;
  }
}

/** Keep `widths` under `key`, or forget them (`null`); a refusing store is no failure of the view. */
export function saveWidths(storage: Pick<Storage, "setItem" | "removeItem"> | null, key: string, widths: Widths | null): void {
  try {
    if (widths === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(widths));
  } catch {
    // The widths stay for this view only.
  }
}
