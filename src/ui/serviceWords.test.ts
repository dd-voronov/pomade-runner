import { describe, expect, it } from "vitest";

import type { ServiceStatus } from "../keeper/model";
import { serviceWords } from "./serviceWords";

const base: ServiceStatus = { job: "web", name: "Web", project: null, state: "running", session: null, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null };

describe("a service in words", () => {
  it("names the state alone when nothing else happened", () => {
    expect(serviceWords(base)).toBe("Running");
    expect(serviceWords({ ...base, state: "stopped-by-you" })).toBe("Stopped by you");
    expect(serviceWords({ ...base, state: "waiting" })).toBe("Waits for its project to open");
  });

  it("adds the restarts, the last crash on this Mac's clock, and a pending restart", () => {
    const crash = new Date(2026, 10, 17, 14, 2, 30).getTime();
    expect(serviceWords({ ...base, restarts: 3, lastCrashAt: crash })).toBe("Running · restarted 3× · last crash 14:02");
    expect(serviceWords({ ...base, state: "failed", restarts: 4, lastCrashAt: crash })).toBe("Failed: crashed 5 times in a minute · restarted 4× · last crash 14:02");
    expect(serviceWords({ ...base, needsRestart: true })).toBe("Running · restart to apply its file");
  });
});
