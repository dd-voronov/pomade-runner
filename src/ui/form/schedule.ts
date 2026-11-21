// The job form's schedule, pure: the values the schedule editor shows, read from a job file's
// `schedule:` as written and written back in the format `pomade-kit/schedule` reads. The form keeps
// no copy of the format's rules: what the person typed is written as typed, the one validator says
// what is wrong, and each of its errors lands on the control it names (`scheduleTarget`). The words
// come from `scheduleWords` (the kit's, a once on today or tomorrow said so) and the next runs
// from the kit's next-occurrence engine.

import { parseDatePhrase } from "pomade-kit/dates";
import { addDays, formatTime, localDateOf, nextOccurrence, parseSchedule, parseTime, WEEKDAYS, weekdayOf, type MonthDay, type Nth, type Schedule, type Weekday } from "pomade-kit/schedule";

import { readJobDocument } from "../../jobs/document";
import type { FieldInput } from "../../jobs/edit";
import { parseJobFile } from "../../jobs/parse";
import { scheduleWords } from "../../jobs/words";

/** The schedule shapes the form offers, in the picker's order. */
export const SCHEDULE_SHAPES = ["once", "every", "daily", "weekly", "monthly"] as const;
export type ScheduleShape = (typeof SCHEDULE_SHAPES)[number];

/** The Weekdays only / Weekends only filter (`only:`), for every and daily. */
export type DayFilter = "all" | "weekdays" | "weekends";

/** The nth weekdays the monthly adder offers ("the first Monday"). */
export const MONTH_NTHS: readonly Nth[] = [1, 2, 3, 4, "last"];

/** Every value the schedule editor shows; a shape writes the ones it takes. Times, counts and dates
 *  are kept as typed, so the validator words what is wrong with them. */
export interface ScheduleValues {
  shape: ScheduleShape;
  /** once: the date (`YYYY-MM-DD`) and the time. */
  onceDate: string;
  onceTime: string;
  /** every: the count and its unit; the window of the day, when `within`. */
  every: string;
  unit: "minutes" | "hours";
  within: boolean;
  from: string;
  to: string;
  /** daily, weekly, monthly: the times of day. */
  times: string[];
  /** weekly: the days, Monday first. */
  days: Weekday[];
  /** monthly: the days of the month. */
  monthDays: MonthDay[];
  /** every, daily: the filter. */
  filter: DayFilter;
  /** What the file's schedule says that the editor has no control for — `monthly.months`, `start`,
   *  `end`, a key it does not know — kept as written. */
  monthsKept: FieldInput | null;
  kept: Readonly<Record<string, FieldInput>>;
}

/** A new job's schedule: daily at 9:00. */
export function blankSchedule(): ScheduleValues {
  return {
    shape: "daily",
    onceDate: "",
    onceTime: "23:00",
    every: "30",
    unit: "minutes",
    within: false,
    from: "9:00",
    to: "21:00",
    times: ["9:00"],
    days: ["mon", "tue", "wed", "thu", "fri"],
    monthDays: [1],
    filter: "all",
    monthsKept: null,
    kept: {},
  };
}

const isMapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "");
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/** A YAML value as the writer takes it; `undefined` for one it cannot write back. */
function asInput(value: unknown): FieldInput | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.every((item) => typeof item === "string" || typeof item === "number") ? (value as (string | number)[]) : undefined;
  if (isMapping(value)) {
    const out: Record<string, FieldInput> = {};
    for (const [key, item] of Object.entries(value)) {
      const input = asInput(item);
      if (input === undefined) return undefined;
      out[key] = input;
    }
    return out;
  }
  return undefined;
}

const NTH_WORDS: Record<string, Nth> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: "last" };

function weekdayOfText(text: string): Weekday | undefined {
  const head = text.trim().toLowerCase().slice(0, 3);
  return WEEKDAYS.find((day) => day === head);
}

function monthDayOfValue(value: unknown): MonthDay | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const words = asText(value).toLowerCase().split(/\s+/);
  if (words.length === 1 && words[0] === "last") return "last";
  if (words.length === 1 && /^\d+$/.test(words[0] ?? "")) return Number(words[0]);
  const nth = NTH_WORDS[words[0] ?? ""];
  const weekday = weekdayOfText(words[1] ?? "");
  return words.length === 2 && nth !== undefined && weekday !== undefined ? { nth, weekday } : undefined;
}

/** The editor's values from a job file's `schedule:` as written — valid or not. What it cannot show
 *  stands at the blank's value; an edit that leaves the schedule alone never writes it. */
