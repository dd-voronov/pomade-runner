// The scheduler: Runner's always-on background part. It serves the control protocol to the
// `pomade-runner` command, keeps a connection to Pomade while Pomade runs, ticks on its clock,
// holds the checked job files and the settings of the current workspace — served to Runner's
// frames through Pomade's broker — owns the keeper's sessions, following them on every tick, and
// after each supervises the services, runs what is due — through the missed-run policies, the
// switch, the warm-up and the queue — and records what ended, keeps Needs you, notices and the
// badge, and publishes Runner's events.

import { join } from "node:path";

import type { AttachedTabActionPayload } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID, APP_VERSION } from "../app";
import type { PostNotice } from "../integrations/notices";
import { setBadge } from "../integrations/notices";
import { announce, offerRunner, type LinkPomade } from "../integrations/pomade";
import {
  JOBS_CHANGED_EVENT,
  RUN_FINISHED_EVENT,
  RUN_STARTED_EVENT,
  RUNS_CHANGED_EVENT,
  SERVICES_CHANGED_EVENT,
  SETTINGS_CHANGED_EVENT,
  type RunFinishedPayload,
  type RunStartedPayload,
} from "../integrations/runner-api";
import { formatJobError } from "../jobs/format";
import { writeEnabled } from "../jobs/folder";
import { createJobsLoader } from "../jobs/loader";
import { entryId, entryPath, type JobEntry, type JobsSnapshot } from "../jobs/model";
import { KIND_DEFAULTS } from "../jobs/parse";
import { sessionOwner } from "../keeper/ids";
import { exitWords, type ServiceActionResult, type ServiceStatus } from "../keeper/model";
import type { NetworkReadiness } from "../keeper/readiness";
import { jobIdOf, RESTART_ACTION } from "../keeper/services";
import type { Sessions } from "../keeper/sessions";
import { createSupervisor, type SupervisionStore } from "../keeper/supervisor";
import type { Clock } from "./clock";
import type { JobEnabled, PomadeLinkState, RunStarted, SchedulerStatus } from "./control/protocol";
import { ControlRefused, serveControl } from "./control/server";
import { createHistory, readOutput } from "./history";
import type { Log } from "./log";
import type { ActiveRun, EnableResult, JobListing, RunActionResult, RunRecord, RunsReport } from "./model";
import { createNeedsYou, fileNeedsYouStore } from "./needs-you";
import { projectsMemory } from "./projects";
import { createRuns, fileRunsStore } from "./runs";
import { settingsFile } from "./settings-file";
import { fileSwitchStore } from "./switch";

/** How often history and output logs older than the settings keep are pruned. */
const PRUNE_EVERY_MS = 60 * 60_000;

export interface SchedulerOptions {
  /** Where the control protocol is served. */
  socketPath: string;
  /** Runner's state folder: runs, history, Needs you, the switch, the projects heard. */
  state: string;
  clock: Clock;
  tickMs: number;
  log: Log;
  linkPomade: LinkPomade;
  /** The workspace root now (absolute), or `null`; asked on every tick, so a switch is followed. */
  workspace(): string | null;
  /** The keeper's sessions; the scheduler refreshes them on every tick and closes them on stop. */
  sessions: Sessions;
  /** Where service supervision keeps its records. */
  supervision: SupervisionStore;
  /** A service's port or URL readiness check. */
  probe(ready: NetworkReadiness): Promise<boolean>;
  /** Post a notice, over the connection to Pomade when there is one. */
  postNotice: PostNotice;
}

export interface Scheduler {
  status(): SchedulerStatus;
  /** The checked job files. */
  jobs(): JobsSnapshot;
  /** Stops ticking, closes the connections to Pomade and the keeper and the control socket; the
   *  keeper and its sessions keep running. */
  stop(): Promise<void>;
}

export type StartResult =
  | { status: "started"; scheduler: Scheduler }
  /** Another scheduler serves the control socket; it stays in charge. */
  | { status: "already-running" }
  | { status: "failed"; reason: string };

