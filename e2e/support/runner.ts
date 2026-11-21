// Runner as processes, with Pomade closed: a copy of the built app folder (no `node_modules` but
// what the build ships), its scheduler started the way Pomade's login item starts it, the keeper it
// starts, and the `pomade-runner` command — all on throwaway folders: user data, workspace, Pomade
// home and the user's home. Sessions run `/bin/sh` as the login shell. `dispose()` stops every
// scheduler and the keeper with what it runs, and removes the folders.

import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "@playwright/test";
import { NOTICE_QUEUE_DIR, parseQueuedNotice, type QueuedNotice } from "pomade-kit/protocol";

import manifest from "../../app/manifest.json" with { type: "json" };
import type { RunnerSession, ServicesReport, ServiceStatus, SessionsReport } from "../../src/keeper/model";
import type { RunRecord } from "../../src/scheduler/model";
import { callScheduler } from "../../src/scheduler/control/client";
import { DIST, cleanEnv, removeDir, run, tempDir, type Finished } from "./env";
import { runningSession, stopKeeper } from "./keeper";
import { startSchedulerProcess, type SchedulerProcess } from "./scheduler";

export interface RunnerWorld {
  tmp: string;
  /** The installed copy of the build. */
  build: string;
  userData: string;
  /** The scheduler's control socket. */
  socketPath: string;
  keeperSocket: string;
  /** The workspace the Pomade home points at. */
  workspace: string;
  /** The jobs folder of the workspace. */
  jobs: string;
  env: Record<string, string>;
  /** Start a scheduler of the build, with `extra` in its environment (its clock, a time zone). */
  startScheduler(extra?: Record<string, string>): SchedulerProcess;
  /** Wait until the scheduler is connected to its keeper. */
  ready(scheduler: SchedulerProcess): Promise<void>;
  /** Write a job file into the jobs folder (`path` inside it). */
  writeJob(path: string, text: string): Promise<void>;
  /** Run `pomade-runner`. */
  command(...args: string[]): Promise<Finished>;
  sessions(): Promise<SessionsReport>;
  services(): Promise<ServicesReport>;
  /** The latest finished runs, newest first, as the scheduler reports them. */
  history(job?: string): Promise<RunRecord[]>;
  /** The notices waiting in Pomade's closed-Pomade queue, oldest first. */
  queuedNotices(): Promise<QueuedNotice[]>;
  /** A service's status, as the scheduler reports it. */
  service(job: string): Promise<ServiceStatus | undefined>;
  /** Wait until session `id` runs (another start than `not`, when given); its session. */
  running(id: string, not?: RunnerSession): Promise<RunnerSession>;
  /** The program a session's shim runs (the shell running the command). */
  childOf(pid: number | null): number;
  /** A log-out or a shutdown: the keeper ends, with what it runs, as macOS ends the user's
   *  processes. Stop the schedulers first; the next one to start finds no keeper — a login. */
  logOut(): Promise<void>;
  dispose(): Promise<void>;
}

/** A service job file. */
export const serviceFile = (name: string, command: string, extra = ""): string => `---\nkind: service\nname: ${name}\nfolder: .\ncommand: ${JSON.stringify(command)}\n${extra}---\n`;

export async function createRunnerWorld(): Promise<RunnerWorld> {
  const tmp = await tempDir();
  const build = join(tmp, "apps", manifest.id);
  await cp(DIST, build, { recursive: true });
  const userData = join(tmp, "ud");
  const keyFile = join(userData, "app-keys", manifest.id);
  await mkdir(join(userData, "app-keys"), { recursive: true });
  await writeFile(keyFile, "test-key\n", { mode: 0o600 });
  const socketPath = join(userData, "app-state", manifest.id, "scheduler.sock");
  const keeperSocket = join(userData, "run", "keepers", `${manifest.id}.sock`);
  const workspace = join(tmp, "ws");
  const jobs = join(workspace, "Apps/pomade-runner/jobs");
  await mkdir(jobs, { recursive: true });
  await mkdir(join(tmp, "home"), { recursive: true });
  await writeFile(join(tmp, "home", "workspace"), `${workspace}\n`);
  await mkdir(join(tmp, "user"));
  const env = cleanEnv({
    POMADE_APP_ID: manifest.id,
    POMADE_APP_KEY_FILE: keyFile,
    POMADE_KEEPER_SOCKET: keeperSocket,
    POMADE_HOME: join(tmp, "home"),
    POMADE_RUNNER_TICK_MS: "50",
    HOME: join(tmp, "user"),
    SHELL: "/bin/sh",
  });
  const started: SchedulerProcess[] = [];
  /** Processes the keeper ran: killed in teardown should one outlive its keeper. */
  const pids: number[] = [];

  const ask = async <T>(result: Promise<{ status: "ok"; value: T } | { status: "not-running" } | { status: "failed"; message: string }>, what: string): Promise<T> => {
    const answer = await result;
    if (answer.status !== "ok") throw new Error(`${what}: ${answer.status === "failed" ? answer.message : answer.status}`);
    return answer.value;
  };

  const world: RunnerWorld = {
    tmp,
    build,
    userData,
    socketPath,
    keeperSocket,
    workspace,
    jobs,
    env,
    startScheduler(extra = {}) {
      const scheduler = startSchedulerProcess(process.execPath, join(build, manifest.backend.entry), { ...env, ...extra, POMADE_CLIENT: "backend" });
      started.push(scheduler);
      return scheduler;
    },
    async ready(scheduler) {
      await expect.poll(() => scheduler.output()).toMatch(/keeper: connected — version \w+, pid \d+\n/);
    },
    writeJob: (path, text) => writeFile(join(jobs, path), text),
    command: (...args) => run(process.execPath, [join(build, "cli/pomade-runner.mjs"), ...args], { env: { ...env, POMADE_CLIENT: "command" }, cwd: tmp }),
    sessions: () => ask(callScheduler(socketPath, "sessions", null), "sessions"),
    async history(job) {
      return (await ask(callScheduler(socketPath, "history", { job: job ?? null, limit: 200 }), "history")).records;
    },
    async queuedNotices() {
      const folder = join(userData, NOTICE_QUEUE_DIR);
      const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
      return Promise.all(
        names.map(async (name) => {
          const parsed = parseQueuedNotice(JSON.parse(await readFile(join(folder, name), "utf8")));
          if (!parsed.ok) throw new Error(`${name}: ${parsed.message}`);
          return parsed.notice;
        }),
      );
    },
    services: () => ask(callScheduler(socketPath, "services", null), "services"),
    async service(job) {
      return (await world.services()).services.find((status) => status.job === job);
    },
    async running(id, not) {
      const found = await runningSession(socketPath, id, not);
      pids.push(found.info.pid ?? 0);
      return found;
    },
    childOf(pid) {
      const child = Number(execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n")[0]);
      pids.push(child);
      return child;
    },
    async logOut() {
      await stopKeeper(keeperSocket, pids.splice(0));
    },
    async dispose() {
      for (const scheduler of started.splice(0)) await scheduler.kill();
      await stopKeeper(keeperSocket, pids.splice(0));
      await removeDir(tmp);
    },
  };
  return world;
}
