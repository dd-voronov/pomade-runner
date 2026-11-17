// The `pomade-runner` command's entry: Pomade's shim in its command folder runs it with Pomade's
// runtime, with Pomade open or closed.

import { schedulerSocketPath } from "../../locations";
import { callScheduler } from "../../scheduler/control/client";
import { runCli } from "./cli";

const socketPath = schedulerSocketPath(process.env);

process.exitCode = await runCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  schedulerStatus: () => (socketPath === null ? Promise.resolve(null) : callScheduler(socketPath, "status")),
});
