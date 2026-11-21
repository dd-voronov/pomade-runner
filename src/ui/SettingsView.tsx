import { useEffect, useRef, useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { SETTINGS_SET_METHOD } from "../integrations/runner-api";
import { describeJobError } from "../jobs/format";
import { JOBS_FOLDER } from "../jobs/model";
import { AGENT_SKILL, type EnvironmentReport, type NotificationState } from "../scheduler/environment";
import { isSettingsWriteResult, SETTINGS_FIELDS, type SettingsField, type SettingsReport } from "../scheduler/settings";
import type { HelpKey } from "./help";
import { Button, Dot, Help, Icon, Stepper, STEPPER_SETTLED_MS, useToast, type DotTone } from "./kit";
import styles from "./SettingsView.module.css";
import { useEnvironment, useSettings, type LiveState } from "./useRunnerApi";

/** How a setting steps and reads: the file holds a count, or minutes; a long-run warning steps by
 *  the hour and reads in hours when it is whole ones. */
interface StepSpec {
  label: string;
  note: string;
  help: HelpKey;
  /** The smallest and largest value the steps reach, in the file's units. */
  lo: number;
  hi: number;
  /** The value after a step in `direction`. */
  step(value: number, direction: -1 | 1): number;
  /** The number the stepper shows. */
  show(value: number): number;
  /** The unit after it. */
  unit(value: number): string;
}

const plural = (value: number, one: string, many: string): string => (value === 1 ? one : many);

/** The hour a minutes value steps to: a whole hour goes by one; anything else to the next whole one. */
const hourStep = (minutes: number, direction: -1 | 1): number => {
  if (minutes % 60 === 0) return minutes + direction * 60;
  return (direction === 1 ? Math.ceil(minutes / 60) : Math.floor(minutes / 60)) * 60;
};

const STEPS: Record<SettingsField, StepSpec> = {
  "max-low-priority-runs": {
    label: "Low-priority runs at once",
    note: "The rest wait as “queued · N ahead”.",
    help: "s.heavy",
    lo: SETTINGS_FIELDS["max-low-priority-runs"].min,
    hi: SETTINGS_FIELDS["max-low-priority-runs"].max,
    step: (value, direction) => value + direction,
    show: (value) => value,
    unit: (value) => plural(value, "run", "runs"),
  },
  "warm-up": {
    label: "Warm-up after login or wake",
    note: "Services start first; caught-up runs and hooks wait this long.",
    help: "s.warm",
    lo: SETTINGS_FIELDS["warm-up"].min,
    hi: SETTINGS_FIELDS["warm-up"].max,
    step: (value, direction) => value + direction,
    show: (value) => value,
    unit: () => "min",
  },
  "long-run-warning": {
    label: "Long-run warning",
    note: "Asks “still expected?” — never stops the run.",
    help: "s.long",
    // A warning under an hour is the file's to set by hand; the steps start at one hour.
    lo: 60,
    hi: SETTINGS_FIELDS["long-run-warning"].max,
    step: hourStep,
    show: (value) => (value % 60 === 0 ? value / 60 : value),
    unit: (value) => (value % 60 === 0 ? plural(value / 60, "hour", "hours") : "min"),
  },
  "history-days": {
    label: "Keep history and output",
    note: "Run records and captured logs on this Mac.",
    help: "s.keep",
    lo: SETTINGS_FIELDS["history-days"].min,
    hi: SETTINGS_FIELDS["history-days"].max,
    step: (value, direction) => value + direction,
    show: (value) => value,
    unit: (value) => plural(value, "day", "days"),
  },
};

/** The notification permission as a status: its dot and words. */
const NOTIFICATIONS: Record<NotificationState, { tone: DotTone; words: string }> = {
  allowed: { tone: "ok", words: "Allowed" },
  denied: { tone: "danger", words: "Blocked" },
  "not-asked": { tone: "hollow", words: "Not asked yet" },
  unavailable: { tone: "hollow", words: "Not available yet" },
};

/** The agent skill's links as a status and the line under its name. */
function skillLook({ linked, folders }: EnvironmentReport["skill"]): { tone: DotTone; words: string; note: React.ReactNode } {
  const name = <code className={styles.mono}>{AGENT_SKILL}</code>;
  if (linked === 0) return { tone: "hollow", words: "Not installed", note: <>{name} is not linked into any skill folder.</> };
  if (linked < folders) return { tone: "warning", words: "Partly installed", note: <>{name} is linked into {linked} of {folders} skill folders.</> };
  return { tone: "ok", words: "Installed", note: <>{name} is linked into {linked} skill {plural(linked, "folder", "folders")}.</> };
}

/** A row of a settings card: its name with (i), a line under it, its control at the end. */
function Row({ label, help, note, error, testId, children }: { label: string; help?: HelpKey | undefined; note: React.ReactNode; error?: string | null; testId?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={styles.row} data-testid={testId}>
      <div className={styles.text}>
        <div className={styles.label}>
          {label} {help !== undefined && <Help k={help} />}
        </div>
        <div className={styles.note}>{note}</div>
        {error !== undefined && error !== null && (
          <div className={styles.rowError} role="alert" data-testid={testId === undefined ? undefined : `${testId}-error`}>
            <Icon name="warn" size={12} />
            <span>{error}</span>
          </div>
        )}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <h4 className={styles.title}>{title}</h4>
      <div className={styles.card}>{children}</div>
    </>
  );
}

/** One setting: a stepper on the value the file gives. A step shows at once and is written, field-only,
 *  once the steps stop — even if the person has left the view by then. The scheduler applies it with
 *  no restart, and the value the file then gives takes over. A refusal puts the value back and says
 *  why. */
function SettingRow({ host, name, value: committed }: { host: HostClient; name: SettingsField; value: number }): React.JSX.Element {
  const spec = STEPS[name];
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const waiting = useRef<number | null>(null);
  const value = picked ?? committed;
  // The file caught up with the pick, or the pick went back to what the file says.
  if (picked !== null && picked === committed) setPicked(null);

  const write = (next: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    waiting.current = null;
    host.apps.call(APP_ID, SETTINGS_SET_METHOD, { field: name, value: next }).then(
      (result: unknown) => {
        const written = isSettingsWriteResult(result) ? result : null;
        if (written === null) setError("the scheduler answered something that is not a settings write");
        else if (!written.ok) setError(written.reason);
        // The pick stays until the file's value arrives; it goes back at once when the file says otherwise.
        const applied = written?.ok === true ? written.settings.settings[SETTINGS_FIELDS[name].key] : null;
        if (waiting.current === null && applied !== next) setPicked(null);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        if (waiting.current === null) setPicked(null);
      },
    );
  };

  const current = useRef(value);
  useEffect(() => {
    current.current = value;
  });
  const step = (direction: -1 | 1): boolean => {
    const next = Math.min(spec.hi, Math.max(spec.lo, spec.step(current.current, direction)));
    if (next === current.current) return false;
    current.current = next;
    setError(null);
    setPicked(next);
    waiting.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => write(next), STEPPER_SETTLED_MS);
    return true;
  };

  return (
    <Row label={spec.label} help={spec.help} note={spec.note} error={error} testId={`setting-${name}`}>
      <Stepper
        value={spec.show(value)}
        valueText={`${spec.show(value)} ${spec.unit(value)}`}
        label={spec.label}
        canDecrease={value > spec.lo}
        canIncrease={value < spec.hi}
        onStep={step}
        testId={`setting-${name}-stepper`}
      />
      <span className={styles.unit} data-testid={`setting-${name}-unit`}>
        {spec.unit(value)}
      </span>
    </Row>
  );
}

