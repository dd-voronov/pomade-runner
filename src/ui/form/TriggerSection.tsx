// The job form's Trigger section for a job that runs once per trigger: the choice between a schedule,
// a hook and none (Manually — the job runs only by hand), then the schedule editor — the shape (Once · Every… · Daily · Weekly · Monthly), the
// shape's own controls, the Weekdays only / Weekends only filter — and the schedule in words with its
// next three runs, live; or the hook editor — the Event list of the hooks the engine fires, with
// "Another job finished" (a chain) last, a chain's job and result — and the trigger in words. A
// hook on an event the form does not offer keeps it: the section says it in words and that it is
// changed in the file. Manually is a sentence and no controls. A service's chain is its own line (`ServiceChainLine`).

import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, localDateOf, WEEKDAYS, type MonthDay, type Nth, type Weekday } from "pomade-kit/schedule";

import { JOBS_FOLDER, type ChainResult, type JobError } from "../../jobs/model";
import { parseJobFile } from "../../jobs/parse";
import { jobTriggerWords } from "../../jobs/words";
import type { HelpKey } from "../help";
import { Button, Check, Checks, DayButton, Field, FieldError, Help, Icon, IconButton, LinkButton, Segmented, Select, TextInput, Toggle, type SelectOption } from "../kit";
import { useRoster } from "../useAgents";
import { useNow } from "../useNow";
import { useSettings } from "../useRunnerApi";
import type { FormProps } from "./FolderField";
import styles from "./JobForm.module.css";
import { FormSection } from "./FormSection";
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
import { ACTION_OPTIONS, agentPicks, CHAIN_CHOICE, chainJobOptions, EVENT_CHOICES, formOffersHook, hookBoxWords, isLoopError, projectPicks, RESULT_CHOICES, SERVICE_RESULT_OPTIONS, statusPicks } from "./triggerWords";

/** The time now, a fresh one every minute: the next runs move on while the form is open. */
function useMinuteClock(): Date {
  const at = useNow(60_000);
  return useMemo(() => new Date(at), [at]);
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
  const { state, set } = props;
  const { trigger } = state.values;
  // Back from a schedule, the hook editor shows the hook or the chain it last showed.
  const [lastHook, setLastHook] = useState<"hook" | "chain">(trigger === "chain" ? "chain" : "hook");
  useEffect(() => {
    if (trigger === "hook" || trigger === "chain") setLastHook(trigger);
  }, [trigger]);
  return (
    <FormSection title="Trigger" sub="when it runs" testId="form-trigger">
      <div className={styles.inline}>
        <Segmented<"schedule" | "hook" | "manual">
          label="Trigger"
          value={trigger === "chain" ? "hook" : trigger}
          onChange={(value) => set("trigger", value === "hook" ? lastHook : value)}
          testId="trigger-choice"
          options={[
            { value: "schedule", label: "On a schedule" },
            { value: "hook", label: "When something happens" },
            { value: "manual", label: "Manually" },
          ]}
        />
        <Help k="f.trigger" />
      </div>
      {trigger === "schedule" ? (
        <ScheduleEditor {...props} />
      ) : trigger === "manual" ? (
        <p className={styles.manual} data-testid="manual-trigger">
          It runs only when you press Run now — never by itself.
        </p>
      ) : trigger === "hook" && !formOffersHook(state.values.hookEvent) ? (
        <FileHook {...props} />
      ) : (
        <HookEditor {...props} />
      )}
    </FormSection>
  );
}

/** A hook on an event the form does not offer, from the file as last read. */
function FileHook({ state, error, openFile }: FormProps): React.JSX.Element {
  const triggerErrors = error("trigger");
  return (
    <>
      <div className={styles.words} data-testid="file-trigger" data-field="trigger">
        <Icon name="clock" />
        <div className={styles.wordsText}>
          <b>Runs {fileTriggerWords(state.path, state.text) ?? "on its hook"}</b>
          <span>This hook is set in the job file: hook:</span>
        </div>
        {openFile !== undefined && (
          <Button icon="file" onClick={openFile} data-testid="trigger-open-file">
            Open file
          </Button>
        )}
      </div>
      {triggerErrors !== undefined && <FieldError>{triggerErrors}</FieldError>}
    </>
  );
}

