// Git runs, pure: the command line, a repo's result in a line, how a run's end reads with what
// `pomade-git` printed, and the `jobs.forRepo` answer — checked with the kit's own check.

process.env.TZ = "Europe/Madrid";

import { checkRepoJobs, type GitRunOutput, type GitRunResult } from "pomade-kit/protocol";
import { describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import type { GitJob } from "../jobs/model";
import { gitCommandLine, gitRepoLine, gitRunEnd, repoJobs, shellQuote, type SessionEnd } from "./git-runs";
import type { JobRuns, RunRecord } from "./model";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const result = (extra: Partial<GitRunResult> = {}): GitRunResult => ({
  repo: "Knowledge",
  path: "/ws/Knowledge",
  op: "commit-push",
  status: "done",
  reason: null,
  steps: [
    { step: "agents", outcome: "done", detail: "no agent working here" },
    { step: "commit", outcome: "done", detail: "committed a1b2c3d (2 files)" },
    { step: "pull", outcome: "done", detail: "up to date with origin/main" },
    { step: "push", outcome: "done", detail: "pushed 1 commit to origin/main" },
  ],
  commit: HASH,
  ...extra,
});

const output = (...results: GitRunResult[]): GitRunOutput => ({ op: "commit-push", job: "Knowledge twice daily", at: "2026-11-18T12:00:00.000Z", results });

const CONFLICT = "Their changes conflict with yours in notes.md. Nothing was changed — the repository is exactly as before, and nothing was pushed.";
const conflict = result({
  status: "failed",
  reason: CONFLICT,
  steps: [
    { step: "agents", outcome: "done", detail: "no agent working here" },
    { step: "commit", outcome: "done", detail: "committed a1b2c3d (1 file) — taken back, as their changes could not come in" },
    { step: "pull", outcome: "failed", detail: "conflict in notes.md" },
  ],
  commit: null,
});
const agentWorking = result({ repo: "coda-helper", path: "/ws/Projects/coda-helper", status: "skipped", reason: "agent working", steps: [{ step: "agents", outcome: "skipped", detail: "agent working: claude in /ws/Projects/coda-helper (pid 7)" }], commit: null });

const exited = (code: number): SessionEnd => ({ state: code === 0 ? "done" : "failed", reason: null, exitCode: code, signal: null, limitHit: null });

function gitJob(text: string): GitJob {
  const snapshot = checkJobs([{ path: "knowledge.md", text }], { workspace: "/ws", projects: [] });
  const entry = snapshot.jobs[0];
  if (entry?.valid !== true || entry.job.kind !== "git") throw new Error("not a valid git job");
  return entry.job;
}

describe("the command line", () => {
  it("quotes every word for the shell, and sends the JSON result to the run's file", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const job = gitJob("---\nkind: git\nname: Daniil's notes · twice\ngit: { operation: commit-push, repos: [Knowledge, \"My repo\"] }\nschedule:\n  daily: { at: 13:00 }\n---\n");
    expect(gitCommandLine("/home/bin/pomade-git", job, "/state/output/knowledge/r.json")).toBe(
      `'/home/bin/pomade-git' 'commit-push' 'Knowledge' 'My repo' '--json' '--job' 'Daniil'\\''s notes · twice' > '/state/output/knowledge/r.json'`,
    );
  });
});

describe("a repo's line", () => {
  it("says what was done, in order, with the commit's short hash", () => {
    expect(gitRepoLine(result())).toBe("Knowledge · committed a1b2c3d · pulled · pushed");
    expect(gitRepoLine(result({ op: "fetch", steps: [{ step: "fetch", outcome: "done", detail: "fetched origin" }], commit: null }))).toBe("Knowledge · fetched");
  });

  it("leaves out what was skipped, and says when there was nothing to do", () => {
    const quiet = result({
      steps: [
        { step: "agents", outcome: "done", detail: "no agent working here" },
        { step: "commit", outcome: "skipped", detail: "nothing to commit" },
        { step: "pull", outcome: "done", detail: "up to date with origin/main" },
        { step: "push", outcome: "skipped", detail: "nothing to push" },
      ],
      commit: null,
    });
    expect(gitRepoLine(quiet)).toBe("Knowledge · pulled");
    expect(gitRepoLine(result({ op: "push", steps: [{ step: "push", outcome: "skipped", detail: "nothing to push" }], commit: null }))).toBe("Knowledge · nothing to do");
  });

  it("says skipped or failed with the reason", () => {
    expect(gitRepoLine(agentWorking)).toBe("coda-helper · skipped · agent working");
    expect(gitRepoLine(conflict)).toBe(`Knowledge · failed · ${CONFLICT}`);
  });
});

