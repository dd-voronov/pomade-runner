import { WORKSPACE_PROJECT_ID, type GitRepoState, type ProjectRef } from "pomade-kit/protocol";
import { describe, expect, it } from "vitest";

import { repoRoot, revealProject, revealVerdict } from "./gitReveal";

const project = (id: string, root: string): ProjectRef => ({ id, kind: "project", name: id, root });
const repo = (root: string, absPath: string): GitRepoState => ({ name: root, root, absPath, remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0, hasCommits: true, changes: [] });

describe("Open in Git's project", () => {
  // `zeta` and `alpha` both hold Projects/blog; `notes` holds notes.
  const projects = [project("zeta", "Projects"), project("notes", "notes"), project("alpha", "Projects/blog"), project("other", "Projects/blogger")];

  it("the job's own project when its folder holds the repo", () => {
    expect(revealProject("Projects/blog", "zeta", projects)).toBe("zeta");
    expect(revealProject("Projects/blog/sub", "alpha", projects)).toBe("alpha");
  });

  it("else the first project, by id, whose folder holds it — a name prefix is not a folder", () => {
    expect(revealProject("Projects/blog", "notes", projects)).toBe("alpha");
    expect(revealProject("Projects/blog", null, projects)).toBe("alpha");
    expect(revealProject("Projects/blog", "gone", projects)).toBe("alpha");
    expect(revealProject("Projects/blogger", null, projects)).toBe("other");
  });

  it("else the Workspace — a repo no project holds, the workspace-root repo, one Pomade does not have", () => {
    expect(revealProject("Journal", "notes", projects)).toBe(WORKSPACE_PROJECT_ID);
    expect(revealProject("", null, projects)).toBe(WORKSPACE_PROJECT_ID);
    expect(revealProject(null, "alpha", projects)).toBe(WORKSPACE_PROJECT_ID);
  });

  it("the repo's root from Pomade's repos by its absolute path", () => {
    const repos = [repo("", "/ws"), repo("Projects/blog", "/ws/Projects/blog")];
    expect(repoRoot("/ws/Projects/blog", repos)).toBe("Projects/blog");
    expect(repoRoot("/ws/Projects/blog/", repos)).toBe("Projects/blog");
    expect(repoRoot("/ws", repos)).toBe("");
    expect(repoRoot("/ws/Projects/shop", repos)).toBeNull();
  });
});

describe("whether Pomade serves git.reveal", () => {
  it("the probe's answer: refused params or a missing repo mean the call is there; unknown-method or no capability, not; anything else, not known yet", () => {
    expect(revealVerdict({ ok: false, code: "invalid-params" })).toBe(true);
    expect(revealVerdict({ ok: false, code: "not-found" })).toBe(true);
    expect(revealVerdict({ ok: true })).toBe(true);
    expect(revealVerdict({ ok: false, code: "unknown-method" })).toBe(false);
    expect(revealVerdict({ ok: false, code: "capability-denied" })).toBe(false);
    expect(revealVerdict({ ok: false, code: "not-ready" })).toBeNull();
    expect(revealVerdict({ ok: false, code: "app-not-responding" })).toBeNull();
    expect(revealVerdict({ ok: false, code: null })).toBeNull();
  });
});