/** A job's trigger in words. */
function triggerWords(entry: JobEntry): string | null {
  if (!entry.valid) return null;
  const { job } = entry;
  if (job.kind === "service") return job.start === "login" ? "always on, from login" : "always on, from its project's first open";
  switch (job.trigger.kind) {
    case "schedule":
      return job.trigger.words;
    case "hook":
      return `on ${job.trigger.hook.event}`;
    case "chain":
      return `after ${job.trigger.chain.job} (${job.trigger.chain.result})`;
  }
}

const startedPayload = (run: ActiveRun | RunRecord): RunStartedPayload => ({
  job: run.job,
  name: run.name,
  run: run.run,
  kind: run.kind,
  folder: run.folder,
  project: run.project,
  trigger: run.trigger,
});

export async function startScheduler(options: SchedulerOptions): Promise<StartResult> {
  const { clock, log, state } = options;
  const startedAt = clock.now().toISOString();
  let lastTickAt: string | null = null;
  let pomade: PomadeLinkState = "disconnected";
  const status = (): SchedulerStatus => ({ version: APP_VERSION, pid: process.pid, startedAt, lastTickAt, pomade });

  const { sessions } = options;
  let host: HostClient | null = null;
  const publish = (event: string, payload?: unknown): void => {
    if (host !== null) announce(host, event, log, payload);
  };
  const jobs = createJobsLoader({ workspace: options.workspace, log, onChange: () => publish(JOBS_CHANGED_EVENT) });
  const settings = settingsFile({ workspace: options.workspace, log, onChange: () => publish(SETTINGS_CHANGED_EVENT) });
  const supervisor = createSupervisor({
    sessions,
    jobs: jobs.snapshot,
    clock,
    log,
    store: options.supervision,
    probe: options.probe,
    onChange: () => publish(SERVICES_CHANGED_EVENT),
  });
  const projects = projectsMemory(state, log);
  const history = createHistory(state, log);

  const post = (notice: Parameters<PostNotice>[0]): void => {
    options.postNotice(notice, host).then(
      (where) => log(`notice "${notice.title}": ${where === "pomade" ? "posted" : "queued for Pomade's next launch"}`),
      (err: unknown) => log(`notice "${notice.title}": cannot post — ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  let reported = "";
  let badged: number | null = null;
  const report = (): RunsReport => ({
    active: runs.active(),
    nextUp: runs.nextUp(),
    jobs: runs.jobRuns(),
    needsYou: [...needsYou.items(), ...runs.needsYou()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)),
    switch: runs.switch(),
  });
  /** Tell the frames when the runs report changed, and keep the badge on the Needs-you count. */
  const publishRuns = (): void => {
    const next = report();
    const text = JSON.stringify(next);
    if (text !== reported) {
      reported = text;
      publish(RUNS_CHANGED_EVENT);
    }
    if (next.needsYou.length !== badged) showBadge(next.needsYou.length);
  };
  const showBadge = (count: number): void => {
    if (host === null) return;
    const client = host;
    badged = count;
    setBadge(client, count).catch((err: unknown) => {
      if (badged === count) badged = null;
      log(`cannot set the badge: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const needsYou = createNeedsYou({ store: fileNeedsYouStore(state, log), log, post, onChange: publishRuns });
  const runs = createRuns({
    sessions,
    jobs: jobs.snapshot,
    settings: () => settings.report().settings,
    servicesSettled: supervisor.settled,
    clock,
    log,
    history,
    store: fileRunsStore(state, log),
    switchStore: fileSwitchStore(state, log),
    post,
    projectPath: (project) => {
      const workspace = jobs.snapshot().workspace;
      const root = projects.root(project);
      return workspace === null || root === null ? null : join(workspace, root);
    },
    onStarted: (run) => publish(RUN_STARTED_EVENT, startedPayload(run)),
    onFinished: (record) => {
      const entry = jobs.snapshot().jobs.find((candidate) => entryId(candidate) === record.job);
      needsYou.runFinished(record, entry?.valid === true ? entry.job.notify : KIND_DEFAULTS[record.kind].notify);
      if (record.startedAt === null || record.state === "skipped") return;
      const payload: RunFinishedPayload = { ...startedPayload(record), result: record.state, exitCode: record.exitCode };
      publish(RUN_FINISHED_EVENT, payload);
    },
    onChange: publishRuns,
  });
  await Promise.all([supervisor.load(), runs.load(), needsYou.load(), projects.load()]);

  const answer = (verb: string, job: string, result: ServiceActionResult): ServiceStatus => {
    if (!result.ok) throw new ControlRefused(`cannot ${verb} "${job}": ${result.reason}`);
    return result.service;
  };

  /** Run now: a service starts, a script runs. */
  const runNow = async (ref: string): Promise<RunActionResult> => {
    const snapshot = jobs.snapshot();
    const entry = snapshot.jobs.find((candidate) => entryId(candidate) === jobIdOf(snapshot, ref));
    if (entry?.valid === true && entry.job.kind === "service") return supervisor.start(ref);
    return runs.runNow(ref);
  };

  /** Resolve a Needs-you item: a long-run warning is the run's, the others Needs you's own. */
  const dismiss = (id: string): boolean => {
    const warning = /^long-run:(.+):([^:]+)$/.exec(id);
    return warning === null ? needsYou.dismiss(id) : runs.dismissWarning(warning[1] ?? "", warning[2] ?? "");
  };

  /** Enable or Disable: `enabled:` written into the job's file, which applies within a tick. */
  const setEnabled = async (ref: string, enabled: boolean): Promise<EnableResult> => {
    const snapshot = jobs.snapshot();
    const id = jobIdOf(snapshot, ref);
    const entry = snapshot.jobs.find((candidate) => entryId(candidate) === id);
    if (entry === undefined || snapshot.workspace === null) return { ok: false, reason: `no job "${ref}"` };
    try {
      await writeEnabled(snapshot.workspace, entryPath(entry), enabled);
    } catch (err) {
      return { ok: false, reason: `cannot write ${entryPath(entry)}: ${err instanceof Error ? err.message : String(err)}` };
    }
    log(`job ${entryId(entry)}: ${enabled ? "enabled" : "disabled"}`);
    await jobs.refresh();
    return { ok: true, job: entryId(entry), enabled };
  };

  /** Every job as `pomade-runner list` shows it. */
  const listings = (): JobListing[] => {
    const snapshot = jobs.snapshot();
    const byJob = new Map(runs.jobRuns().map((info) => [info.job, info]));
    const services = new Map(supervisor.report().services.map((service) => [service.job, service]));
    return snapshot.jobs.map((entry): JobListing => {
      const id = entryId(entry);
      const info = byJob.get(id);
      const first = entry.valid ? undefined : entry.invalid.errors[0];
      return {
        job: id,
        name: entry.valid ? entry.job.name : (entry.invalid.name ?? id),
        kind: entry.valid ? entry.job.kind : entry.invalid.kind,
        enabled: entry.valid ? entry.job.enabled : false,
        trigger: triggerWords(entry),
        problem: first === undefined ? null : formatJobError(first),
        next: info?.next ?? null,
        finished: info?.finished ?? false,
        last: info?.last ?? null,
        service: services.get(id) ?? null,
      };
    });
  };

  const control = await serveControl(options.socketPath, {
    status,
    sessions: () => sessions.report(),
    services: () => supervisor.report(),
    run: async ({ job }): Promise<RunStarted> => {
      const result = await runNow(job);
      if (!result.ok) throw new ControlRefused(`cannot run "${job}": ${result.reason}`);
      return "run" in result ? { run: result.run } : { service: result.service };
    },
    stop: async ({ job }) => answer("stop", job, await supervisor.stop(job)),
    restart: async ({ job }) => answer("restart", job, await supervisor.restart(job)),
    enable: ({ job }) => enabledAnswer(job, true),
    disable: ({ job }) => enabledAnswer(job, false),
    list: listings,
    history: ({ job, limit }) => history.page({ job: job === null ? null : (jobIdOf(jobs.snapshot(), job) ?? job), before: null, limit }),
    runs: report,
    switch: ({ position }) => (position === null ? runs.switch() : runs.setSwitch(position)),
  });
  async function enabledAnswer(job: string, enabled: boolean): Promise<JobEnabled> {
    const result = await setEnabled(job, enabled);
    if (!result.ok) throw new ControlRefused(`cannot ${enabled ? "enable" : "disable"} "${job}": ${result.reason}`);
    const entry = jobs.snapshot().jobs.find((candidate) => entryId(candidate) === result.job);
    const name = entry === undefined ? result.job : entry.valid ? entry.job.name : (entry.invalid.name ?? result.job);
    return { job: result.job, name, enabled };
  }
  if (control.status !== "listening") return control;
  await jobs.refresh();
  await settings.refresh();

  const unwatchExits = sessions.onExit(({ id, info }) => log(`session ${id}: ended${info.exit === null ? "" : `: ${exitWords(info.exit)}`}`));
  const tabAction = (payload: AttachedTabActionPayload): void => {
    const { session, action } = payload;
    if (session.app !== APP_ID || action !== RESTART_ACTION.id) return;
    log(`session ${session.session}: Restart from its tab`);
    const owner = sessionOwner(session.session);
    if (owner?.kind !== "service") {
      log(`session ${session.session}: cannot restart — not a service's session`);
      return;
    }
    void supervisor.restart(owner.job).then((restarted) => {
      if (!restarted.ok) log(`session ${session.session}: cannot restart — ${restarted.reason}`);
    });
  };

  const link = options.linkPomade({
    connected(client) {
      host = client;
      pomade = "connected";
      badged = null;
      log("connected to Pomade");
      void offerRunner(client, {
        jobs: jobs.snapshot,
        services: supervisor.report,
        serviceAction: (verb, job) => supervisor[verb](job),
        projects: (list) => {
          projects.remember(list);
          jobs.setProjects(list);
        },
        tabAction,
        runs: report,
        history: (query) => history.page(query),
        run: (job, run) => runs.find(job, run),
        output: async (job, run) => {
          const view = await runs.find(job, run);
          return view?.log == null ? { text: "", truncated: false } : readOutput(view.log);
        },
        runNow,
        setEnabled,
        dismiss,
        missed: runs.missed,
        stopRun: runs.stop,
        setSwitch: runs.setSwitch,
        settings: settings.report,
        setSetting: settings.write,
        ready: () => showBadge(needsYou.items().length),
        log,
      });
      showBadge(needsYou.items().length);
    },
    disconnected() {
      host = null;
      pomade = "disconnected";
      log("Pomade went away; reconnecting");
    },
    rejected(reason) {
      pomade = "rejected";
      log(`Pomade refused the connection: ${reason}`);
    },
  });

  let prunedAt = Number.NEGATIVE_INFINITY;
  /** Drop history and output logs past what the settings keep, at most once an hour; never a log in
   *  use. */
  const prune = async (): Promise<void> => {
    const now = clock.now();
    if (now.getTime() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now.getTime();
    const inUse = runs.logsInUse();
    for (const session of sessions.list()) if (session.log !== null) inUse.add(session.log);
    await history.prune(now, settings.report().settings.historyDays, inUse);
  };

  /** Follow the keeper, then supervise, run and record on what it says. */
  const follow = async (): Promise<void> => {
    await sessions.refresh();
    await supervisor.tick();
    await runs.tick();
    needsYou.services(supervisor.report());
    needsYou.jobs(jobs.snapshot());
    publishRuns();
    if (sessions.followed()) await prune();
  };
  let following: Promise<void> | null = null;
  const tick = (): void => {
    following ??= follow()
      .catch((err: unknown) => log(`tick: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
      .finally(() => {
        following = null;
      });
  };
  const ticker = setInterval(() => {
    lastTickAt = clock.now().toISOString();
    void jobs.refresh();
    void settings.refresh();
    tick();
  }, options.tickMs);
  log(`scheduler ${APP_VERSION} started (pid ${process.pid}, tick ${options.tickMs} ms)`);
  tick();

  return {
    status: "started",
    scheduler: {
      status,
      jobs: jobs.snapshot,
      async stop() {
        clearInterval(ticker);
        jobs.stop();
        link.stop();
        unwatchExits();
        await following;
        await supervisor.close();
        await runs.close();
        await needsYou.close();
        await projects.flush();
        await sessions.close();
        await control.close();
        log("scheduler stopped");
      },
    },
  };
}