describe("a git run's end", () => {
  const stderr = ["pomade-git: could not write the run log in /ud: EACCES"];

  it("exit 0 with the result is done: the result whole, a line per repo", () => {
    const printed = output(result(), agentWorking);
    expect(gitRunEnd(exited(0), printed, [])).toEqual({
      ...exited(0),
      git: printed,
      lastLines: ["Knowledge · committed a1b2c3d · pulled · pushed", "coda-helper · skipped · agent working"],
    });
  });

  it("exit 1 is failed, with each failed repo's reason", () => {
    const printed = output(conflict, result({ repo: "Pomade", path: "/ws/Projects/Pomade", status: "failed", reason: "No remote — there is nowhere to push.", steps: [], commit: null }));
    expect(gitRunEnd(exited(1), printed, stderr)).toEqual({
      ...exited(1),
      reason: `Knowledge: ${CONFLICT}; Pomade: No remote — there is nowhere to push.`,
      git: printed,
      lastLines: [`Knowledge · failed · ${CONFLICT}`, "Pomade · failed · No remote — there is nowhere to push."],
    });
    expect(gitRunEnd(exited(1), output(result()), []).reason).toBe("pomade-git failed (exit 1)");
  });

  it("exit 2 is failed: the command line was wrong, as the command said", () => {
    const usage = ["pomade-git: --job needs a name: one line, at most 100 characters.", "", "Usage: pomade-git <operation> <repo…> [options]"];
    expect(gitRunEnd(exited(2), null, usage)).toEqual({ ...exited(2), reason: "the command line was wrong — --job needs a name: one line, at most 100 characters.", git: null, lastLines: usage });
    expect(gitRunEnd(exited(2), null, []).reason).toBe("the command line was wrong");
  });

  it("no result, or one that is not pomade-git's, is failed and says so — whatever the exit", () => {
    expect(gitRunEnd(exited(0), null, [])).toEqual({ ...exited(0), state: "failed", reason: "pomade-git gave no result (exit 0)", git: null, lastLines: [] });
    expect(gitRunEnd(exited(1), null, stderr)).toMatchObject({ state: "failed", reason: "pomade-git gave no result (exit 1)", lastLines: stderr });
    expect(gitRunEnd({ state: "failed", reason: null, exitCode: null, signal: "SIGKILL", limitHit: null }, null, [])).toMatchObject({ state: "failed", reason: "pomade-git gave no result (SIGKILL)" });
  });

  it("an end of Runner's or the person's stays what it is for any run", () => {
    const limit: SessionEnd = { state: "failed", reason: "stopped: time limit, 5 min", exitCode: null, signal: "SIGTERM", limitHit: 5 };
    expect(gitRunEnd(limit, null, stderr)).toEqual({ ...limit, git: null, lastLines: stderr });
    const stopped: SessionEnd = { state: "stopped-by-you", reason: null, exitCode: null, signal: "SIGINT", limitHit: null };
    expect(gitRunEnd(stopped, null, [])).toEqual({ ...stopped, git: null, lastLines: [] });
    const lost: SessionEnd = { state: "failed", reason: "its session is gone", exitCode: null, signal: null, limitHit: null };
    expect(gitRunEnd(lost, output(result()), [])).toEqual({ ...lost, git: output(result()), lastLines: ["Knowledge · committed a1b2c3d · pulled · pushed"] });
  });
});

