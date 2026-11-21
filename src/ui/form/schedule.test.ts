import { parseSchedule } from "pomade-kit/schedule";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { checkJobs } from "../../jobs/check";
import { describeJobError } from "../../jobs/format";
import type { JobsSnapshot, ProjectRecord } from "../../jobs/model";
import { blankSchedule, dayWords, nextTime, readOncePhrase, scheduleInput, schedulePreview, scheduleTarget, whenWords, type ScheduleValues } from "./schedule";
import { blocksSave, editForm, errorPlace, errorsByPlace, fieldChanges, formErrors, hasChanges, newForm, setFolder, setValue, switchKind, wouldBe, type FormState } from "./state";

const PROJECTS: ProjectRecord[] = [{ id: "p-coda", name: "coda-helper", root: "Projects/coda-helper" }];
const EMPTY: JobsSnapshot = checkJobs([], { workspace: "/ws", projects: PROJECTS });
/** Tue 17 Nov 2026, 12:48 — the prototype's clock. */
const NOW = new Date(2026, 10, 17, 12, 48);

/** A script job file with `schedule` as its block's lines, a comment before and after, and a body. */
const scriptFile = (schedule: string): string => `---\nkind: script # tidy\nname: Tidy\nfolder: .\ncommand: ./tidy.sh\n${schedule}\nnotify: always # say so\n---\nNotes.\n`;

const PATH = "Apps/pomade-runner/jobs/tidy.md";

function edit(text: string): FormState {
  const state = editForm(PATH, text);
  if (state === null) throw new Error("not editable");
  return state;
}

/** The schedule a job file's text holds, as the kit reads it. */
function scheduleOf(text: string): unknown {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const fields = parse(match?.[1] ?? "") as Record<string, unknown>;
  const read = parseSchedule(fields.schedule, { resolution: "time" });
  return read.ok ? read.schedule : read.errors;
}

/** A value as YAML writes it: a mapping's `null` entries left out. */
function withoutNulls(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]: [string, unknown]) => (item === null ? [] : [[key, withoutNulls(item)]])));
}

/** Every shape the format has, as the kit's canonical lines, with the filter where it applies. */
const SHAPES: Record<string, string> = {
  "once at": "schedule:\n  once: 2026-11-20 23:00",
  "every N minutes": "schedule:\n  every: { minutes: 30 }",
  "every N hours within hours, weekdays only": "schedule:\n  every: { hours: 2, from: 9:00, to: 19:00 }\n  only: weekdays",
  "every N minutes from a time on": "schedule:\n  every: { minutes: 15, from: 8:00 }",
  "daily at one time": "schedule:\n  daily: { at: 7:00 }",
  "daily at several times, weekends only": "schedule:\n  daily: { at: [9:00, 13:00, 20:00] }\n  only: weekends",
  "weekly on chosen days": "schedule:\n  weekly: { days: [mon, wed, fri], at: 7:30 }",
  "monthly on days, the last day and the first Monday": "schedule:\n  monthly: { days: [1, 15, last, first mon], at: 9:00 }",
  "monthly in some months, with start and end": "schedule:\n  monthly: { days: [last fri], months: [jan, jul], at: [8:00, 18:00] }\n  start: 2026-01-01\n  end: 2027-12-31",
};

