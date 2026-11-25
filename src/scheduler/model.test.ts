import { describe, expect, it } from "vitest";

import { APP_TAB_KEY_RE } from "pomade-kit/protocol";

import { editRoute, jobsRoute, newRoute, outputRoute, outputTab, outputTabKey, parseRoute, promptRoute, runRoute } from "../integrations/runner-api";
import { MAX_ENCODED_JOB_ID } from "../keeper/ids";
import { clockTime, dayTime, durationWords, heldRowWords, hookCauseWords, isActiveRun, isHistoryPage, isMissedChoiceResult, isRunsReport, otherMissedRuns, parseRunRecord, runTriggerWords, runWords, type ActiveRun, type RunRecord } from "./model";

const base = { job: "blog/web", name: "Web", kind: "script" as const, project: "p1", folder: "Projects/blog", run: "20261117-120000-abcdef", trigger: "manual" as const, cause: null, dueAt: 1, agent: null, missed: null, series: null };
const active: ActiveRun = {
  ...base,
  state: "running",
  lowPriority: true,
  runAt: null,
  deadline: null,
  waits: null,
  startedAt: 1,
  session: "run:blog.web:20261117-120000-abcdef",
  log: "/o.log",
  limitHit: null,
  warnedAt: null,
  warningDismissed: false,
};
const queued: ActiveRun = { ...active, state: "queued", startedAt: null, session: null, log: null };
const record: RunRecord = { ...base, state: "failed", action: null, reason: null, startedAt: 1, endedAt: 2, durationMs: 1, exitCode: 1, signal: null, log: "/o.log", lastLines: [], git: null, limitHit: null };

const AGENT = { agent: "claude", name: "Claude", provider: "claude" as const, mode: "normal", modeName: "Normal", sessionId: null, cwd: "/ws", startedAt: "2026-11-17T12:00:00.000Z", exit: "/exit", exitSentAt: null, worked: true, waiting: null, waitedMs: 0, background: null, answered: [], workedOn: false };