/** A read-only row's status: a dot and words, or nothing while it loads. */
function status(state: LiveState<EnvironmentReport>, look: (environment: EnvironmentReport) => { tone: DotTone; words: string }, testId: string): React.JSX.Element | null {
  if (state.status === "loading") return null;
  const shown = state.status === "ready" ? look(state.value) : { tone: "hollow" as const, words: "Unknown" };
  return (
    <span className={styles.status} data-testid={testId}>
      <Dot tone={shown.tone} />
      {shown.words}
    </span>
  );
}

/** The Settings view: the four settings, each a stepper written field-only to the workspace's
 *  `settings.yaml`; what the Mac says about notifications and the agent skill, read-only; the
 *  files. The file's own problems are listed on top. */
export function SettingsView({ host }: { host: HostClient }): React.JSX.Element {
  const settings = useSettings(host);
  const environment = useEnvironment(host);
  const toast = useToast();
  if (settings.status === "loading") return <section data-testid="settings-loading" />;
  if (settings.status !== "ready") {
    return (
      <p className={styles.problem} role="alert" data-testid="settings-problem">
        {settings.status === "failed" ? settings.message : "Runner's scheduler is not running."}
      </p>
    );
  }
  const report: SettingsReport = settings.value;
  const skill = environment.status === "ready" ? skillLook(environment.value.skill) : null;
  const openFile = (): void => {
    host.tabs.openFile({ path: report.path }).catch((err: unknown) => toast(`Could not open ${report.path}: ${err instanceof Error ? err.message : String(err)}`));
  };
  const fileNote = (
    <>
      <code className={styles.mono}>{report.path}</code>
      {!report.exists && <div>No file yet: every setting is its default, and the first change writes it.</div>}
    </>
  );
  const value = (name: SettingsField): number => report.settings[SETTINGS_FIELDS[name].key];
  return (
    <section className={styles.root} data-testid="settings">
      {report.errors.length > 0 && (
        <div className={styles.errors}>
          {report.errors.map((error) => (
            <div key={`${error.line}-${error.field}`} className={styles.error} role="alert" data-testid="settings-error">
              <Icon name="warn" size={12} />
              <span>
                Line {error.line}: {describeJobError(error)}
              </span>
            </div>
          ))}
        </div>
      )}
      <Card title="Load">
        <SettingRow host={host} name="max-low-priority-runs" value={value("max-low-priority-runs")} />
        <SettingRow host={host} name="warm-up" value={value("warm-up")} />
        <SettingRow host={host} name="long-run-warning" value={value("long-run-warning")} />
      </Card>
      <Card title="History">
        <SettingRow host={host} name="history-days" value={value("history-days")} />
      </Card>
      <Card title="Notifications">
        <Row label="macOS notifications while Pomade is closed" help="s.native" note="Only for “Needs you” items. Allowed in System Settings." testId="setting-notifications">
          {status(environment, ({ notifications }) => NOTIFICATIONS[notifications], "notifications-status")}
        </Row>
      </Card>
      <Card title="Agents">
        <Row label="Job skill for agents" help="s.skill" note={skill?.note ?? <code className={styles.mono}>{AGENT_SKILL}</code>} testId="setting-skill">
          {status(environment, ({ skill: links }) => skillLook(links), "skill-status")}
        </Row>
      </Card>
      <Card title="Files">
        <Row label="Workspace settings" note={fileNote} testId="setting-file">
          <Button disabled={!report.exists} onClick={openFile}>
            Open file
          </Button>
        </Row>
        <Row label="Job files" help="f.file" note={<code className={styles.mono}>{JOBS_FOLDER}/</code>} testId="setting-jobs-folder" />
      </Card>
    </section>
  );
}