/** A hook's or a chain's words, from the file as last read; `null` when the file does not check. */
function fileTriggerWords(path: string | null, text: string | null): string | null {
  if (path === null || text === null) return null;
  const job = parseJobFile({ path: path.slice(JOBS_FOLDER.length + 1), text }).job;
  return job === null ? null : jobTriggerWords(job);
}

/** A chain's errors, in the checker's words; a loop's with the (i) on why it is refused. */
function ChainErrors({ errors, rendered }: { errors: readonly JobError[]; rendered: React.ReactNode }): React.JSX.Element | null {
  if (errors.length === 0) return null;
  return (
    <div className={styles.chainErrors} data-testid="chain-error">
      <FieldError>{rendered}</FieldError>
      {errors.some(isLoopError) && <Help k="hk.loop" />}
    </div>
  );
}

/** The Event list, and a chain's job and result in a box under it; the trigger in words. */
function HookEditor(props: FormProps): React.JSX.Element {
  const { state, set, error, errorList, jobs, jobId, projects } = props;
  const { values } = state;
  const chain = values.trigger === "chain";
  const event = chain ? CHAIN_CHOICE : values.hookEvent;
  const choice = EVENT_CHOICES.find((one) => one.value === event) ?? EVENT_CHOICES[0];
  const triggerErrors = error("trigger");
  return (
    <>
      <Field label="Event" help={choice?.help}>
        {(id) => (
          <Select
            id={id}
            options={EVENT_CHOICES}
            value={event}
            data-field="trigger"
            data-testid="hook-event"
            onChange={(e) => {
              if (e.target.value === CHAIN_CHOICE) set("trigger", "chain");
              else {
                set("trigger", "hook");
                set("hookEvent", e.target.value);
              }
            }}
          />
        )}
      </Field>
      {triggerErrors !== undefined && <FieldError>{triggerErrors}</FieldError>}
      {!chain && (values.hookEvent === "project-first-open" || values.hookEvent === "project-opened") && (
        <div className={styles.subBox} data-testid="hook-box">
          <Field label="Project">
            {(id) => (
              <Select
                id={id}
                options={[{ value: "", label: "Any project" }, ...projectPicks(projects.records, values.hookProject.trim(), null)]}
                value={values.hookProject.trim()}
                data-testid="hook-project"
                onChange={(e) => set("hookProject", e.target.value)}
              />
            )}
          </Field>
        </div>
      )}
      {!chain && (values.hookEvent === "session-finished" || values.hookEvent === "session-status") && <SessionFilters {...props} />}
      {chain && (
        <div className={styles.subBox} data-testid="chain-box">
          <div className={styles.row}>
            <Field label="Job">
              {(id) => (
                <Select
                  id={id}
                  options={chainJobOptions(jobs, jobId, values.chainJob, "Choose a job…")}
                  value={values.chainJob}
                  bad={errorList("chainJob").length > 0}
                  data-field="chainJob"
                  data-testid="chain-job"
                  onChange={(e) => set("chainJob", e.target.value)}
                />
              )}
            </Field>
            <Field label="When it" help="hk.result">
              {() => <Segmented<ChainResult> label="When it" value={values.chainResult} onChange={(value) => set("chainResult", value)} options={RESULT_CHOICES} testId="chain-result" />}
            </Field>
          </div>
          <ChainErrors errors={errorList("chainJob")} rendered={error("chainJob")} />
        </div>
      )}
      <HookWords {...props} />
    </>
  );
}

/** An agent session hook's filters in a box: a status change's Status, then Only in project and
 *  Only agent — the roster's agents; without the Agents app, the box says so. */
