// The keeper's entry (`backend/keeper.mjs`): Runner's keeper — `pomade-kit/keeper` — in its own
// detached process, started by the scheduler and handed the open sessions on an update. Its one
// argument is the keeper version the build computed, which it reports to the scheduler. The
// socket, the app id and the owner's key come from the environment the scheduler passes on.

import { runKeeper } from "pomade-kit/keeper";

const version = process.argv[2];

if (version === undefined || version === "") {
  process.stderr.write("keeper: not started — the scheduler starts it with its version as the argument\n");
  process.exitCode = 1;
} else {
  await runKeeper({ version });
}
