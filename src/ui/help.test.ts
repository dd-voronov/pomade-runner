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

  it("a first open: a waiting service starts on its project's open or with Start and stops with Pomade; a hook made or enabled after the open runs on the next Pomade start's", () => {
    expect(HELP["st.svcwaiting"][0]).toBe("Its project has not been opened since Pomade started: it starts when you open it and stops when Pomade quits. Start runs it now.");
    expect(HELP["hk.project-first-open"][0]).toContain("A job made or enabled after that open does not run for it: it runs on the next Pomade start's first open.");
    expect(HELP["hk.project-opened"][0]).toContain("every time");
  });

  it("services: no text says every service outlives Pomade; a service waiting for Pomade says it cannot be started until Pomade starts", () => {
    expect(HELP["kind.service"][0]).toContain("or only while Pomade is running");
    expect(HELP["f.start"][0]).toContain("it stops when Pomade quits");
    expect(HELP["st.svcwaitpomade"][0]).toContain("until then it cannot be started");
  });

  it("a stopped or failed service says Start brings it back — the button its rows offer", () => {
    for (const key of ["st.stopped", "st.svcfailed", "need.crashloop"] as const) expect(HELP[key][0] + HELP[key][1]).toMatch(/press Start/i);
  });
});
