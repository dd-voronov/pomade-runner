// Where Runner keeps its machine-local state: `<userData>/app-state/pomade-runner/` of the Pomade
// that hosts it (docs/DESIGN.md "Data and locations"). The scheduler and the command both run with
// `POMADE_APP_KEY_FILE` — `<userData>/app-keys/pomade-runner`, issued by that Pomade — and it is
// the one value both get that names the user-data folder, so the state folder is found from it. A
// dev Pomade, the stable one and a test run each resolve to their own folder.

import { dirname, join } from "node:path";

import { pomadeHome } from "pomade-kit/node";
import { HOME_FILES, POMADE_ENV } from "pomade-kit/protocol";

import { APP_ID } from "./app";
import { encodeJobId } from "./keeper/ids";

export type Env = Readonly<Record<string, string | undefined>>;

/** The user-data folder of the Pomade that started the process, or `null` when no Pomade did. */
export function userDataDir(env: Env): string | null {
  const keyFile = env[POMADE_ENV.keyFile];
  return keyFile ? dirname(dirname(keyFile)) : null;
}

/** Runner's state folder, or `null` when the process was not started by Pomade or one of its shims. */
export function stateDir(env: Env): string | null {
  const userData = userDataDir(env);
  return userData === null ? null : join(userData, "app-state", APP_ID);
}

/** The socket the scheduler serves its control protocol on. */
export function schedulerSocketPath(env: Env): string | null {
  const dir = stateDir(env);
  return dir === null ? null : join(dir, "scheduler.sock");
}

/** Where the scheduler finds the keeper: `POMADE_KEEPER_SOCKET`, which Pomade gives its backend
 *  (`<userData>/run/keepers/pomade-runner.sock`); `null` when it is not set. */
export function keeperSocketPath(env: Env): string | null {
  return env[POMADE_ENV.keeperSocket] || null;
}

/** Pomade's `pomade-git` command: in the command folder of the Pomade the process belongs to
 *  (`<POMADE_HOME>/bin/pomade-git`), where that Pomade writes it at every start. It runs with
 *  Pomade closed. */
export function pomadeGitPath(env: Env): string {
  return join(pomadeHome(env), HOME_FILES.bin, "pomade-git");
}

/** Which job and run each keeper session belongs to, and the exits already reported. */
export function sessionsRecordPath(state: string): string {
  return join(state, "sessions.json");
}

/** One run's full output, which the keeper appends to: `output/<encoded job id>/<run id>.log`. */
export function outputLogPath(state: string, jobId: string, runId: string): string {
  return join(state, "output", encodeJobId(jobId), `${runId}.log`);
}

/** A git run's result, what `pomade-git --json` prints, beside its output log:
 *  `output/<encoded job id>/<run id>.json`. It goes once the run's record holds it. */
export function gitResultPath(state: string, jobId: string, runId: string): string {
  return join(state, "output", encodeJobId(jobId), `${runId}.json`);
}

/** The keeper's own folder (`pomade-kit/keeper`'s state: its session records, exit statuses, log),
 *  where its stdout and stderr go too: `keeper/keeper.out`. */
export function keeperOutPath(state: string): string {
  return join(state, "keeper", "keeper.out");
}
