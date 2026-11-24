// A stand-in for Runner's scheduler in the fake host: another client of the app that serves
// Runner's API — the jobs, the services, the runs, the history a page at a time, one run and its output, Run now,
// Enable / Disable, Needs you, a missed run's choice, Stop, the switch, Resume, the settings — and
// announces `jobs.changed`, `services.changed`, `runs.changed` and `settings.changed`, as the real
// scheduler does through Pomade. It reads the fake workspace's jobs folder through the Host API and
// checks it with the real validator, so the UI specs drive it by writing files
// (`fakeHost.writeFile`). Every valid service runs; Restart is refused; a spec sets another state with
// `window.setServiceStatus` (the projects opened since Pomade started with `window.setOpenedProjects`), the runs with `window.setRuns`, the settings with
// `window.setSettings` (a setting written by the UI changes that text field-only: `window.settingsText`), the Mac with `window.setEnvironment`, and reads the actions the UI asked for in `window.runnerCalls`. Delete
// removes the job's file — refused with `window.refuseDelete`'s reason while one is set; Run now and
// Enable / Disable are refused with `window.refuseActions`'s. Any action is refused with
// `window.refuse[<method>]` while one is set.

import type { FakeHost } from "pomade-kit/fake-host";
import type { JsonValue } from "pomade-kit/protocol";
import { connect } from "pomade-kit/sdk";

import {
  DELETE_JOB_METHOD,
  DISMISS_METHOD,
  HISTORY_LIST_METHOD,
  JOBS_CHANGED_EVENT,
  JOBS_LIST_METHOD,
  MISSED_METHOD,
  RESUME_METHOD,
  RUN_GET_METHOD,
  RUN_NOW_METHOD,
  RUN_OUTPUT_METHOD,
  RUN_STOP_METHOD,
  RUNS_CHANGED_EVENT,
  RUNS_LIST_METHOD,
  SERVICE_METHODS,
  SERVICES_CHANGED_EVENT,
  SERVICES_LIST_METHOD,
  SET_ENABLED_METHOD,
  ENVIRONMENT_GET_METHOD,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_GET_METHOD,
  SETTINGS_SET_METHOD,
  SWITCH_METHOD,
} from "../../src/integrations/runner-api";
import { checkJobs } from "../../src/jobs/check";
import { entryId, entryPath, JOBS_FOLDER, type JobKind, type JobsSnapshot } from "../../src/jobs/model";
import type { ServicesReport, ServiceStatus } from "../../src/keeper/model";
import { parseRunAt } from "../../src/scheduler/missed";
import type { ActiveRun, HeldRun, HistoryPage, RunRecord, RunsReport, RunView, SwitchPosition } from "../../src/scheduler/model";
import type { EnvironmentReport } from "../../src/scheduler/environment";
import { checkSettings, setSettingsField, SETTINGS_PATH, settingsValueProblem, type SettingsField, type SettingsReport, type SettingsValue } from "../../src/scheduler/settings";

