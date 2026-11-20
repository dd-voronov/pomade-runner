// A stand-in for Runner's scheduler in the fake host: another client of the app that serves
// Runner's API — the jobs, the services, the runs, the history, one run and its output, Run now,
// Enable / Disable, Needs you, a missed run's choice, Stop, the switch, Resume, the settings — and
// announces `jobs.changed`, `services.changed`, `runs.changed` and `settings.changed`, as the real
// scheduler does through Pomade. It reads the fake workspace's jobs folder through the Host API and
// checks it with the real validator, so the UI specs drive it by writing files
// (`fakeHost.writeFile`). Every valid service runs; Restart is refused; a spec sets another state with
// `window.setServiceStatus`, the runs with `window.setRuns`, the settings with
// `window.setSettings`, and reads the actions the UI asked for in `window.runnerCalls`. Delete
// removes the job's file — refused with `window.refuseDelete`'s reason while one is set.

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
  SETTINGS_CHANGED_EVENT,
  SETTINGS_GET_METHOD,
  SETTINGS_SET_METHOD,
  SWITCH_METHOD,
} from "../../src/integrations/runner-api";
import { checkJobs } from "../../src/jobs/check";
import { entryId, entryPath, JOBS_FOLDER, type JobsSnapshot } from "../../src/jobs/model";
import type { ServicesReport, ServiceStatus } from "../../src/keeper/model";
import type { RunRecord, RunsReport, RunView, SwitchPosition } from "../../src/scheduler/model";
import { checkSettings, type SettingsReport } from "../../src/scheduler/settings";

export async function startFakeScheduler(fake: FakeHost): Promise<void> {
  const result = await connect({ transport: fake.createTransport({ surface: "backend" }), keySource: null });
  if (result.status !== "connected") throw new Error(`fake scheduler: ${result.status}`);
  const { host } = result;

  const read = async (): Promise<JobsSnapshot> => {
    const { entries } = await host.files.readFolder({ path: "", recursive: true });
    const paths = entries.filter((e) => e.kind === "file" && e.path.startsWith(`${JOBS_FOLDER}/`) && e.path.endsWith(".md")).map((e) => e.path);
    const files = await Promise.all(paths.map(async (path) => ({ path: path.slice(JOBS_FOLDER.length + 1), text: (await host.files.readFile({ path })).content })));
    const { projects } = await host.project.list();
    return checkJobs(files, { workspace: "/fake/workspace", projects: projects.map(({ id, name, root }) => ({ id, name, root })) });
  };

  /** Services whose status a spec set, by job id. */
  const set = new Map<string, Partial<ServiceStatus>>();
  const services = (snapshot: JobsSnapshot): ServicesReport => ({
    keeper: { state: "connected", version: "e2e", pid: 1 },
    services: snapshot.jobs.flatMap((entry) =>
      entry.valid && entry.job.kind === "service"
        ? [{ job: entry.job.id, name: entry.job.name, project: entry.job.project, state: "running", session: null, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null, ...set.get(entry.job.id) }]
        : [],
    ),
  });

  let snapshot = await read();
  let runs: { report: RunsReport; history: RunRecord[]; output: string } = {
    report: { active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null } },
    history: [],
    output: "",
  };
  let settings: SettingsReport = checkSettings(null);
  const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
  /** An action the UI asked for: recorded, answered `answer`. */
  const action =
    (method: string, answer: (params: JsonValue) => unknown = () => ({ ok: true })) =>
    (params: JsonValue): JsonValue => {
      window.runnerCalls.push({ method, params });
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
  window.runnerCalls = [];
  window.refuseDelete = null;
  await host.api.serve({
    [JOBS_LIST_METHOD]: () => json(snapshot),
    [SERVICES_LIST_METHOD]: () => json(services(snapshot)),
    [RUNS_LIST_METHOD]: () => json(runs.report),
    [HISTORY_LIST_METHOD]: () => json({ records: runs.history, next: null }),
    [RUN_GET_METHOD]: (params) => json(find(params) ?? null),
    [RUN_OUTPUT_METHOD]: () => json({ text: runs.output, truncated: false }),
    [RUN_NOW_METHOD]: action(RUN_NOW_METHOD),
    [SET_ENABLED_METHOD]: action(SET_ENABLED_METHOD),
    [SERVICE_METHODS.start]: action(SERVICE_METHODS.start, serviceAnswer),
    [SERVICE_METHODS.stop]: action(SERVICE_METHODS.stop, serviceAnswer),
    [SERVICE_METHODS.restart]: action(SERVICE_METHODS.restart, () => ({ ok: false, reason: "the keeper is not connected" })),
    [MISSED_METHOD]: action(MISSED_METHOD, () => ({ ok: true, at: null })),
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
    [SETTINGS_SET_METHOD]: action(SETTINGS_SET_METHOD, () => ({ ok: true, settings })),
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
    settings = checkSettings(text);
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
  await host.events.publish(JOBS_CHANGED_EVENT);
  await host.events.publish(SERVICES_CHANGED_EVENT);
  await host.events.publish(RUNS_CHANGED_EVENT);
  await host.events.publish(SETTINGS_CHANGED_EVENT);
}
