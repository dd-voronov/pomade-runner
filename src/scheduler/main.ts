// The always-on backend's entry: Pomade's login item runs it with Pomade's runtime, and it keeps
// running when Pomade quits. It runs the scheduler on the workspace Pomade records — waiting while
// there is none, starting again on another (`workspace-follow.ts`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { launchPomade, resolveWorkspace } from "pomade-kit/node";
import { POMADE_ENV } from "pomade-kit/protocol";

import { noticePoster } from "../integrations/notices";
import { pomadeStartOf } from "../integrations/pomade-start";
import { linkPomade } from "../integrations/pomade";
import { createAgentTurns, loginShell } from "../keeper/agent-turns";
import { keychainCheckArgv } from "../keeper/keychain";
import { probeReadiness } from "../keeper/readiness";
import { createSessions } from "../keeper/sessions";
import { fileStore } from "../keeper/supervisor";
import { keeperSocketPath, pomadeGitPath, recordsFolderOf, schedulerSocketPath, stateFolder, userDataDir } from "../locations";
import { notStartedMs } from "./agent-runs";
import { clockFrom, quitGraceMs, systemClock, tickMs } from "./clock";
import { createLog } from "./log";
import { startScheduler, type StartResult } from "./scheduler";
import { followWorkspace } from "./workspace-follow";

/** The version of the keeper this build ships (`src/keeper/version.ts`), set by the build. */
declare const KEEPER_VERSION: string;

/** The keeper's entry, next to this one in the build folder. */
const KEEPER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "keeper.mjs");
/** The agent skill in the build folder (`skills/` beside `backend/`). */
const SKILL_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "pomade-runner-jobs", "SKILL.md");

const log = createLog(systemClock, (line) => process.stdout.write(line));

function readKey(file: string | undefined): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

const state = stateFolder(process.env);
const userData = userDataDir(process.env);
const socketPath = schedulerSocketPath(process.env);
const keeperSocket = keeperSocketPath(process.env);
const key = readKey(process.env[POMADE_ENV.keyFile]);

if (state === null || socketPath === null || userData === null) {
  log("not started: POMADE_APP_KEY_FILE is not set — the scheduler runs as Runner's background part, started by Pomade");
  process.exitCode = 1;
} else if (keeperSocket === null) {
  log("not started: POMADE_KEEPER_SOCKET is not set — Pomade gives it to Runner's background part");
  process.exitCode = 1;
} else if (key === null) {
  log(`not started: cannot read the app's key from ${process.env[POMADE_ENV.keyFile] ?? ""}`);
  process.exitCode = 1;
} else {
  const clock = clockFrom(process.env);
  const tick = tickMs(process.env);
  const start = (workspace: string): Promise<StartResult> => {
    const records = recordsFolderOf(workspace);
    return startScheduler({
      socketPath,
      state,
      workspace,
      clock,
      tickMs: tick,
      log,
      linkPomade,
      launchPomade: () => launchPomade({ role: "backend" }),
      sessions: createSessions({ socketPath: keeperSocket, key, keeper: { entry: KEEPER_ENTRY, version: KEEPER_VERSION }, state, clock, log, keychainCheck: keychainCheckArgv(process.env) }),
      supervision: fileStore(state, records, log),
      probe: probeReadiness,
      postNotice: noticePoster(userData, log),
      pomadeGit: pomadeGitPath(process.env),
      skillSource: SKILL_SOURCE,
      turns: createAgentTurns({ socketPath: keeperSocket, log }),
      shell: loginShell(process.env),
      pomadeStart: () => pomadeStartOf(process.env),
      quitGraceMs: quitGraceMs(process.env),
      notStartedMs: notStartedMs(process.env),
    });
  };
  const following = followWorkspace({ workspace: () => resolveWorkspace(), start, pollMs: tick, log });
  const shutDown = (): void => {
    void following.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutDown);
  process.once("SIGINT", shutDown);
  const end = await following.ended;
  if (end.status === "already-running") {
    // A clean exit: launchd restarts a login item only after a failure.
    log("another scheduler is running; this one exits");
    process.exit(0);
  } else if (end.status === "failed") {
    log(`not started: ${end.reason}`);
    process.exit(1);
  }
}
