// Git jobs as processes: the scheduler of a copy of the built app folder runs a git job of a temp
// workspace through Pomade's real `pomade-git` (the Pomade checkout's build, `POMADE_REPO`), with
// Pomade closed — on throwaway repos only: a bare remote, the workspace's clone `Knowledge` and a
// second clone that stands for another machine (`support/git.ts`). E-006's acceptance on real
// processes: the scheduled commit and push with its hash in History, a conflict that fails the run
// with its reason and a notice and leaves the repo exactly as it was, the skip while an agent works
// in the repo — and a scheduler restarted while `pomade-git` runs, which records the run once.
// The mapping of every end is in the unit tests (`src/scheduler/git-runs.test.ts`).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { callScheduler } from "../src/scheduler/control/client";
import type { RunRecord } from "../src/scheduler/model";
import { cleanEnv } from "./support/env";
import { createGitFixture, gitEnv, writeFakeAgent, writePomadeGit, type GitFixture } from "./support/git";
import { createRunnerWorld, type RunnerWorld } from "./support/runner";

const ZONE = { TZ: "Europe/Madrid" };
const NAME = "Knowledge twice daily";
const JOB = `---\nkind: git\nname: ${NAME}\ngit: { operation: commit-push, repos: [Knowledge] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n`;
const MESSAGE = new RegExp(`^Committed automatically · job "${NAME}" · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\n\\nPomade-Job: ${NAME}$`);