describe("the schedule round-trips: file → form → file", () => {
  for (const [shape, lines] of Object.entries(SHAPES)) {
    it(`${shape}: unchanged when nothing was edited, and the same schedule when it is written again`, () => {
      const text = scriptFile(lines);
      expect(formErrors(edit(text), EMPTY, PROJECTS)).toEqual([]);
      const state = edit(text);
      expect(state.values.trigger).toBe("schedule");
      expect(hasChanges(state)).toBe(false);
      // Set again as it is: nothing to write.
      expect(fieldChanges(setValue(state, "schedule", { ...state.values.schedule }))).toEqual({});
      // Written from the form's values — one more entry makes it write — the schedule's lines come
      // out as the kit's canonical ones, and the kit reads the very schedule the file had.
      const rewritten = wouldBe(setValue(state, "schedule", { ...state.values.schedule, kept: { ...state.values.schedule.kept, x: "y" } }), EMPTY, PROJECTS).text;
      expect(rewritten).toBe(text.replace(lines, `${lines}\n  x: y`));
      const again = parseSchedule(withoutNulls(scheduleInput(state.values.schedule)), { resolution: "time" });
      expect(again.ok ? again.schedule : again.errors).toEqual(scheduleOf(text));
    });
  }

  it("reads each shape into the editor's values", () => {
    const values = (lines: string): ScheduleValues => edit(scriptFile(lines)).values.schedule;
    expect(values(SHAPES["once at"] ?? "")).toMatchObject({ shape: "once", onceDate: "2026-11-20", onceTime: "23:00" });
    expect(values(SHAPES["every N hours within hours, weekdays only"] ?? "")).toMatchObject({ shape: "every", every: "2", unit: "hours", within: true, from: "9:00", to: "19:00", filter: "weekdays" });
    expect(values(SHAPES["every N minutes"] ?? "")).toMatchObject({ shape: "every", every: "30", unit: "minutes", within: false });
    expect(values(SHAPES["daily at several times, weekends only"] ?? "")).toMatchObject({ shape: "daily", times: ["9:00", "13:00", "20:00"], filter: "weekends" });
    expect(values(SHAPES["weekly on chosen days"] ?? "")).toMatchObject({ shape: "weekly", days: ["mon", "wed", "fri"], times: ["7:30"] });
    expect(values(SHAPES["monthly on days, the last day and the first Monday"] ?? "")).toMatchObject({ shape: "monthly", monthDays: [1, 15, "last", { nth: 1, weekday: "mon" }], times: ["9:00"] });
    expect(values(SHAPES["monthly in some months, with start and end"] ?? "")).toMatchObject({ monthDays: [{ nth: "last", weekday: "fri" }], monthsKept: ["jan", "jul"], kept: { start: "2026-01-01", end: "2027-12-31" } });
  });
});

describe("editing the schedule writes the schedule field only", () => {
  const DAILY = scriptFile("schedule:\n  daily: { at: 7:00 } # before the standup");

  it("a new time: the schedule's lines are rewritten, comments elsewhere and the body stay", () => {
    const state = edit(DAILY);
    const next = setValue(state, "schedule", { ...state.values.schedule, times: ["7:00", "13:00"], filter: "weekdays" });
    expect(fieldChanges(next)).toEqual({ schedule: { daily: { at: ["7:00", "13:00"] }, only: "weekdays" } });
    expect(wouldBe(next, EMPTY, PROJECTS).text).toBe(scriptFile("schedule:\n  daily: { at: [7:00, 13:00] }\n  only: weekdays"));
  });

  it("another shape: the old shape and a filter it does not take go; what the file had besides stays", () => {
    const state = edit(scriptFile("schedule:\n  daily: { at: 7:00 }\n  only: weekdays\n  end: 2027-01-01"));
    const weekly = setValue(state, "schedule", { ...state.values.schedule, shape: "weekly", days: ["sat"] });
    expect(wouldBe(weekly, EMPTY, PROJECTS).text).toBe(scriptFile("schedule:\n  weekly: { days: [sat], at: 7:00 }\n  end: 2027-01-01"));
    expect(formErrors(weekly, EMPTY, PROJECTS)).toEqual([]);
  });

  it("each shape a new job gets: the file the kit and the checker accept", () => {
    const base = setFolder(setValue(setValue(switchKind(newForm("service"), "script"), "name", "Tidy"), "command", "./tidy.sh"), ".", PROJECTS);
    const cases: [Partial<ScheduleValues>, string][] = [
      [{}, "schedule:\n  daily: { at: 9:00 }"],
      [{ shape: "once", onceDate: "2026-11-20", onceTime: "23:00" }, "schedule:\n  once: 2026-11-20 23:00"],
      [{ shape: "every", every: "30", within: true, from: "9:00", to: "19:00", filter: "weekdays" }, "schedule:\n  every: { minutes: 30, from: 9:00, to: 19:00 }\n  only: weekdays"],
      [{ shape: "every", every: "2", unit: "hours" }, "schedule:\n  every: { hours: 2 }"],
      [{ shape: "daily", times: ["13:00", "20:00"], filter: "weekends" }, "schedule:\n  daily: { at: [13:00, 20:00] }\n  only: weekends"],
      [{ shape: "weekly", days: ["fri", "mon"], times: ["7:00"], filter: "weekdays" }, "schedule:\n  weekly: { days: [mon, fri], at: 7:00 }"],
      [{ shape: "monthly", monthDays: [{ nth: 1, weekday: "mon" }, "last", 15, 1], times: ["9:00"] }, "schedule:\n  monthly: { days: [1, 15, last, first mon], at: 9:00 }"],
      [{ shape: "monthly", monthDays: [{ nth: "last", weekday: "fri" }, { nth: 3, weekday: "wed" }] }, "schedule:\n  monthly: { days: [third wed, last fri], at: 9:00 }"],
    ];
    for (const [schedule, lines] of cases) {
      const state = setValue(base, "schedule", { ...blankSchedule(), ...schedule });
      expect(wouldBe(state, EMPTY, PROJECTS).text).toBe(`---\nkind: script\nname: Tidy\nfolder: .\nenabled: true\ncommand: ./tidy.sh\n${lines}\n---\n`);
      expect(formErrors(state, EMPTY, PROJECTS)).toEqual([]);
    }
  });
});

