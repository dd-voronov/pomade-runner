import type { GitRunOutput, GitRunStep } from "pomade-kit/protocol";
import { describe, expect, it } from "vitest";

import { pulledCommits, stepCommits } from "./pomade-next";

const pull = (commits?: unknown, outcome: GitRunStep["outcome"] = "done"): GitRunStep => ({ step: "pull", outcome, detail: "pulled", ...(commits === undefined ? {} : { commits }) }) as GitRunStep;

const output = (...steps: GitRunStep[][]): GitRunOutput => ({
  op: "pull",
  job: "Pull",
  at: "2026-11-25T09:00:00.000Z",
  results: steps.map((list, index) => ({ repo: `r${index}`, path: `/ws/r${index}`, op: "pull", status: "done", reason: null, steps: list, commit: null })),
});

describe("a pull's commits", () => {
  it("a done pull's non-negative integer; anything else unknown", () => {
    expect(stepCommits(pull(2))).toBe(2);
    expect(stepCommits(pull(0))).toBe(0);
    for (const bad of [undefined, -1, 1.5, "2", null, Number.NaN]) expect(stepCommits(pull(bad))).toBeNull();
    expect(stepCommits(pull(2, "failed"))).toBeNull();
    expect(stepCommits({ ...pull(2), step: "push" })).toBeNull();
  });

  it("summed over the repos' done pulls; unknown when any is, or when none pulled", () => {
    expect(pulledCommits(output([pull(2)], [pull(3)]))).toBe(5);
    expect(pulledCommits(output([pull(0)], [pull(0)]))).toBe(0);
    expect(pulledCommits(output([pull(2)], [pull()]))).toBeNull();
    // A skipped repo and a failed pull add nothing.
    expect(pulledCommits(output([pull(1)], [], [pull(undefined, "failed")]))).toBe(1);
    expect(pulledCommits(output([{ step: "fetch", outcome: "done", detail: "fetched" }]))).toBeNull();
    expect(pulledCommits(output())).toBeNull();
    expect(pulledCommits(null)).toBeNull();
  });
});
