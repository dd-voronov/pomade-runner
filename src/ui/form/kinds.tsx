// The job form's kinds, as the person sees them: each kind's card in the picker, and — for a kind
// the form builds — its sections between Kind and Policies, its policy rows and its Create button.
// A kind the form builds is registered twice: its file fields in `state.ts` (`FORM_KINDS`) and its
// sections here (`sections`, `policies`); the picker offers exactly those.

import { useState, type ReactNode } from "react";

import type { JobKind, MissedPolicy, Notify, OverlapPolicy } from "../../jobs/model";
import type { HelpKey } from "../help";
import { Field, FieldError, Help, LinkButton, Segmented, Select, TextInput, Toggle, type IconName, type SelectOption } from "../kit";
import { FolderField, type FormProps } from "./FolderField";
import { FormSection } from "./FormSection";
import styles from "./JobForm.module.css";
import { LOW_PRIORITY_WORDS, MISSED_WORDS, NOTIFY_WORDS, OVERLAP_WORDS, TIME_LIMIT_WORDS, type PolicyWords } from "./policies";
import type { FormValues, WorthUntil } from "./state";
import { ServiceChainLine, TriggerSection } from "./TriggerSection";

/** A policy as the Policies section shows it: its words in the summary (`policies.ts`), and its
 *  row — its control — once the person presses Change. */
export interface PolicyRow extends PolicyWords {
  /** Its row; `null` when it shows none. */
  row(props: FormProps & { defaults: FormValues }): ReactNode;
}

export interface KindUi {
  label: string;
  /** The card's line under its name. */
  line: string;
  icon: IconName;
  help: HelpKey;
  /** The Name field's placeholder. */
  namePlaceholder: string;
  /** For a kind the form builds: its sections between Kind and Policies, its policy rows and the
   *  primary button's words for a new job. */
  build?: {
    sections(props: FormProps): ReactNode;
    policies: readonly PolicyRow[];
    createLabel(values: FormValues): string;
  };
}

/** A policy's line: its label with its (i), and its control. A `muted` one does not apply. */
export function PolicyLine({ label, help, muted = false, children }: { label: string; help?: HelpKey; muted?: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.policy}>
      <div className={muted ? `${styles.policyLabel} ${styles.policyLabelMuted}` : styles.policyLabel}>
        {label} {help !== undefined && <Help k={help} />}
      </div>
      <div className={styles.policyControl}>{children}</div>
    </div>
  );
}

const LOW_PRIORITY: PolicyRow = {
  ...LOW_PRIORITY_WORDS,
  row: ({ state, set, defaults }) => (
    <PolicyLine key="lowPriority" label="Low priority" help="p.low">
      <div className={styles.inline}>
        <Toggle on={state.values.lowPriority} onChange={(on) => set("lowPriority", on)} label="Low priority" tip="" data-field="lowPriority" />
        <span>
          {state.values.lowPriority ? "Runs in the background, never in your way" : "Runs at normal priority"}
          {state.values.lowPriority === defaults.lowPriority && ` · default for ${KIND_UI[state.values.kind].label}`}
        </span>
      </div>
    </PolicyLine>
  ),
};

const NOTIFY: PolicyRow = {
  ...NOTIFY_WORDS,
  row: ({ state, set, defaults, error }) => (
    <PolicyLine key="notify" label="Notify me" help="p.notify">
      <div data-field="notify">
        <Segmented<Notify>
          label="Notify me"
          value={state.values.notify}
          onChange={(value) => set("notify", value)}
          options={[
            { value: "on-failure", label: "On failure", isDefault: defaults.notify === "on-failure" },
            { value: "always", label: "Always", isDefault: defaults.notify === "always" },
            { value: "never", label: "Never", isDefault: defaults.notify === "never" },
          ]}
        />
      </div>
      {error("notify") !== undefined && <FieldError>{error("notify")}</FieldError>}
    </PolicyLine>
  ),
};

const OVERLAP: PolicyRow = {
  ...OVERLAP_WORDS,
  row: ({ state, set, defaults, error }) => (
    <PolicyLine key="overlap" label="If still running" help="p.overlap">
      <div data-field="overlap">
        <Segmented<OverlapPolicy>
          label="If still running"
          value={state.values.overlap}
          onChange={(value) => set("overlap", value)}
          options={[
            { value: "skip", label: "Skip", isDefault: defaults.overlap === "skip" },
            { value: "parallel", label: "Run in parallel", isDefault: defaults.overlap === "parallel" },
            { value: "queue", label: "Queue after", isDefault: defaults.overlap === "queue" },
          ]}
        />
      </div>
      {error("overlap") !== undefined && <FieldError>{error("overlap")}</FieldError>}
    </PolicyLine>
  ),
};