export async function startFakeScheduler(fake: FakeHost): Promise<void> {
  const result = await connect({ transport: fake.createTransport({ surface: "backend" }), keySource: null });
  if (result.status !== "connected") throw new Error(`fake scheduler: ${result.status}`);
  const { host } = result;

  const read = async (): Promise<JobsSnapshot> => {
    const { entries } = await host.files.readFolder({ path: "", recursive: true });
    const paths = entries.filter((e) => e.kind === "file" && e.path.startsWith(`${JOBS_FOLDER}/`) && e.path.endsWith(".md")).map((e) => e.path);
    // A file deleted between the listing and the read is gone from the next listing too.
    const read = await Promise.all(paths.map((path) => host.files.readFile({ path }).then((file) => ({ path: path.slice(JOBS_FOLDER.length + 1), text: file.content }), () => null)));
    const files = read.filter((file) => file !== null);
    const { projects } = await host.project.list();
    return checkJobs(files, { workspace: "/fake/workspace", projects: projects.map(({ id, name, root }) => ({ id, name, root })) });
  };

  /** Services whose status a spec set, by job id. */
  const set = new Map<string, Partial<ServiceStatus>>();
  /** The projects opened since Pomade started, as a spec set them. */
  let openedProjects: string[] = [];
  const services = (snapshot: JobsSnapshot): ServicesReport => ({
    keeper: { state: "connected", version: "e2e", pid: 1 },
    services: snapshot.jobs.flatMap((entry) =>
      entry.valid && entry.job.kind === "service"
        ? [{ job: entry.job.id, name: entry.job.name, project: entry.job.project, state: "running", session: null, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null, ...set.get(entry.job.id) }]
        : [],
    ),
    openedProjects,
  });

  let snapshot = await read();
  let runs: { report: RunsReport; held: HeldRun[]; history: RunRecord[]; output: string; outputMissing: boolean } = {
    report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null }, heldRuns: 0 },
    held: [],
    history: [],
    output: "",
    outputMissing: false,
  };
  let settingsText: string | null = null;
  let settings: SettingsReport = checkSettings(null);
  /** The settings file's new text — on disk in the fake workspace, as the real scheduler leaves it — and what it says. */
  const keep = (text: string | null): void => {
    const there = settingsText !== null;
    settingsText = text;
    settings = checkSettings(text);
    if (text !== null) fake.writeFile(SETTINGS_PATH, text);
    else if (there) fake.deleteFile(SETTINGS_PATH);
  };
  let environment: EnvironmentReport = { notifications: "unavailable", skill: { folder: "Knowledge/_skills/apps/pomade-runner-jobs", problem: null } };
  const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
  /** An action the UI asked for: recorded, answered `answer`. */
  const action =
    (method: string, answer: (params: JsonValue) => unknown = () => ({ ok: true })) =>
    (params: JsonValue): JsonValue => {
      window.runnerCalls.push({ method, params });
      const refusal = window.refuse[method];
      if (refusal !== undefined) return { ok: false, reason: refusal };
      return json(answer(params));
    };
  const find = (params: JsonValue): RunView | undefined => {
    const { job, run } = params as { job: string; run: string };
    return [...runs.report.active, ...runs.history].find((view) => view.job === job && view.run === run);
  };
  /** Start and Stop: the service as it stands (a spec sets what follows with `setServiceStatus`). */
  const serviceAnswer = (params: JsonValue): unknown => {
    const { job } = params as { job: string };
    const service = services(snapshot).services.find((status) => status.job === job);
    return service === undefined ? { ok: false, reason: `no service "${job}"` } : { ok: true, service };
  };
  /** A page of the history as set, newest first: `limit` records from the cursor `before` (an index);
   *  the newest page leads with the held rows as set. */
  const historyPage = (params: JsonValue): HistoryPage => {
    const { before = null, limit = 50 } = (params ?? {}) as { before?: string | null; limit?: number };
    const from = before === null ? 0 : Number(before);
    const records = runs.history.slice(from, from + limit);
    return { held: before === null ? runs.held : [], records, next: from + limit < runs.history.length ? String(from + limit) : null };
  };
  /** The run Run now starts, as the scheduler answers it. */
  const startedRun = (job: string, name: string, kind: JobKind, project: string | null): ActiveRun => ({
    job,
    name,
    kind,
    project,
    folder: "",
    run: "20261117-120000-abcdef",
    trigger: "manual",
    cause: null,
    dueAt: Date.now(),
    agent: null,
    missed: null,
    series: null,
    state: "running",
    lowPriority: false,
    runAt: null,
    deadline: null,
    waits: null,
    startedAt: Date.now(),
    session: null,
    log: null,
    limitHit: null,
    warnedAt: null,
    warningDismissed: false,
  });
  window.runnerCalls = [];
  window.refuseDelete = null;
  window.refuseActions = null;
  window.refuse = {};
  await host.api.serve({
    [JOBS_LIST_METHOD]: () => json(snapshot),
    [SERVICES_LIST_METHOD]: () => json(services(snapshot)),
    [RUNS_LIST_METHOD]: () => json(runs.report),
    [HISTORY_LIST_METHOD]: (params) => json(historyPage(params)),
    [RUN_GET_METHOD]: (params) => json(find(params) ?? null),
    [RUN_OUTPUT_METHOD]: () => json({ text: runs.output, truncated: false, missing: runs.outputMissing }),
    [RUN_NOW_METHOD]: action(RUN_NOW_METHOD, (params) => {
      const { job } = params as { job: string };
      if (window.refuseActions !== null) return { ok: false, reason: window.refuseActions };
      const entry = snapshot.jobs.find((candidate) => entryId(candidate) === job);
      if (entry === undefined || !entry.valid) return { ok: false, reason: `no job "${job}"` };
      return { ok: true, run: startedRun(entry.job.id, entry.job.name, entry.job.kind, entry.job.project) };
    }),
    [SET_ENABLED_METHOD]: action(SET_ENABLED_METHOD, () => (window.refuseActions === null ? { ok: true } : { ok: false, reason: window.refuseActions })),
    [SERVICE_METHODS.start]: action(SERVICE_METHODS.start, serviceAnswer),
    [SERVICE_METHODS.stop]: action(SERVICE_METHODS.stop, serviceAnswer),
    [SERVICE_METHODS.restart]: action(SERVICE_METHODS.restart, () => ({ ok: false, reason: "the keeper is not connected" })),
    [MISSED_METHOD]: action(MISSED_METHOD, (params) => {
      const { job, choice, at } = params as { job: string; choice: string; at?: string };
      if (choice === "skip") return { ok: true, at: null, runs: 0 };
      if (choice === "run-all" || choice === "run-others") {
        // As many as the waiting run, or the caught-up run, stands for: the other ones for run-others.
        const counted = [...runs.report.active, ...runs.history].find((view) => view.job === job && view.missed !== null)?.missed?.count ?? 1;
        return { ok: true, at: Date.now(), runs: choice === "run-all" ? counted : counted - 1 };
      }
      if (choice !== "run-at") return { ok: true, at: null, runs: 1 };
      const when = parseRunAt(at ?? "", new Date());
      return when.ok ? { ok: true, at: when.at, runs: 1 } : { ok: false, reason: when.reason };
    }),
    [RUN_STOP_METHOD]: action(RUN_STOP_METHOD),
    [RESUME_METHOD]: action(RESUME_METHOD, (params) => {
      const { job } = params as { job: string };
      runs = { ...runs, report: { ...runs.report, needsYou: runs.report.needsYou.filter((item) => item.id !== `loop-paused:${job}`) } };
      void host.events.publish(RUNS_CHANGED_EVENT);
      return { ok: true, job, name: job };
    }),
    [SWITCH_METHOD]: action(SWITCH_METHOD, (params) => {
      const position = (params as { position: SwitchPosition }).position;
      runs = { ...runs, report: { ...runs.report, switch: { position, since: 1 } } };
      void host.events.publish(RUNS_CHANGED_EVENT);
      return runs.report.switch;
    }),
    [SETTINGS_GET_METHOD]: () => json(settings),
    [SETTINGS_SET_METHOD]: action(SETTINGS_SET_METHOD, (params) => {
      const { field, value } = params as { field: SettingsField; value: SettingsValue };
      const problem = settingsValueProblem(field, value);
      if (problem !== null) return { ok: false, reason: problem };
      const written = setSettingsField(settingsText ?? "", field, value);
      if (!written.ok) return { ok: false, reason: written.message };
      keep(written.text);
      void host.events.publish(SETTINGS_CHANGED_EVENT);
      return { ok: true, settings };
    }),
    [ENVIRONMENT_GET_METHOD]: () => json(environment),
    [DELETE_JOB_METHOD]: action(DELETE_JOB_METHOD, (params) => {
      const { job } = params as { job: string };
      if (window.refuseDelete !== null) return { ok: false, reason: window.refuseDelete };
      const entry = snapshot.jobs.find((candidate) => entryId(candidate) === job);
      if (entry === undefined) return { ok: false, reason: `no job "${job}"` };
      fake.deleteFile(entryPath(entry));
      return { ok: true, job, path: entryPath(entry), stopped: entry.valid && entry.job.kind === "service" };
    }),
    [DISMISS_METHOD]: action(DISMISS_METHOD, (params) => {
      const { id } = params as { id: string };
      runs = { ...runs, report: { ...runs.report, needsYou: runs.report.needsYou.filter((item) => item.id !== id) } };
      void host.events.publish(RUNS_CHANGED_EVENT);
      return { resolved: true };
    }),
  });
  window.setRuns = (next) => {
    runs = { ...runs, ...next };
    void host.events.publish(RUNS_CHANGED_EVENT);
  };
  window.setSettings = (text) => {
    keep(text);
    void host.events.publish(SETTINGS_CHANGED_EVENT);
  };
  window.settingsText = () => settingsText;
  window.setEnvironment = (next) => {
    environment = next;
    void host.events.publish(SETTINGS_CHANGED_EVENT);
  };
  await host.files.watch({ path: "", recursive: true }, () => {
    void read().then(async (next) => {
      snapshot = next;
      await host.events.publish(JOBS_CHANGED_EVENT);
      await host.events.publish(SERVICES_CHANGED_EVENT);
    });
  });
  window.setServiceStatus = (job, status) => {
    set.set(job, status);
    void host.events.publish(SERVICES_CHANGED_EVENT);
  };
  window.setOpenedProjects = (projects) => {
    openedProjects = projects;
    void host.events.publish(SERVICES_CHANGED_EVENT);
  };
  await host.events.publish(JOBS_CHANGED_EVENT);
  await host.events.publish(SERVICES_CHANGED_EVENT);
  await host.events.publish(RUNS_CHANGED_EVENT);
  await host.events.publish(SETTINGS_CHANGED_EVENT);
}
