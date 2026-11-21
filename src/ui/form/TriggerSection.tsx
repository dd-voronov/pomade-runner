// The job form's Trigger section for a job that runs once per trigger: the choice between a schedule
// and a hook, then the schedule editor — the shape (Once · Every… · Daily · Weekly · Monthly), the
// shape's own controls, the Weekdays only / Weekends only filter — and the schedule in words with its
// next three runs, live. A file whose trigger is a hook or a chain keeps it: the section says it in
// words and that it is changed in the file.

import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, localDateOf, WEEKDAYS, type MonthDay, type Nth, type Weekday } from "pomade-kit/schedule";

import { JOBS_FOLDER } from "../../jobs/model";
import { parseJobFile } from "../../jobs/parse";
import { jobTriggerWords } from "../../jobs/words";
import type { HelpKey } from "../help";
import { Button, Check, Checks, DayButton, Field, FieldError, Help, Icon, Segmented, Select, TextInput, Toggle, type SelectOption } from "../kit";
import type { FormProps } from "./FolderField";
import styles from "./JobForm.module.css";
import { FormSection } from "./FormSection";
import { fileValue } from "./state";
import {
  dayWords,
  MONTH_NTHS,
  monthDayText,
  nextTime,
  readOncePhrase,
  sameMonthDay,
  schedulePreview,
  scheduleTarget,
  sortDays,
  sortMonthDays,
  WEEKDAY_LABELS,
  WEEKDAY_LONG,
  whenWords,
  type DayFilter,
  type ScheduleShape,
  type ScheduleTarget,
  type ScheduleValues,
} from "./schedule";

/** The time now, a fresh one every minute: the next runs move on while the form is open. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const SHAPES: readonly { value: ScheduleShape; label: string; help: HelpKey }[] = [
  { value: "once", label: "Once", help: "sh.once" },
  { value: "every", label: "Every…", help: "sh.every" },
  { value: "daily", label: "Daily", help: "sh.daily" },
  { value: "weekly", label: "Weekly", help: "sh.weekly" },
  { value: "monthly", label: "Monthly", help: "sh.monthly" },
];

const NTH_LABELS: Record<string, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", last: "last" };

/** A day of the month in words, as its check names it: "the first Monday". */
function monthDayWords(day: MonthDay): string {
  if (typeof day === "number" || day === "last") return monthDayText(day);
  return `the ${NTH_LABELS[String(day.nth)] ?? ""} ${WEEKDAY_LONG[day.weekday]}`;
}

export function TriggerSection(props: FormProps): React.JSX.Element {
  const { state, error } = props;
  const { trigger } = state.values;
  const triggerErrors = error("trigger");
  return (
    <FormSection title="Trigger" sub="when it runs" testId="form-trigger">
      <div className={styles.inline}>
        <Segmented<"schedule" | "hook">
          label="Trigger"
          value={trigger === "schedule" ? "schedule" : "hook"}
          onChange={() => undefined}
          testId="trigger-choice"
          options={[
            { value: "schedule", label: "On a schedule", unavailable: trigger !== "schedule", tip: trigger === "schedule" ? undefined : "Its trigger is set in the job file: hook: or after:" },
            { value: "hook", label: "When something happens", unavailable: trigger === "schedule", tip: trigger === "schedule" ? "A hook or a chain is set in the job file: hook: or after:" : undefined },
          ]}
        />
        <Help k="f.trigger" />
      </div>
      {trigger === "schedule" ? (
        <ScheduleEditor {...props} />
      ) : (
        <>
          <FileTrigger
            words={fileTriggerWords(state.path, state.text) ?? (trigger === "hook" ? "on its hook" : `after ${chainOf(fileValue(state, "after"))}`)}
            openFile={props.openFile}
          />
          {triggerErrors !== undefined && <FieldError>{triggerErrors}</FieldError>}
        </>
      )}
    </FormSection>
  );
}