const MISSED_OPTIONS: readonly { value: MissedPolicy; label: string; help: HelpKey }[] = [
  { value: "run-on-wake", label: "Run on wake", help: "p.wake" },
  { value: "wait-for-me", label: "Wait for me", help: "p.waitme" },
  { value: "skip", label: "Skip", help: "p.skip" },
];

const WORTH_OPTIONS: readonly { value: WorthUntil; label: string }[] = [
  { value: "next-run", label: "the next scheduled run" },
  { value: "time", label: "a time of day" },
];

/** What a missed run becomes — for a job on a schedule; a hook or a chain says it does not apply. */
const MISSED: PolicyRow = {
  ...MISSED_WORDS,
  row: ({ state, set, defaults, error }) => {
    const { values } = state;
    if (values.trigger !== "schedule") {
      return (
        <PolicyLine key="missed" label="If a run is missed" muted>
          <div className={styles.inline} data-testid="missed-n-a">
            {values.trigger === "hook" ? "Doesn’t apply — hooks fire only while Pomade is running." : "Doesn’t apply — a chain runs when the job before it finishes."}
          </div>
        </PolicyLine>
      );
    }
    return (
      <PolicyLine key="missed" label="If a run is missed" help="p.missed">
        <div data-field="missed">
          <Segmented<MissedPolicy>
            label="If a run is missed"
            value={values.missed}
            onChange={(value) => set("missed", value)}
            options={MISSED_OPTIONS.map((option) => ({ ...option, isDefault: defaults.missed === option.value }))}
          />
        </div>
        {error("missed") !== undefined && <FieldError>{error("missed")}</FieldError>}
        {values.missed === "run-on-wake" && (
          <>
            <div className={styles.inline}>
              Still worth it until
              <Segmented<WorthUntil> label="Still worth it until" value={values.worth} onChange={(value) => set("worth", value)} options={WORTH_OPTIONS} />
              {values.worth === "time" && (
                <TextInput
                  width="time"
                  placeholder="13:00"
                  aria-label="Worth it until"
                  inputMode="numeric"
                  value={values.worthAt}
                  bad={error("worthAt") !== undefined}
                  data-field="worthAt"
                  onChange={(event) => set("worthAt", event.target.value)}
                />
              )}
              <Help k="p.worth" />
            </div>
            {error("worthAt") !== undefined && <FieldError>{error("worthAt")}</FieldError>}
          </>
        )}
      </PolicyLine>
    );
  },
};

/** A run stopped past its time limit; empty is no limit. */
const TIME_LIMIT: PolicyRow = {
  ...TIME_LIMIT_WORDS,
  row: ({ state, set, error }) => {
    const limited = state.values.timeLimit.trim() !== "";
    return (
      <PolicyLine key="timeLimit" label="Time limit" help="p.limit">
        <div className={styles.inline}>
          <TextInput className={styles.limit} placeholder="none" aria-label="Time limit" value={state.values.timeLimit} bad={error("timeLimit") !== undefined} data-field="timeLimit" onChange={(event) => set("timeLimit", event.target.value)} />
          <span>{limited ? "Stops the run with a red card" : "No limit · the “still expected?” warning still applies"}</span>
        </div>
        {error("timeLimit") !== undefined && <FieldError>{error("timeLimit")}</FieldError>}
      </PolicyLine>
    );
  },
};

/** A script's policies, in the sentence's order. */
const SCRIPT_POLICIES: readonly PolicyRow[] = [MISSED, OVERLAP, LOW_PRIORITY, TIME_LIMIT, NOTIFY];

/** The Script kind: Trigger (a schedule, a hook or a chain), then Runs. */
function ScriptSections(props: FormProps): React.JSX.Element {
  const { state, set, error } = props;
  return (
    <>
      <TriggerSection {...props} />
      <FormSection title="Runs" sub="what · where">
        <Field label="Command" help="f.command" error={error("command")}>
          {(id) => <TextInput id={id} mono placeholder="./scripts/backup.sh" value={state.values.command} bad={error("command") !== undefined} data-field="command" onChange={(event) => set("command", event.target.value)} />}
        </Field>
        <FolderAndProject {...props} />
      </FormSection>
    </>
  );
}

/** The Service kind: Trigger (always on — when it starts, when it counts as up, a chain that acts on
 *  it), then Runs. */
