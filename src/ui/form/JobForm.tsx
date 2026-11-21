// The job form: a full page in the Runner tab, for a new job or for editing one. Its head (back to
// Jobs, the title, Enabled, and — editing — Open file and Delete), the sections — Kind and name,
// then the kind's own (a service's Trigger and Runs), then Policies — and the sticky Save bar. The
// values live in `state.ts`; the file the form would write is checked by the one validator and each
// error shows on its field. Editing follows the file on disk: what the person left alone takes the
// file's values, what they set stays.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectListResult } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { projectJobsFolder } from "../../jobs/check";
import { describeJobError } from "../../jobs/format";
import type { JobError, JobKind, JobsSnapshot } from "../../jobs/model";
import { createJobFile, followJobFile, updateJobFile } from "../jobFiles";
import { DeleteJobDialog } from "../DeleteJobDialog";
import { Button, EmptyBlock, Field, Help, Icon, IconButton, TextInput, Toggle, useToast } from "../kit";
import type { FormProps, ProjectChoices } from "./FolderField";
import styles from "./JobForm.module.css";
import { FormSection } from "./FormSection";
import { KIND_UI } from "./kinds";
import { policySentence } from "./policies";
import {
  blankValues,
  blocksSave,
  bodyChange,
  editForm,
  errorShows,
  errorsByPlace,
  fieldChanges,
  followText,
  formErrors,
  FORM_KINDS,
  hasChanges,
  newBody,
  newForm,
  projectRecords,
  setFolder,
  setValue,
  switchKind,
  wouldBe,
  type ErrorPlace,
  type FormField,
  type FormState,
} from "./state";

/** Which job the form is for. */
/** A new job — in `project` (an id) when given: its project and folder start as that project's — or the job edited. */
export type FormTarget = { kind: "new"; project: string | null } | { kind: "edit"; job: string };

/** One validator error, in `pomade-runner check`'s words, its field in bold. */
function ErrorText({ error }: { error: JobError }): React.JSX.Element {
  const text = describeJobError(error);
  if (error.field === "" || !text.startsWith(error.field)) return <span className={styles.errorLine}>{text}</span>;
  return (
    <span className={styles.errorLine}>
      <b>{error.field}</b>
      {text.slice(error.field.length)}
    </span>
  );
}