test.describe("git jobs", () => {
  let world: RunnerWorld;
  let repos: GitFixture;
  let agent: ChildProcess | null = null;

  /** The scheduler, on a clock that starts at `local` (Madrid), with the specs' git configuration. */
  async function startTheScheduler(local = "2026-11-18T10:00:00"): Promise<void> {
    const scheduler = world.startScheduler({ ...ZONE, ...gitEnv(world.tmp), POMADE_RUNNER_CLOCK: `${local}+01:00` });
    await world.ready(scheduler);
  }

  /** The job's runs in History, once there are `count`. */
  async function records(count: number): Promise<RunRecord[]> {
    await expect.poll(async () => (await world.history("knowledge")).length, { timeout: 30_000 }).toBe(count);
    return world.history("knowledge");
  }

  test.beforeEach(async () => {
    world = await createRunnerWorld();
    repos = await createGitFixture(world.tmp, join(world.tmp, "ws"));
    await writePomadeGit(join(world.tmp, "home"), world.userData);
    await world.writeJob("knowledge.md", JOB);
  });

  test.afterEach(async () => {
    agent?.kill("SIGKILL");
    agent = null;
    await world.dispose();
  });

  test("1 · Commit & push at 13:00: a commit with the platform's message and Pomade-Job trailer, pushed; History shows the hash", async () => {
    await writeFile(join(repos.repo, "notes.md"), "# Notes\n\nfirst line\nwritten before 13:00\n");
    await startTheScheduler("2026-11-18T12:59:57");
    const [record] = await records(1);
    expect(record).toMatchObject({ kind: "git", trigger: "scheduled", state: "done", exitCode: 0, reason: null, dueAt: Date.parse("2026-11-18T13:00:00+01:00") });
    const result = record?.git?.results[0];
    expect(result).toMatchObject({ repo: "Knowledge", status: "done", reason: null });
    const hash = result?.commit ?? "";
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(repos.git(repos.repo, "rev-parse", "HEAD")).toBe(hash);
    expect(repos.git(repos.remote, "rev-parse", "main")).toBe(hash);
    expect(repos.git(repos.repo, "log", "-1", "--format=%B")).toMatch(MESSAGE);
    expect(repos.git(repos.repo, "status", "--porcelain")).toBe("");
    const line = `Knowledge · committed ${hash.slice(0, 7)} · pulled · pushed`;
    expect(record?.lastLines).toEqual([line]);
    expect((await world.command("history", "knowledge")).stdout).toContain(`\n    ${line}\n`);
    // The command logged the run where Pomade's Git panel reads it; Runner keeps no result file.
    expect(await readFile(join(world.userData, "git", "runs.jsonl"), "utf8")).toContain(`"job":"${NAME}"`);
    expect(existsSync(join(world.userData, "app-state", "pomade-runner", "output", "knowledge", `${record?.run ?? ""}.json`))).toBe(false);
    // Done, with notify on failure: no notice.
    expect(await world.queuedNotices()).toEqual([]);
  });

  test("2 · a conflict: failed with the reason, a notice and a Needs-you item; the repo is left exactly as it was, nothing pushed", async () => {
    await writeFile(join(repos.other, "notes.md"), "# Notes\n\nfirst line, as the other machine has it\n");
    repos.git(repos.other, "commit", "--quiet", "-am", "Theirs");
    repos.git(repos.other, "push", "--quiet");
    const theirs = repos.git(repos.remote, "rev-parse", "main");
    await writeFile(join(repos.repo, "notes.md"), "# Notes\n\nfirst line, as this machine has it\n");
    const before = repos.snapshot();

    await startTheScheduler();
    expect((await world.command("run", "knowledge")).code).toBe(0);
    const [record] = await records(1);
    const reason = "Their changes conflict with yours in notes.md. Nothing was changed — the repository is exactly as before, and nothing was pushed.";
    expect(record).toMatchObject({ trigger: "manual", state: "failed", exitCode: 1, reason: `Knowledge: ${reason}` });
    expect(record?.git?.results[0]).toMatchObject({ status: "failed", reason, commit: null });
    expect(record?.lastLines).toEqual([`Knowledge · failed · ${reason}`]);
    expect(repos.snapshot()).toEqual(before);
    expect(repos.git(repos.remote, "rev-parse", "main")).toBe(theirs);
    // Their commit was fetched — the only thing that moved.
    expect(repos.git(repos.repo, "rev-parse", "origin/main")).toBe(theirs);

    await expect.poll(() => world.queuedNotices()).toMatchObject([{ source: "pomade-runner", title: `${NAME} failed`, body: `Knowledge: ${reason}`, action: { kind: "openApp", route: `run/knowledge/${record?.run ?? ""}` } }]);
    const report = await callScheduler(world.socketPath, "runs", null);
    expect(report.status === "ok" ? report.value.needsYou : null).toMatchObject([{ id: "run-failed:knowledge", kind: "run-failed", run: record?.run, detail: `Knowledge: ${reason}` }]);
  });

  test("3 · an agent working in the repo: skipped with the reason, the repo untouched", async () => {
    await writeFile(join(repos.repo, "notes.md"), "# Notes\n\nfirst line\nan agent is editing this\n");
    const before = repos.snapshot();
    agent = spawn(await writeFakeAgent(world.tmp), [], { cwd: repos.repo, env: cleanEnv(), stdio: "ignore" });
    await startTheScheduler();
    expect((await world.command("run", "knowledge")).code).toBe(0);
    const [record] = await records(1);
    expect(record).toMatchObject({ state: "done", exitCode: 0 });
    expect(record?.git?.results[0]).toMatchObject({ repo: "Knowledge", status: "skipped", reason: "agent working", commit: null });
    expect(record?.git?.results[0]?.steps[0]?.detail).toContain(`(pid ${agent.pid ?? ""})`);
    expect(record?.lastLines).toEqual(["Knowledge · skipped · agent working"]);
    expect((await world.command("history", "knowledge")).stdout).toContain("\n    Knowledge · skipped · agent working\n");
    expect(repos.snapshot()).toEqual(before);
  });

  test("a scheduler restarted while pomade-git runs records the run once, from the result pomade-git left", async () => {
    await writeFile(join(repos.repo, "notes.md"), "# Notes\n\nfirst line\nwritten across a restart\n");
    // The repo is busy with another operation: pomade-git waits for it (up to 30 s).
    const lock = join(repos.repo, ".git", "pomade-operation.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, title: "Another operation", at: Date.now() }));
    const first = world.startScheduler({ ...ZONE, ...gitEnv(world.tmp) });
    await world.ready(first);
    expect((await world.command("run", "knowledge")).code).toBe(0);
    const [going] = (await world.sessions()).sessions.filter((session) => session.kind === "run");
    expect(going?.job).toBe("knowledge");
    await world.running(going?.id ?? "");

    await first.kill();
    const second = world.startScheduler({ ...ZONE, ...gitEnv(world.tmp) });
    await world.ready(second);
    await rm(lock);
    const [record] = await records(1);
    expect(record).toMatchObject({ run: going?.run, state: "done" });
    expect(record?.git?.results[0]?.commit).toBe(repos.git(repos.remote, "rev-parse", "main"));
    expect(second.output()).toContain(`run knowledge ${going?.run ?? ""}: done — exit 0`);

    await second.kill();
    await world.ready(world.startScheduler({ ...ZONE, ...gitEnv(world.tmp) }));
    expect(await world.history("knowledge")).toHaveLength(1);
  });
});
