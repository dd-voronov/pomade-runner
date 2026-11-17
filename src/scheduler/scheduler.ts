// The scheduler: Runner's always-on background part. It serves the control protocol to the
// `pomade-runner` command, keeps a connection to Pomade while Pomade runs, and ticks on its clock.

import { APP_VERSION } from "../app";
import type { LinkPomade } from "../integrations/pomade";
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
}

export interface Scheduler {
  status(): SchedulerStatus;
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

  const link = options.linkPomade({
    connected() {
      pomade = "connected";
      log("connected to Pomade");
    },
    disconnected() {
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
  }, options.tickMs);
  log(`scheduler ${APP_VERSION} started (pid ${process.pid}, tick ${options.tickMs} ms)`);

  return {
    status: "started",
    scheduler: {
      status,
      async stop() {
        clearInterval(ticker);
        link.stop();
        await control.close();
        log("scheduler stopped");
      },
    },
  };
}