/** Pomade's projects, as `project.list` answers once. */
function useProjectList(host: HostClient): ProjectListResult | null {
  const [list, setList] = useState<ProjectListResult | null>(null);
  useEffect(() => {
    let live = true;
    host.project.list().then(
      (result) => {
        if (live) setList(result);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host]);
  return list;
}

/** The workspace folder's name, from its absolute path. */
function folderName(path: string | null): string {
  const name = path?.split("/").filter(Boolean).at(-1);
  return name ?? "Workspace";
}

export function JobForm({
  host,
  target,
  jobs,
  serviceRunning,
  open,
}: {
  host: HostClient;
  target: FormTarget;
  jobs: JobsSnapshot;
  /** Whether the edited job's service runs now: Delete says it stops it first. */
  serviceRunning: boolean;
  /** Navigates the tab to a route. */
  open: (route: string) => void;
}): React.JSX.Element {
  const list = useProjectList(host);
  const projects: ProjectChoices = useMemo(() => ({ list, records: projectRecords(list?.projects ?? []) }), [list]);
  const entry = target.kind === "edit" ? jobs.jobs.find((candidate) => (candidate.valid ? candidate.job.id : candidate.invalid.id) === target.job) : undefined;
  const found = target.kind === "edit" ? (entry === undefined ? null : entry.valid ? entry.job.path : entry.invalid.path) : null;
  // The file stays the form's once found: deleted on disk while the form is open, the form says so.
  const known = useRef<{ job: string; path: string } | null>(null);
  if (target.kind === "edit" && found !== null) known.current = { job: target.job, path: found };
  const path = target.kind === "edit" ? (found ?? (known.current?.job === target.job ? known.current.path : null)) : null;
  const back = (): void => open("");

  if (target.kind === "edit" && path === null) {
    return (
      <FormFrame title="Edit job" back={back}>
        <div className={styles.page}>
          <EmptyBlock title="No such job" testId="form-missing" action={<Button onClick={back}>Back to Jobs</Button>}>
            <p>
              No job file has the id <span className={styles.mono}>{target.job}</span>. It may have been deleted or renamed.
            </p>
          </EmptyBlock>
        </div>
      </FormFrame>
    );
  }
  return <FormBody key={path ?? "new"} host={host} path={path} preset={target.kind === "new" ? target.project : null} jobs={jobs} projects={projects} serviceRunning={serviceRunning} open={open} />;
}

/** The form's head and page around what it shows. */
function FormFrame({ title, back, right, children, foot }: { title: ReactNode; back: () => void; right?: ReactNode; children?: ReactNode; foot?: ReactNode }): React.JSX.Element {
  return (
    <main className={styles.root} data-testid="job-form">
      <header className={styles.head} data-testid="form-head">
        <IconButton icon="back" label="Back to Jobs" onClick={back} data-testid="form-back" />
        <h2 className={styles.title} data-testid="form-title">
          <span className={styles.crumb}>Jobs /</span> {title}
        </h2>
        {right !== undefined && <div className={styles.headRight}>{right}</div>}
      </header>
      <div className={styles.scroll}>{children}</div>
      {foot}
    </main>
  );
}

const KINDS = Object.keys(KIND_UI) as JobKind[];

function FormBody({
  host,
  path,
  preset,
  jobs,
  projects,
  serviceRunning,
  open,
}: {
  host: HostClient;
  /** The edited file; `null` for a new job. */
  path: string | null;
  /** The project a new job starts in; `null` for none. */
  preset: string | null;
  jobs: JobsSnapshot;
  projects: ProjectChoices;
  serviceRunning: boolean;
  open: (route: string) => void;
}): React.JSX.Element {
  const toast = useToast();
  const [state, setState] = useState<FormState | null>(() => (path === null ? newForm("service") : null));
  /** The file's text as last read: `undefined` until read, `null` once it is gone. */
  const [file, setFile] = useState<string | null | undefined>(path === null ? null : undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [polOpen, setPolOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const back = (): void => open("");
  /** Opens the file in Pomade's editor; a file that went away since the form read it is said, not thrown. */
  const openJobFile = (): void => {
    if (path === null) return;
    host.tabs.openFile({ path }).catch((err: unknown) => toast(`Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`));
  };

  // A new job opened from a project starts in it, once Pomade's projects are known — unless the
  // person has set either field by then.
  const presetRoot = preset === null ? undefined : projects.list?.projects.find((project) => project.id === preset)?.root;
  useEffect(() => {
    if (preset === null || presetRoot === undefined) return;
    setState((now) => {
      if (now === null || now.path !== null || now.touched.includes("project") || now.touched.includes("folder") || now.values.project !== null) return now;
      const start = { project: preset, folder: presetRoot };
      return { ...now, values: { ...now.values, ...start }, base: { ...now.base, ...start } };
    });
  }, [preset, presetRoot]);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    const failed = (err: unknown): void => {
      if (live) setSaveError(err instanceof Error ? err.message : String(err));
    };
    const following = followJobFile(
      host,
      path,
      (text) => {
        if (!live) return;
        setFile(text);
        if (text !== null) setState((current) => (current === null ? editForm(path, text) : followText(current, text)));
      },
      failed,
    );
    following.catch(failed);
    return () => {
      live = false;
      void following.then((f) => f.close(), () => undefined);
    };
  }, [host, path]);

  const errors = useMemo(() => (state === null ? [] : formErrors(state, jobs, list(projects))), [state, jobs, projects]);

  // A Save that found errors: the first field in error takes the focus.
  useEffect(() => {
    if (focusTick === 0 || state === null) return;
    const places = errorsByPlace(errors, state.values);
    for (const el of form.current?.querySelectorAll<HTMLElement>("[data-field]") ?? []) {
      if (!places.has(el.dataset.field as FormField)) continue;
      const target = el.matches("input, select, textarea, button") ? el : (el.querySelector<HTMLElement>('[aria-invalid="true"]') ?? el.querySelector<HTMLElement>("input, select, textarea, button"));
      target?.focus();
      el.scrollIntoView({ block: "center" });
      break;
    }
    // Only a new Save moves the focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  const title = state === null ? "" : path === null ? "New job" : state.base.name || "Untitled job";
  if (path !== null && file === undefined) return <FormFrame title="" back={back} />;
  if (state === null) {
    const why = file === null ? "Its file is gone: it was deleted or moved on disk." : "The form cannot read its file: the frontmatter is broken, or its kind is not one Runner has. Open the file to fix it.";
    return (
      <FormFrame title={title || "Edit job"} back={back}>
        <div className={styles.page}>
          <EmptyBlock
            title="The form cannot edit this job"
            testId="form-unsupported"
            action={
              file !== null && path !== null ? (
                <Button icon="file" onClick={openJobFile}>
                  Open file
                </Button>
              ) : (
                <Button onClick={back}>Back to Jobs</Button>
              )
            }
          >
            <p>{why}</p>
          </EmptyBlock>
        </div>
      </FormFrame>
    );
  }

  const { values } = state;
  const ui = KIND_UI[values.kind];
  const { build } = ui;
  const places = errorsByPlace(errors, values);
  const blocking = [...places].filter(([place]) => blocksSave(state, place)).flatMap(([, list]) => list);
  const shownCount = state.tried ? blocking.length : 0;
  const errorList = (place: ErrorPlace): readonly JobError[] => (errorShows(state, place) ? (places.get(place) ?? []) : []);
  const error = (place: ErrorPlace): ReactNode => {
    const list = errorList(place);
    if (list.length === 0) return undefined;
    return list.map((one, index) => <ErrorText key={index} error={one} />);
  };
  const update = (next: (current: FormState) => FormState): void => {
    setSaveError(null);
    setState((current) => (current === null ? current : next(current)));
  };
  const target = wouldBe(state, jobs, projects.records);
  const gone = path !== null && file === null;
  const openFile = path === null || gone ? undefined : openJobFile;
  const jobId = path === null ? null : entryId(jobs, path);
  const props: FormProps = {
    host,
    state,
    set: (field, value) => update((current) => setValue(current, field, value)),
    setFolder: (folder) => update((current) => setFolder(current, folder, projects.records)),
    error,
    errorList,
    wouldBeText: target.text,
    openFile,
    projects,
    workspaceName: folderName(jobs.workspace),
    jobs,
    jobId,
  };
  const changed = hasChanges(state);

  const save = async (): Promise<void> => {
    if (blocking.length > 0) {
      setState({ ...state, tried: true });
      setFocusTick((tick) => tick + 1);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (state.path === null) {
        const project = values.project === null ? undefined : projects.records.find((record) => record.id === values.project);
        const fields = Object.fromEntries(Object.entries(FORM_KINDS[values.kind].fields(values)).filter(([, value]) => value !== undefined));
        const created = await createJobFile(host, { folder: project === undefined ? null : projectJobsFolder(project), fields: { ...fields, name: values.name.trim() }, body: newBody(values) });
        const started = values.kind === "service" && values.enabled && values.start === "login";
        toast(
          <>
            Created <span className={styles.mono}>{created}</span>
            {started ? " · started" : ""}
          </>,
        );
      } else {
        await updateJobFile(host, state.path, fieldChanges(state), bodyChange(state));
        if (target.movesFrom !== null) await host.files.move({ from: target.movesFrom, to: target.path });
        toast(
          <>
            Saved <span className={styles.mono}>{target.path}</span>
          </>,
        );
      }
      back();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const head = (
    <>
      <label className={styles.enabled}>
        Enabled <Help k="f.enabled" />
        <Toggle on={values.enabled} onChange={(on) => props.set("enabled", on)} label="Enabled" tip="" data-testid="form-enabled" />
      </label>
      {path !== null && (
        <div className={styles.fileActions}>
          <Button icon="file" onClick={openFile} disabled={openFile === undefined} data-testid="form-open-file">
            Open file
          </Button>
          <Button icon="trash" variant="danger" onClick={() => setDeleting(true)} disabled={gone} data-testid="form-delete">
            Delete
          </Button>
        </div>
      )}
    </>
  );

  const fileErrors = places.get("file");
  const clashWords = state.clashes.map((field) => FIELD_WORDS[field]).join(", ");
  const policyDefaults = blankValues(values.kind);
  const sentence = policySentence(build.policies, state, policyDefaults);
  const policySummary = sentence.parts.map((part, index) => (
    <span key={part.key}>
      {index > 0 && " · "}
      {part.isDefault ? part.text : <b>{part.text}</b>}
    </span>
  ));

  return (
    <FormFrame
      title={title}
      back={back}
      right={head}
      foot={
        <footer className={styles.foot}>
          <div className={styles.footPath} data-testid="form-foot-note">
            {saveError !== null ? (
              <span className={styles.footError}>
                <Icon name="warn" size={12} />
                <span>Not saved: {saveError}</span>
              </span>
            ) : shownCount > 0 ? (
              <span className={styles.footError} data-testid="form-error-count">
                <Icon name="warn" size={12} />
                <span>
                  {shownCount} thing{shownCount > 1 ? "s" : ""} to fix before saving
                </span>
              </span>
            ) : (
              <>
                Saves to <code data-testid="form-path">{target.path}</code> <Help k="f.file" />
              </>
            )}
          </div>
          <Button onClick={back}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || gone || (path !== null && !changed)} data-testid="form-save">
            {saving ? "Saving…" : path === null ? build.createLabel(values) : changed ? "Save" : "Saved"}
          </Button>
        </footer>
      }
    >
      <form ref={form} className={styles.form} autoComplete="off" onSubmit={(event) => event.preventDefault()} data-testid={`form-${values.kind}`}>
        {gone && (
          <div className={styles.notice} role="status" data-testid="form-gone">
            <Icon name="warn" />
            <p>This job's file is gone: it was deleted or moved on disk. Save has nothing to write to.</p>
          </div>
        )}
        {state.clashes.length > 0 && !gone && (
          <div className={styles.notice} role="status" data-testid="form-clash">
            <Icon name="warn" />
            <p>
              The file changed on disk while you edited it: {clashWords}. Your edits stay, and Save writes them over the file's.
            </p>
          </div>
        )}
        {fileErrors !== undefined && errorShows(state, "file") && (
          <div className={styles.notice} role="alert" data-testid="form-file-errors">
            <Icon name="warn" />
            <div>
              <p>The file has {fileErrors.length === 1 ? "a problem" : "problems"} the form has no field for — open the file to fix {fileErrors.length === 1 ? "it" : "them"}:</p>
              <ul>
                {fileErrors.map((one, index) => (
                  <li key={index}>
                    line {one.line}: <ErrorText error={one} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <FormSection title="Kind">
          <div className={styles.kinds} role="radiogroup" aria-label="Kind" data-field="kind">
            {KINDS.map((kind) => {
              const card = KIND_UI[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  className={styles.kind}
                  aria-checked={values.kind === kind}
                  data-help={card.help}
                  data-testid={`kind-${kind}`}
                  onClick={() => update((current) => switchKind(current, kind))}
                >
                  <b className={styles.kindName}>
                    <Icon name={card.icon} />
                    {card.label}
                  </b>
                  <span className={styles.kindLine}>{card.line}</span>
                </button>
              );
            })}
          </div>
          {error("kind")}
          <NameField {...props} placeholder={ui.namePlaceholder} focus={path === null} />
        </FormSection>
        {build.sections(props)}
        <FormSection title="Policies" sub={sentence.customised ? "customised" : `defaults for ${ui.label}`} testId="form-policies">
          {polOpen ? (
            <div>{build.policies.map((policy) => policy.row({ ...props, defaults: policyDefaults }))}</div>
          ) : (
            <div className={styles.policySum}>
              <p data-testid="policy-summary">{policySummary}</p>
              <Button onClick={() => setPolOpen(true)}>Change</Button>
            </div>
          )}
        </FormSection>
      </form>
      {deleting && path !== null && jobId !== null && (
        <DeleteJobDialog host={host} job={{ id: jobId, name: state.base.name, path }} serviceRunning={serviceRunning} onDeleted={back} onCancel={() => setDeleting(false)} />
      )}
    </FormFrame>
  );
}

/** A field's name in words, for the notice of a change on disk. */
const FIELD_WORDS: Record<FormField, string> = {
  kind: "kind",
  name: "name",
  project: "project",
  folder: "folder",
  enabled: "enabled",
  command: "command",
  start: "starts",
  startProject: "start project",
  ready: "counts as up",
  port: "port",
  url: "URL",
  trigger: "trigger",
  schedule: "schedule",
  hookEvent: "event",
  hookProject: "event's project",
  hookAgent: "event's agent",
  hookStatus: "event's status",
  serviceChain: "chain",
  chainJob: "chain's job",
  chainResult: "chain's result",
  chainAction: "chain's action",
  missed: "if a run is missed",
  worth: "still worth it until",
  worthAt: "worth it until",
  overlap: "if still running",
  lowPriority: "low priority",
  timeLimit: "time limit",
  notify: "notify me",
  operation: "operation",
  repos: "repositories",
  agent: "agent",
  mode: "mode",
  prompt: "prompt",
};

/** The job's name; a new job's form opens with the cursor in it (`focus`), as the prototype's does. */
function NameField({ state, set, error, placeholder, focus }: FormProps & { placeholder: string; focus: boolean }): React.JSX.Element {
  return (
    <Field label="Name" help="f.name" error={error("name")}>
      {(id) => <TextInput id={id} value={state.values.name} bad={error("name") !== undefined} placeholder={placeholder} autoFocus={focus} data-field="name" onChange={(event) => set("name", event.target.value)} />}
    </Field>
  );
}

/** The id of the snapshot's job at `path`. */
function entryId(jobs: JobsSnapshot, path: string): string | null {
  const entry = jobs.jobs.find((candidate) => (candidate.valid ? candidate.job.path : candidate.invalid.path) === path);
  return entry === undefined ? null : entry.valid ? entry.job.id : entry.invalid.id;
}

/** The project records the checks take, or `null` while Pomade's projects are not known. */
function list(projects: ProjectChoices): ProjectChoices["records"] | null {
  return projects.list === null ? null : projects.records;
}

