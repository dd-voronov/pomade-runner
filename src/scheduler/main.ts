// The always-on backend's entry: Pomade's login item runs it with Pomade's runtime, and it keeps
// running when Pomade quits.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkspace } from "pomade-kit/node";
import { POMADE_ENV } from "pomade-kit/protocol";

import { linkPomade } from "../integrations/pomade";
import { createSessions } from "../keeper/sessions";
import { keeperSocketPath, schedulerSocketPath, stateDir } from "../locations";
import { systemClock, tickMs } from "./clock";
import { createLog } from "./log";
import { startScheduler } from "./scheduler";

/** The version of the keeper this build ships (`src/keeper/version.ts`), set by the build. */
declare const KEEPER_VERSION: string;

/** The keeper's entry, next to this one in the build folder. */
const KEEPER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "keeper.mjs");

const log = createLog(systemClock, (line) => process.stdout.write(line));

function readKey(file: string | undefined): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

const state = stateDir(process.env);
const socketPath = schedulerSocketPath(process.env);
const keeperSocket = keeperSocketPath(process.env);
const key = readKey(process.env[POMADE_ENV.keyFile]);

if (state === null || socketPath === null) {
  log("not started: POMADE_APP_KEY_FILE is not set — the scheduler runs as Runner's background part, started by Pomade");
  process.exitCode = 1;
} else if (keeperSocket === null) {
  log("not started: POMADE_KEEPER_SOCKET is not set — Pomade gives it to Runner's background part");
  process.exitCode = 1;
} else if (key === null) {
  log(`not started: cannot read the app's key from ${process.env[POMADE_ENV.keyFile] ?? ""}`);
  process.exitCode = 1;
} else {
  const sessions = createSessions({ socketPath: keeperSocket, key, keeper: { entry: KEEPER_ENTRY, version: KEEPER_VERSION }, state, clock: systemClock, log });
  const result = await startScheduler({ socketPath, clock: systemClock, tickMs: tickMs(process.env), log, linkPomade, workspace: () => resolveWorkspace(), sessions });
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
