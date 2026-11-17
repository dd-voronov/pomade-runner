// The scheduler: Runner's always-on background part. It serves the control protocol to the
// `pomade-runner` command, keeps a connection to Pomade while Pomade runs, ticks on its clock,
// holds the checked job files of the current workspace — served to Runner's frames through
// Pomade's broker — owns the keeper's sessions, following them on every tick, and supervises the
// services after each.

import type { AttachedTabActionPayload } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID, APP_VERSION } from "../app";
import { announce, offerRunner, type LinkPomade } from "../integrations/pomade";
import { JOBS_CHANGED_EVENT, SERVICES_CHANGED_EVENT } from "../integrations/runner-api";
import { createJobsLoader } from "../jobs/loader";
import type { JobsSnapshot } from "../jobs/model";
import { sessionOwner } from "../keeper/ids";
import { exitWords, type ServiceActionResult, type ServiceStatus } from "../keeper/model";
import type { NetworkReadiness } from "../keeper/readiness";
import { RESTART_ACTION } from "../keeper/services";
import type { Sessions } from "../keeper/sessions";
import { createSupervisor, type SupervisionStore } from "../keeper/supervisor";
import type { Clock } from "./clock";
import type { PomadeLinkState, SchedulerStatus } from "./control/protocol";
import { ControlRefused, serveControl } from "./control/server";
import type { Log } from "./log";

export interface SchedulerOptions {
  /** Where the control protocol is served. */
  socketPath: string;
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
  const { clock, log } = options;
  const startedAt = clock.now().toISOString();
  let lastTickAt: string | null = null;
  let pomade: PomadeLinkState = "disconnected";
  const status = (): SchedulerStatus => ({ version: APP_VERSION, pid: process.pid, startedAt, lastTickAt, pomade });

  const { sessions } = options;
  let host: HostClient | null = null;
  const jobs = createJobsLoader({
    workspace: options.workspace,
    log,
    onChange: () => {
      if (host !== null) announce(host, JOBS_CHANGED_EVENT, log);
    },
  });
  const supervisor = createSupervisor({
    sessions,
    jobs: jobs.snapshot,
    clock,
    log,
    store: options.supervision,
    probe: options.probe,
    onChange: () => {
      if (host !== null) announce(host, SERVICES_CHANGED_EVENT, log);
    },
  });
  await supervisor.load();
  const answer = (verb: string, job: string, result: ServiceActionResult): ServiceStatus => {
    if (!result.ok) throw new ControlRefused(`cannot ${verb} "${job}": ${result.reason}`);
    return result.service;
  };

  const control = await serveControl(options.socketPath, {
    status,
    sessions: () => sessions.report(),
    services: () => supervisor.report(),
    start: async ({ job }) => answer("start", job, await supervisor.start(job)),
    stop: async ({ job }) => answer("stop", job, await supervisor.stop(job)),
    restart: async ({ job }) => answer("restart", job, await supervisor.restart(job)),
  });
  if (control.status !== "listening") return control;
  await jobs.refresh();

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
      log("connected to Pomade");
      void offerRunner(client, {
        jobs: jobs.snapshot,
        services: supervisor.report,
        serviceAction: (verb, job) => supervisor[verb](job),
        projects: jobs.setProjects,
        tabAction,
        log,
      });
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
  /** Follow the keeper, then supervise on what it says. */
  const follow = async (): Promise<void> => {
    await sessions.refresh();
    await supervisor.tick();
  };
  const ticker = setInterval(() => {
    lastTickAt = clock.now().toISOString();
    void jobs.refresh();
    void follow();
  }, options.tickMs);
  log(`scheduler ${APP_VERSION} started (pid ${process.pid}, tick ${options.tickMs} ms)`);
  void follow();

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
        await supervisor.close();
        await sessions.close();
        await control.close();
        log("scheduler stopped");
      },
    },
  };
}
