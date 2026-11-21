// The scheduler: Runner's always-on background part. It serves the control protocol to the
// `pomade-runner` command, keeps a connection to Pomade while Pomade runs, ticks on its clock,
// holds the checked job files and the settings of the current workspace — served to Runner's
// frames through Pomade's broker — owns the keeper's sessions, following them on every tick, and
// after each supervises the services, runs what is due — through the missed-run policies, the
// switch, the warm-up and the queue — and records what ended, keeps Needs you, notices and the
// badge, and publishes Runner's events. It runs on one workspace: its records are in that
// workspace's records folder, moved there from the state folder on the first start
// (`records-move.ts`); `main.ts` starts it again when the workspace changes.

import { join } from "node:path";

import type { LaunchResult } from "pomade-kit/node";
import type { AttachedTabActionPayload } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID, APP_VERSION } from "../app";
import type { PostNotice } from "../integrations/notices";
import { setBadge } from "../integrations/notices";
import { agentsOf } from "../integrations/agents";
import { announce, offerRunner, type LinkPomade, type PomadeLinkHandlers } from "../integrations/pomade";
import { pomadeOpener } from "../integrations/pomade-open";
import { pomadeStarts } from "../integrations/pomade-start";
import {
  JOBS_CHANGED_EVENT,
  RUN_FINISHED_EVENT,
  RUN_STARTED_EVENT,
  RUNS_CHANGED_EVENT,
  SERVICES_CHANGED_EVENT,
  SETTINGS_CHANGED_EVENT,
} from "../integrations/runner-api";
import { formatJobError } from "../jobs/format";
import { findOutputLog, gitResultPath, recordsFolderOf, type StateFolder } from "../locations";
import { removeJobFile, writeEnabled } from "../jobs/folder";
import { createJobsLoader } from "../jobs/loader";
import { entryId, entryPath, type JobsSnapshot, type ProjectRecord } from "../jobs/model";
import { jobTriggerWords } from "../jobs/words";
import { KIND_DEFAULTS } from "../jobs/parse";
import type { AgentTurns } from "../keeper/agent-turns";
import { sessionIdOf, sessionOwner } from "../keeper/ids";
import { exitWords, type ServiceActionResult, type ServiceStatus } from "../keeper/model";
import type { NetworkReadiness } from "../keeper/readiness";
import { jobIdOf, RESTART_ACTION, START_ACTION } from "../keeper/services";
import type { Sessions } from "../keeper/sessions";
import { createSupervisor, type SupervisionStore } from "../keeper/supervisor";
import type { Clock } from "./clock";
import type { JobEnabled, PomadeLinkState, RunStarted, SchedulerStatus } from "./control/protocol";
import { callScheduler } from "./control/client";
import { ControlRefused, serveControl } from "./control/server";
import { deleteJob } from "./delete";
import { createHistory, keepOutputLog, readOutput } from "./history";
import type { Log } from "./log";
import type { DeleteResult, EnableResult, JobListing, RunActionResult, RunsReport } from "./model";
import { runFinishedPayload, runStartedPayload } from "./run-events";
import { createNeedsYou, fileNeedsYouStore } from "./needs-you";
import { POMADE_STARTED, projectFiring } from "./hooks";
import { applyMove, planMove, projectMoves, type ProjectMove } from "./project-moves";
import { projectsMemory } from "./projects";
import { renamedJobs } from "./renamed";
import { readEnvironment } from "./read-environment";
import { repoJobs } from "./git-runs";
import { moveRecords } from "./records-move";
import { createRuns, fileRunsStore } from "./runs";
import { settingsFile } from "./settings-file";
import { fileSwitchStore } from "./switch";

/** How often history and output logs older than the settings keep are pruned. */
const PRUNE_EVERY_MS = 60 * 60_000;