describe("runs in words", () => {
  it("says each state", () => {
    expect(runWords(active)).toBe("running");
    expect(runWords({ ...active, kind: "agent", agent: { ...AGENT, waiting: { prompt: "permission", since: 2 } } })).toBe("waiting for you");
    expect(runWords({ ...active, kind: "agent", agent: { ...AGENT, background: "idle" } })).toBe("running · waiting for the agent's background work");
    expect(runWords({ ...queued, waits: { kind: "previous-run" } })).toBe("queued · after the previous run");
    expect(runWords({ ...queued, waits: { kind: "keeper" } })).toBe("queued · a fresh keeper, after the runs going");
    expect(runWords({ ...queued, waits: { kind: "pomade" } })).toBe("queued · opening Pomade");
    expect(runWords({ ...queued, waits: { kind: "slot", ahead: 1 } })).toBe("queued · 1 ahead");
    expect(runWords({ ...queued, waits: { kind: "switch", position: "pause-low" } })).toBe("queued · held · Pause low-priority");
    expect(runWords({ ...queued, waits: { kind: "warm-up", until: null } })).toBe("queued · warm-up · services start first");
    expect(runWords({ ...queued, waits: { kind: "warm-up", until: new Date(2026, 10, 18, 8, 32).getTime() } })).toBe("queued · warm-up until 08:32");
    expect(runWords({ ...queued, waits: { kind: "time", at: new Date(2026, 10, 18, 23, 0).getTime() } })).toBe("queued · at Wed 23:00");
    expect(runWords(queued)).toBe("queued · starting");
    expect(runWords({ ...queued, state: "missed-waiting" })).toBe("missed · waiting for you");
    expect(runWords(record)).toBe("failed · exit 1");
    expect(runWords({ ...record, exitCode: null, signal: "SIGKILL" })).toBe("failed · SIGKILL");
    expect(runWords({ ...record, exitCode: null })).toBe("failed · ended");
    expect(runWords({ ...record, reason: "lost in a keeper crash" })).toBe("failed · lost in a keeper crash");
    expect(runWords({ ...record, state: "done" })).toBe("done");
    expect(runWords({ ...record, state: "stopped-by-you" })).toBe("stopped by you");
    expect(runWords({ ...record, state: "skipped", reason: "previous run still going" })).toBe("skipped · previous run still going");
    expect(runWords({ ...record, state: "skipped" })).toBe("skipped");
    expect(runWords({ ...record, state: "missed", reason: "skipped" })).toBe("missed · skipped");
    expect(runWords({ ...record, state: "missed", reason: null })).toBe("missed");
  });

  it("T-026 · says a run of a Run all as caught up n of N: it stands for one of the missed runs", () => {
    const missed = { count: 4, first: new Date(2026, 10, 18, 17, 40).getTime(), last: new Date(2026, 10, 18, 17, 46).getTime() };
    expect(runTriggerWords({ ...record, trigger: "caught-up", missed })).toBe("missed 4 runs, 17:40–17:46 · caught up once");
    expect(runTriggerWords({ ...record, trigger: "caught-up", missed, series: { n: 2, of: 4 } })).toBe("caught up 2 of 4");
  });

  it("T-026 · a caught-up run that ran for more than one missed run can run the others while it is its job's latest and no Run all of the job goes", () => {
    const missed = { count: 3, first: 1, last: 2 };
    const caught: RunRecord = { ...record, trigger: "caught-up", missed };
    expect(otherMissedRuns(caught, caught, [])).toBe(2);
    expect(otherMissedRuns(caught, { ...caught, run: "later" }, [])).toBe(0);
    expect(otherMissedRuns(caught, null, [])).toBe(0);
    expect(otherMissedRuns(caught, caught, [{ ...queued, job: caught.job, trigger: "caught-up", series: { n: 2, of: 3 } }])).toBe(0);
    expect(otherMissedRuns(caught, caught, [{ ...queued, job: caught.job }])).toBe(2);
    expect(otherMissedRuns({ ...caught, missed: { count: 1, first: 1, last: 1 } }, caught, [])).toBe(0);
    expect(otherMissedRuns({ ...caught, series: { n: 3, of: 3 } }, { ...caught, series: { n: 3, of: 3 } }, [])).toBe(0);
    expect(otherMissedRuns({ ...caught, trigger: "manual" }, { ...caught, trigger: "manual" }, [])).toBe(0);
    // One that never ran — missed past its worth-until — stood for them all: none of them ran.
    const never: RunRecord = { ...caught, state: "missed", startedAt: null };
    expect(otherMissedRuns(never, never, [])).toBe(0);
    expect(otherMissedRuns({ ...queued, trigger: "caught-up", missed }, caught, [])).toBe(0);
  });

  it("T-026 · checks a missed-run choice's answer: how many runs it made", () => {
    expect(isMissedChoiceResult({ ok: true, at: 5, runs: 3 })).toBe(true);
    expect(isMissedChoiceResult({ ok: true, at: null, runs: 0 })).toBe(true);
    expect(isMissedChoiceResult({ ok: false, reason: "no" })).toBe(true);
    for (const bad of [{ ok: true, at: 5 }, { ok: true, at: 5, runs: -1 }, { ok: true, at: 5, runs: 1.5 }]) expect(isMissedChoiceResult(bad)).toBe(false);
  });

  it("T-026 · checks a run's series; a record of an older build reads with none", () => {
    const { series: _series, ...older } = record;
    expect(parseRunRecord(older)).toEqual(record);
    expect(isActiveRun({ ...active, series: { n: 1, of: 3 } })).toBe(true);
    for (const series of [{ n: 0, of: 3 }, { n: 4, of: 3 }, { n: 1 }, "1/3", undefined]) expect(isActiveRun({ ...active, series })).toBe(false);
  });

  it("says a moment on this Mac's clock", () => {
    expect(clockTime(new Date(2026, 10, 17, 14, 2, 30).getTime())).toBe("14:02");
    expect(clockTime(new Date(2026, 10, 17, 7, 5).getTime())).toBe("07:05");
    expect(dayTime(new Date(2026, 10, 18, 13, 0).getTime())).toBe("Wed 13:00");
    expect(dayTime(new Date(2026, 10, 22, 7, 5).getTime())).toBe("Sun 07:05");
  });

  it("checks an active run's shape", () => {
    expect(isActiveRun(active)).toBe(true);
    expect(isActiveRun({ ...queued, runAt: 5, deadline: 9, waits: { kind: "time", at: 5 } })).toBe(true);
    expect(isActiveRun({ ...queued, kind: "agent", waits: { kind: "pomade" } })).toBe(true);
    expect(isActiveRun({ ...queued, trigger: "hook", cause: { kind: "hook", event: "login", context: {} } })).toBe(true);
    expect(isActiveRun({ ...queued, trigger: "chain", cause: { kind: "chain", job: "a", name: "A", run: "r", result: "failed" } })).toBe(true);
    for (const bad of [
      { ...active, lowPriority: undefined },
      { ...active, waits: { kind: "slot", ahead: 0 } },
      { ...active, waits: { kind: "nap" } },
      { ...active, waits: { kind: "switch", position: "running" } },
      { ...active, warningDismissed: null },
      { ...active, trigger: "cron" },
      { ...active, cause: undefined },
      { ...active, cause: { kind: "hook", event: "reboot", context: {} } },
      { ...active, cause: { kind: "hook", event: "login", context: { A: 1 } } },
      { ...active, cause: { kind: "chain", job: "a", name: "A", run: "r", result: "stopped-by-you" } },
    ]) {
      expect(isActiveRun(bad)).toBe(false);
    }
  });

  it("says a project's hooks as a run's cause", () => {
    const hook = (event: "project-first-open" | "project-opened", projectName?: string) => ({ kind: "hook" as const, event, context: {}, ...(projectName === undefined ? {} : { projectName }) });
    expect(hookCauseWords(hook("project-first-open", "shop"))).toBe("first open of shop");
    expect(hookCauseWords(hook("project-opened", "shop"))).toBe("shop opened");
    expect(hookCauseWords(hook("project-opened"))).toBe("a project opened");
  });

  it("says how long", () => {
    expect([0, 850, 1000, 12_400, 60_000, 184_000, 3_600_000, 7_500_000].map(durationWords)).toEqual(["0 ms", "850 ms", "1 s", "12 s", "1 min", "3 min 4 s", "1 h", "2 h 5 min"]);
  });
});

