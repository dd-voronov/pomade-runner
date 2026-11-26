// The keeper's reach to the macOS login keychain (docs/ARCHITECTURE.md "Sessions", **Keychain check**).
// A keeper can lose it while it runs: every process it starts then fails `security list-keychains`,
// and an agent started there finds no login. Before an agent run starts, the scheduler runs this
// check as a short session in the keeper (`Sessions.checkKeychain`) and reads it by its exit
// status; it knows no provider and no credential's name. The pure part — the check's command, its
// verdict, a process's age — is here; the process's start time is read with `ps`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SessionExit } from "pomade-kit/protocol";

/** A command line the check runs by `/bin/sh -c` in place of `security list-keychains`: the test
 *  seam for a keeper that lost the keychain, which no test can bring about. */
export const KEYCHAIN_CHECK_ENV = "POMADE_RUNNER_KEYCHAIN_CHECK";

/** What the check runs: `security list-keychains`, or the command `POMADE_RUNNER_KEYCHAIN_CHECK` names. */
export function keychainCheckArgv(env: Record<string, string | undefined>): string[] {
  const line = env[KEYCHAIN_CHECK_ENV];
  return line === undefined || line === "" ? ["/usr/bin/security", "list-keychains"] : ["/bin/sh", "-c", line];
}

/** How long the check may take before it counts as one that could not run. */
export const KEYCHAIN_CHECK_TIMEOUT_MS = 5_000;

/** What the check found: the keychain is reachable · it is not (the check ended with another
 *  status) · the check could not run (the keeper refused it, or it did not end in time). */
export type KeychainCheck = { status: "reachable" } | { status: "unreachable"; detail: string } | { status: "unknown"; detail: string };

/** The check's verdict from its session's end: exit status 0 is reachable; any other end is not. */
export function keychainVerdict(exit: SessionExit): KeychainCheck {
  if (exit.reason === "exited" && exit.code === 0) return { status: "reachable" };
  const detail = exit.code !== null ? `exit ${exit.code}` : exit.signal !== null ? `ended by ${exit.signal}` : `ended: ${exit.reason}`;
  return { status: "unreachable", detail };
}

/** `ps`'s elapsed time (`[[dd-]hh:]mm:ss`) in ms; `null` when it is not one. */
export function elapsedMs(etime: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

const run = promisify(execFile);

/** When process `pid` started, ISO 8601 to the second on this Mac's clock; `unknown` when `ps`
 *  cannot tell. */
export async function processStartedAt(pid: number): Promise<string> {
  try {
    const { stdout } = await run("/bin/ps", ["-o", "etime=", "-p", String(pid)]);
    const ms = elapsedMs(stdout);
    return ms === null ? "unknown" : new Date(Math.floor((Date.now() - ms) / 1000) * 1000).toISOString();
  } catch {
    return "unknown";
  }
}
