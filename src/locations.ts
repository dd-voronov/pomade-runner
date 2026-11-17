// Where Runner keeps its machine-local state: `<userData>/app-state/pomade-runner/` of the Pomade
// that hosts it (docs/DESIGN.md "Data and locations"). The scheduler and the command both run with
// `POMADE_APP_KEY_FILE` — `<userData>/app-keys/pomade-runner`, issued by that Pomade — and it is
// the one value both get that names the user-data folder, so the state folder is found from it. A
// dev Pomade, the stable one and a test run each resolve to their own folder.

import { dirname, join } from "node:path";

import { POMADE_ENV } from "pomade-kit/protocol";

import { APP_ID } from "./app";

export type Env = Readonly<Record<string, string | undefined>>;

/** Runner's state folder, or `null` when the process was not started by Pomade or one of its shims. */
export function stateDir(env: Env): string | null {
  const keyFile = env[POMADE_ENV.keyFile];
  if (!keyFile) return null;
  return join(dirname(dirname(keyFile)), "app-state", APP_ID);
}

/** The socket the scheduler serves its control protocol on. */
export function schedulerSocketPath(env: Env): string | null {
  const dir = stateDir(env);
  return dir === null ? null : join(dir, "scheduler.sock");
}
