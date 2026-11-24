import { describe, expect, it } from "vitest";

import type { ActiveRun } from "../scheduler/model";
import { latestGoing, terminalLabel } from "./rowRun";

const run = (id: string, extra: Partial<ActiveRun> = {}): ActiveRun => ({
  job: "backup",
  name: "Backup",
  kind: "script",
  project: null,
  folder: "",
  run: id,
  trigger: "manual",
  cause: null,
  dueAt: 1000,
  agent: null,
  missed: null,
  series: null,
  state: "running",
  lowPriority: false,
  runAt: null,
  deadline: null,
  waits: null,
  startedAt: 1000,
  session: `run:backup:${id}`,
  log: null,
  limitHit: null,
  warnedAt: null,
  warningDismissed: false,
  ...extra,
});

describe("latestGoing", () => {
  it("is none while no run has a terminal going", () => {
    expect(latestGoing([])).toBeNull();
    expect(latestGoing([run("a", { state: "queued", startedAt: null, session: null }), run("b", { state: "missed-waiting", startedAt: null, session: null })])).toBeNull();
  });

  it("is the run that started last, whatever the list's order", () => {
    const older = run("20261117-130000-aaaaaa", { startedAt: 1000 });
    const newer = run("20261117-130200-bbbbbb", { startedAt: 5000 });
    expect(latestGoing([older, newer])?.run).toBe(newer.run);
    expect(latestGoing([newer, older])?.run).toBe(newer.run);
  });

  it("skips a queued run that is newer; a tie goes to the later run id", () => {
    expect(latestGoing([run("a", { startedAt: 1000 }), run("z", { state: "queued", startedAt: null, session: null })])?.run).toBe("a");
    expect(latestGoing([run("a"), run("b")])?.run).toBe("b");
    expect(latestGoing([run("b"), run("a")])?.run).toBe("b");
  });
});

describe("terminalLabel", () => {
  const agent = { agent: "claude", name: "claude", provider: "claude", mode: "normal", modeName: "Normal", sessionId: null, cwd: "", startedAt: "", exit: "/exit", exitSentAt: null, waitedMs: 0 } as const;

  it("is the card's: Open terminal, or Open at the prompt for an agent run waiting for you", () => {
    expect(terminalLabel(run("a"))).toBe("Open terminal");
    expect(terminalLabel(run("a", { agent: { ...agent, waiting: null } }))).toBe("Open terminal");
    expect(terminalLabel(run("a", { agent: { ...agent, waiting: { prompt: "permission", since: 1 } } }))).toBe("Open at the prompt");
  });
});
