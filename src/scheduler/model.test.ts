import { describe, expect, it } from "vitest";

import { outputRoute, parseRoute, runRoute } from "../integrations/runner-api";
import { durationWords, isRunsReport, runWords, type ActiveRun, type RunRecord } from "./model";

const base = { job: "coda/web", name: "Web", kind: "script" as const, project: "p1", folder: "Projects/coda", run: "20261117-120000-abcdef", trigger: "manual" as const, dueAt: 1 };
const active: ActiveRun = { ...base, state: "running", startedAt: 1, session: "run:coda.web:20261117-120000-abcdef", log: "/o.log" };
const record: RunRecord = { ...base, state: "failed", reason: null, startedAt: 1, endedAt: 2, durationMs: 1, exitCode: 1, signal: null, log: "/o.log", lastLines: [] };

describe("runs in words", () => {
  it("says each state", () => {
    expect(runWords(active)).toBe("running");
    expect(runWords({ ...active, state: "queued" })).toBe("queued · after the previous run");
    expect(runWords(record)).toBe("failed · exit 1");
    expect(runWords({ ...record, exitCode: null, signal: "SIGKILL" })).toBe("failed · SIGKILL");
    expect(runWords({ ...record, exitCode: null })).toBe("failed · ended");
    expect(runWords({ ...record, reason: "lost in a keeper crash" })).toBe("failed · lost in a keeper crash");
    expect(runWords({ ...record, state: "done" })).toBe("done");
    expect(runWords({ ...record, state: "stopped-by-you" })).toBe("stopped by you");
    expect(runWords({ ...record, state: "skipped", reason: "previous run still going" })).toBe("skipped · previous run still going");
    expect(runWords({ ...record, state: "skipped" })).toBe("skipped");
  });

  it("says how long", () => {
    expect([0, 850, 1000, 12_400, 60_000, 184_000, 3_600_000, 7_500_000].map(durationWords)).toEqual(["0 ms", "850 ms", "1 s", "12 s", "1 min", "3 min 4 s", "1 h", "2 h 5 min"]);
  });
});

describe("routes", () => {
  it("name a run's result and output by the job id and run id, and read back", () => {
    expect(runRoute("coda/web", "20261117-120000-abcdef")).toBe("run/coda.web/20261117-120000-abcdef");
    expect(outputRoute("Café", "r1")).toBe("output/Caf_c3_a9/r1");
    expect(parseRoute(runRoute("coda/web", "20261117-120000-abcdef"))).toEqual({ view: "run", job: "coda/web", run: "20261117-120000-abcdef" });
    expect(parseRoute(outputRoute("Café", "r1"))).toEqual({ view: "output", job: "Café", run: "r1" });
    expect(parseRoute("history")).toEqual({ view: "history" });
    for (const route of ["", "jobs", "run/x", "run/a_zz/r", "run//r", "nope/a/b"]) expect(parseRoute(route)).toEqual({ view: "jobs" });
  });
});

describe("isRunsReport", () => {
  it("checks a runs report's shape", () => {
    const report = {
      active: [active],
      nextUp: [{ job: "a", name: "A", project: null, at: 5 }],
      jobs: [{ job: "a", next: null, finished: true, last: record }],
      needsYou: [
        { id: "run-failed:a", kind: "run-failed", job: "a", name: "A", project: null, run: "r", at: 1, count: 1, detail: "exit 1" },
        { id: "service-failed:w", kind: "service-failed", job: "w", name: "W", project: null, at: 1, detail: "x" },
      ],
    };
    expect(isRunsReport(report)).toBe(true);
    for (const bad of [
      { ...report, active: [{ ...active, state: "done" }] },
      { ...report, nextUp: [{ job: "a" }] },
      { ...report, jobs: [{ job: "a", next: "soon", finished: true, last: null }] },
      { ...report, needsYou: [{ ...report.needsYou[0], count: "1" }] },
      { ...report, needsYou: [{ ...report.needsYou[1], kind: "other" }] },
      { active: [] },
    ]) {
      expect(isRunsReport(bad)).toBe(false);
    }
  });
});
