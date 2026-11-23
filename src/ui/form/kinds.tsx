// The job form's kinds, as the person sees them: each kind's card in the picker, its sections
// between Kind and Policies, its policy rows and its Create button. A kind is registered twice: its
// file fields in `state.ts` (`FORM_KINDS`) and its sections here (`sections`, `policies`).

import { useState, type ReactNode } from "react";

import { agentModes, FULL_AUTONOMY_MODE, modeWords } from "../../integrations/agents";
import { GIT_OPERATIONS, type GitOperation, type JobKind, type MissedPolicy, type Notify, type OverlapPolicy, type ServiceStart } from "../../jobs/model";
import { GIT_OPERATION_WORDS } from "../../jobs/words";
import type { HelpKey } from "../help";
import { Check, Checks, Field, FieldError, Help, Icon, LinkButton, Segmented, Select, TextArea, TextInput, Toggle, type IconName, type SelectOption } from "../kit";
import { useProjectsFor, useRoster } from "../useAgents";
import { useRepos } from "../useRunnerApi";
import { FolderField, type FormProps } from "./FolderField";
import { FormSection } from "./FormSection";
import styles from "./JobForm.module.css";
import { LOW_PRIORITY_WORDS, MISSED_WORDS, NOTIFY_WORDS, OVERLAP_WORDS, TIME_LIMIT_WORDS, type PolicyWords } from "./policies";
import type { FormValues, TriggerKind, WorthUntil } from "./state";
import { ServiceChainLine, TriggerSection } from "./TriggerSection";
import { projectPicks } from "./triggerWords";

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
  /** Its sections between Kind and Policies, its policy rows and the primary button's words for a
   *  new job — `startsNow`: it starts as it is created (`startsOnCreate`). */
  build: {
    sections(props: FormProps): ReactNode;
    policies: readonly PolicyRow[];
    createLabel(startsNow: boolean): string;
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

/** Why a job not on a schedule never misses a run. */
const MISSED_N_A: Record<Exclude<TriggerKind, "schedule">, string> = {
  hook: "Doesn’t apply — hooks fire only while Pomade is running.",
  chain: "Doesn’t apply — a chain runs when the job before it finishes.",
  manual: "Doesn’t apply — a manual job runs only when you start it.",
};

/** What a missed run becomes — for a job on a schedule; a hook, a chain or a manual job says it does
 *  not apply. */
const MISSED: PolicyRow = {
  ...MISSED_WORDS,
  row: ({ state, set, defaults, error }) => {
    const { values } = state;
    if (values.trigger !== "schedule") {
      const why = MISSED_N_A[values.trigger];
      return (
        <PolicyLine key="missed" label="If a run is missed" muted>
          <div className={styles.inline} data-testid="missed-n-a">
            {why}
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

/** A script's and a git job's policies, in the sentence's order. */
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

/** What each start means for the service's life, under Starts. */
const STARTS_HINT: Record<ServiceStart, string> = {
  login: "Up before you open Pomade, and it outlives Pomade. It restarts after a crash; stopped by you, it stays stopped until Start.",
  "pomade-started": "Starts when Pomade starts and stops when Pomade quits. It restarts after a crash; stopped by you, it stays stopped until Start or the next Pomade start.",
  "project-first-open": "Starts on the project's first open since Pomade started — at once if it is open already — and stops when Pomade quits. Stopped by you, it stays stopped until Start or the next Pomade start.",
};

/** The Service kind: Trigger (always on — when it starts, when it counts as up, a chain that acts on
 *  it), then Runs. */
function ServiceSections(props: FormProps): React.JSX.Element {
  const { state, set, error, projects } = props;
  const { values } = state;
  const [readyOpen, setReadyOpen] = useState(false);
  // The project whose first open starts it: the one picked, else the job's own.
  const startProject = values.startProject.trim() || values.project || "";
  return (
    <>
      <FormSection title="Trigger" sub="always on">
        <Field label="Starts" help="f.start" error={error("start")} hint={STARTS_HINT[values.start]}>
          {() => (
            <div className={styles.inline} data-field="start">
              <Segmented
                label="Starts"
                value={values.start}
                onChange={(value) => set("start", value)}
                options={[
                  { value: "login", label: "On Mac startup", isDefault: true },
                  { value: "pomade-started", label: "While Pomade is running" },
                  { value: "project-first-open", label: "On first open of a project" },
                ]}
              />
              {values.start === "project-first-open" && (
                <Select
                  auto
                  aria-label="Project it starts on"
                  options={projectPicks(projects.records, startProject, "Choose a project…")}
                  value={startProject}
                  bad={error("start") !== undefined}
                  data-testid="start-project"
                  onChange={(event) => set("startProject", event.target.value)}
                />
              )}
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
  return (
    <div className={styles.row}>
      <div className={styles.wide}>
        <FolderField {...props} />
      </div>
      <ProjectField {...props} />
    </div>
  );
}

/** The project: the Workspace, then Pomade's projects under their groups; one the file names that
 *  Pomade does not list stays, by its id. */
function ProjectField({ state, set, error, projects }: FormProps): React.JSX.Element {
  const { project } = state.values;
  const options: SelectOption[] = [{ value: "", label: "Workspace (no project)" }];
  for (const record of projects.list?.projects ?? []) options.push({ value: record.id, label: record.name, group: record.groupPath.length > 0 ? record.groupPath.join(" / ") : undefined });
  if (project !== null && !options.some((option) => option.value === project)) options.push({ value: project, label: project });
  return (
    <Field label="Project" help="f.project" error={error("project")}>
      {(id) => <Select id={id} options={options} value={project ?? ""} bad={error("project") !== undefined} data-field="project" onChange={(event) => set("project", event.target.value === "" ? null : event.target.value)} />}
    </Field>
  );
}

const OPERATION_OPTIONS: readonly { value: GitOperation; label: string }[] = GIT_OPERATIONS.map((value) => ({ value, label: GIT_OPERATION_WORDS[value] }));

/** The Git kind: Trigger (a schedule, a hook or a chain), then Git — the operation, the repos it
 *  runs on and the project; no folder: `pomade-git` works in the repos. */
function GitSections(props: FormProps): React.JSX.Element {
  const { state, set, error } = props;
  const { values } = state;
  return (
    <>
      <TriggerSection {...props} />
      <FormSection title="Git" sub="what · where">
        <Field label="Operation" help="f.gitop" error={error("operation")}>
          {() => (
            <div data-field="operation">
              <Segmented<GitOperation> label="Operation" value={values.operation} onChange={(value) => set("operation", value)} options={OPERATION_OPTIONS} />
            </div>
          )}
        </Field>
        <RepoPicker {...props} />
        <div className={styles.narrow}>
          <ProjectField {...props} />
        </div>
      </FormSection>
    </>
  );
}

/** The repos: a check per repo of the workspace, as Pomade's Git panel names them, followed live;
 *  one the file names that the workspace lacks stays, checked, and is said under them. A repo
 *  checked runs after the ones checked before it. */
function RepoPicker({ host, state, set, error }: FormProps): React.JSX.Element {
  const repos = useRepos(host);
  const chosen = state.values.repos;
  const known = repos.status === "ready" ? repos.value.map((repo) => repo.name) : [];
  const missing = repos.status === "ready" ? chosen.filter((repo) => !known.includes(repo)) : [];
  const shown = repos.status === "ready" ? [...known, ...missing] : chosen;
  const toggle = (repo: string): void => set("repos", chosen.includes(repo) ? chosen.filter((name) => name !== repo) : [...chosen, repo]);
  const hint =
    repos.status === "loading" ? (
      "Reading the workspace's repos…"
    ) : repos.status !== "ready" ? (
      <span className={styles.problem}>Could not read the workspace's repos: {repos.status === "failed" ? repos.message : "Pomade did not answer"}.</span>
    ) : missing.length > 0 ? (
      <span className={styles.problem} data-testid="repos-missing">
        {missing.join(", ")} {missing.length === 1 ? "is" : "are"} not in this workspace.
      </span>
    ) : known.length === 0 ? (
      "The workspace has no git repos."
    ) : undefined;
  return (
    <Field label="Repositories" help="f.repos" error={error("repos")} hint={hint}>
      {(id) => (
        <div id={id} role="group" aria-label="Repositories" data-field="repos" data-testid="repo-picker">
          {shown.length > 0 && (
            <Checks>
              {shown.map((repo) => (
                <Check key={repo} on={chosen.includes(repo)} data-tip={missing.includes(repo) ? "Not in this workspace" : undefined} aria-invalid={missing.includes(repo) || undefined} onClick={() => toggle(repo)}>
                  {repo}
                </Check>
              ))}
            </Checks>
          )}
        </div>
      )}
    </Field>
  );
}

/** The modes every agent is offered — Normal and Full autonomy, faded where the agent lacks one — and
 *  the agent's own others after them. */
const BASE_MODES = ["normal", FULL_AUTONOMY_MODE] as const;

/** The Agent kind: Trigger (a schedule, a hook or a chain), then Agent — who (the roster), where
 *  (the folder: the projects connected to the agent first, then any folder; the project), how (the
 *  agent's modes, the Full-autonomy warning) — and the prompt, the file's body. Without the Agents
 *  app the form says so in place of the agent and mode pickers. */
function AgentSections(props: FormProps): React.JSX.Element {
  const { host, state, set, error, projects, workspaceName } = props;
  const { values } = state;
  const roster = useRoster(host);
  const agents = roster.status === "ready" ? roster.value : [];
  const agent = agents.find((candidate) => candidate.id === values.agent);
  const connected = useProjectsFor(host, roster.status === "ready" && agent !== undefined ? agent.id : null);
  const own = agent === undefined ? [] : agentModes(agent);
  const modes = [...BASE_MODES.map((id) => own.find((mode) => mode.id === id) ?? { id, name: modeWords(id), args: [] }), ...own.filter((mode) => !(BASE_MODES as readonly string[]).includes(mode.id))];
  if (!modes.some((mode) => mode.id === values.mode)) modes.push({ id: values.mode, name: modeWords(values.mode), args: [] });
  const pickAgent = (id: string): void => {
    set("agent", id);
    const next = agents.find((candidate) => candidate.id === id);
    if (next !== undefined && !agentModes(next).some((mode) => mode.id === values.mode)) set("mode", "normal");
  };
  const agentName = agent?.name ?? values.agent;
  const connectedProjects = connected.status === "ready" ? connected.value.flatMap((id) => projects.records.filter((record) => record.id === id)) : [];
  const suggestions =
    agent === undefined ? undefined : (
      <div className={styles.inline} data-testid="agent-folders">
        <span className={styles.hint}>Connected to {agentName}:</span>
        {connectedProjects.map((project) => (
          <button key={project.id} type="button" className={styles.suggest} data-tip={project.root} onClick={() => props.setFolder(project.root)}>
            {project.name}
          </button>
        ))}
        <button type="button" className={styles.suggest} onClick={() => props.setFolder(".")}>
          {workspaceName} (workspace root)
        </button>
      </div>
    );
  const absent = roster.status === "absent" || roster.status === "failed";
  return (
    <>
      <TriggerSection {...props} />
      <FormSection title="Agent" sub="who · where · how">
        {absent ? (
          <div className={styles.notice} role="status" data-testid="agents-absent">
            <Icon name="warn" />
            <p>
              {roster.status === "absent" ? `${capitalised(roster.message)}.` : `The Agents app's roster cannot be read: ${roster.message}.`} Runner lists the agents and their modes from it, so the job keeps{" "}
              <b>{values.agent}</b> in mode <b>{modeWords(values.mode)}</b> until it answers; a run due meanwhile fails.
            </p>
          </div>
        ) : (
          <Field label="Agent" help="f.agent" error={error("agent")} hint={roster.status === "ready" && agent === undefined ? <span className={styles.problem}>{values.agent} is not in the Agents app's roster.</span> : roster.status === "loading" ? "Reading the Agents app's roster…" : undefined}>
            {() => (
              <div data-field="agent">
                <Segmented<string>
                  label="Agent"
                  value={values.agent}
                  onChange={pickAgent}
                  options={[...agents.map((candidate) => ({ value: candidate.id, label: candidate.name })), ...(agent === undefined && roster.status === "ready" ? [{ value: values.agent, label: values.agent }] : [])]}
                  optionTestId={(id) => `agent-${id}`}
                />
              </div>
            )}
          </Field>
        )}
        <div className={styles.row}>
          <div className={styles.wide}>
            <FolderField {...props} help="f.agentfolder" below={absent ? undefined : suggestions} />
          </div>
          <ProjectField {...props} />
        </div>
        {!absent && (
          <Field label="Mode" help="f.mode" error={error("mode")}>
            {() => (
              <div data-field="mode">
                <Segmented<string>
                  label="Mode"
                  value={values.mode}
                  onChange={(mode) => set("mode", mode)}
                  options={modes.map((mode) => {
                    const offered = own.some((candidate) => candidate.id === mode.id);
                    return { value: mode.id, label: mode.name, isDefault: mode.id === "normal", disabled: !offered && mode.id !== values.mode, tip: offered || roster.status !== "ready" ? undefined : `${agentName} has no ${mode.name.toLowerCase()} mode` };
                  })}
                  optionTestId={(id) => `mode-${id}`}
                />
              </div>
            )}
          </Field>
        )}
        {values.mode === FULL_AUTONOMY_MODE && (
          <div className={styles.warnbar} role="note" data-testid="full-autonomy-warning">
            <Icon name="warn" />
            <span>
              <b>Skips every approval.</b> The agent edits files and runs commands without asking. The job shows a “Full autonomy” mark in the list. <Help k="f.fullauto" />
            </span>
          </div>
        )}
        <Field label="Prompt" help="f.prompt" error={error("prompt")} hint="Saved as the body of the job file.">
          {(id) => <TextArea id={id} rows={6} placeholder="What should the agent do?" value={values.prompt} bad={error("prompt") !== undefined} data-field="prompt" onChange={(event) => set("prompt", event.target.value)} />}
        </Field>
      </FormSection>
    </>
  );
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Every kind's card, in the picker's order. */
export const KIND_UI: Record<JobKind, KindUi> = {
  service: {
    label: "Service",
    line: "Keeps a command running, always",
    icon: "service",
    help: "kind.service",
    namePlaceholder: "Dev server",
    build: {
      sections: (props) => <ServiceSections {...props} />,
      policies: [LOW_PRIORITY, NOTIFY],
      createLabel: (startsNow) => (startsNow ? "Create and start" : "Create job"),
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
  agent: {
    label: "Agent",
    line: "Runs an agent with a prompt",
    icon: "agent",
    help: "kind.agent",
    namePlaceholder: "Morning summary",
    build: {
      sections: (props) => <AgentSections {...props} />,
      policies: SCRIPT_POLICIES,
      createLabel: () => "Create job",
    },
  },
  git: {
    label: "Git",
    line: "Git operation on your repos",
    icon: "git",
    help: "kind.git",
    namePlaceholder: "Commit notes",
    build: {
      sections: (props) => <GitSections {...props} />,
      policies: SCRIPT_POLICIES,
      createLabel: () => "Create job",
    },
  },
};