describe("routes", () => {
  it("name a run's result and output by the job id and run id, and read back", () => {
    expect(runRoute("blog/web", "20261117-120000-abcdef")).toBe("run/blog.web/20261117-120000-abcdef");
    expect(outputRoute("Café", "r1")).toBe("output/Caf_c3_a9/r1");
    expect(parseRoute(runRoute("blog/web", "20261117-120000-abcdef"))).toEqual({ view: "run", job: "blog/web", run: "20261117-120000-abcdef" });
    expect(parseRoute(outputRoute("Café", "r1"))).toEqual({ view: "output", job: "Café", run: "r1" });
    expect(promptRoute("blog/web", "r1")).toBe("prompt/blog.web/r1");
    expect(parseRoute(promptRoute("blog/web", "r1"))).toEqual({ view: "prompt", job: "blog/web", run: "r1" });
    expect(parseRoute("history")).toEqual({ view: "history", filter: null });
    expect(parseRoute("history/missed")).toEqual({ view: "history", filter: "missed" });
    expect(parseRoute("history/failed")).toEqual({ view: "jobs", job: null });
    expect(parseRoute("services")).toEqual({ view: "services" });
    expect(parseRoute("settings")).toEqual({ view: "settings" });
    for (const route of ["", "jobs", "run/x", "run/a_zz/r", "run//r", "nope/a/b", "jobs/a/b"]) expect(parseRoute(route)).toEqual({ view: "jobs", job: null });
    expect(jobsRoute("blog/notes")).toBe("jobs/blog.notes");
    expect(parseRoute(jobsRoute("blog/notes"))).toEqual({ view: "jobs", job: "blog/notes" });
    expect(parseRoute("jobs/a_zz")).toEqual({ view: "jobs", job: null });
  });

  it("open a run's output in its own keyed tab, one per run, whose key Pomade takes for any job id", () => {
    expect(outputTab("blog/web", "20261117-120000-abcdef", "Dev server")).toEqual({
      route: "output/blog.web/20261117-120000-abcdef",
      key: "out:blog.web:20261117-120000-abcdef",
      title: "Dev server · output",
      kind: "output",
    });
    expect(outputTabKey("blog/web", "20261117-120000-abcdef")).not.toBe(outputTabKey("blog/web", "20261117-120001-abcdef"));
    expect(outputTabKey("blog.web", "r")).not.toBe(outputTabKey("blog/web", "r"));
    const run = "20261117-120000-abcdef";
    for (const job of ["Café", "a b/c", "a".repeat(MAX_ENCODED_JOB_ID), "é".repeat(Math.floor(MAX_ENCODED_JOB_ID / 6))]) {
      expect(outputTabKey(job, run)).toMatch(APP_TAB_KEY_RE);
    }
  });

  it("name the job form: a new job, or a job by its id, and read back", () => {
    expect(newRoute()).toBe("new");
    expect(parseRoute(newRoute())).toEqual({ view: "new", project: null });
    expect(newRoute("blog")).toBe("new/blog");
    expect(parseRoute(newRoute("blog"))).toEqual({ view: "new", project: "blog" });
    expect(parseRoute(newRoute("Café"))).toEqual({ view: "new", project: "Café" });
    expect(editRoute("blog/dev-server")).toBe("edit/blog.dev-server");
    expect(parseRoute(editRoute("blog/dev-server"))).toEqual({ view: "edit", job: "blog/dev-server" });
    expect(parseRoute(editRoute("Café"))).toEqual({ view: "edit", job: "Café" });
    for (const route of ["edit", "edit/", "edit/a_zz", "edit/a/b", "new/", "new/a_zz", "new/a/b"]) expect(parseRoute(route)).toEqual({ view: "jobs", job: null });
  });
});

