// Jobs whose ids changed: a job's history takes in every id it had.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordsFolderOf } from "../locations";
import { renamedJobs } from "./renamed";

describe("renamed jobs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a job's former ids, through every move; none a job has now; kept across schedulers", async () => {
    const records = recordsFolderOf(dir);
    const renamed = renamedJobs(records, () => undefined);
    await renamed.load();
    renamed.add(new Map([["a/web", "b/web"]]));
    renamed.add(new Map([["b/web", "c/web"], ["b/x", "c/x"]]));
    expect(renamed.formerIds("c/web", new Set(["c/web"]))).toEqual(["a/web", "b/web"]);
    // A new job made where the old one was is its own job.
    expect(renamed.formerIds("c/web", new Set(["c/web", "a/web"]))).toEqual(["b/web"]);
    expect(renamed.formerIds("c/x", new Set())).toEqual(["b/x"]);
    await renamed.flush();
    const again = renamedJobs(records, () => undefined);
    await again.load();
    expect(again.formerIds("c/web", new Set())).toEqual(["a/web", "b/web"]);
    // A move back and forth ends where it began, without looping.
    again.add(new Map([["c/web", "a/web"]]));
    expect(again.formerIds("a/web", new Set())).toEqual(["b/web", "c/web"]);
    // The write `add` started ends before the folder is removed, which it would race.
    await again.flush();
  });
});
