import { describe, expect, it } from "vitest";

import { filterRepos, inListOrder, repoGroups, repoPath, topFolder, type RepoRef } from "./repoList";

/** A workspace as Pomade's Git panel lists its repos: by path. */
const REPOS: RepoRef[] = [
  { name: "my-workspace", root: "" },
  { name: "Knowledge", root: "Knowledge" },
  { name: "notes", root: "notes" },
  { name: "AI Lab", root: "Projects/AI Lab" },
  { name: "blog", root: "Projects/blog" },
  { name: "ai-book-club", root: "Projects/Book-Club/ai-book-club" },
  { name: "Pomade", root: "Projects/Pomade" },
  { name: "pomade-kit", root: "Projects/pomade-kit" },
  { name: "mcp-gateway", root: "Services/mcp-gateway" },
  { name: "archive", root: "attic/archive" },
];

const view = (repos: readonly RepoRef[]): [string, string[]][] => repoGroups(repos).map((group) => [group.top, group.repos.map((repo) => repo.name)]);

describe("the repository list", () => {
  it("a repo's top folder is its root's first part; one directly under the workspace root, or the root itself, has none", () => {
    expect(topFolder("")).toBe("");
    expect(topFolder("Knowledge")).toBe("");
    expect(topFolder("Projects/blog")).toBe("Projects");
    expect(topFolder("Projects/Book-Club/cv")).toBe("Projects");
  });

  it("the workspace root's repo reads 'workspace root'; the others, their root", () => {
    expect(repoPath({ name: "my-workspace", root: "" })).toBe("workspace root");
    expect(repoPath({ name: "cv", root: "Projects/Book-Club/cv" })).toBe("Projects/Book-Club/cv");
  });

  it("groups: Top level first, then the top folders by name, case aside; in each, the repos by name, case aside", () => {
    expect(view(REPOS)).toEqual([
      ["", ["Knowledge", "my-workspace", "notes"]],
      ["attic", ["archive"]],
      ["Projects", ["AI Lab", "ai-book-club", "blog", "Pomade", "pomade-kit"]],
      ["Services", ["mcp-gateway"]],
    ]);
  });

  it("no Top level group when every repo sits in a folder; no group at all for no repos", () => {
    expect(view(REPOS.filter((repo) => repo.root.includes("/")))[0]?.[0]).toBe("attic");
    expect(view([])).toEqual([]);
  });

  it("two repos of one name keep a stated order: by root", () => {
    expect(repoGroups([{ name: "docs", root: "Projects/b/docs" }, { name: "docs", root: "Projects/a/docs" }])[0]?.repos.map((repo) => repo.root)).toEqual(["Projects/a/docs", "Projects/b/docs"]);
  });

  it("the filter matches the name or the path, case aside; blank shows all", () => {
    expect(filterRepos(REPOS, "POMADE").map((repo) => repo.name)).toEqual(["Pomade", "pomade-kit"]);
    expect(filterRepos(REPOS, "book-club").map((repo) => repo.name)).toEqual(["ai-book-club"]);
    expect(filterRepos(REPOS, "workspace root").map((repo) => repo.name)).toEqual(["my-workspace"]);
    expect(filterRepos(REPOS, "  ")).toHaveLength(REPOS.length);
    expect(filterRepos(REPOS, "nothing-like-it")).toEqual([]);
  });

  it("picked repos are written in the list's order, not the order they were picked; names the workspace lacks follow, as they were", () => {
    expect(inListOrder(["pomade-kit", "notes", "old-site", "Knowledge", "gone", "AI Lab"], REPOS)).toEqual(["Knowledge", "notes", "AI Lab", "pomade-kit", "old-site", "gone"]);
    expect(inListOrder(new Set(["blog", "blog"]), REPOS)).toEqual(["blog"]);
    expect(inListOrder([], REPOS)).toEqual([]);
    expect(inListOrder(["notes"], [])).toEqual(["notes"]);
  });
});