function SessionFilters({ host, state, set, projects }: FormProps): React.JSX.Element {
  const { values } = state;
  const roster = useRoster(host);
  const agent = values.hookAgent.trim();
  return (
    <div className={styles.subBox} data-testid="hook-box">
      {values.hookEvent === "session-status" && (
        <Field label="Status">
          {(id) => <Select id={id} auto options={statusPicks(values.hookStatus.trim())} value={values.hookStatus.trim()} data-testid="hook-status" onChange={(e) => set("hookStatus", e.target.value)} />}
        </Field>
      )}
      <div className={styles.row}>
        <Field label="Only in project">
          {(id) => (
            <Select
              id={id}
              options={[{ value: "", label: "Any project" }, ...projectPicks(projects.records, values.hookProject.trim(), null)]}
              value={values.hookProject.trim()}
              data-testid="hook-project"
              onChange={(e) => set("hookProject", e.target.value)}
            />
          )}
        </Field>
        <Field label="Only agent" hint={roster.status === "loading" ? "Reading the Agents app's roster…" : roster.status === "ready" && agent !== "" && !roster.value.some((one) => one.id === agent) ? <span className={styles.problem}>{agent} is not in the Agents app's roster.</span> : undefined}>
          {(id) => <Select id={id} options={agentPicks(roster.status === "ready" ? roster.value : [], agent)} value={agent} data-testid="hook-agent" onChange={(e) => set("hookAgent", e.target.value)} />}
        </Field>
      </div>
      {(roster.status === "absent" || roster.status === "failed") && (
        <div className={styles.notice} role="status" data-testid="agents-absent">
          <Icon name="warn" />
          <p>
            {roster.status === "absent" ? `${capitalised(roster.message)}.` : `The Agents app's roster cannot be read: ${roster.message}.`} Runner lists the agents from its roster, and the Agents app tells Runner of its sessions: this hook fires only while it runs.
          </p>
        </div>
      )}
    </div>
  );
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function HookWords({ host, state, jobs, projects }: FormProps): React.JSX.Element {
  const settings = useSettings(host);
  const words = hookBoxWords(state.values, jobs, settings.status === "ready" ? settings.value.settings.warmUpMinutes : null, projects.records);
  return (
    <div className={styles.words} data-testid="hook-words">
      <Icon name="clock" />
      <div className={styles.wordsText}>
        <b>{words.title}</b>
        <span>{words.sub}</span>
      </div>
    </div>
  );
}

/** A service's chain: "+ Restart, start or stop it after another job", or the line "Also restart
 *  it after Pull is done", with its remove button. */
export function ServiceChainLine(props: FormProps): React.JSX.Element {
  const { state, set, error, errorList, jobs, jobId } = props;
  const { values } = state;
  if (!values.serviceChain) {
    return (
      <div className={styles.inline}>
        <LinkButton onClick={() => set("serviceChain", true)} data-testid="service-chain-add">
          + Restart, start or stop it after another job
        </LinkButton>
        <Help k="f.after" />
      </div>
    );
  }
  const options = (list: readonly { value: string; label: string }[]): SelectOption[] => list.map(({ value, label }) => ({ value, label }));
  return (
    <div className={styles.subBox} data-testid="service-chain">
      <div className={styles.chainLine}>
        <div className={`${styles.inline} ${styles.grow}`}>
          <b className={styles.chainAlso}>Also</b>
          <Select auto aria-label="What it does" options={options(ACTION_OPTIONS)} value={values.chainAction} onChange={(e) => set("chainAction", ACTION_OPTIONS.find((one) => one.value === e.target.value)?.value ?? "restart")} />
          after
          <Select
            auto
            className={styles.chainJob}
            aria-label="Job"
            options={chainJobOptions(jobs, jobId, values.chainJob, "choose a job…")}
            value={values.chainJob}
            bad={errorList("chainJob").length > 0}
            data-field="chainJob"
            data-testid="chain-job"
            onChange={(e) => set("chainJob", e.target.value)}
          />
          <Select auto aria-label="When it" options={options(SERVICE_RESULT_OPTIONS)} value={values.chainResult} onChange={(e) => set("chainResult", SERVICE_RESULT_OPTIONS.find((one) => one.value === e.target.value)?.value ?? "done")} />
          <Help k="f.after" />
        </div>
        <IconButton icon="x" iconSize={12} label="Remove" onClick={() => set("serviceChain", false)} data-testid="service-chain-remove" />
      </div>
      <ChainErrors errors={errorList("chainJob")} rendered={error("chainJob")} />
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
  const now = useMinuteClock();
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
