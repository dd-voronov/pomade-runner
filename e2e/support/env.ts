// What the process-level specs share: the built app folder, throwaway folders, a clean
// environment, and running a program to its end.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "../..");
export const DIST = join(REPO, "dist");

/** A throwaway folder. Its name is short: the unix sockets under it must fit macOS's 103-byte path limit. */
export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pr-"));
}

export function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** This process's environment without any `POMADE_*` variable — a run started from a Pomade
 *  terminal must not reach that Pomade — plus `extra`. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("POMADE_")) env[key] = value;
  }
  return { ...env, ...extra };
}

export interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a program to its end. */
export function run(file: string, args: readonly string[], options: { env: Record<string, string>; cwd?: string }): Promise<Finished> {
  return new Promise((done, fail) => {
    const child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}
