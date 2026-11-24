// The `pomade-runner` command's entry: Pomade's shim in its command folder runs it with Pomade's
// runtime, with Pomade open or closed.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { connectSocket, resolveWorkspace } from "pomade-kit/node";

import { schedulerSocketPath } from "../../locations";
import { callScheduler } from "../../scheduler/control/client";
import { readSettingsText } from "../../scheduler/settings-file";
import { readJobFiles } from "../folder";
import type { ProjectRecord } from "../model";
import { runCli } from "./cli";
import { guardOutput } from "./output";

const socketPath = schedulerSocketPath(process.env);

/** The methods that may wait on a session or a tick. */
const SLOW: ReadonlySet<string> = new Set(["run", "stop", "restart", "enable", "disable", "switch"]);

/** Pomade's projects over its socket; `null` when it is closed or this is not run through its shim. */
async function projects(): Promise<ProjectRecord[] | null> {
  let result;
  try {
    result = await connectSocket({ role: "command", timeoutMs: 2000 });
  } catch {
    return null;
  }
  if (result.status !== "connected") return null;
  try {
    const { projects: list } = await result.host.project.list();
    return list.map(({ id, name, root }) => ({ id, name, root }));
  } finally {
    result.host.close();
  }
}

/** A path by its real path — the form `process.cwd()` has — as far as it exists: a missing file by its folder's. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

function workspace(): string | null {
  const root = resolveWorkspace();
  return root === null ? null : realPath(root);
}

const stdout = guardOutput(process.stdout);
const stderr = guardOutput(process.stderr);
process.exitCode = await runCli(process.argv.slice(2), {
  out: stdout.write,
  err: stderr.write,
  cwd: process.cwd(),
  // A service's start or restart waits for its running session to end first: up to the keeper's
  // grace and more; Run now and Enable / Disable wait their turn behind a tick.
  ask: (method, params) => (socketPath === null ? Promise.resolve(null) : callScheduler(socketPath, method, params, SLOW.has(method) ? { timeoutMs: 15_000 } : {})),
  workspace,
  realPath,
  readJobFiles,
  readSettings: readSettingsText,
  projects,
  exists: existsSync,
});
