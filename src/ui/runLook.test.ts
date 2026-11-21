import { describe, expect, it } from "vitest";

import type { ActiveRun, RunRecord, RunView } from "../scheduler/model";
import { byDay, dayWords, filterCounts, keeps, runDuration, runLook, runTime, shortDuration, TRIGGER_HELP, waitsSentence, whenWords, whyWords } from "./runLook";

/** Tue 17 Nov 2026, 12:48 — the prototype's "now". */
const NOW = new Date(2026, 10, 17, 12, 48).getTime();
const at = (day: number, hours: number, minutes: number): number => new Date(2026, 10, day, hours, minutes).getTime();

const record = (extra: Partial<RunRecord> = {}): RunRecord => ({
  job: "backup",
  name: "Backup",
  kind: "script",
  project: null,
  folder: "",
  run: "20261117-120000-abcdef",
  trigger: "scheduled",
  cause: null,
  dueAt: at(17, 12, 0),
  state: "done",
  action: null,
  reason: null,
  startedAt: at(17, 12, 0),
  endedAt: at(17, 12, 0) + 2000,
  durationMs: 2000,
  exitCode: 0,
  signal: null,
  log: "/ud/r.log",
  lastLines: [],
  git: null,
  limitHit: null,
  ...extra,
});

const active = (extra: Partial<ActiveRun> = {}): ActiveRun => ({
  job: "lint",
  name: "Lint",
  kind: "script",
  project: null,
  folder: "",
  run: "20261117-124500-aaaaaa",
  trigger: "scheduled",
  cause: null,
  dueAt: at(17, 12, 45),
  state: "running",
  lowPriority: true,
  runAt: null,
  deadline: null,
  waits: null,
  startedAt: at(17, 12, 45),
  session: "run:lint:x",
  log: "/ud/l.log",
  limitHit: null,
  warnedAt: null,
  warningDismissed: false,
  ...extra,
});

describe("a run's status: tone, words, help, pill, chip", () => {
  const cases: [string, RunView, Partial<ReturnType<typeof runLook>>][] = [
    ["done", record(), { tone: "ok", words: "done", help: "st.done", label: "Done", pill: "ok", cardTone: undefined, filter: null }],
    ["failed", record({ state: "failed", exitCode: 1 }), { tone: "danger", words: "failed · exit 1", help: "st.failed", label: "Failed", pill: "danger", cardTone: "danger", filter: "failed" }],
    [
      "stopped at its time limit",
      record({ state: "failed", reason: "stopped: time limit, 45 min", exitCode: null, signal: "SIGTERM", limitHit: 45 }),
      { tone: "danger", words: "stopped: time limit, 45 min", help: "st.limit", label: "Stopped: time limit", pill: "danger", cardTone: "danger", filter: "failed" },
    ],
    ["running", active(), { tone: "accent", live: true, words: "running", help: "st.running", label: "Running", filter: "active" }],
    ["queued", active({ state: "queued", startedAt: null, waits: { kind: "slot", ahead: 1 } }), { tone: "hollow", words: "queued · 1 ahead", help: "st.queued", label: "Queued", filter: "active" }],
    ["missed-waiting", active({ state: "missed-waiting", startedAt: null }), { tone: "warning", words: "missed · waiting for you", help: "st.missed", label: "Missed · waiting for you", pill: "warning", cardTone: "warning", filter: "missed" }],
    ["skipped", record({ state: "skipped", reason: "previous run still going", startedAt: null, durationMs: null }), { tone: "hollow", words: "skipped · previous run still going", help: "st.skipped", label: "Skipped", filter: "missed" }],
    ["missed", record({ state: "missed", reason: "skipped", startedAt: null, durationMs: null }), { tone: "hollow", words: "missed · skipped", help: "st.missed", label: "Missed · skipped", filter: "missed" }],
    ["stopped by you", record({ state: "stopped-by-you", exitCode: 130 }), { tone: "hollow", words: "stopped by you", help: "st.byyou", label: "Stopped by you", filter: null }],
  ];
  for (const [name, view, look] of cases) {
    it(name, () => {
      expect(runLook(view)).toMatchObject(look);
    });
  }

  it("a chain's action on a service and a git run's commit say what was done", () => {
    expect(runLook(record({ kind: "service", action: "restart", startedAt: null, durationMs: null })).words).toBe("done · restarted");
    const git = record({
      kind: "git",
      git: { op: "commit-push", job: "K", at: "2026-11-17T12:00:00Z", results: [{ repo: "K", path: "/k", op: "commit-push", status: "done", reason: null, steps: [], commit: "a1b2c3d4e5f6" }] },
    });
    expect(runLook(git).words).toBe("done · a1b2c3d");
  });

  it("a long-run warning asks whether the run is still expected, until it is dismissed", () => {
    const long = active({ startedAt: NOW - (3 * 60 + 2) * 60_000, warnedAt: NOW - 60_000 });
    expect(runLook(long, NOW).words).toBe("running · 3h — still expected?");
    expect(runLook({ ...long, warningDismissed: true }, NOW).words).toBe("running");
    expect(runLook(long).words).toBe("running");
  });
});