/** A hook's or a chain's words, from the file as last read; `null` when the file does not check. */
function fileTriggerWords(path: string | null, text: string | null): string | null {
  if (path === null || text === null) return null;
  const job = parseJobFile({ path: path.slice(JOBS_FOLDER.length + 1), text }).job;
  return job === null ? null : jobTriggerWords(job);
}

/** The job a chain names, as written. */
function chainOf(after: unknown): string {
  const job = typeof after === "object" && after !== null && "job" in after ? (after as { job: unknown }).job : null;
  return typeof job === "string" && job.trim() !== "" ? job.trim() : "another job";
}

function FileTrigger({ words, openFile }: { words: string; openFile: (() => void) | undefined }): React.JSX.Element {
  return (
    <div className={styles.words} data-testid="file-trigger" data-field="trigger">
      <Icon name="clock" />
      <div className={styles.wordsText}>
        <b>Runs {words}</b>
        <span>The form edits schedules; a hook or a chain is changed in the job file.</span>
      </div>
      {openFile !== undefined && (
        <Button icon="file" onClick={openFile} data-testid="trigger-open-file">
          Open file
        </Button>
      )}
    </div>
  );
}

/** The controls of one shape, and the controls an error names. */
interface ShapeProps {
  schedule: ScheduleValues;
  change: (next: Partial<ScheduleValues>) => void;
  bad: (target: ScheduleTarget) => boolean;
  now: Date;
}

function ScheduleEditor(props: FormProps): React.JSX.Element {
  const { state, set, error, errorList, wouldBeText } = props;
  const now = useNow();
  const { schedule } = state.values;
  const change = (next: Partial<ScheduleValues>): void => set("schedule", { ...schedule, ...next });
  const targets = new Set(errorList("schedule").map((one) => scheduleTarget(one.field)));
  const bad = (target: ScheduleTarget): boolean => targets.has(target) || (target.startsWith("time:") && targets.has("times"));
  const shape: ShapeProps = { schedule, change, bad, now };
  const errors = error("schedule");
  return (
    <>
      <Field label="Repeats">
        {() => (
          <Segmented<ScheduleShape>
            label="Repeats"
            value={schedule.shape}
            testId="schedule-shape"
            onChange={(value) => change(value === "once" && schedule.onceDate === "" ? { shape: value, onceDate: localDateOf(now) } : { shape: value })}
            options={SHAPES}
          />
        )}
      </Field>
      <div className={styles.subBox} data-field="schedule" data-testid="schedule-box">
        {schedule.shape === "once" && <OnceControls {...shape} />}
        {schedule.shape === "every" && <EveryControls {...shape} />}
        {schedule.shape === "daily" && (
          <>
            <Field label="At">{() => <TimesEditor {...shape} />}</Field>
            <DayFilterField {...shape} />
          </>
        )}
        {schedule.shape === "weekly" && (
          <>
            <Field label="On">
              {() => (
                <div className={styles.days} role="group" aria-label="Days of the week" data-testid="week-days">
                  {WEEKDAYS.map((day) => (
                    <DayButton key={day} on={schedule.days.includes(day)} onClick={() => change({ days: schedule.days.includes(day) ? schedule.days.filter((other) => other !== day) : sortDays([...schedule.days, day]) })}>
                      {WEEKDAY_LABELS[day]}
                    </DayButton>
                  ))}
                </div>
              )}
            </Field>
            <Field label="At">{() => <TimesEditor {...shape} />}</Field>
          </>
        )}
        {schedule.shape === "monthly" && <MonthlyControls {...shape} />}
      </div>
      {errors !== undefined && <FieldError>{errors}</FieldError>}
      <WordsBox text={wouldBeText} now={now} once={schedule.shape === "once"} />
    </>
  );
}

function WordsBox({ text, now, once }: { text: string; now: Date; once: boolean }): React.JSX.Element {
  const preview = useMemo(() => schedulePreview(text, now), [text, now]);
  return (
    <div className={styles.words} data-testid="schedule-words">
      <Icon name="clock" />
      <div className={styles.wordsText}>
        <b data-testid="schedule-in-words">{preview === null ? "Fix the schedule to see it in words" : `Runs ${preview.words}`}</b>
        {preview !== null && (
          <span data-testid="schedule-next">
            {preview.next.length === 0 ? "No upcoming runs." : `Next: ${preview.next.map((at) => whenWords(at, now)).join(" · ")}${once ? " — then finished" : ""} · Mac’s local time`}
          </span>
        )}
      </div>
    </div>
  );
}

