// The `pomade-runner` command: what it prints and how it exits, for the arguments it is given.

import { APP_VERSION } from "../../app";
import type { ControlCallResult } from "../../scheduler/control/client";
import type { SchedulerStatus } from "../../scheduler/control/protocol";

export const COMMAND = "pomade-runner";

/** Exit codes: 0 done · 2 the command line is wrong. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export interface CliDeps {
  out(text: string): void;
  err(text: string): void;
  /** Asks the scheduler for its status; `null` when the command does not run under Pomade's shim,
   *  so there is no scheduler to find. */
  schedulerStatus(): Promise<ControlCallResult<SchedulerStatus> | null>;
}

export const USAGE = `${COMMAND} ${APP_VERSION} — Runner from the command line

Usage:
  ${COMMAND} --version   print the version and whether the scheduler is running
  ${COMMAND} --help      print this help
`;

function schedulerLine(result: ControlCallResult<SchedulerStatus> | null): string {
  if (result === null) return `scheduler: unknown — ${COMMAND} was not started through Pomade's command folder`;
  if (result.status === "not-running") return "scheduler: not running";
  if (result.status === "failed") return `scheduler: not answering — ${result.message}`;
  const { version, pid, startedAt, pomade } = result.value;
  const link = pomade === "connected" ? "connected to Pomade" : pomade === "rejected" ? "refused by Pomade" : "Pomade closed";
  return `scheduler: running — ${version}, pid ${pid}, since ${startedAt}, ${link}`;
}

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [first] = args;
  if (first === undefined || first === "--help" || first === "-h") {
    deps.out(USAGE);
    return EXIT_OK;
  }
  if (first === "--version" || first === "-V") {
    deps.out(`${COMMAND} ${APP_VERSION}\n${schedulerLine(await deps.schedulerStatus())}\n`);
    return EXIT_OK;
  }
  const what = first.startsWith("-") ? "option" : "command";
  deps.err(`${COMMAND}: unknown ${what} "${first}". Run \`${COMMAND} --help\` for what it takes.\n`);
  return EXIT_USAGE;
}
