// Where Runner keeps what it writes (docs/DESIGN.md "Data and locations"), in two folders:
//
// - **The records folder** — `<workspace>/Apps/pomade-runner/records/`, beside the Owner's `jobs/`
//   and `settings.yaml`: what belongs to the Owner's working process — run history with each
//   finished run's output log, the runs going, the switch, Needs you, the services the Owner
//   stopped — so a copy of the workspace carries it to another Mac.
// - **The state folder** — `<userData>/app-state/pomade-runner/` of the Pomade that hosts Runner:
//   what describes this Mac's processes — the control socket, the keeper's state and its session
//   records, the output a live run or a service is writing, service crash counts, Pomade's projects
//   as last heard.
//
// A run's output log is written in the state folder while the run goes (`liveOutputLogPath`) and
// kept in the records folder once it ended (`keptOutputLogPath`); a record names it by job and run
// (`outputLogName`), never by a path, and a reader finds it with `findOutputLog`. The scheduler and the
//   command both run with `POMADE_APP_KEY_FILE` — `<userData>/app-keys/pomade-runner`, issued by that
//   Pomade — the one value both get that names the user-data folder, so the state folder is found
//   from it. A dev Pomade, the stable one and a test run each resolve to their own folder.
//
// Each folder has its own type, so a path in one is never taken for the other.

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

import { pomadeHome } from "pomade-kit/node";
import { HOME_FILES, POMADE_ENV } from "pomade-kit/protocol";

import { APP_ID } from "./app";
import { encodeJobId } from "./keeper/ids";

export type Env = Readonly<Record<string, string | undefined>>;

declare const stateBrand: unique symbol;
declare const recordsBrand: unique symbol;

/** Runner's machine-local state folder: `<userData>/app-state/pomade-runner/`. */
export type StateFolder = string & { readonly [stateBrand]: true };
/** Runner's records folder in a workspace: `<workspace>/Apps/pomade-runner/records/`. */
export type RecordsFolder = string & { readonly [recordsBrand]: true };

/** The records folder, workspace-relative. The jobs folder (`Apps/pomade-runner/jobs`) is its
 *  sibling, never its parent, so the job files never include a record. */
export const RECORDS_FOLDER = "Apps/pomade-runner/records";

/** The user-data folder of the Pomade that started the process, or `null` when no Pomade did. */
export function userDataDir(env: Env): string | null {
  const keyFile = env[POMADE_ENV.keyFile];
  return keyFile ? dirname(dirname(keyFile)) : null;
}

/** The state folder in a user-data folder. */
export function stateFolderOf(userData: string): StateFolder {
  return join(userData, "app-state", APP_ID) as StateFolder;
}

/** Runner's state folder, or `null` when the process was not started by Pomade or one of its shims. */
export function stateFolder(env: Env): StateFolder | null {
  const userData = userDataDir(env);
  return userData === null ? null : stateFolderOf(userData);
}

/** The records folder of a workspace (its root, absolute). */
export function recordsFolderOf(workspace: string): RecordsFolder {
  return join(workspace, RECORDS_FOLDER) as RecordsFolder;
}

// --- The state folder ---------------------------------------------------------------------------

/** The socket the scheduler serves its control protocol on. */
export function schedulerSocketPath(env: Env): string | null {
  const state = stateFolder(env);
  return state === null ? null : join(state, "scheduler.sock");
}

/** Which job and run each keeper session belongs to, and the exits already reported. */
export function sessionsRecordPath(state: StateFolder): string {
  return join(state, "sessions.json");
}

/** The keeper's own folder (`pomade-kit/keeper`'s state: its session records, exit statuses, log),
 *  where its stdout and stderr go too: `keeper/keeper.out`. */
export function keeperOutPath(state: StateFolder): string {
  return join(state, "keeper", "keeper.out");
}

/** Service supervision on this Mac: crash counts, a restart due, a service given up on, the last
 *  start's problem. */
export function supervisionRecordPath(state: StateFolder): string {
  return join(state, "services.json");
}

/** Pomade's projects as the scheduler last heard them. */
export function projectsRecordPath(state: StateFolder): string {
  return join(state, "projects.json");
}

/** The output being written — live runs', services' — and git results, one sub-folder per job:
 *  `output/<encoded job id>/`. */
export function liveOutputFolder(state: StateFolder): string {
  return join(state, "output");
}

/** A run's output log, relative to either folder: `output/<encoded job id>/<run id>.log` — what a
 *  record keeps in its `log`. */
export function outputLogName(jobId: string, runId: string): string {
  return join("output", encodeJobId(jobId), `${runId}.log`);
}

/** Where the keeper writes a run's or a service's output while it goes. */
export function liveOutputLogPath(state: StateFolder, jobId: string, runId: string): string {
  return join(state, outputLogName(jobId, runId));
}

/** A git run's result, what `pomade-git --json` prints, beside its output log:
 *  `output/<encoded job id>/<run id>.json`. It goes once the run's record holds it. */
export function gitResultPath(state: StateFolder, jobId: string, runId: string): string {
  return join(liveOutputFolder(state), encodeJobId(jobId), `${runId}.json`);
}

// --- The records folder -------------------------------------------------------------------------

/** Run history: one JSON Lines file per day, `history/YYYY-MM-DD.jsonl`. */
export function historyFolder(records: RecordsFolder): string {
  return join(records, "history");
}

/** The runs going, each job's latest record, the last alive time, the looks the switch holds, the
 *  loop guard's firings and pauses. */
export function runsRecordPath(records: RecordsFolder): string {
  return join(records, "runs.json");
}

/** The switch's position. */
export function switchRecordPath(records: RecordsFolder): string {
  return join(records, "switch.json");
}

/** Needs-you items and the giving-ups noticed. */
export function needsYouRecordPath(records: RecordsFolder): string {
  return join(records, "needs-you.json");
}

/** The finished runs' output logs, one sub-folder per job: `output/<encoded job id>/`. */
export function keptOutputFolder(records: RecordsFolder): string {
  return join(records, "output");
}

/** Where a finished run's output log is kept: moved here from the state folder when the run ends. */
export function keptOutputLogPath(records: RecordsFolder, jobId: string, runId: string): string {
  return join(records, outputLogName(jobId, runId));
}

/** A finished run's output log, for a reader: kept in the records folder, else still in the state
 *  folder (before its move, or after a move that did not finish); where it is kept when it is in
 *  neither. */
export async function findOutputLog(records: RecordsFolder, state: StateFolder, jobId: string, runId: string): Promise<string> {
  const kept = keptOutputLogPath(records, jobId, runId);
  const live = liveOutputLogPath(state, jobId, runId);
  for (const path of [kept, live]) {
    try {
      await access(path);
      return path;
    } catch {
      // Not there: the next place.
    }
  }
  return kept;
}

/** The services the Owner stopped, which stay stopped. */
export function serviceHoldsPath(records: RecordsFolder): string {
  return join(records, "services.json");
}

// --- Elsewhere ----------------------------------------------------------------------------------

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
