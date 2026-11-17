import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readJobFiles } from "./folder";
import { createJobsLoader, type JobsLoader } from "./loader";
import type { JobsSnapshot } from "./model";

const job = (name: string): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./x.sh\nhook: { event: login }\n---\n`;

describe("reading the jobs folder", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("is null for a folder that does not exist", async () => {
    expect(await readJobFiles(join(dir, "nope"))).toBeNull();
  });

  it("reads .md files at the top and in sub-folders, deeper ones too, and nothing else", async () => {
    await mkdir(join(dir, "proj/old"), { recursive: true });
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "a.md"), "A");
    await writeFile(join(dir, "proj/b.md"), "B");
    await writeFile(join(dir, "proj/old/c.md"), "C");
    await writeFile(join(dir, ".a.md.swp"), "x");
    await writeFile(join(dir, ".#a.md"), "x");
    await writeFile(join(dir, "a.md~"), "x");
    await writeFile(join(dir, "notes.txt"), "x");
    await writeFile(join(dir, ".git/x.md"), "x");
    await symlink(join(dir, "a.md"), join(dir, "linked.md"));
    expect(await readJobFiles(dir)).toEqual([
      { path: "a.md", text: "A" },
      { path: "linked.md", text: "A" },
      { path: "proj/b.md", text: "B" },
      { path: "proj/old/c.md", text: "C" },
    ]);
  });

  it("reports a file it cannot read, and skips a dangling link", async () => {
    await mkdir(join(dir, "folder.md"));
    await symlink(join(dir, "gone.md"), join(dir, "dangling.md"));
    await writeFile(join(dir, "a.md"), "A", { mode: 0o000 });
    const files = await readJobFiles(dir);
    expect(files).toEqual([{ path: "a.md", readError: expect.stringContaining("EACCES") as string }]);
  });
});

describe("the jobs loader", () => {
  let dir: string;
  let workspace: string | null;
  let jobs: string;
  let changes: JobsSnapshot[];
  let loader: JobsLoader | null;

  function start(): JobsLoader {
    loader = createJobsLoader({ workspace: () => workspace, onChange: (s) => changes.push(s), log: () => undefined });
    return loader;
  }
  const ids = (s: JobsSnapshot | undefined): string[] => (s?.jobs ?? []).map((e) => `${e.valid ? "ok" : "invalid"} ${e.valid ? e.job.id : e.invalid.id}`);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    workspace = join(dir, "ws");
    jobs = join(workspace, "Apps/pomade-runner/jobs");
    changes = [];
    loader = null;
  });
  afterEach(async () => {
    loader?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty when the folder does not exist yet, and picks it up when it appears", async () => {
    const l = start();
    await l.refresh();
    expect(l.snapshot()).toEqual({ workspace, projectsChecked: false, jobs: [] });
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "a.md"), job("A"));
    await l.refresh();
    expect(ids(l.snapshot())).toEqual(["ok a"]);
  });

  it("sees the jobs folder created, through the watch alone, within a second", async () => {
    await mkdir(workspace ?? "", { recursive: true });
    const l = start();
    await l.refresh();
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "a.md"), job("A"));
    await vi.waitFor(() => expect(ids(l.snapshot())).toEqual(["ok a"]), { timeout: 1000, interval: 10 });
  });

  it("applies an added, edited, broken and deleted file through the watch alone, within a second", async () => {
    await mkdir(jobs, { recursive: true });
    const l = start();
    await l.refresh();
    const within = { timeout: 1000, interval: 10 };
    await writeFile(join(jobs, "a.md"), job("A"));
    await vi.waitFor(() => expect(ids(l.snapshot())).toEqual(["ok a"]), within);
    await writeFile(join(jobs, "a.md"), job("Renamed"));
    await vi.waitFor(() => expect(l.snapshot().jobs[0]).toMatchObject({ job: { name: "Renamed" } }), within);
    await writeFile(join(jobs, "a.md"), "---\nkind: script\n");
    await vi.waitFor(() => expect(ids(l.snapshot())).toEqual(["invalid a"]), within);
    await rm(join(jobs, "a.md"));
    await vi.waitFor(() => expect(ids(l.snapshot())).toEqual([]), within);
  });

  it("follows an editor's save by atomic rename, and a new project sub-folder", async () => {
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "a.md"), job("A"));
    const l = start();
    await l.refresh();
    await writeFile(join(jobs, ".a.md.tmp"), job("Saved"));
    await rename(join(jobs, ".a.md.tmp"), join(jobs, "a.md"));
    await vi.waitFor(() => expect(l.snapshot().jobs[0]).toMatchObject({ job: { name: "Saved" } }), { timeout: 1000, interval: 10 });
    await mkdir(join(jobs, "proj"));
    await writeFile(join(jobs, "proj/b.md"), job("B"));
    await vi.waitFor(() => expect(ids(l.snapshot())).toEqual(["ok a", "invalid proj/b"]), { timeout: 1000, interval: 10 });
  });

  it("tells a change once, never a refresh that changed nothing", async () => {
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "a.md"), job("A"));
    const l = start();
    await l.refresh();
    await l.refresh();
    await Promise.all([l.refresh(), l.refresh()]);
    expect(changes).toHaveLength(1);
  });

  it("checks project ids once it knows the projects", async () => {
    await mkdir(join(jobs, "alpha"), { recursive: true });
    await writeFile(join(jobs, "alpha/a.md"), job("A").replace("name: A", "name: A\nproject: nope"));
    const l = start();
    await l.refresh();
    expect(l.snapshot()).toMatchObject({ projectsChecked: false, jobs: [{ valid: true }] });
    l.setProjects([{ id: "p1", name: "Alpha", root: "Projects/alpha" }]);
    await l.refresh();
    expect(l.snapshot()).toMatchObject({ projectsChecked: true, jobs: [{ valid: false }] });
  });

  it("follows a workspace switch, and having none", async () => {
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "a.md"), job("A"));
    const l = start();
    await l.refresh();
    workspace = null;
    await l.refresh();
    expect(l.snapshot()).toEqual({ workspace: null, projectsChecked: false, jobs: [] });
  });

  it("empties when the folder is deleted, and watches it again when it comes back", async () => {
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "a.md"), job("A"));
    const l = start();
    await l.refresh();
    await rm(jobs, { recursive: true });
    await l.refresh();
    expect(l.snapshot().jobs).toEqual([]);
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, "b.md"), job("B"));
    await l.refresh();
    expect(ids(l.snapshot())).toEqual(["ok b"]);
    await writeFile(join(jobs, "c.md"), job("C"));
    await vi.waitFor(() => expect(ids(l.snapshot())).toEqual(["ok b", "ok c"]), { timeout: 1000, interval: 10 });
  });
});