function OnceControls({ schedule, change, bad, now }: ShapeProps): React.JSX.Element {
  const [phrase, setPhrase] = useState("");
  const today = localDateOf(now);
  const options: SelectOption[] = Array.from({ length: 7 }, (_, ahead) => {
    const date = addDays(today, ahead);
    const words = dayWords(date, now);
    return { value: date, label: words.charAt(0).toUpperCase() + words.slice(1) };
  });
  if (!options.some((option) => option.value === schedule.onceDate)) {
    const known = /^\d{4}-\d{2}-\d{2}$/.test(schedule.onceDate);
    options.push({ value: schedule.onceDate, label: known ? dayWords(schedule.onceDate, now) : schedule.onceDate === "" ? "No date" : schedule.onceDate });
  }
  const unread = phrase.trim() !== "" && readOncePhrase(phrase, now) === null;
  return (
    <>
      <div className={styles.inline}>
        On
        <Select auto aria-label="Date" options={options} value={schedule.onceDate} bad={bad("once")} onChange={(event) => change({ onceDate: event.target.value })} />
        at
        <TextInput width="time" aria-label="Time" placeholder="13:00" inputMode="numeric" value={schedule.onceTime} bad={bad("once")} onChange={(event) => change({ onceTime: event.target.value })} />
      </div>
      <Field label="Or say it in words" optional help="sh.phrase" error={unread ? "Can’t read that — try “tonight 23:00”, “tomorrow 7:00” or “+2h”." : undefined}>
        {(id) => (
          <TextInput
            id={id}
            className={styles.phrase}
            placeholder="tonight 23:00 · tomorrow 7:00 · +2h"
            value={phrase}
            bad={unread}
            onChange={(event) => {
              setPhrase(event.target.value);
              const read = readOncePhrase(event.target.value, new Date());
              if (read !== null) change(read.time === undefined ? { onceDate: read.date } : { onceDate: read.date, onceTime: read.time });
            }}
          />
        )}
      </Field>
    </>
  );
}

function EveryControls(props: ShapeProps): React.JSX.Element {
  const { schedule, change, bad } = props;
  return (
    <>
      <div className={styles.inline}>
        Every
        <TextInput width="number" aria-label="Interval" inputMode="numeric" value={schedule.every} bad={bad("every")} onChange={(event) => change({ every: event.target.value })} />
        <Select
          auto
          aria-label="Unit"
          options={[
            { value: "minutes", label: "minutes" },
            { value: "hours", label: "hours" },
          ]}
          value={schedule.unit}
          onChange={(event) => change({ unit: event.target.value === "hours" ? "hours" : "minutes" })}
        />
      </div>
      <div className={styles.inline}>
        <Toggle on={schedule.within} onChange={(on) => change({ within: on })} label="Only between" tip="" />
        <span>Only between</span>
        {schedule.within && (
          <>
            <TextInput width="time" aria-label="From" placeholder="9:00" inputMode="numeric" value={schedule.from} bad={bad("from")} onChange={(event) => change({ from: event.target.value })} />
            <span>and</span>
            <TextInput width="time" aria-label="To" placeholder="21:00" inputMode="numeric" value={schedule.to} bad={bad("to")} onChange={(event) => change({ to: event.target.value })} />
          </>
        )}
        <Help k="sh.within" />
      </div>
      <DayFilterField {...props} />
    </>
  );
}

function DayFilterField({ schedule, change }: ShapeProps): React.JSX.Element {
  return (
    <Field label="Days" help="sh.filter">
      {() => (
        <Segmented<DayFilter>
          label="Days"
          value={schedule.filter}
          testId="day-filter"
          onChange={(value) => change({ filter: value })}
          options={[
            { value: "all", label: "Every day" },
            { value: "weekdays", label: "Weekdays only" },
            { value: "weekends", label: "Weekends only" },
          ]}
        />
      )}
    </Field>
  );
}