describe("the checker's schedule errors land on the control that caused them", () => {
  const base = setFolder(setValue(setValue(switchKind(newForm("service"), "script"), "name", "Tidy"), "command", "./tidy.sh"), ".", PROJECTS);
  const errorsOf = (schedule: Partial<ScheduleValues>): { field: string; text: string; target: string }[] =>
    formErrors(setValue(base, "schedule", { ...blankSchedule(), ...schedule }), EMPTY, PROJECTS).map((error) => ({ field: error.field, text: describeJobError(error), target: scheduleTarget(error.field) }));

  it("a time that is not one, on that time", () => {
    expect(errorsOf({ times: ["13:00", "25:00"] })).toEqual([
      { field: "schedule.daily.at[1]", text: 'schedule.daily.at[1] — "25:00" is not a time. Fix: write a time like 7:00 or 13:30 (H:MM, 24-hour).', target: "time:1" },
    ]);
    // One time is written alone, so the error names the times: each time shows it.
    expect(errorsOf({ times: ["noon"] })[0]?.target).toBe("times");
    expect(errorsOf({ times: ["", "13:00"] })[0]?.target).toBe("time:0");
  });

  it("each shape's own controls", () => {
    expect(errorsOf({ shape: "every", every: "0" }).map((one) => one.target)).toEqual(["every"]);
    expect(errorsOf({ shape: "every", every: "x" }).map((one) => one.target)).toEqual(["every"]);
    expect(errorsOf({ shape: "every", within: true, from: "19:00", to: "9:00" })).toEqual([{ field: "schedule.every.to", text: "schedule.every.to — 9:00 is not after from (19:00). Fix: the window runs within one day.", target: "to" }]);
    expect(errorsOf({ shape: "every", within: true, from: "9", to: "19:00" }).map((one) => one.target)).toEqual(["from"]);
    expect(errorsOf({ shape: "weekly", days: [] })).toEqual([{ field: "schedule.weekly.days", text: "schedule.weekly.days — empty. Fix: list at least one a weekday (mon, tue, wed, thu, fri, sat or sun).", target: "days" }]);
    expect(errorsOf({ shape: "monthly", monthDays: [] }).map((one) => one.target)).toEqual(["monthDays"]);
    expect(errorsOf({ shape: "once", onceDate: "2026-11-20", onceTime: "" }).map((one) => [one.target, one.text])).toEqual([["once", "schedule.once — needs a time. Fix: write it like 2026-11-20 23:00."]]);
    expect(errorsOf({ shape: "once", onceDate: "2026-11-20", onceTime: "24:00" }).map((one) => one.target)).toEqual(["once"]);
  });

  it("all on the schedule's place, which keeps a new job's Save", () => {
    const state = setValue(base, "schedule", { ...blankSchedule(), times: ["25:00"] });
    const errors = formErrors(state, EMPTY, PROJECTS);
    expect(errors.map((error) => errorPlace(error, state.values))).toEqual(["schedule"]);
    expect(blocksSave(state, "schedule")).toBe(true);
  });

  it("targets from every path the kit names", () => {
    expect(scheduleTarget("schedule")).toBe("shape");
    expect(scheduleTarget("schedule.daily")).toBe("shape");
    expect(scheduleTarget("schedule.only")).toBe("filter");
    expect(scheduleTarget("schedule.weekly.at")).toBe("times");
    expect(scheduleTarget("schedule.monthly.at[2]")).toBe("time:2");
    expect(scheduleTarget("schedule.monthly.days[0]")).toBe("monthDays");
    expect(scheduleTarget("schedule.every.hours")).toBe("every");
    expect(scheduleTarget("schedule.every.from")).toBe("from");
  });

  it("a filter the shape does not take, from a hand-edited file, is the schedule's", () => {
    const state = edit(scriptFile("schedule:\n  weekly: { days: [mon], at: 7:00 }\n  only: weekdays"));
    const [error] = formErrors(state, EMPTY, PROJECTS);
    expect(error === undefined ? null : [error.field, scheduleTarget(error.field), errorPlace(error, state.values)]).toEqual(["schedule.only", "filter", "schedule"]);
    // The form shows the file's days and times; picking the filter's own shape mends it.
    expect(state.values.schedule).toMatchObject({ shape: "weekly", days: ["mon"], filter: "weekdays" });
    expect(formErrors(setValue(state, "schedule", { ...state.values.schedule, shape: "daily" }), EMPTY, PROJECTS)).toEqual([]);
  });
});

