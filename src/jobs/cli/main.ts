// The `pomade-runner` command's entry: Pomade's shim in its command folder runs it with Pomade's
// runtime, with Pomade open or closed.

import { realpathSync } from "node:fs";

import { connectSocket, resolveWorkspace } from "pomade-kit/node";

import { schedulerSocketPath } from "../../locations";
import { callScheduler } from "../../scheduler/control/client";
import { readJobFiles } from "../folder";
import type { ProjectRecord } from "../model";
import { runCli } from "./cli";

const socketPath = schedulerSocketPath(process.env);

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

/** The workspace by its real path — the form `process.cwd()` has — so paths print relative to where the command runs. */
function workspace(): string | null {
  const root = resolveWorkspace();
  if (root === null) return null;
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  schedulerStatus: () => (socketPath === null ? Promise.resolve(null) : callScheduler(socketPath, "status")),
  workspace,
  readJobFiles,
  projects,
});
