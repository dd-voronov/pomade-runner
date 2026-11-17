import { describe, expect, it } from "vitest";

import { keeperNeedsUpdate, keeperVersion } from "./version";

const ENTRY = new TextEncoder().encode("await runKeeper({ version });\n");
const PACKAGES = [
  { name: "node-pty", version: "1.1.0" },
  { name: "@xterm/headless", version: "5.5.0" },
];

describe("the keeper's version", () => {
  it("is the same for the same keeper, whatever order the packages come in", () => {
    const version = keeperVersion(ENTRY, PACKAGES);
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(keeperVersion(ENTRY, [...PACKAGES].reverse())).toBe(version);
  });

  it("changes with the entry's bytes and with any package's version", () => {
    const version = keeperVersion(ENTRY, PACKAGES);
    expect(keeperVersion(new TextEncoder().encode("await runKeeper({ version }); \n"), PACKAGES)).not.toBe(version);
    expect(keeperVersion(ENTRY, [{ name: "node-pty", version: "1.1.1" }, { name: "@xterm/headless", version: "5.5.0" }])).not.toBe(version);
    expect(keeperVersion(ENTRY, PACKAGES.slice(0, 1))).not.toBe(version);
  });

  it("is updated whenever the running keeper's differs from the shipped one, older or newer", () => {
    expect(keeperNeedsUpdate("3ec9b16fc34c", "3ec9b16fc34c")).toBe(false);
    expect(keeperNeedsUpdate("3ec9b16fc34c", "000000000000")).toBe(true);
    expect(keeperNeedsUpdate("0", "3ec9b16fc34c")).toBe(true);
  });
});