/** The times of day, each removable while there are two or more, and Add time. */
function TimesEditor({ schedule, change, bad }: ShapeProps): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState(0);
  useEffect(() => {
    if (added > 0) list.current?.querySelector<HTMLInputElement>(`.${styles.timeItem}:last-of-type input`)?.focus();
  }, [added]);
  const { times } = schedule;
  return (
    <div ref={list} className={styles.times} data-testid="schedule-times">
      {times.map((time, index) => (
        <span key={index} className={styles.timeItem}>
          <TextInput
            className={styles.timeInput}
            aria-label={`Time ${index + 1}`}
            placeholder="13:00"
            inputMode="numeric"
            value={time}
            bad={bad(`time:${index}`)}
            onChange={(event) => change({ times: times.map((other, at) => (at === index ? event.target.value : other)) })}
          />
          {times.length > 1 && (
            <button type="button" className={styles.timeRemove} aria-label={`Remove time ${index + 1}`} data-tip="Remove" onClick={() => change({ times: times.filter((_, at) => at !== index) })}>
              <Icon name="x" size={10} />
            </button>
          )}
        </span>
      ))}
      <Button
        variant="ghost"
        icon="plus"
        iconSize={12}
        onClick={() => {
          change({ times: [...times, nextTime(times)] });
          setAdded((count) => count + 1);
        }}
      >
        Add time
      </Button>
    </div>
  );
}

function MonthlyControls(props: ShapeProps): React.JSX.Element {
  const { schedule, change } = props;
  const [nth, setNth] = useState<Nth>(1);
  const [weekday, setWeekday] = useState<Weekday>("mon");
  const has = (day: MonthDay): boolean => schedule.monthDays.some((other) => sameMonthDay(other, day));
  const toggle = (day: MonthDay): void => change({ monthDays: has(day) ? schedule.monthDays.filter((other) => !sameMonthDay(other, day)) : sortMonthDays([...schedule.monthDays, day]) });
  const weekdaysOfMonth = schedule.monthDays.filter((day) => typeof day === "object");
  return (
    <>
      <Field label="On day">
        {() => (
          <div className={styles.monthGrid} role="group" aria-label="Days of the month" data-testid="month-days">
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
              <DayButton key={day} compact on={has(day)} onClick={() => toggle(day)}>
                {day}
              </DayButton>
            ))}
            <DayButton compact wide on={has("last")} onClick={() => toggle("last")}>
              Last day
            </DayButton>
          </div>
        )}
      </Field>
      <Field label="Or on a weekday of the month">
        {() => (
          <>
            <div className={styles.inline}>
              The
              <Select auto aria-label="Which" options={MONTH_NTHS.map((value) => ({ value: String(value), label: NTH_LABELS[String(value)] ?? "" }))} value={String(nth)} onChange={(event) => setNth(event.target.value === "last" ? "last" : (Number(event.target.value) as Nth))} />
              <Select auto aria-label="Weekday" options={WEEKDAYS.map((value) => ({ value, label: WEEKDAY_LONG[value] }))} value={weekday} onChange={(event) => setWeekday(WEEKDAYS.find((value) => value === event.target.value) ?? "mon")} />
              <Button icon="plus" iconSize={12} onClick={() => !has({ nth, weekday }) && change({ monthDays: sortMonthDays([...schedule.monthDays, { nth, weekday }]) })}>
                Add
              </Button>
            </div>
            {weekdaysOfMonth.length > 0 && (
              <Checks>
                {weekdaysOfMonth.map((day) => (
                  <Check key={monthDayText(day)} on data-tip="Remove" onClick={() => toggle(day)}>
                    {monthDayWords(day)}
                  </Check>
                ))}
              </Checks>
            )}
          </>
        )}
      </Field>
      <Field label="At">{() => <TimesEditor {...props} />}</Field>
    </>
  );
}