export interface SchedulerOptions {
  /** Where the control protocol is served. */
  socketPath: string;
  /** Runner's state folder: the output logs, the projects heard; the records once there, moved out
   *  at start. */
  state: StateFolder;
  clock: Clock;
  tickMs: number;
  log: Log;
  linkPomade: LinkPomade;
  /** Start Pomade the way it recorded and wait for its socket to answer (`launchPomade`): an agent
   *  run due while Pomade is not up opens it. */
  launchPomade(): Promise<LaunchResult>;
  /** The workspace root (absolute): its jobs, settings and records are the scheduler's. */
  workspace: string;
  /** The keeper's sessions; the scheduler refreshes them on every tick and closes them on stop. */
  sessions: Sessions;
  /** Where service supervision keeps its records (`fileStore` on the state and records folders). */
  supervision: SupervisionStore;
  /** A service's port or URL readiness check. */
  probe(ready: NetworkReadiness): Promise<boolean>;
  /** Post a notice, over the connection to Pomade when there is one. */
  postNotice: PostNotice;
  /** The `pomade-git` command git jobs run. */
  pomadeGit: string;
  /** Following agent runs' turns in their sessions; closed when the scheduler stops. */
  turns: AgentTurns;
  /** The user's login shell: agent runs run their line in it. */
  shell: string;
  /** The running Pomade's start (`pomadeStartOf`); `null` when it cannot be told. */
  pomadeStart(): Promise<string | null>;
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

export async function startScheduler(options: SchedulerOptions): Promise<StartResult> {
  const { clock, log, state } = options;
  const records = recordsFolderOf(options.workspace);
  const workspace = (): string => options.workspace;
  // Another scheduler serving the socket owns the records: nothing is moved under it.
  if ((await callScheduler(options.socketPath, "status", null)).status === "ok") return { status: "already-running" };
  await moveRecords(state, records, log);
  const startedAt = clock.now().toISOString();
  let lastTickAt: string | null = null;
  let pomade: PomadeLinkState = "disconnected";
  const status = (): SchedulerStatus => ({ version: APP_VERSION, pid: process.pid, startedAt, lastTickAt, pomade });

  const { sessions } = options;
  let host: HostClient | null = null;
  /** Set by `stop()`: nothing connects again. */
  let stopped = false;
  /** Whether Pomade restored its tabs (`pomade.ready`) on the current connection. */
  let ready = false;
  const publish = (event: string, payload?: unknown): void => {
    if (host !== null) announce(host, event, log, payload);
  };
  const jobs = createJobsLoader({ workspace, log, onChange: () => publish(JOBS_CHANGED_EVENT) });
  const settings = settingsFile({ workspace, log, onChange: () => publish(SETTINGS_CHANGED_EVENT) });
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
  const starts = pomadeStarts(state, log);
  /** The projects whose first open fired since this Pomade start, as this scheduler heard them. */
  let openedThisStart = new Set<string>();
  const history = createHistory(records, state, log);
  const renamed = renamedJobs(records, log);
  /** A page of history: a job's takes in the ids it had before its project moved. */
  const historyPage = (query: { job: string | null; before: string | null; limit: number }): ReturnType<typeof history.page> =>
    history.page(query.job === null ? query : { ...query, formerly: renamed.formerIds(query.job, new Set(jobs.snapshot().jobs.map(entryId))) });

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

  const needsYou = createNeedsYou({ store: fileNeedsYouStore(records, log), log, post, onChange: publishRuns });
  const runs = createRuns({
    sessions,
    jobs: jobs.snapshot,
    settings: () => settings.report().settings,
    servicesSettled: supervisor.settled,
    clock,
    log,
    history,
    store: fileRunsStore(records, state, log),
    switchStore: fileSwitchStore(records, log),
    post,
    serviceAction: supervisor.chainAction,
    pomadeGit: options.pomadeGit,
    agents: () => (host === null ? null : agentsOf(host)),
    pomade: pomadeOpener({
      launch: options.launchPomade,
      connected: () => host !== null,
      agents: () => (host === null || !ready ? null : agentsOf(host)),
      reconnect: () => {
        if (stopped) return;
        link.stop();
        link = options.linkPomade(linkHandlers);
      },
      log,
    }),
    turns: options.turns,
    shell: options.shell,
    gitResult: (job, run) => gitResultPath(state, job, run),
    keepLog: (job, run) => keepOutputLog(records, state, job, run),
    projectPath: (project) => {
      const workspace = jobs.snapshot().workspace;
      const root = projects.root(project);
      return workspace === null || root === null ? null : join(workspace, root);
    },
    onStarted: (run) => publish(RUN_STARTED_EVENT, runStartedPayload(run)),
    onFinished: (record) => {
      const entry = jobs.snapshot().jobs.find((candidate) => entryId(candidate) === record.job);
      needsYou.runFinished(record, entry?.valid === true ? entry.job.notify : KIND_DEFAULTS[record.kind].notify);
      if (record.startedAt === null || record.state === "skipped") return;
      publish(RUN_FINISHED_EVENT, runFinishedPayload(record));
    },
    onChange: publishRuns,
  });
  await Promise.all([supervisor.load(), runs.load(), needsYou.load(), projects.load(), renamed.load()]);

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

  /** Delete: a running service stopped first, then the file removed; refused while a run goes. */
  const removeJob = (ref: string): Promise<DeleteResult> =>
    deleteJob(ref, {
      jobs: jobs.snapshot,
      active: runs.active,
      serviceRunning: (job) => {
        const id = sessionIdOf({ kind: "service", job });
        return sessions.list().some((session) => session.id === id && session.info.state === "running");
      },
      stopService: (job) => supervisor.stop(job),
      refreshSessions: () => sessions.refresh(),
      removeFile: removeJobFile,
      refreshJobs: () => jobs.refresh(),
      log,
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

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
        trigger: entry.valid ? jobTriggerWords(entry.job) : null,
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
    history: ({ job, limit }) => historyPage({ job: job === null ? null : (jobIdOf(jobs.snapshot(), job) ?? job), before: null, limit }),
    runs: report,
    switch: ({ position }) => (position === null ? runs.switch() : runs.setSwitch(position)),
    resumeJob: async ({ job }) => {
      const result = await runs.resume(job);
      if (!result.ok) throw new ControlRefused(`cannot resume "${job}": ${result.reason}`);
      return { job: result.job, name: result.name };
    },
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
    const verb = action === RESTART_ACTION.id ? "restart" : action === START_ACTION.id ? "start" : null;
    if (session.app !== APP_ID || verb === null) return;
    log(`session ${session.session}: ${verb === "restart" ? RESTART_ACTION.title : START_ACTION.title} from its tab`);
    const owner = sessionOwner(session.session);
    if (owner?.kind !== "service") {
      log(`session ${session.session}: cannot ${verb} — not a service's session`);
      return;
    }
    void supervisor[verb](owner.job).then((answer) => {
      if (!answer.ok) log(`session ${session.session}: cannot ${verb} — ${answer.reason}`);
    });
  };

  /** Pomade's projects, as just read: a project whose folder changed since the list before moves
   *  its jobs with it, one move after another. */
  let moving: Promise<void> = Promise.resolve();
  const projectsHeard = (list: ProjectRecord[]): Promise<void> => {
    const moves = projectMoves(projects.list(), list);
    projects.remember(list);
    // A move checks the jobs against the new list once their files moved, never in between.
    if (moves.length === 0) jobs.setProjects(list);
    moving = moving.then(async () => {
      for (const move of moves) await moveProject(move, list);
    });
    return moving;
  };

  /** A project's folder changed: its jobs follow it — their folders, their sub-folder, and with the
   *  sub-folder their ids, their services, runs and history. */
  const moveProject = async (move: ProjectMove, list: readonly ProjectRecord[]): Promise<void> => {
    const { previous, project } = move;
    log(`project ${previous.name} (${project.id}) moved: ${previous.root} → ${project.root}`);
    try {
      const plan = await planMove(workspace(), move, jobs.snapshot().jobs.map(entryId), log);
      const ids = plan.ids ?? new Map<string, string>();
      await runs.move(ids, () =>
        supervisor.move(ids, async () => {
          await applyMove(workspace(), plan, log);
          jobs.setProjects(list);
          await jobs.refresh();
          const moved = plan.ids !== null && [...ids.values()].every((id) => jobs.snapshot().jobs.some((entry) => entryId(entry) === id));
          if (moved) renamed.add(ids);
          return moved;
        }),
      );
    } catch (err) {
      jobs.setProjects(list);
      log(`project ${project.name}: cannot move its jobs — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Pomade is ready: on the first ready of a Pomade start, the "Pomade started" hooks fire, and
   *  the project in front counts as opened — its own `project.opened` came before this scheduler
   *  was listening, or comes now and fires nothing twice. A ready heard again while the same
   *  Pomade runs (a reconnect, a restarted scheduler, a workspace switch back) fires nothing. */
  const pomadeReady = async (client: HostClient, active: ProjectRecord | null): Promise<void> => {
    const start = await options.pomadeStart();
    if (host !== client) return;
    if (start === null) {
      log("Pomade ready: cannot tell which Pomade start this is — its socket is not found; the Pomade started hooks do not fire");
      return;
    }
    if (!(await starts.firstReady(workspace(), start))) {
      log("Pomade ready: the Pomade started hooks fired for this Pomade start already");
      return;
    }
    openedThisStart = new Set();
    log("Pomade started");
    await runs.hook(POMADE_STARTED);
    if (active !== null && host === client) projectOpened(active);
  };

  /** A project's first open since Pomade started: its first-open services start, its hooks fire —
   *  once per project and Pomade start. A project this workspace does not have (Pomade switched
   *  to another workspace, and this scheduler has yet to follow it) is not this workspace's. */
  const projectOpened = (project: ProjectRecord): void => {
    if (openedThisStart.has(project.id)) return;
    if (projects.root(project.id) === null) {
      log(`project ${project.name} (${project.id}) opened: not a project of this workspace`);
      return;
    }
    openedThisStart.add(project.id);
    log(`project ${project.name} (${project.id}) opened for the first time since Pomade started`);
    void supervisor.firstOpen(project.id);
    void runs.hook(projectFiring("project-first-open", project, workspace()));
  };

  const linkHandlers: PomadeLinkHandlers = {
    connected(client) {
      host = client;
      ready = false;
      pomade = "connected";
      badged = null;
      log("connected to Pomade");
      void offerRunner(client, {
        jobs: jobs.snapshot,
        services: supervisor.report,
        serviceAction: (verb, job) => supervisor[verb](job),
        projects: (list) => {
          void projectsHeard(list);
        },
        tabAction,
        runs: report,
        repoJobs: (repo) => repoJobs(jobs.snapshot(), runs.jobRuns(), repo),
        history: historyPage,
        run: (job, run) => runs.find(job, run),
        output: async (job, run) => {
          const view = await runs.find(job, run);
          if (view?.log == null) return { text: "", truncated: false, missing: false };
          // A run going writes its log in the state folder; a finished one's is found where it is.
          const going = runs.active().some((candidate) => candidate.job === job && candidate.run === run);
          return readOutput(going ? view.log : await findOutputLog(records, state, job, run));
        },
        runNow,
        setEnabled,
        dismiss,
        missed: runs.missed,
        stopRun: runs.stop,
        setSwitch: runs.setSwitch,
        resume: runs.resume,
        settings: settings.report,
        environment: () => readEnvironment(options.workspace),
        setSetting: settings.write,
        deleteJob: removeJob,
        ready: (active) => {
          if (host !== client) return;
          ready = true;
          showBadge(needsYou.items().length);
          void pomadeReady(client, active);
        },
        opened: (project) => {
          if (host === client) projectOpened(project);
        },
        created: (project) => {
          if (host !== client) return;
          projects.add(project);
          log(`project ${project.name} (${project.id}) created`);
          void runs.hook(projectFiring("project-created", project, workspace()));
        },
        log,
      });
      showBadge(needsYou.items().length);
    },
    disconnected() {
      host = null;
      ready = false;
      pomade = "disconnected";
      log("Pomade went away; reconnecting");
    },
    rejected(reason) {
      pomade = "rejected";
      log(`Pomade refused the connection: ${reason}`);
    },
  };
  let link = options.linkPomade(linkHandlers);

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
        stopped = true;
        clearInterval(ticker);
        jobs.stop();
        link.stop();
        unwatchExits();
        await following;
        await supervisor.close();
        await runs.close();
        options.turns.close();
        await needsYou.close();
        await projects.flush();
        await starts.flush();
        await moving;
        await renamed.flush();
        await sessions.close();
        await control.close();
        log("scheduler stopped");
      },
    },
  };
}
