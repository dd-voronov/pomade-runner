// The always-on backend's entry: Pomade's login item runs it with Pomade's runtime, and it keeps
// running when Pomade quits.

import { resolveWorkspace } from "pomade-kit/node";

import { linkPomade } from "../integrations/pomade";
import { schedulerSocketPath } from "../locations";
import { systemClock, tickMs } from "./clock";
import { createLog } from "./log";
import { startScheduler } from "./scheduler";

const log = createLog(systemClock, (line) => process.stdout.write(line));
const socketPath = schedulerSocketPath(process.env);

if (socketPath === null) {
  log("not started: POMADE_APP_KEY_FILE is not set — the scheduler runs as Runner's background part, started by Pomade");
  process.exitCode = 1;
} else {
  const result = await startScheduler({ socketPath, clock: systemClock, tickMs: tickMs(process.env), log, linkPomade, workspace: () => resolveWorkspace() });
  if (result.status === "already-running") {
    // A clean exit: launchd restarts a login item only after a failure.
    log("another scheduler is running; this one exits");
  } else if (result.status === "failed") {
    log(`not started: ${result.reason}`);
    process.exitCode = 1;
  } else {
    const { scheduler } = result;
    const shutDown = (): void => {
      void scheduler.stop().finally(() => process.exit(0));
    };
    process.once("SIGTERM", shutDown);
    process.once("SIGINT", shutDown);
  }
}
