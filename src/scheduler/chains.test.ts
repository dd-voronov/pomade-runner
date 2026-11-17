// Chain matching: which finished runs are parents, and which jobs follow each — every result, every
// kind, disabled and invalid followers, fan-out order.

import { describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import type { JobsSnapshot } from "../jobs/model";
import { chainCause, followers, parentResult } from "./chains";
import { RUN_RESULTS, type RunRecord } from "./model";

const record = (state: RunRecord["state"], extra: Partial<RunRecord> = {}): RunRecord => ({
  job: "pull",
  name: "Pull",
  kind: "script",
  project: null,
  folder: "",
  run: "20261118-120000-abcdef",
  trigger: "manual",
  cause: null,
  dueAt: 1,
  state,
  action: null,
  reason: null,
  startedAt: 1,
  endedAt: 2,
  durationMs: 1,
  exitCode: 0,
  signal: null,
  log: null,
  lastLines: [],
  git: null,
  ...extra,
});

const script = (name: string, extra: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./x.sh\n${extra}---\n`;
const service = (name: string, extra: string): string => `---\nkind: service\nname: ${name}\nfolder: .\ncommand: ./web.sh\n${extra}---\n`;

function jobs(files: Record<string, string>): JobsSnapshot {
  const snapshot = checkJobs(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    { workspace: "/ws", projects: null },
  );
  const invalid = snapshot.jobs.filter((entry) => !entry.valid && !entry.invalid.path.endsWith("bad.md"));
  expect(invalid).toEqual([]);
  return snapshot;
}

describe("chains", () => {
  it("a run that ended done or failed is a parent; stopped by you, skipped and missed are none", () => {
    const parents = Object.fromEntries(RUN_RESULTS.map((state) => [state, parentResult(record(state))]));
    expect(parents).toEqual({ done: "done", failed: "failed", skipped: null, missed: null, "stopped-by-you": null });
    expect(parentResult(record("failed", { reason: "stopped: ran over 1 min", exitCode: null, signal: "SIGTERM" }))).toBe("failed");
    expect(parentResult(record("failed", { reason: "cannot start — no such folder", startedAt: null }))).toBe("failed");
  });

  it("a chain's action on a service is no parent", () => {
    expect(parentResult(record("done", { kind: "service", action: "restart", trigger: "chain" }))).toBeNull();
    expect(parentResult(record("failed", { kind: "service", action: "start", trigger: "chain" }))).toBeNull();
  });

  it("links the parent: its job, name, run and result", () => {
    expect(chainCause(record("failed"), "failed")).toEqual({ kind: "chain", job: "pull", name: "Pull", run: "20261118-120000-abcdef", result: "failed" });
  });

  it("each follower fires on its result: done, failed, or any", () => {
    const snapshot = jobs({
      "pull.md": script("Pull", "hook: { event: project-created }\n"),
      "on-done.md": script("On done", "after: { job: pull }\n"),
      "on-done-said.md": script("On done said", "after: { job: pull, result: done }\n"),
      "on-fail.md": script("On fail", "after: { job: pull, result: failed }\n"),
      "on-any.md": script("On any", "after: { job: pull, result: any }\n"),
      "other.md": script("Other", "after: { job: on-any }\n"),
    });
    const ids = (state: RunRecord["state"]): string[] => followers(snapshot, record(state)).map((job) => job.id);
    expect(ids("done")).toEqual(["on-any", "on-done", "on-done-said"]);
    expect(ids("failed")).toEqual(["on-any", "on-fail"]);
    for (const state of ["skipped", "missed", "stopped-by-you"] as const) expect(ids(state)).toEqual([]);
    expect(followers(snapshot, record("done", { job: "on-any" })).map((job) => job.id)).toEqual(["other"]);
    expect(followers(snapshot, record("done", { job: "nobody-follows" }))).toEqual([]);
  });

  it("services follow with their action, git jobs run; disabled and invalid followers and agent jobs do not fire", () => {
    const snapshot = jobs({
      "pull.md": script("Pull", "hook: { event: project-created }\n"),
      "web.md": service("Web", "after: { job: pull }\n"),
      "api.md": service("Api", "after: { job: pull, result: any, action: stop }\n"),
      "off.md": script("Off", "after: { job: pull }\nenabled: false\n"),
      "off-web.md": service("Off web", "after: { job: pull }\nenabled: false\n"),
      "bad.md": script("Bad", "after: { job: pull }\noverlap: sometimes\n"),
      "summary.md": "---\nkind: agent\nname: Summary\nfolder: .\nagent: claude\nafter: { job: pull }\n---\nSummarize.\n",
      "push.md": "---\nkind: git\nname: Push\ngit: { operation: push, repos: [x] }\nafter: { job: pull }\n---\n",
      "plain.md": service("Plain", ""),
    });
    const fired = followers(snapshot, record("done"));
    expect(fired.map((job) => [job.id, job.kind === "service" ? job.after?.action : job.kind])).toEqual([
      ["api", "stop"],
      ["push", "git"],
      ["web", "restart"],
    ]);
    expect(followers(snapshot, record("failed")).map((job) => job.id)).toEqual(["api"]);
  });

  it("names project jobs by their id, sub-folder included", () => {
    const snapshot = checkJobs(
      [
        { path: "coda/git-pull.md", text: "---\nkind: script\nname: Pull\nproject: p1\nfolder: .\ncommand: ./x.sh\nhook: { event: project-created }\n---\n" },
        { path: "coda/web.md", text: "---\nkind: service\nname: Web\nproject: p1\nfolder: .\ncommand: ./web.sh\nafter: { job: coda/git-pull }\n---\n" },
      ],
      { workspace: "/ws", projects: [{ id: "p1", name: "Coda", root: "Projects/coda" }] },
    );
    expect(followers(snapshot, record("done", { job: "coda/git-pull" })).map((job) => job.id)).toEqual(["coda/web"]);
  });
});
