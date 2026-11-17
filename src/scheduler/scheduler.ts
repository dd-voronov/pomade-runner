// The scheduler: Runner's always-on background part. It serves the control protocol to the
// `pomade-runner` command, keeps a connection to Pomade while Pomade runs, ticks on its clock, and
// holds the checked job files of the current workspace — served to Runner's frames through
// Pomade's broker.

import type { HostClient } from "pomade-kit/sdk";

import { APP_VERSION } from "../app";
import { announceJobs, offerRunner, type LinkPomade } from "../integrations/pomade";
import { createJobsLoader } from "../jobs/loader";
import type { JobsSnapshot } from "../jobs/model";
import type { Clock } from "./clock";
import type { PomadeLinkState, SchedulerStatus } from "./control/protocol";
import { serveControl } from "./control/server";
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
}

export interface Scheduler {
  status(): SchedulerStatus;
  /** The checked job files. */
  jobs(): JobsSnapshot;
  /** Stops ticking, closes the connection to Pomade and the control socket. */
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

  const control = await serveControl(options.socketPath, { status });
  if (control.status !== "listening") return control;

  let host: HostClient | null = null;
  const jobs = createJobsLoader({
    workspace: options.workspace,
    log,
    onChange: () => {
      if (host !== null) announceJobs(host, log);
    },
  });
  await jobs.refresh();

  const link = options.linkPomade({
    connected(client) {
      host = client;
      pomade = "connected";
      log("connected to Pomade");
      void offerRunner(client, { jobs: jobs.snapshot, projects: jobs.setProjects, log });
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
  const ticker = setInterval(() => {
    lastTickAt = clock.now().toISOString();
    void jobs.refresh();
  }, options.tickMs);
  log(`scheduler ${APP_VERSION} started (pid ${process.pid}, tick ${options.tickMs} ms)`);

  return {
    status: "started",
    scheduler: {
      status,
      jobs: jobs.snapshot,
      async stop() {
        clearInterval(ticker);
        jobs.stop();
        link.stop();
        await control.close();
        log("scheduler stopped");
      },
    },
  };
}
