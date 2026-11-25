// The scheduler: Runner's always-on background part. It serves the control protocol to the
// `pomade-runner` command, keeps a connection to Pomade while Pomade runs, ticks on its clock,
// holds the checked job files and the settings of the current workspace — served to Runner's
// frames through Pomade's broker — owns the keeper's sessions, following them on every tick, and
// after each supervises the services, runs what is due — through the missed-run policies, the
// switch, the warm-up and the queue — and records what ended, keeps Needs you, notices and the
// badge, and publishes Runner's events. It tells whether Pomade runs — for the services that run
// with it — from its link and Pomade's socket: Pomade has quit once the link dropped and no Pomade
// start is found for the quit grace. It runs on one workspace: its records are in that
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
import type { SessionClosed, StatusChanged } from "../integrations/agent-events";
import {
  JOBS_CHANGED_EVENT,
  RUN_FINISHED_EVENT,
  RUN_STARTED_EVENT,
  RUNS_CHANGED_EVENT,
  SERVICES_CHANGED_EVENT,
  SETTINGS_CHANGED_EVENT,
} from "../integrations/runner-api";
import { formatJobError } from "../jobs/format";
import { findOutputLog, gitResultPath, recordsFolderOf, skillRecordPath, type StateFolder } from "../locations";
import { skillKeeper } from "../jobs/skill/place";
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
import { createSupervisor, type PomadeState, type SupervisionStore } from "../keeper/supervisor";
import { QUIT_GRACE_MS, type Clock } from "./clock";
import { loginRecord, type ConsoleLogin } from "./console-login";
import type { JobEnabled, PomadeLinkState, RunStarted, SchedulerStatus } from "./control/protocol";
import { callScheduler } from "./control/client";
import { ControlRefused, serveControl } from "./control/server";
import { deleteJob } from "./delete";
import { createHistory, keepOutputLog, readOutput } from "./history";
import type { Log } from "./log";
import type { DeleteResult, EnableResult, HistoryPage, JobListing, RunActionResult, RunsReport } from "./model";
import { runFinishedPayload, runStartedPayload } from "./run-events";
import { createNeedsYou, fileNeedsYouStore } from "./needs-you";
import { POMADE_STARTED, projectFiring, sessionFiring } from "./hooks";
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
  /** The agent skill's file in the installed build (`skills/pomade-runner-jobs/SKILL.md`): its copy
   *  is kept in the skills folder the settings name. */
  skillSource: string;
  /** Following agent runs' turns in their sessions; closed when the scheduler stops. */
  turns: AgentTurns;
  /** The user's login shell: agent runs run their line in it. */
  shell: string;
  /** The running Pomade's start (`pomadeStartOf`); `null` when it cannot be told, or Pomade does
   *  not run. */
  pomadeStart(): Promise<string | null>;
  /** The Mac's console login now (`consoleLoginOf`): a start at another one than the scheduler last
   *  acted on is a login. */
  consoleLogin(): Promise<ConsoleLogin>;
  /** How long, on the clock, the link to Pomade is down with no Pomade start found before Pomade
   *  counts as quit; default `QUIT_GRACE_MS`. */
  quitGraceMs?: number;
  /** How long an agent has to start working before its run waits for the person; default
   *  `NOT_STARTED_MS`. */
  notStartedMs?: number;
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
  const skillsFolder = (): string => join(options.workspace, settings.report().settings.skillsFolder);
  const skill = skillKeeper({ source: options.skillSource, record: skillRecordPath(state), skillsFolder, log });
  let skillPlacedIn: string | null = null;
  const settings = settingsFile({
    workspace,
    log,
    onChange: () => {
      // A changed skills folder moves the skill; Settings hears once it is in place.
      if (skillPlacedIn !== null && skillsFolder() !== skillPlacedIn) {
        skillPlacedIn = skillsFolder();
        void skill.place().finally(() => publish(SETTINGS_CHANGED_EVENT));
      }
      publish(SETTINGS_CHANGED_EVENT);
    },
  });
  const supervisor = createSupervisor({
    sessions,
    jobs: jobs.snapshot,
    clock,
    log,
    store: options.supervision,
    probe: options.probe,
    pomade: () => ({ state: pomadeState, opened }),
    onChange: () => publish(SERVICES_CHANGED_EVENT),
    // A service event lands in History; the frames ask for it again.
    onEvent: (record, put) => void (put ? history.put(record) : history.append(record)).then(() => publish(RUNS_CHANGED_EVENT)),
    projectName: (project) => projects.list().find((known) => known.id === project)?.name ?? null,
  });
  const projects = projectsMemory(state, log);
  const starts = pomadeStarts(state, log);
  /** The projects opened since this Pomade start, kept with the start so a scheduler restarted while
   *  the same Pomade runs knows them. */
  let opened = new Set<string>();
  /** The Pomade start this connection's ready named: `undefined` until then, `null` when it cannot
   *  be told (what is opened is then this scheduler's alone). Opens heard before are held till then. */
  let thisStart: string | null | undefined;
  let heldOpens: ProjectRecord[] = [];
  /** Where Pomade stands for the services that run with it. */
  let pomadeState: PomadeState = "unsure";
  /** Since when (on the clock) the link to Pomade is down; `null` while connected. A scheduler
   *  starts with it down. */
  let droppedAt: number | null = clock.now().getTime();
  const quitGraceMs = options.quitGraceMs ?? QUIT_GRACE_MS;
  /** The project in front (id; `null` for the Workspace project), as last heard on this connection;
   *  `undefined` before Pomade said. */
  let inFront: string | null | undefined;
  const history = createHistory(records, state, log);
  const renamed = renamedJobs(records, log);
  /** A page of history: a job's takes in the ids it had before its project moved; the newest page
   *  leads with the held rows — the job's, when one is asked for. */
  const historyPage = async (query: { job: string | null; before: string | null; limit: number }): Promise<HistoryPage> => {
    const page = await history.page(query.job === null ? query : { ...query, formerly: renamed.formerIds(query.job, new Set(jobs.snapshot().jobs.map(entryId))) });
    const held = query.before === null ? runs.heldRows().filter((row) => query.job === null || row.job === query.job) : [];
    return { held, ...page };
  };

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
    heldRuns: runs.heldRuns(),
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
    consoleLogin: options.consoleLogin,
    logins: loginRecord(state, log),
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
    ...(options.notStartedMs === undefined ? {} : { notStartedMs: options.notStartedMs }),
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

  /** Enable or Disable: `enabled:` written into the job's file, which applies within a tick — a
   *  service turned off at once. */
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
    // Turned off, a service lets go of its hold now: turned on again at once, it follows its trigger.
    if (!enabled) await supervisor.tick();
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
    missed: async ({ job, choice }) => {
      const result = await runs.missed(job, choice);
      if (!result.ok) throw new ControlRefused(`cannot settle the missed runs of "${job}": ${result.reason}`);
      return { job: jobIdOf(jobs.snapshot(), job) ?? job, at: result.at, runs: result.runs };
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
  skillPlacedIn = skillsFolder();
  await skill.place();

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
      startKnown(null, null);
      return;
    }
    if (!(await starts.firstReady(workspace(), start))) {
      const kept = await starts.opened(workspace(), start);
      if (host !== client) return;
      log("Pomade ready: the Pomade started hooks fired for this Pomade start already");
      frontChanged(active, false);
      startKnown(start, kept);
      return;
    }
    log("Pomade started");
    // What ran with an earlier Pomade start — its quit unseen, the scheduler down then — is over.
    await supervisor.pomadeEnded();
    await runs.hook(POMADE_STARTED);
    if (host !== client) return;
    startKnown(start, []);
    if (active !== null) projectOpened(active);
    frontChanged(active, true);
  };

  /** The connection's Pomade start is known, and what was kept as opened in it (`null`: only what
   *  this scheduler heard): the services follow it, and the opens held till now count. A ready
   *  heard again for the start already known adds to what is opened. */
  const startKnown = (start: string | null, kept: readonly string[] | null): void => {
    if (kept !== null) opened = thisStart === start ? new Set([...opened, ...kept]) : new Set(kept);
    thisStart = start;
    pomadeState = "running";
    void supervisor.tick();
    const held = heldOpens;
    heldOpens = [];
    for (const project of held) projectOpened(project);
  };

  /** A project's first open since Pomade started: its first-open services start, its hooks fire —
   *  once per project and Pomade start. A project this workspace does not have (Pomade switched
   *  to another workspace, and this scheduler has yet to follow it) is not this workspace's. An
   *  open heard before the connection's ready named the Pomade start waits for it. */
  const projectOpened = (project: ProjectRecord): void => {
    if (thisStart === undefined) {
      heldOpens.push(project);
      return;
    }
    if (opened.has(project.id)) return;
    if (projects.root(project.id) === null) {
      log(`project ${project.name} (${project.id}) opened: not a project of this workspace`);
      return;
    }
    opened.add(project.id);
    if (thisStart !== null) void starts.open(workspace(), thisStart, project.id);
    log(`project ${project.name} (${project.id}) opened for the first time since Pomade started`);
    void supervisor.firstOpen(project.id);
    void runs.hook(projectFiring("project-first-open", project, workspace()));
  };

  /** The project in front is now `project` (`null`: the Workspace project). When `fires`, a project
   *  of this workspace fires the "project opened" hooks. */
  const frontChanged = (project: ProjectRecord | null, fires: boolean): void => {
    inFront = project?.id ?? null;
    if (!fires || project === null) return;
    if (projects.root(project.id) === null) {
      log(`project ${project.name} (${project.id}) opened: not a project of this workspace`);
      return;
    }
    log(`project ${project.name} (${project.id}) opened`);
    void runs.hook(projectFiring("project-opened", project, workspace()));
  };

  /** Pomade's project in front changed (`project.changed`): a project becoming the active one is
   *  opened. The same project again — renamed or moved — and a change heard before the connection's
   *  Pomade start is known fire nothing. */
  const projectChanged = (project: ProjectRecord | null): void => {
    frontChanged(project, thisStart !== undefined && inFront !== undefined && (project?.id ?? null) !== inFront);
  };

  /** Whether Pomade quit: the link has been down for the quit grace and no Pomade start is found.
   *  Then the services that run with it stop, and what was opened is forgotten. */
  const linked = (): boolean => host !== null;
  const checkQuit = async (): Promise<void> => {
    if (host !== null || pomadeState === "closed" || droppedAt === null) return;
    if (clock.now().getTime() - droppedAt < quitGraceMs) return;
    const found = await options.pomadeStart();
    // A connection made while the socket was looked at is Pomade, back.
    if (found !== null || linked()) return;
    pomadeState = "closed";
    opened = new Set();
    log("Pomade is not running: the services that run with it stop");
    await supervisor.pomadeEnded();
  };

  /** An agent session finished, or its status changed: its hooks fire. A session Runner started
   *  never fires "agent session finished" — its run's end would fire it, and a hook that runs an
   *  agent would start the next (the loop guard). A status change always fires: it is the Owner's. */
  const sessionEvent = (event: "session-finished" | "session-status", session: SessionClosed | StatusChanged, how: string): void => {
    log(`agent session ${session.sessionId} (${session.agent}) ${event === "session-finished" ? "finished" : "status changed"}: ${how}`);
    if (event === "session-finished" && session.startedByRunner) return;
    const name = session.project === null ? null : (projects.list().find((project) => project.id === session.project?.id)?.name ?? null);
    void runs.hook(sessionFiring(event, session, workspace(), name));
  };

  const linkHandlers: PomadeLinkHandlers = {
    connected(client) {
      host = client;
      ready = false;
      thisStart = undefined;
      heldOpens = [];
      inFront = undefined;
      droppedAt = null;
      pomadeState = "unsure";
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
        sessionEnd: (job, run) => history.sessionEnd(job, run),
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
        environment: () => readEnvironment(options.workspace, skill),
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
        changed: (project) => {
          if (host === client) projectChanged(project);
        },
        created: (project) => {
          if (host !== client) return;
          projects.add(project);
          log(`project ${project.name} (${project.id}) created`);
          void runs.hook(projectFiring("project-created", project, workspace()));
        },
        sessionClosed: (event) => {
          if (host !== client) return;
          sessionEvent("session-finished", event, `${event.reason}${event.startedByRunner ? `, started by Runner (${event.job ?? "a job"})` : ""}`);
        },
        statusChanged: (event) => {
          if (host === client) sessionEvent("session-status", event, `${event.from} → ${event.to}`);
        },
        log,
      });
      showBadge(needsYou.items().length);
    },
    disconnected() {
      host = null;
      ready = false;
      droppedAt = clock.now().getTime();
      if (pomadeState === "running") pomadeState = "unsure";
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
    await checkQuit();
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