function ServiceSections(props: FormProps): React.JSX.Element {
  const { state, set, error, projects } = props;
  const { values } = state;
  const [readyOpen, setReadyOpen] = useState(false);
  const projectName = values.project === null ? null : (projects.records.find((project) => project.id === values.project)?.name ?? values.project);
  return (
    <>
      <FormSection title="Trigger" sub="always on">
        <Field label="Starts" help="f.start" error={error("start")} hint="Then it stays up: restarts after a crash, keeps running when Pomade quits, stays stopped when you stop it.">
          {() => (
            <div className={styles.inline} data-field="start">
              <Segmented
                label="Starts"
                value={values.start}
                onChange={(value) => set("start", value)}
                options={[
                  { value: "login", label: "At login", isDefault: true },
                  { value: "project-first-open", label: "On first open of a project" },
                ]}
              />
              {values.start === "project-first-open" && projectName !== null && <span data-testid="start-project">{projectName}, the job's project</span>}
            </div>
          )}
        </Field>
        {readyOpen || values.ready !== "alive" ? (
          <Field label="Counts as “up” when" help="f.ready" error={error("ready")}>
            {(id) => (
              <div className={styles.inline} data-field="ready">
                <Segmented
                  label="Counts as up when"
                  value={values.ready}
                  onChange={(value) => set("ready", value)}
                  options={[
                    { value: "alive", label: "Alive after 5 s", isDefault: true },
                    { value: "port", label: "A port is open" },
                    { value: "url", label: "A URL answers" },
                  ]}
                />
                {values.ready === "port" && (
                  <TextInput id={id} className={styles.port} inputMode="numeric" placeholder="5173" aria-label="Port" value={values.port} bad={error("ready") !== undefined} onChange={(event) => set("port", event.target.value)} />
                )}
                {values.ready === "url" && (
                  <TextInput id={id} className={styles.url} mono placeholder="http://localhost:5173/" aria-label="URL" value={values.url} bad={error("ready") !== undefined} onChange={(event) => set("url", event.target.value)} />
                )}
              </div>
            )}
          </Field>
        ) : (
          <div className={styles.inline}>
            Counts as “up” when it is still alive after 5 s.
            <LinkButton onClick={() => setReadyOpen(true)}>Check a port or URL instead</LinkButton>
            <Help k="f.ready" />
          </div>
        )}
        <ServiceChainLine {...props} />
      </FormSection>
      <FormSection title="Runs" sub="what · where">
        <Field label="Command" help="f.command" error={error("command")}>
          {(id) => <TextInput id={id} mono placeholder="./start.sh" value={values.command} bad={error("command") !== undefined} data-field="command" onChange={(event) => set("command", event.target.value)} />}
        </Field>
        <FolderAndProject {...props} />
      </FormSection>
    </>
  );
}

/** The folder (with its picker) and the project, side by side. */
export function FolderAndProject(props: FormProps): React.JSX.Element {
  const { state, set, error, projects } = props;
  const { project } = state.values;
  const options: SelectOption[] = [{ value: "", label: "Workspace (no project)" }];
  for (const record of projects.list?.projects ?? []) options.push({ value: record.id, label: record.name, group: record.groupPath.length > 0 ? record.groupPath.join(" / ") : undefined });
  if (project !== null && !options.some((option) => option.value === project)) options.push({ value: project, label: project });
  return (
    <div className={styles.row}>
      <div className={styles.wide}>
        <FolderField {...props} />
      </div>
      <Field label="Project" help="f.project" error={error("project")}>
        {(id) => <Select id={id} options={options} value={project ?? ""} bad={error("project") !== undefined} data-field="project" onChange={(event) => set("project", event.target.value === "" ? null : event.target.value)} />}
      </Field>
    </div>
  );
}


/** Every kind's card, in the picker's order; the ones with `build` are the ones the form makes. */
export const KIND_UI: Record<JobKind, KindUi> = {
  service: {
    label: "Service",
    line: "Keeps a command running, always",
    icon: "service",
    help: "kind.service",
    namePlaceholder: "Coda web",
    build: {
      sections: (props) => <ServiceSections {...props} />,
      policies: [LOW_PRIORITY, NOTIFY],
      createLabel: (values) => (values.enabled ? "Create and start" : "Create job"),
    },
  },
  script: {
    label: "Script",
    line: "Runs a command on a trigger",
    icon: "script",
    help: "kind.script",
    namePlaceholder: "Health check",
    build: {
      sections: (props) => <ScriptSections {...props} />,
      policies: SCRIPT_POLICIES,
      createLabel: () => "Create job",
    },
  },
  agent: { label: "Agent", line: "Runs an agent with a prompt", icon: "agent", help: "kind.agent", namePlaceholder: "Morning summary" },
  git: { label: "Git", line: "Git operation on your repos", icon: "git", help: "kind.git", namePlaceholder: "Knowledge commit & push" },
};