export function readSchedule(value: unknown): ScheduleValues {
  const values = blankSchedule();
  if (!isMapping(value)) return values;
  const shape = SCHEDULE_SHAPES.find((key) => value[key] !== undefined);
  const kept: Record<string, FieldInput> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((SCHEDULE_SHAPES as readonly string[]).includes(key) || key === "only" || key === "after-completion" || key === "always") continue;
    const input = asInput(item);
    if (input !== undefined) kept[key] = input;
  }
  values.kept = kept;
  if (value.only === "weekdays" || value.only === "weekends") values.filter = value.only;
  if (shape === undefined) return values;
  values.shape = shape;
  const body = value[shape];
  if (shape === "once") {
    const match = /^(\S*)(?:[ T]+(.*))?$/.exec(asText(body));
    values.onceDate = match?.[1] ?? "";
    values.onceTime = match?.[2]?.trim() ?? "";
    return values;
  }
  if (!isMapping(body)) return values;
  if (shape === "every") {
    values.unit = body.hours !== undefined && body.minutes === undefined ? "hours" : "minutes";
    values.every = asText(values.unit === "hours" ? body.hours : body.minutes);
    values.within = body.from !== undefined || body.to !== undefined;
    if (values.within) {
      values.from = asText(body.from);
      values.to = asText(body.to);
    }
    return values;
  }
  values.times = listOf(body.at).map(asText);
  if (shape === "weekly") values.days = sortDays(listOf(body.days).flatMap((day) => weekdayOfText(asText(day)) ?? []));
  if (shape === "monthly") {
    values.monthDays = sortMonthDays(listOf(body.days).flatMap((day) => monthDayOfValue(day) ?? []));
    values.monthsKept = body.months === undefined ? null : (asInput(body.months) ?? null);
  }
  return values;
}

/** Days in week order, each once. */
export function sortDays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAYS.filter((day) => days.includes(day));
}

function monthDayOrder(day: MonthDay): number {
  if (typeof day === "number") return day;
  if (day === "last") return 40;
  return 50 + (day.nth === "last" ? 6 : day.nth) * 7 + WEEKDAYS.indexOf(day.weekday);
}

export const sameMonthDay = (a: MonthDay, b: MonthDay): boolean => monthDayText(a) === monthDayText(b);

/** Days of the month in the format's order — numbers, the last day, then the nth weekdays — each once. */
export function sortMonthDays(days: readonly MonthDay[]): MonthDay[] {
  const unique = days.filter((day, index) => days.findIndex((other) => sameMonthDay(other, day)) === index);
  return [...unique].sort((a, b) => monthDayOrder(a) - monthDayOrder(b));
}

const NTH_TEXT: Record<string, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", last: "last" };

/** A day of the month as the file writes it: `15`, `last`, `first mon`. */
export function monthDayText(day: MonthDay): string {
  if (typeof day === "number") return String(day);
  if (day === "last") return "last";
  return `${NTH_TEXT[String(day.nth)] ?? ""} ${day.weekday}`;
}

