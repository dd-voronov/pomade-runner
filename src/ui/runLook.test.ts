import { describe, expect, it } from "vitest";

import type { ActiveRun, HeldRun, RunRecord, RunView, ServiceEvent } from "../scheduler/model";
import { promptLines, byDay, dayWords, filterCounts, itemKey, keeps, runDuration, runLook, runningSince, runTime, shortDuration, slotHolders, TRIGGER_HELP, waitsSentence, whenWords, whyWords, type HistoryItem } from "./runLook";

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
  agent: null,
  missed: null,
  series: null,
  state: "done",
  event: null,
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
  agent: null,
  missed: null,
  series: null,
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

const AGENT = { agent: "claude", name: "claude", provider: "claude" as const, mode: "normal", modeName: "Normal", sessionId: "s1", cwd: "/ws", startedAt: "2026-11-17T11:31:00.000Z", exit: "/exit", exitSentAt: null, worked: true, waitedMs: 0, background: null, answered: [], workedOn: false };

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
    [
      "waiting for you at a prompt",
      active({ kind: "agent", agent: { ...AGENT, waiting: { prompt: "permission", since: at(17, 12, 46) } } }),
      { tone: "warning", live: false, words: "waiting for you", help: "st.waiting", label: "Waiting for you", pill: "warning", cardTone: "warning", filter: "active" },
    ],
    ["an agent running, not waiting", active({ kind: "agent", agent: { ...AGENT, waiting: null } }), { tone: "accent", live: true, words: "running", help: "st.running" }],
    [
      "an agent's background work going",
      active({ kind: "agent", agent: { ...AGENT, waiting: null, background: "idle" } }),
      { tone: "accent", live: true, words: "running · waiting for the agent's background work", help: "st.background", label: "Running", pill: "accent", cardTone: undefined, filter: "active" },
    ],
    ["an agent at its background-work question", active({ kind: "agent", agent: { ...AGENT, waiting: null, background: "asked" } }), { tone: "accent", words: "running · waiting for the agent's background work", help: "st.background" }],
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

  it("a service event looks as the prototype's: its dot, words, pill and chip", () => {
    const event = (what: ServiceEvent["what"], cause: ServiceEvent["cause"], more: Partial<ServiceEvent> = {}, rest: Partial<RunRecord> = {}): RunRecord =>
      record({ kind: "service", startedAt: null, durationMs: null, exitCode: null, event: { what, cause, detail: null, session: null, ended: [], restarts: 0, ends: [], ...more }, ...rest });
    const look = (view: RunRecord): unknown => {
      const { tone, words, label, pill, cardTone, filter, plain } = runLook(view);
      return { tone, words, label, pill, cardTone, filter, plain };
    };
    expect(look(event("started", "you"))).toEqual({ tone: "ok", words: "started", label: "Started", pill: "ok", cardTone: undefined, filter: null, plain: undefined });
    expect(look(event("stopped", "pomade-quit"))).toEqual({ tone: "hollow", words: "stopped", label: "Stopped", pill: "muted", cardTone: undefined, filter: null, plain: undefined });
    expect(look(event("restarted", "chain"))).toEqual({ tone: "ring-ok", words: "restarted", label: "Restarted", pill: "accent", cardTone: undefined, filter: null, plain: undefined });
    expect(look(event("restarted", "crash", { restarts: 1, ends: [{ code: 137, signal: null }] }))).toEqual({ tone: "warning", words: "restarted · exit 137", label: "Restarted after a crash", pill: "warning", cardTone: "warning", filter: null, plain: true });
    expect(runLook(event("restarted", "crash", { restarts: 4, ends: [{ code: 1, signal: null }, { code: 137, signal: null }, { code: null, signal: "SIGKILL" }] })).words).toBe("restarted 4× · exit 1, 137, SIGKILL");
    expect(look(event("gave-up", "crash", {}, { state: "failed", exitCode: 1 }))).toEqual({ tone: "danger", words: "gave up after 5 crashes", label: "Gave up", pill: "danger", cardTone: "danger", filter: "failed", plain: undefined });
    expect(look(event("restarted", "chain", {}, { state: "skipped", reason: "it is not running" }))).toMatchObject({ tone: "hollow", words: "restart skipped · it is not running", filter: "missed" });
    expect(look(event("started", "chain", {}, { state: "failed", reason: "no such folder" }))).toMatchObject({ tone: "danger", words: "start failed · no such folder", filter: "failed" });
  });

  it("a git run's commit says what was done", () => {
    const git = record({
      kind: "git",
      git: { op: "commit-push", job: "K", at: "2026-11-17T12:00:00Z", results: [{ repo: "K", path: "/k", op: "commit-push", status: "done", reason: null, steps: [], commit: "a1b2c3d4e5f6" }] },
    });
    expect(runLook(git).words).toBe("done · a1b2c3d");
  });

  it("a done pull says what it got, summed over its repos: commits pulled, or up to date; unknown on any repo, plain done", () => {
    const pulled = (counts: (number | undefined)[], commit: string | null = null) =>
      record({
        kind: "git",
        git: {
          op: "pull",
          job: "P",
          at: "2026-11-17T12:00:00Z",
          results: counts.map((commits, index) => ({ repo: `r${index}`, path: `/r${index}`, op: "pull" as const, status: "done" as const, reason: null, commit: index === 0 ? commit : null, steps: [{ step: "pull" as const, outcome: "done" as const, detail: "pulled", ...(commits === undefined ? {} : { commits }) }] })),
        },
      });
    expect(runLook(pulled([2])).words).toBe("done · 2 commits pulled");
    expect(runLook(pulled([1])).words).toBe("done · 1 commit pulled");
    expect(runLook(pulled([0])).words).toBe("done · up to date");
    expect(runLook(pulled([2, 0, 3])).words).toBe("done · 5 commits pulled");
    expect(runLook(pulled([2, undefined])).words).toBe("done");
    expect(runLook(pulled([undefined])).words).toBe("done");
    // A commit & push: its commit, then what its pull got.
    expect(runLook(pulled([0], "a1b2c3d4e5f6")).words).toBe("done · a1b2c3d · up to date");
  });

  it("a run waiting for its agent's background work says so, with the clock too; a long-run warning asks over it", () => {
    const background = active({ kind: "agent", agent: { ...AGENT, waiting: null, background: "idle" }, startedAt: NOW - 60_000 });
    expect(runLook(background, NOW).words).toBe("running · waiting for the agent's background work");
    expect(runLook({ ...background, startedAt: NOW - 4 * 3_600_000, warnedAt: NOW - 60_000 }, NOW).words).toBe("running · 4h — still expected?");
  });

  it("a waiting run says it waits, over a long-run warning too", () => {
    const long = active({ kind: "agent", agent: { ...AGENT, waiting: { prompt: "trust", since: NOW } }, startedAt: NOW - 4 * 3_600_000, warnedAt: NOW - 60_000 });
    expect(runLook(long, NOW).words).toBe("waiting for you");
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

describe("a held row: a job's runs the switch holds so far", () => {
  const held: HeldRun = { state: "held", job: "lint", name: "Lint", kind: "script", project: null, folder: "", missed: { count: 2, first: at(17, 12, 40), last: at(17, 12, 42) } };

  it("reads held, amber, and keeps to Skipped & missed — never Active or Failed", () => {
    expect(runLook(held, NOW)).toMatchObject({ tone: "warning", live: false, words: "held · 2 runs so far, 12:40–12:42", help: "sw.held", label: "Held", filter: "missed" });
    expect(runLook({ ...held, missed: { count: 1, first: at(17, 12, 42), last: at(17, 12, 42) } }).words).toBe("held · 1 run so far, 12:42");
    expect(runLook({ ...held, missed: { count: 3, first: at(16, 23, 58), last: at(17, 0, 2) } }).words).toBe("held · 3 runs so far, Mon 23:58–Tue 00:02");
    const items: HistoryItem[] = [held, record({ state: "missed", startedAt: null }), active()];
    expect(filterCounts(items)).toEqual({ active: 1, failed: 0, missed: 2 });
    expect(items.filter((item) => keeps("missed", item)).map((item) => item.state)).toEqual(["held", "missed"]);
  });

  it("shows at its latest held run, among the runs by time, with no duration and a key of its own", () => {
    expect(runTime(held)).toBe(at(17, 12, 42));
    expect(runDuration(held, NOW)).toBeNull();
    expect(itemKey(held)).toBe("lint/held");
    const days = byDay<HistoryItem>([record({ run: "a", startedAt: at(17, 12, 30) }), held, active({ run: "b", startedAt: at(17, 12, 45) })], NOW);
    expect(days.map((day) => day.runs.map(itemKey))).toEqual([["lint/b", "lint/held", "backup/a"]]);
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

  it("counts a time from the start of the runs that are going, and no other", () => {
    expect(runningSince([active({ startedAt: 5000 }), active({ state: "queued", startedAt: null }), record({ durationMs: 8000 }), active({ state: "missed-waiting", startedAt: null }), active({ startedAt: 9000 })])).toEqual([5000, 9000]);
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
    expect(waitsSentence({ kind: "keeper" }, NOW)).toBe(
      "The keeper cannot reach the macOS keychain, so an agent started there would have no login. Runner starts a fresh keeper once the runs going have finished, then this run.",
    );
    expect(waitsSentence({ kind: "pomade" }, NOW)).toBe("An agent run needs Pomade, so Runner is opening it. The run starts once Pomade and the Agents app are ready.");
    expect(waitsSentence(null, NOW)).toBe("It is about to start.");
  });

  it("a run waiting for a slot names the low-priority runs holding the slots, as the prototype's card does", () => {
    expect(waitsSentence({ kind: "slot", ahead: 1 }, NOW, ["Wiki lint", "Photo backup"])).toBe("Two low-priority runs are going (Wiki lint, Photo backup). This one starts when one of them finishes.");
    expect(waitsSentence({ kind: "slot", ahead: 1 }, NOW, ["Wiki lint"])).toBe("One low-priority run is going (Wiki lint). This one starts when it finishes.");
    expect(waitsSentence({ kind: "slot", ahead: 3 }, NOW, ["A", "B"])).toBe("Two low-priority runs are going (A, B). This one starts once 3 runs ahead of it have finished.");
    const going = [
      active({ name: "Wiki lint" }),
      active({ name: "Normal", lowPriority: false }),
      active({ name: "Queued", state: "queued", startedAt: null }),
      active({ name: "At a prompt", agent: { ...AGENT, waiting: { prompt: "permission", since: at(17, 12, 31) } } }),
      record({ name: "Ended" }),
    ];
    expect(slotHolders(going)).toEqual(["Wiki lint"]);
  });
});

describe("what a waiting card shows of the agent's output", () => {
  it("starts at the step that asks, and drops the blank end", () => {
    expect(promptLines(["● Read 14 files", "● Moving 14 notes", "", "  Do you want to proceed?", "  ❯ 1. Yes", "", ""])).toEqual(["● Moving 14 notes", "", "  Do you want to proceed?", "  ❯ 1. Yes"]);
  });

  it("without a marked step, starts at the first line that is not blank, within the last 14", () => {
    const lines = ["", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
    expect(promptLines(lines)).toEqual(lines.slice(-14));
    expect(promptLines(["", "", "Press enter to confirm"])).toEqual(["Press enter to confirm"]);
    expect(promptLines(["", " "])).toEqual([]);
  });
});