describe("the schedule in words and its next runs", () => {
  const preview = (lines: string): unknown => schedulePreview(scriptFile(lines), NOW);
  const words = (lines: string): unknown => {
    const read = schedulePreview(scriptFile(lines), NOW);
    return read === null ? null : { words: read.words, next: read.next.map((at) => whenWords(at, NOW)) };
  };

  it("each shape, from the kit's words and engine", () => {
    expect(words("schedule:\n  every: { minutes: 30, from: 9:00, to: 19:00 }\n  only: weekdays")).toEqual({ words: "every 30 min on weekdays, 9:00–19:00", next: ["today 13:00", "today 13:30", "today 14:00"] });
    expect(words("schedule:\n  daily: { at: [13:00, 20:00] }")).toEqual({ words: "daily at 13:00 and 20:00", next: ["today 13:00", "today 20:00", "tomorrow 13:00"] });
    expect(words("schedule:\n  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }")).toEqual({ words: "weekdays at 7:00", next: ["tomorrow 7:00", "Thu 7:00", "Fri 7:00"] });
    expect(words("schedule:\n  monthly: { days: [1, 15, last, first mon], at: 9:00 }")).toEqual({ words: "monthly on the 1st, 15th, the last day and the first Monday at 9:00", next: ["Mon 30 Nov 9:00", "Tue 1 Dec 9:00", "Mon 7 Dec 9:00"] });
    expect(words("schedule:\n  once: 2026-11-17 23:00")).toEqual({ words: "once, today at 23:00", next: ["today 23:00"] });
    expect(words("schedule:\n  daily: { at: 7:00 }\n  only: weekends")).toEqual({ words: "weekends at 7:00", next: ["Sat 7:00", "Sun 7:00", "Sat 28 Nov 7:00"] });
  });

  it("a once in the past has no next run; a schedule the checker refuses has no words", () => {
    expect(words("schedule:\n  once: 2026-11-16 23:00")).toEqual({ words: "once on Nov 16, 2026 at 23:00", next: [] });
    expect(preview("schedule:\n  daily: { at: 25:00 }")).toBeNull();
    expect(preview("schedule:\n  always: true")).toBeNull();
    expect(schedulePreview("---\nkind: [x\n---\n", NOW)).toBeNull();
  });

  it("days relative to today, and a far date with its year", () => {
    expect(dayWords("2026-11-17", NOW)).toBe("today");
    expect(dayWords("2026-11-18", NOW)).toBe("tomorrow");
    expect(dayWords("2026-11-23", NOW)).toBe("Mon");
    expect(dayWords("2026-11-24", NOW)).toBe("Tue 24 Nov");
    expect(dayWords("2027-01-05", NOW)).toBe("Tue 5 Jan 2027");
  });
});

