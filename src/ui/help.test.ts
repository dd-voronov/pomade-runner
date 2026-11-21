import { describe, expect, it } from "vitest";

import { HELP } from "./help";

describe("help texts say what the app does", () => {
  it("an agent run due while Pomade is closed opens it", () => {
    expect(HELP["kind.agent"][0]).toContain("Runner opens it if it is closed");
    expect(HELP["kind.agent"][0]).not.toContain("fails");
  });

  it("a run's output is kept as long as the history setting says, not a fixed number of days", () => {
    expect(HELP["c.output"][0]).toContain("Keep history and output");
    expect(HELP["c.output"][0]).not.toMatch(/\d+ days/);
  });
});
