import { parseManifest } from "pomade-kit/protocol";
import { describe, expect, it } from "vitest";

import manifest from "../app/manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { APP_ID, STRIP_ICON } from "./app";
import { OUTPUT_TAB_KIND } from "./integrations/runner-api";

describe("manifest.json", () => {
  it("is a valid Pomade manifest", () => {
    const result = parseManifest(manifest);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("declares what Runner is hosted as", () => {
    const result = parseManifest(manifest);
    if (!result.ok) throw new Error(result.message);
    const { id, name, strip, tabKinds, backend, commands } = result.manifest;
    expect({ id, name }).toEqual({ id: "pomade-runner", name: "Runner" });
    expect(strip).toEqual([expect.objectContaining({ id: STRIP_ICON, title: "Runner", action: "panel" })]);
    expect(tabKinds).toEqual({ [OUTPUT_TAB_KIND]: { title: "Output", icon: "output.svg" } });
    expect(backend).toMatchObject({ entry: "backend/scheduler.mjs", mode: "always-on", restartOnUpdate: true });
    expect(commands).toEqual([expect.objectContaining({ name: APP_ID, entry: "cli/pomade-runner.mjs" })]);
  });

  it("carries the package's version", () => {
    expect(manifest.version).toBe(pkg.version);
  });
});
