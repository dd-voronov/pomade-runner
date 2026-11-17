// A scheduler process under test: the built backend entry, started the way Pomade's login item
// starts it, with its output collected.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface SchedulerProcess {
  readonly child: ChildProcess;
  /** Everything it has written to stdout and stderr so far. */
  output(): string;
  /** Resolves with its exit code; `null` when a signal ended it. */
  exited: Promise<number | null>;
  /** SIGKILL it, unless it has exited, and wait until it is gone. */
  kill(): Promise<void>;
}

export function startSchedulerProcess(runtime: string, entry: string, env: Record<string, string>): SchedulerProcess {
  const child = spawn(runtime, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return {
    child,
    output: () => text,
    exited,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}
