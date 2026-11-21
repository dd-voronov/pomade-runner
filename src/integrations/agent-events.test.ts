// The Agents app's session events as Runner reads them: the contract's shapes pass, anything else
// is `null`.

import { describe, expect, it } from "vitest";

import { readSessionClosed, readStatusChanged, SESSION_CLOSED_EVENT, SESSION_STATUS_CHANGED_EVENT } from "./agent-events";

const base = {
  sessionId: "s-1",
  provider: "claude-code",
  agent: "claude",
  project: { id: "alpha", root: "Projects/alpha" },
  cwd: "/ws/Projects/alpha",
  transcript: "/home/.claude/projects/-ws-Projects-alpha/s-1.jsonl",
  name: "Fix the build",
  status: "done",
  startedByRunner: false,
  job: null,
  at: "2026-11-21T10:00:00.000Z",
};

describe("the Agents app's session events", () => {
  it("are named as a subscriber names them", () => {
    expect([SESSION_CLOSED_EVENT, SESSION_STATUS_CHANGED_EVENT]).toEqual(["pomade-agents:session.closed", "pomade-agents:session.statusChanged"]);
  });

  it("reads B with each reason, one it does not know too, extra fields dropped", () => {
    for (const reason of ["exit", "tab-closed", "crash", "run-finished", "something-new"]) expect(readSessionClosed({ ...base, reason, extra: 1 })).toEqual({ ...base, reason });
    expect(readSessionClosed({ ...base, reason: "run-finished", startedByRunner: true, job: "Nightly" })).toMatchObject({ startedByRunner: true, job: "Nightly" });
    expect(readSessionClosed({ ...base, reason: "exit", project: null, cwd: null, name: null, provider: "codex" })).toMatchObject({ project: null, cwd: null, name: null, provider: "codex" });
  });

  it("reads C with `status` = `to`", () => {
    expect(readStatusChanged({ ...base, from: "active", to: "done" })).toEqual({ ...base, from: "active", to: "done" });
    expect(readStatusChanged({ ...base, from: "active", to: "on-hold" })).toBeNull();
  });

  it("refuses what is not the contract's", () => {
    const broken: Record<string, unknown>[] = [
      { sessionId: "" },
      { sessionId: 7 },
      { agent: "" },
      { provider: null },
      { project: { id: "alpha" } },
      { project: { id: "", root: "x" } },
      { project: "alpha" },
      { cwd: 3 },
      { transcript: "" },
      { name: 1 },
      { status: "parked" },
      { startedByRunner: "yes" },
      { job: 5 },
      { at: "" },
    ];
    for (const patch of broken) {
      expect(readSessionClosed({ ...base, reason: "exit", ...patch })).toBeNull();
      expect(readStatusChanged({ ...base, from: "active", to: "done", ...patch, ...(patch.status === undefined ? {} : { to: patch.status }) })).toBeNull();
    }
    expect(readSessionClosed({ ...base })).toBeNull();
    expect(readSessionClosed({ ...base, reason: "" })).toBeNull();
    expect(readStatusChanged({ ...base, from: "parked", to: "done" })).toBeNull();
    for (const payload of [null, [], "x", 1]) {
      expect(readSessionClosed(payload)).toBeNull();
      expect(readStatusChanged(payload)).toBeNull();
    }
  });
});
