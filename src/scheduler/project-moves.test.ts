// A project moved in Pomade: which projects moved, where a job's folder goes, which job ids change,
// and the files' writes.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMove, movedFolder, planMove, projectMoves, subFolderMoves } from "./project-moves";

const ALPHA = { id: "a1", name: "Alpha", root: "Projects/alpha" };

describe("what a project move moves", () => {
  it("a project whose folder changed moves; a new name alone, a new project or one gone does not", () => {
    const before = [ALPHA, { id: "b1", name: "Beta", root: "Projects/beta" }, { id: "c1", name: "Gone", root: "Projects/gone" }];
    const after = [{ ...ALPHA, name: "Alpha 2", root: "Projects/alpha-2" }, { id: "b1", name: "Beta 2", root: "Projects/beta" }, { id: "d1", name: "New", root: "Projects/new" }];
    expect(projectMoves(before, after)).toEqual([{ previous: ALPHA, project: after[0] }]);
    expect(projectMoves([], after)).toEqual([]);
  });

  it("a folder in the project's folder follows it; one beside it, or a prefix of its name, stays", () => {
    expect(movedFolder("Projects/alpha", "Projects/alpha", "Work/alpha-2")).toBe("Work/alpha-2");
    expect(movedFolder("Projects/alpha/", "Projects/alpha", "Work/alpha-2")).toBe("Work/alpha-2");
    expect(movedFolder("Projects/alpha/web", "Projects/alpha", "Work/alpha-2")).toBe("Work/alpha-2/web");
    expect(movedFolder("Projects/alphabet", "Projects/alpha", "Work/alpha-2")).toBeNull();
    expect(movedFolder(".", "Projects/alpha", "Work/alpha-2")).toBeNull();
  });

  it("the ids of the jobs in the sub-folder change; others stay", () => {
    expect(subFolderMoves(["alpha/web", "alpha/nightly", "alphabet/x", "backup"], "alpha", "alpha-2")).toEqual(
      new Map([
        ["alpha/web", "alpha-2/web"],
        ["alpha/nightly", "alpha-2/nightly"],
      ]),
    );
  });
});

describe("a project move on disk", () => {
  let dir: string;
  let jobs: string;
  let lines: string[];
  const log = (line: string): void => void lines.push(line);
  const moved = { previous: ALPHA, project: { ...ALPHA, name: "Alpha 2", root: "Work/alpha-2" } };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    jobs = join(dir, "Apps/pomade-runner/jobs");
    lines = [];
    await mkdir(join(jobs, "alpha"), { recursive: true });
    await writeFile(join(jobs, "alpha/web.md"), "---\nkind: service\nname: Web\nproject: a1\nfolder: Projects/alpha/web # the app\ncommand: ./w.sh\n---\nNotes.\n");
    await writeFile(join(jobs, "sync.md"), "---\nkind: script\nname: Sync\nfolder: Projects/alpha\ncommand: ./s.sh\nhook: { event: login }\n---\n");
    await writeFile(join(jobs, "other.md"), "---\nkind: script\nname: Other\nfolder: Projects/alphabet\ncommand: ./o.sh\nhook: { event: login }\n---\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rewrites the folders in the project's folder field-only and renames the sub-folder", async () => {
    const plan = await planMove(dir, moved, ["alpha/web", "sync", "other"], log);
    expect(plan).toMatchObject({ from: "alpha", to: "alpha-2", ids: new Map([["alpha/web", "alpha-2/web"]]) });
    await applyMove(dir, plan, log);
    expect(await readFile(join(jobs, "alpha-2/web.md"), "utf8")).toBe("---\nkind: service\nname: Web\nproject: a1\nfolder: Work/alpha-2/web # the app\ncommand: ./w.sh\n---\nNotes.\n");
    expect(await readFile(join(jobs, "sync.md"), "utf8")).toContain("\nfolder: Work/alpha-2\n");
    expect(await readFile(join(jobs, "other.md"), "utf8")).toContain("\nfolder: Projects/alphabet\n");
    expect(lines).toEqual(["project Alpha 2 moved: jobs/alpha/web.md now runs in Work/alpha-2/web", "project Alpha 2 moved: jobs/sync.md now runs in Work/alpha-2", "project Alpha 2 moved: its jobs are in jobs/alpha-2/ now"]);
  });

  it("keeps the sub-folder when the new one is there already, and says so; the folders still follow", async () => {
    await mkdir(join(jobs, "alpha-2"));
    const plan = await planMove(dir, moved, ["alpha/web"], log);
    expect(plan.ids).toBeNull();
    expect(lines).toEqual(["project Alpha 2: its jobs stay in jobs/alpha/ — jobs/alpha-2/ is there already; move them by hand"]);
    await applyMove(dir, plan, log);
    expect(await readFile(join(jobs, "alpha/web.md"), "utf8")).toContain("\nfolder: Work/alpha-2/web # the app\n");
  });

  it("a move that keeps the folder's last segment keeps the sub-folder and the ids", async () => {
    const plan = await planMove(dir, { previous: ALPHA, project: { ...ALPHA, root: "Archive/alpha" } }, ["alpha/web"], log);
    expect(plan).toMatchObject({ from: "alpha", to: "alpha", ids: null });
  });
});