describe("History's result chips", () => {
  const views: RunView[] = [
    record(),
    record({ state: "failed", exitCode: 1 }),
    record({ state: "failed", reason: "stopped: time limit, 45 min", exitCode: null, limitHit: 45 }),
    active(),
    active({ state: "queued", startedAt: null }),
    active({ state: "missed-waiting", startedAt: null }),
    record({ state: "skipped", startedAt: null }),
    record({ state: "missed", startedAt: null }),
    record({ state: "stopped-by-you" }),
  ];

  it("count the runs each keeps", () => {
    expect(filterCounts(views)).toEqual({ active: 2, failed: 2, missed: 3 });
  });

  it("All keeps every run; each other chip its own", () => {
    expect(views.filter((view) => keeps("all", view))).toHaveLength(views.length);
    expect(views.filter((view) => keeps("active", view)).map((view) => view.state)).toEqual(["running", "queued"]);
    expect(views.filter((view) => keeps("failed", view)).map((view) => view.state)).toEqual(["failed", "failed"]);
    expect(views.filter((view) => keeps("missed", view)).map((view) => view.state)).toEqual(["missed-waiting", "skipped", "missed"]);
  });
});

describe("History's days and times", () => {
  it("a day's head: Today, Yesterday, then the weekday and date", () => {
    expect([at(17, 0, 5), at(16, 23, 59), at(15, 3, 0), at(13, 7, 0), at(20, 9, 0)].map((epoch) => dayWords(epoch, NOW))).toEqual(["Today", "Yesterday", "Sun 15 Nov", "Fri 13 Nov", "Fri 20 Nov"]);
    expect(whenWords(at(15, 3, 0), NOW)).toBe("Sun 15 Nov 3:00");
    expect(whenWords(at(17, 8, 32), NOW)).toBe("Today 8:32");
  });

  it("a run shows when it started, or one that has not when it was due", () => {
    expect(runTime(record({ dueAt: at(17, 7, 0), startedAt: at(17, 8, 32) }))).toBe(at(17, 8, 32));
    expect(runTime(record({ dueAt: at(17, 7, 0), startedAt: null }))).toBe(at(17, 7, 0));
  });

  it("groups the runs by day, newest first; the runs going take their place by time", () => {
    const days = byDay(
      [
        record({ run: "a", startedAt: at(16, 20, 0) }),
        active({ run: "b", startedAt: at(17, 12, 45) }),
        record({ run: "c", startedAt: at(17, 9, 14) }),
        active({ run: "d", state: "missed-waiting", startedAt: null, dueAt: at(15, 3, 0) }),
        active({ run: "e", startedAt: at(17, 9, 46) }),
      ],
      NOW,
    );
    expect(days.map((day) => [day.day, day.runs.map((view) => view.run)])).toEqual([
      ["Today", ["b", "e", "c"]],
      ["Yesterday", ["a"]],
      ["Sun 15 Nov", ["d"]],
    ]);
  });

  it("durations as the column says them; none for a run that never started", () => {
    expect([850, 2000, 59_000, 3 * 60_000, 4 * 60_000 + 12_000, 45 * 60_000, (3 * 60 + 2) * 60_000].map(shortDuration)).toEqual(["1s", "2s", "59s", "3m", "4m 12s", "45m", "3h 02m"]);
    expect(runDuration(record({ durationMs: 8000 }), NOW)).toBe(8000);
    expect(runDuration(record({ durationMs: null }), NOW)).toBeNull();
    expect(runDuration(active({ startedAt: NOW - 180_000 }), NOW)).toBe(180_000);
    expect(runDuration(active({ state: "queued", startedAt: null }), NOW)).toBeNull();
  });
});

describe("what started a run, and what a queued one waits for", () => {
  it("each trigger has its help", () => {
    expect(TRIGGER_HELP).toEqual({ scheduled: "tr.scheduled", "caught-up": "tr.caught up", manual: "tr.manual", hook: "tr.hook", chain: "tr.chain" });
  });

  it("the card's why line: a hook's event, a caught-up run's missed time; none otherwise", () => {
    expect(whyWords(record({ trigger: "hook", cause: { kind: "hook", event: "login", context: {} } }), NOW)).toBe("Mac login");
    expect(whyWords(record({ trigger: "caught-up", dueAt: at(17, 7, 0) }), NOW)).toBe("Missed 7:00 — caught up after wake");
    expect(whyWords(record({ trigger: "caught-up", dueAt: at(16, 7, 0) }), NOW)).toBe("Missed yesterday 7:00 — caught up after wake");
    expect(whyWords(record(), NOW)).toBeNull();
  });

  it("a queued run's card says what it waits for", () => {
    expect(waitsSentence({ kind: "slot", ahead: 1 }, NOW)).toBe("Low-priority runs are going in every free slot — 1 run ahead. This one starts when one of them finishes.");
    expect(waitsSentence({ kind: "slot", ahead: 2 }, NOW)).toContain("2 runs ahead");
    expect(waitsSentence({ kind: "time", at: at(17, 23, 0) }, NOW)).toBe("It runs at the time you picked: today 23:00.");
    expect(waitsSentence({ kind: "switch", position: "pause-low" }, NOW)).toBe("The switch is at Pause low-priority, so it waits. It runs once the switch is back at Running.");
    expect(waitsSentence({ kind: "warm-up", until: at(17, 8, 32) }, NOW)).toBe("It waits for the warm-up after login or wake, until 8:32.");
    expect(waitsSentence({ kind: "warm-up", until: null }, NOW)).toBe("It waits for the warm-up after login or wake: the services start first.");
    expect(waitsSentence({ kind: "previous-run" }, NOW)).toBe("The job's previous run is still going. This one starts when it finishes.");
    expect(waitsSentence(null, NOW)).toBe("It is about to start.");
  });
});
