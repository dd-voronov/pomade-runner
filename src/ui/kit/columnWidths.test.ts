import { describe, expect, it } from "vitest";

import { clampWidth, COLUMN_MAX, loadWidths, saveWidths, tableMinWidth, trackList, type Column, type SizedColumn } from "./columnWidths";

const KEY = "test.column-widths";
const COLUMNS: readonly Column[] = [
  { id: "icon", width: 16 },
  { id: "name", min: 80, track: "minmax(0, 1fr)" },
  { id: "note", min: 60, track: "120px" },
];
const NAME = COLUMNS[1] as SizedColumn;

/** A store that keeps what it is given; `refuse` makes every call throw, as a blocked one does. */
function store(initial?: string, refuse = false): Storage & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  if (initial !== undefined) kept.set(KEY, initial);
  const guard = <T>(run: () => T): T => {
    if (refuse) throw new DOMException("blocked", "SecurityError");
    return run();
  };
  return {
    kept,
    getItem: (key: string) => guard(() => kept.get(key) ?? null),
    setItem: (key: string, value: string) => guard(() => void kept.set(key, value)),
    removeItem: (key: string) => guard(() => void kept.delete(key)),
  } as Storage & { kept: Map<string, string> };
}

describe("clampWidth", () => {
  it("keeps a width inside the column's limits and rounds it", () => {
    expect(clampWidth(NAME, 300)).toBe(300);
    expect(clampWidth(NAME, 200.6)).toBe(201);
    expect(clampWidth(NAME, 79)).toBe(80);
    expect(clampWidth(NAME, COLUMN_MAX + 1)).toBe(COLUMN_MAX);
  });

  it("gives the minimum for a number that is not one", () => {
    expect(clampWidth(NAME, Number.NaN)).toBe(80);
    expect(clampWidth(NAME, Number.POSITIVE_INFINITY)).toBe(80);
  });
});

describe("trackList", () => {
  it("is the default tracks while no column was resized, the fixed column's width in either case", () => {
    expect(trackList(COLUMNS, null)).toBe("16px minmax(0, 1fr) 120px");
  });

  it("is one fixed track per column once widths are kept", () => {
    expect(trackList(COLUMNS, { name: 300, note: 90 })).toBe("16px 300px 90px");
  });
});

describe("tableMinWidth", () => {
  it("is nothing at the default layout", () => {
    expect(tableMinWidth(COLUMNS, null)).toBe("0px");
  });

  it("adds the columns, the gaps between them and the row's padding", () => {
    expect(tableMinWidth(COLUMNS, { name: 300, note: 90 })).toBe("calc(406px + 2 * var(--space-3) + 2 * var(--space-2))");
  });
});

describe("the kept widths", () => {
  it("are none with nothing kept, an unreadable value, one that is not an object, one that misses a column, or no store", () => {
    expect(loadWidths(store(), KEY, COLUMNS)).toBeNull();
    expect(loadWidths(store(""), KEY, COLUMNS)).toBeNull();
    expect(loadWidths(store("wide"), KEY, COLUMNS)).toBeNull();
    expect(loadWidths(store("300"), KEY, COLUMNS)).toBeNull();
    expect(loadWidths(store("null"), KEY, COLUMNS)).toBeNull();
    expect(loadWidths(store('{"name":300}'), KEY, COLUMNS)).toBeNull();
    expect(loadWidths(store('{"name":"300","note":90}'), KEY, COLUMNS)).toBeNull();
    expect(loadWidths(null, KEY, COLUMNS)).toBeNull();
  });

  it("come back as they were saved; a kept value out of range is brought into it; an unknown column is ignored", () => {
    const kept = store();
    saveWidths(kept, KEY, { name: 345, note: 99 });
    expect(loadWidths(kept, KEY, COLUMNS)).toEqual({ name: 345, note: 99 });
    expect(loadWidths(store('{"name":5,"note":99999,"gone":7}'), KEY, COLUMNS)).toEqual({ name: 80, note: COLUMN_MAX });
  });

  it("are forgotten by saving none", () => {
    const kept = store('{"name":300,"note":90}');
    saveWidths(kept, KEY, null);
    expect(loadWidths(kept, KEY, COLUMNS)).toBeNull();
  });

  it("do not fail where the store refuses", () => {
    const blocked = store(undefined, true);
    expect(() => saveWidths(blocked, KEY, { name: 300, note: 90 })).not.toThrow();
    expect(() => saveWidths(blocked, KEY, null)).not.toThrow();
    expect(loadWidths(blocked, KEY, COLUMNS)).toBeNull();
    expect(() => saveWidths(null, KEY, { name: 300, note: 90 })).not.toThrow();
  });
});