describe("isRunsReport", () => {
  it("checks a history page's shape: its held rows, then its records", () => {
    const held = { state: "held", job: "lint", name: "Lint", kind: "script", project: null, folder: "", missed: { count: 2, first: 1, last: 7 } };
    expect(isHistoryPage({ held: [held], records: [record], next: null })).toBe(true);
    expect(isHistoryPage({ held: [], records: [], next: "2026-11-17:3" })).toBe(true);
    for (const bad of [{ records: [], next: null }, { held: [{ ...held, state: "missed" }], records: [], next: null }, { held: [{ ...held, kind: "other" }], records: [], next: null }, { held: [{ ...held, missed: null }], records: [], next: null }]) {
      expect(isHistoryPage(bad)).toBe(false);
    }
    expect(heldRowWords({ count: 4, first: new Date(2026, 10, 17, 17, 40).getTime(), last: new Date(2026, 10, 17, 17, 46).getTime() })).toBe("held · 4 runs so far, 17:40–17:46");
  });

  it("checks a runs report's shape", () => {
    const report = {
      active: [active, { ...active, kind: "agent", agent: { ...AGENT, waiting: { prompt: "trust", since: 2 }, waitedMs: 5 } }],
      nextUp: [{ job: "a", name: "A", project: null, at: 5, held: true }],
      jobs: [{ job: "a", next: null, finished: true, last: record, held: false }],
      needsYou: [
        { id: "run-failed:a", kind: "run-failed", job: "a", name: "A", project: null, run: "r", at: 1, count: 1, detail: "exit 1" },
        { id: "service-failed:w", kind: "service-failed", job: "w", name: "W", project: null, at: 1, detail: "x", problem: null, session: true },
        { id: "missed:a", kind: "missed", job: "a", name: "A", project: null, run: "r", at: 1, missed: null, detail: "x" },
        { id: "long-run:a:r", kind: "long-run", job: "a", name: "A", project: null, run: "r", at: 2, startedAt: 1, detail: "x" },
        { id: "waiting:a:r", kind: "waiting", job: "a", name: "A", project: null, run: "r", prompt: "permission", at: 2, detail: "x" },
      ],
      switch: { position: "pause-low", since: 3 },
      heldRuns: 4,
    };
    expect(isRunsReport(report)).toBe(true);
    expect(isRunsReport({ ...report, active: [{ ...active, state: "missed-waiting", missed: { count: 4, first: 1, last: 7 } }] })).toBe(true);
    for (const bad of [
      { ...report, active: [{ ...active, state: "done" }] },
      { ...report, nextUp: [{ job: "a" }] },
      { ...report, nextUp: [{ job: "a", name: "A", project: null, at: 5 }] },
      { ...report, jobs: [{ job: "a", next: "soon", finished: true, last: null }] },
      { ...report, needsYou: [{ ...report.needsYou[0], count: "1" }] },
      { ...report, needsYou: [{ ...report.needsYou[1], kind: "other" }] },
      { ...report, needsYou: [{ ...report.needsYou[1], session: "yes" }] },
      { ...report, needsYou: [{ ...report.needsYou[1], problem: 3 }] },
      { ...report, needsYou: [{ ...report.needsYou[3], startedAt: null }] },
      { ...report, needsYou: [{ ...report.needsYou[4], prompt: "other" }] },
      { ...report, active: [{ ...active, agent: { ...AGENT, waiting: { prompt: "permission" } } }] },
      { ...report, active: [{ ...active, agent: { ...AGENT, waitedMs: null } }] },
      { ...report, switch: { position: "off", since: null } },
      { ...report, switch: undefined },
      { ...report, heldRuns: undefined },
      { ...report, heldRuns: -1 },
      { ...report, jobs: [{ job: "a", next: null, finished: true, last: record }] },
      { ...report, active: [{ ...active, missed: { count: 0, first: 1, last: 1 } }] },
      { ...report, active: [{ ...active, missed: { count: 2, first: 7, last: 1 } }] },
      { ...report, active: [{ ...active, missed: undefined }] },
      { active: [] },
    ]) {
      expect(isRunsReport(bad)).toBe(false);
    }
  });
});