describe("a once schedule typed in words", () => {
  it("reads the kit's date phrases", () => {
    expect(readOncePhrase("tonight 23:00", NOW)).toEqual({ date: "2026-11-17", time: "23:00" });
    expect(readOncePhrase("tomorrow 7:00", NOW)).toEqual({ date: "2026-11-18", time: "7:00" });
    expect(readOncePhrase("+2h", NOW)).toEqual({ date: "2026-11-17", time: "14:48" });
    expect(readOncePhrase("fri", NOW)).toEqual({ date: "2026-11-20" });
    expect(readOncePhrase("whenever", NOW)).toBeNull();
    expect(readOncePhrase("tomorrow 25:00", NOW)).toBeNull();
  });
});

describe("the times editor's next time", () => {
  it("is seven hours after the last, while that is still the same day", () => {
    expect(nextTime(["9:00"])).toBe("16:00");
    expect(nextTime(["13:00", "16:59"])).toBe("23:59");
    expect(nextTime(["17:00"])).toBe("");
    expect(nextTime(["25:00"])).toBe("");
  });
});

describe("a script whose trigger is a hook or a chain", () => {
  const HOOK = "---\nkind: script\nname: Mount\nfolder: .\ncommand: ./mount.sh\nhook: { event: login } # once per login\n---\n";

  it("keeps it: the form writes no schedule, and an edit leaves the hook as it is", () => {
    const state = edit(HOOK);
    expect(state.values.trigger).toBe("hook");
    const next = setValue(state, "command", "./mount-all.sh");
    expect(fieldChanges(next)).toEqual({ command: "./mount-all.sh" });
    expect(wouldBe(next, EMPTY, PROJECTS).text).toBe(HOOK.replace("./mount.sh", "./mount-all.sh"));
    expect(edit(HOOK.replace("hook: { event: login } # once per login", "after: { job: backup }")).values.trigger).toBe("chain");
  });

  it("a chain that loops back shows the checker's message on the chain's job, and Save refuses it", () => {
    const a = "---\nkind: script\nname: A\nfolder: .\ncommand: ./a.sh\nafter: { job: b }\n---\n";
    const b = "---\nkind: script\nname: B\nfolder: .\ncommand: ./b.sh\nafter: { job: a }\n---\n";
    const snapshot = checkJobs(
      [
        { path: "a.md", text: a },
        { path: "b.md", text: b },
      ],
      { workspace: "/ws", projects: PROJECTS },
    );
    const state = editForm("Apps/pomade-runner/jobs/a.md", a);
    if (state === null) throw new Error("not editable");
    const places = errorsByPlace(formErrors(setValue(state, "command", "./a2.sh"), snapshot, PROJECTS), state.values);
    expect(places.get("chainJob")?.map(describeJobError)).toEqual(["after.job — the chain loops back: a → b → a. Fix: remove after: from one of these jobs, or point it at a job outside the loop."]);
    expect(blocksSave(state, "chainJob")).toBe(true);
  });
});
