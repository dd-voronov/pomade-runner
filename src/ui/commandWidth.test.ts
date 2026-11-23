import { describe, expect, it } from "vitest";

import { clampCommandWidth, COMMAND_DEFAULT, COMMAND_MAX, COMMAND_MIN, COMMAND_RESERVED, commandRoom, loadCommandWidth, saveCommandWidth } from "./commandWidth";

/** A store that keeps what it is given; `refuse` makes every call throw, as a blocked one does. */
function store(initial?: string, refuse = false): Storage & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  if (initial !== undefined) kept.set("pomade-runner.services.command-width", initial);
  const guard = <T>(run: () => T): T => {
    if (refuse) throw new DOMException("blocked", "SecurityError");
    return run();
  };
  return { kept, getItem: (key) => guard(() => kept.get(key) ?? null), setItem: (key, value) => guard(() => void kept.set(key, value)) } as Storage & { kept: Map<string, string> };
}

describe("clampCommandWidth", () => {
  it("keeps a width inside the limits", () => {
    expect(clampCommandWidth(300)).toBe(300);
    expect(clampCommandWidth(COMMAND_MIN - 1)).toBe(COMMAND_MIN);
    expect(clampCommandWidth(COMMAND_MAX + 1)).toBe(COMMAND_MAX);
  });

  it("keeps it inside what the row has left, but never under the minimum", () => {
    expect(clampCommandWidth(500, 400)).toBe(400);
    expect(clampCommandWidth(500, 10)).toBe(COMMAND_MIN);
    expect(clampCommandWidth(500, 9999)).toBe(500);
  });

  it("rounds, and takes the default for a number that is not one", () => {
    expect(clampCommandWidth(200.6)).toBe(201);
    expect(clampCommandWidth(Number.NaN)).toBe(COMMAND_DEFAULT);
    expect(clampCommandWidth(Number.POSITIVE_INFINITY)).toBe(COMMAND_DEFAULT);
  });
});

describe("commandRoom", () => {
  it("is what a row's width leaves once the other columns take theirs", () => {
    expect(commandRoom(COMMAND_RESERVED + 300)).toBe(300);
  });
});

describe("the remembered width", () => {
  it("is the default with nothing kept, an unreadable value or no store", () => {
    expect(loadCommandWidth(store())).toBe(COMMAND_DEFAULT);
    expect(loadCommandWidth(store("wide"))).toBe(COMMAND_DEFAULT);
    expect(loadCommandWidth(store(""))).toBe(COMMAND_DEFAULT);
    expect(loadCommandWidth(null)).toBe(COMMAND_DEFAULT);
  });

  it("comes back as it was saved, and a kept value out of range is brought into it", () => {
    const kept = store();
    saveCommandWidth(kept, 345);
    expect(loadCommandWidth(kept)).toBe(345);
    expect(loadCommandWidth(store("5"))).toBe(COMMAND_MIN);
    expect(loadCommandWidth(store("99999"))).toBe(COMMAND_MAX);
  });

  it("does not fail where the store refuses", () => {
    const blocked = store(undefined, true);
    expect(() => saveCommandWidth(blocked, 300)).not.toThrow();
    expect(loadCommandWidth(blocked)).toBe(COMMAND_DEFAULT);
    expect(() => saveCommandWidth(null, 300)).not.toThrow();
  });
});
