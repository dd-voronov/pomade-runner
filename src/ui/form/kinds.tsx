// The job form's kinds, as the person sees them: each kind's card in the picker, and — for a kind
// the form builds — its sections between Kind and Policies, its policy rows and its Create button.
// A kind the form builds is registered twice: its file fields in `state.ts` (`FORM_KINDS`) and its
// sections here (`sections`, `policies`); the picker offers exactly those.

import { useState, type ReactNode } from "react";

import type { JobKind, Notify, OverlapPolicy } from "../../jobs/model";
import type { HelpKey } from "../help";
import { Field, Help, LinkButton, Segmented, Select, TextInput, Toggle, type IconName, type SelectOption } from "../kit";
import { FolderField, type FormProps } from "./FolderField";
import { FormSection } from "./FormSection";
import styles from "./JobForm.module.css";
import { fileLimit, fileMissed, LOW_PRIORITY_WORDS, MISSED_FROM_FILE_WORDS, NOTIFY_WORDS, OVERLAP_WORDS, TIME_LIMIT_FROM_FILE_WORDS, type PolicyWords } from "./policies";
import type { FormValues } from "./state";
import { TriggerSection } from "./TriggerSection";

/** A policy as the Policies section shows it: its words in the summary (`policies.ts`), and its
 *  row once the person presses Change — a control for a policy the form edits, the file's value for
 *  one it shows from the file only. */
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

export function PolicyLine({ label, help, children }: { label: string; help: HelpKey; children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.policy}>
      <div className={styles.policyLabel}>
        {label} <Help k={help} />
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
      {error("notify")}
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
      {error("overlap")}
    </PolicyLine>
  ),
};

/** A policy the form shows from the file only: its row says it is changed in the job file. */
function FileOnlyLine({ label, help, value }: { label: string; help: HelpKey; value: string }): React.JSX.Element {
  return (
    <PolicyLine key={label} label={label} help={help}>
      <div className={styles.inline} data-testid="policy-file-only">
        <span>
          <b className={styles.fileOnlyValue}>{value}</b> · changed in the job file
        </span>
      </div>
    </PolicyLine>
  );
}

const MISSED_FROM_FILE: PolicyRow = {
  ...MISSED_FROM_FILE_WORDS,
  row: ({ state }) => {
    const read = fileMissed(state);
    return read === null ? null : <FileOnlyLine key="missed" label="If a run is missed" help="p.missed" value={read.label} />;
  },
};

const TIME_LIMIT_FROM_FILE: PolicyRow = {
  ...TIME_LIMIT_FROM_FILE_WORDS,
  row: ({ state }) => {
    const limit = fileLimit(state);
    return limit === null ? null : <FileOnlyLine key="timeLimit" label="Time limit" help="p.limit" value={limit} />;
  },
};

/** A script's policies, in the sentence's order. */
const SCRIPT_POLICIES: readonly PolicyRow[] = [MISSED_FROM_FILE, OVERLAP, LOW_PRIORITY, TIME_LIMIT_FROM_FILE, NOTIFY];

/** The Script kind: Trigger (a schedule), then Runs. */
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

/** The Service kind: Trigger (always on — when it starts, when it counts as up), then Runs. */
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
