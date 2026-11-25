// Git runs (docs/DESIGN.md "Git runs"): what Runner runs for a git job, how it reads the result and
// what it answers Pomade's repo rows (`jobs.forRepo`). Pure: the scheduler does the I/O.
//
// - **The command line.** `pomade-git <operation> <repo…> --json --job "<job name>"`, run by the
//   login shell in a keeper session like a script, with its standard output sent to a file
//   (`> <run id>.json`): the JSON never passes through the terminal, so nothing the terminal does —
//   a profile's greeting, escape sequences, line wrapping, CRLF — can garble it. What the command
//   writes to its standard error stays the run's output log.
// - **The end.** Exit 0 is `done`: every repo done or skipped. Exit 1 is `failed`: a repo failed, its
//   reason in the record's. Exit 2 is `failed`: the command line was wrong, and nothing ran. A result
//   file that is missing or not a `GitRunOutput` makes the run `failed` with that said. Every other
//   end — Stop, a time limit, a lost session — is a script's.
// - **The record** keeps the `GitRunOutput` whole (`git`), and its last lines are one line per repo:
//   "notes · committed a1b2c3d · pulled · pushed", "notes · skipped · agent working".

import type { GitRunOutput, GitRunResult, GitRunStatus, GitRunStepName, RepoJob, RepoJobsParams } from "pomade-kit/protocol";

import { stepCommits } from "../integrations/pomade-next";
import { jobsRoute } from "../integrations/runner-api";
import type { GitJob, JobsSnapshot } from "../jobs/model";
import { jobTriggerWords } from "../jobs/words";
import type { JobRuns, RunRecord, RunResult } from "./model";

/** `pomade-git`'s exit codes. */
export const GIT_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** A word quoted for a POSIX shell. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The shell command a git job's run is: `pomade-git` with the job's operation, repos and name, its
 *  standard output — the `--json` result — into `resultFile`. */
export function gitCommandLine(pomadeGit: string, job: GitJob, resultFile: string): string {
  const words = [pomadeGit, job.git.operation, ...job.git.repos, "--json", "--job", job.name];
  return `${words.map(shellQuote).join(" ")} > ${shellQuote(resultFile)}`;
}

const STEP_DONE: Record<Exclude<GitRunStepName, "agents" | "commit">, string> = { pull: "pulled", push: "pushed", fetch: "fetched" };

/** One repo's result in a line: "notes · committed a1b2c3d · pulled · 2 commits · pushed", "notes ·
 *  skipped · agent working", "notes · failed · <the reason>". A pull says what it got ("pulled · 2 commits",
 *  "pulled · up to date") when its step carries `commits`, else plain "pulled". */
export function gitRepoLine(result: GitRunResult): string {
  if (result.status !== "done") return [result.repo, result.status, result.reason].filter((part) => part !== null && part !== "").join(" · ");
  const done = result.steps.flatMap((step): string[] => {
    if (step.outcome !== "done" || step.step === "agents") return [];
    if (step.step === "commit") return [result.commit === null ? "committed" : `committed ${result.commit.slice(0, 7)}`];
    if (step.step === "pull") {
      const commits = stepCommits(step);
      if (commits === null) return [STEP_DONE.pull];
      return [STEP_DONE.pull, commits === 0 ? "up to date" : `${commits} ${commits === 1 ? "commit" : "commits"}`];
    }
    return [STEP_DONE[step.step]];
  });
  return [result.repo, ...(done.length === 0 ? ["nothing to do"] : done)].join(" · ");
}

/** The failed repos and their reasons: "notes: Their changes conflict with yours in notes.md. …". */
function failedWords(output: GitRunOutput): string | null {
  const failed = output.results.filter((result) => result.status === "failed");
  return failed.length === 0 ? null : failed.map((result) => `${result.repo}: ${result.reason ?? "failed"}`).join("; ");
}

/** How a git run's session ended, as a script's would read: the keeper's end in record terms. */
export type SessionEnd = Pick<RunRecord, "state" | "reason" | "exitCode" | "signal" | "limitHit">;

/** A git run's end: its session's end read with what `pomade-git` printed (`output`, `null` when the
 *  result file is missing or not a `GitRunOutput`) and the last lines of its output log (`lines`,
 *  its standard error). */
export function gitRunEnd(end: SessionEnd, output: GitRunOutput | null, lines: readonly string[]): SessionEnd & Pick<RunRecord, "git" | "lastLines"> {
  const lastLines = output === null ? [...lines] : output.results.map(gitRepoLine);
  const failed = (reason: string): SessionEnd & Pick<RunRecord, "git" | "lastLines"> => ({ ...end, state: "failed", reason, git: output, lastLines });
  const exited = end.state === "done" || (end.state === "failed" && end.reason === null);
  if (!exited) return { ...end, git: output, lastLines };
  if (end.exitCode === GIT_EXIT.usage) {
    const said = lines.find((line) => line.startsWith("pomade-git: "))?.slice("pomade-git: ".length);
    return failed(said === undefined ? "the command line was wrong" : `the command line was wrong — ${said}`);
  }
  if (output === null) {
    const how = end.exitCode !== null ? `exit ${end.exitCode}` : (end.signal ?? "no exit code");
    return failed(`pomade-git gave no result (${how})`);
  }
  if (end.exitCode === GIT_EXIT.ok) return { ...end, git: output, lastLines };
  return failed(failedWords(output) ?? `pomade-git failed (exit ${end.exitCode ?? end.signal ?? "?"})`);
}

/** A run's result as a repo row shows it: the repo's own result in the run when it has one, else
 *  the run's — a missed run is skipped, a run stopped by you failed. */
function repoStatus(record: RunRecord, repo: RepoJobsParams["repo"]): GitRunStatus {
  const own = record.git?.results.find((result) => result.repo === repo.name || (result.path !== "" && result.path === repo.path));
  if (own !== undefined) return own.status;
  const byState: Record<RunResult, GitRunStatus> = { done: "done", failed: "failed", skipped: "skipped", missed: "skipped", "stopped-by-you": "failed" };
  return byState[record.state];
}

/** Whether a job's repo entry names `repo`: by the name `pomade-git` accepts, or by its absolute path. */
function names(entry: string, repo: RepoJobsParams["repo"]): boolean {
  return entry === repo.name || (entry.startsWith("/") && entry.replace(/\/+$/, "") === repo.path);
}

/** `jobs.forRepo`: the valid, enabled git jobs whose repos include `repo`, by id — when each runs in
 *  words, its next run and its latest result for the repo, and the route of Runner's tab that opens it. */
export function repoJobs(snapshot: JobsSnapshot, runs: readonly JobRuns[], repo: RepoJobsParams["repo"]): RepoJob[] {
  const byJob = new Map(runs.map((info) => [info.job, info]));
  return snapshot.jobs
    .flatMap((entry) => (entry.valid && entry.job.kind === "git" && entry.job.enabled && entry.job.git.repos.some((candidate) => names(candidate, repo)) ? [entry.job] : []))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((job): RepoJob => {
      const info = byJob.get(job.id);
      const last = info?.last ?? null;
      return {
        id: job.id,
        name: job.name,
        operation: job.git.operation,
        schedule: jobTriggerWords(job),
        nextRun: info?.next == null ? null : new Date(info.next).toISOString(),
        lastResult: last === null ? null : { status: repoStatus(last, repo), at: new Date(last.endedAt).toISOString() },
        route: jobsRoute(job.id),
      };
    });
}