describe("jobs.forRepo", () => {
  const files: Record<string, string> = {
    "knowledge.md": "---\nkind: git\nname: Knowledge twice daily\ngit: { operation: commit-push, repos: [Knowledge, coda-helper] }\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\n",
    "fetch.md": "---\nkind: git\nname: Fetch all\ngit: { operation: fetch, repos: [/ws/Knowledge] }\nhook: { event: login }\n---\n",
    "off.md": "---\nkind: git\nname: Off\nenabled: false\ngit: { operation: pull, repos: [Knowledge] }\nschedule:\n  daily: { at: 9:00 }\n---\n",
    "other.md": "---\nkind: git\nname: Other\ngit: { operation: pull, repos: [Pomade] }\nschedule:\n  daily: { at: 9:00 }\n---\n",
    "backup.md": "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n",
    "coda/knowledge-pull.md": "---\nkind: git\nname: Coda pull\nproject: p1\ngit: { operation: pull, repos: [Knowledge] }\nschedule:\n  weekly: { days: [mon], at: 9:00 }\n---\n",
  };
  const snapshot = checkJobs(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    { workspace: "/ws", projects: [{ id: "p1", name: "Coda", root: "Projects/coda" }] },
  );
  const repo = { name: "Knowledge", path: "/ws/Knowledge" };
  const next = new Date("2026-11-18T20:00:00").getTime();
  const last: RunRecord = {
    job: "knowledge",
    name: "Knowledge twice daily",
    kind: "git",
    project: null,
    folder: "",
    run: "20261118-120000-abcdef",
    trigger: "scheduled",
    cause: null,
    dueAt: new Date("2026-11-18T13:00:00").getTime(),
    agent: null,
    missed: null,
    series: null,
    state: "done",
    action: null,
    reason: null,
    startedAt: new Date("2026-11-18T13:00:00").getTime(),
    endedAt: new Date("2026-11-18T13:00:04").getTime(),
    durationMs: 4000,
    exitCode: 0,
    signal: null,
    log: "/s/o.log",
    lastLines: [],
    git: output(result(), agentWorking),
    limitHit: null,
  };
  const runs: JobRuns[] = [
    { job: "knowledge", next, finished: false, last, held: false },
    { job: "fetch", next: null, finished: false, last: { ...last, job: "fetch", state: "missed", git: null }, held: false },
  ];

  it("every file is valid", () => {
    expect(snapshot.jobs.filter((entry) => !entry.valid)).toEqual([]);
  });

  it("lists the enabled git jobs naming the repo — by name or by path — in the kit's shape, by id", () => {
    const jobs = repoJobs(snapshot, runs, repo);
    expect(checkRepoJobs({ jobs })).toEqual(jobs);
    expect(jobs).toEqual([
      { id: "coda/knowledge-pull", name: "Coda pull", operation: "pull", schedule: "every Mon at 9:00", nextRun: null, lastResult: null, route: "jobs/coda.knowledge-pull" },
      { id: "fetch", name: "Fetch all", operation: "fetch", schedule: "at Mac login", nextRun: null, lastResult: { status: "skipped", at: new Date(last.endedAt).toISOString() }, route: "jobs/fetch" },
      {
        id: "knowledge",
        name: "Knowledge twice daily",
        operation: "commit-push",
        schedule: "daily at 13:00 and 20:00",
        nextRun: new Date(next).toISOString(),
        lastResult: { status: "done", at: new Date(last.endedAt).toISOString() },
        route: "jobs/knowledge",
      },
    ]);
  });

  it("the last result is the repo's own in the run when it has one", () => {
    const coda = repoJobs(snapshot, runs, { name: "coda-helper", path: "/ws/Projects/coda-helper" });
    expect(coda.map((job) => [job.id, job.lastResult?.status])).toEqual([["knowledge", "skipped"]]);
    const stopped = repoJobs(snapshot, [{ job: "knowledge", next: null, finished: false, last: { ...last, state: "stopped-by-you", git: null }, held: false }], repo);
    expect(stopped.find((job) => job.id === "knowledge")?.lastResult?.status).toBe("failed");
  });

  it("no job targets an unknown repo", () => {
    expect(repoJobs(snapshot, runs, { name: "Nope", path: "/ws/Nope" })).toEqual([]);
  });
});