/** A count as typed: a number when it is digits, else the text, so the validator says what is wrong. */
function countInput(text: string): number | string {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/** One time as a scalar, several as a list — the format's canonical form. */
function timesInput(times: readonly string[]): FieldInput {
  const trimmed = times.map((time) => time.trim());
  return trimmed.length === 1 ? (trimmed[0] ?? "") : trimmed;
}

/** The `schedule:` mapping the values make: the shape, the filter where it applies, then what the
 *  file had that the editor keeps. */
export function scheduleInput(values: ScheduleValues): FieldInput {
  const out: Record<string, FieldInput> = {};
  switch (values.shape) {
    case "once":
      out.once = [values.onceDate.trim(), values.onceTime.trim()].filter((part) => part !== "").join(" ");
      break;
    case "every":
      out.every = {
        [values.unit]: countInput(values.every),
        from: values.within && values.from.trim() !== "" ? values.from.trim() : null,
        to: values.within && values.to.trim() !== "" ? values.to.trim() : null,
      };
      break;
    case "daily":
      out.daily = { at: timesInput(values.times) };
      break;
    case "weekly":
      out.weekly = { days: sortDays(values.days), at: timesInput(values.times) };
      break;
    case "monthly":
      out.monthly = { days: sortMonthDays(values.monthDays).map((day) => (typeof day === "number" ? day : monthDayText(day))), months: values.monthsKept, at: timesInput(values.times) };
      break;
  }
  if ((values.shape === "every" || values.shape === "daily") && values.filter !== "all") out.only = values.filter;
  return { ...out, ...values.kept };
}

/** Which of the editor's controls an error about `field` (`schedule.weekly.days[1]`) belongs to:
 *  `shape` for the schedule as a whole, `time:<i>` for one of the times. */
export type ScheduleTarget = "shape" | "once" | "every" | "from" | "to" | "times" | `time:${number}` | "days" | "monthDays" | "filter";

export function scheduleTarget(field: string): ScheduleTarget {
  const path = field.replace(/^schedule\.?/, "");
  const time = /^(?:daily|weekly|monthly)\.at\[(\d+)\]$/.exec(path);
  if (time) return `time:${Number(time[1])}`;
  if (/^(?:daily|weekly|monthly)\.at$/.test(path)) return "times";
  if (path === "once") return "once";
  if (path === "every.from") return "from";
  if (path === "every.to") return "to";
  if (path.startsWith("every")) return "every";
  if (path.startsWith("weekly.days")) return "days";
  if (path.startsWith("monthly.days")) return "monthDays";
  if (path === "only") return "filter";
  return "shape";
}

/** What the schedule the form would write says: in words and its next runs; `null` when the
 *  validator would refuse it. */
export interface SchedulePreview {
  words: string;
  next: Date[];
}

/** The next `count` runs of a schedule after `now`, from the kit's engine. */
export function nextRuns(schedule: Schedule, now: Date, count: number): Date[] {
  const out: Date[] = [];
  let after = now;
  while (out.length < count) {
    const next = nextOccurrence(schedule, after);
    if (next === null) break;
    out.push(next);
    after = next;
  }
  return out;
}

/** The preview of a job file's schedule, read from the text the form would write; `null` when the
 *  checker finds a problem with the schedule. */
export function schedulePreview(text: string, now: Date): SchedulePreview | null {
  const read = readJobDocument(text);
  if (!read.ok) return null;
  if (parseJobFile({ path: "preview.md", text }).errors.some((error) => error.field === "schedule" || error.field.startsWith("schedule."))) return null;
  const parsed = parseSchedule(read.doc.fields.schedule, { resolution: "time" });
  if (!parsed.ok) return null;
  return { words: scheduleWords(parsed.schedule, now), next: nextRuns(parsed.schedule, now, 3) };
}

const WEEKDAY_SHORT: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const WEEKDAY_LONG: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
export const WEEKDAY_LABELS = WEEKDAY_SHORT;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day relative to today: "today", "tomorrow", "Thu" within the week, else "Thu 3 Dec" (and the
 *  year when it is not this one). */
export function dayWords(date: string, now: Date): string {
  const today = localDateOf(now);
  for (let ahead = 0; ahead < 7; ahead++) {
    if (addDays(today, ahead) !== date) continue;
    return ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : WEEKDAY_SHORT[weekdayOf(date)];
  }
  const [year, month, day] = date.split("-").map(Number);
  const head = `${WEEKDAY_SHORT[weekdayOf(date)]} ${day ?? ""} ${MONTH_SHORT[(month ?? 1) - 1] ?? ""}`;
  return year === Number(today.slice(0, 4)) ? head : `${head} ${year ?? ""}`;
}

/** A run's time in words: "today 13:15", "tomorrow 9:00", "Thu 9:00". */
export function whenWords(at: Date, now: Date): string {
  return `${dayWords(localDateOf(at), now)} ${formatTime({ hour: at.getHours(), minute: at.getMinutes() })}`;
}

/** A typed date phrase for a once schedule ("tonight 23:00", "+2h", "tomorrow"): the date and the
 *  time it names (`time` absent for a whole day), or `null` when it names none. */
export function readOncePhrase(text: string, now: Date): { date: string; time?: string } | null {
  const phrase = parseDatePhrase(text, { now });
  if (phrase.kind === "date-time") return { date: phrase.date, time: formatTime(phrase.time) };
  if (phrase.kind === "date") return { date: phrase.date };
  return null;
}

/** The times editor's next time: seven hours after the last, when that is still today. */
export function nextTime(times: readonly string[]): string {
  const last = parseTime(times.at(-1)?.trim() ?? "");
  if (last === null) return "";
  const minutes = last.hour * 60 + last.minute + 420;
  return minutes < 1440 ? formatTime({ hour: Math.floor(minutes / 60), minute: minutes % 60 }) : "";
}
