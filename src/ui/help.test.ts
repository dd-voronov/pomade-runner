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

  it("a first open: a waiting service starts on its project's open or with Start; a hook made after the open waits for the next Pomade start", () => {
    expect(HELP["st.svcwaiting"][0]).toBe("Its project has not been opened since Pomade started: it starts when you open it. Start runs it now.");
    expect(HELP["hk.project-first-open"][0]).toContain("A job made after that open waits for the next Pomade start.");
  });

  it("a stopped or failed service says Start brings it back — the button its rows offer", () => {
    for (const key of ["st.stopped", "st.svcfailed", "need.crashloop"] as const) expect(HELP[key][0] + HELP[key][1]).toMatch(/press Start/i);
  });
});
