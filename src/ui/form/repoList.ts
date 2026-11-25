// The Git form's repository list, as pure math: the workspace's repos grouped by their top folder —
// the repos directly under the workspace root first, under "Top level" — each group's repos by name;
// the filter; and the order a job's repos are written in, which is the list's: `pomade-git` goes
// through the repos one at a time in the order the job file names them.

import type { GitRepoState } from "pomade-kit/protocol";

/** A repo as the list shows it: its name (what the job file names) and its workspace-relative
 *  root (`""` = the workspace root). */
export type RepoRef = Pick<GitRepoState, "name" | "root">;

/** A group of the list: the repos under one top folder; `top` `""` = directly under the workspace root. */
export interface RepoGroup {
  top: string;
  repos: RepoRef[];
}

/** The head of the group of repos directly under the workspace root. */
export const TOP_LEVEL = "Top level";

/** The filter shows from this many repos up. */
export const FILTER_FROM = 10;

/** Text order: by letters, case aside ("AI Lab", "ai-book-club", "blog"); exact text breaks a tie, so
 *  the order is total. */
function byText(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The repo's top folder: the first part of its root; `""` for a repo directly under the workspace
 *  root (`Knowledge`) or the workspace root itself. */
export function topFolder(root: string): string {
  const slash = root.indexOf("/");
  return slash < 0 ? "" : root.slice(0, slash);
}

/** The repo's path as the list shows it. */
export function repoPath(repo: RepoRef): string {
  return repo.root === "" ? "workspace root" : repo.root;
}

/** The repos in groups: Top level first, then the top folders by name; in each, the repos by name
 *  (then by root). */
export function repoGroups(repos: readonly RepoRef[]): RepoGroup[] {
  const groups = new Map<string, RepoRef[]>();
  for (const repo of repos) {
    const top = topFolder(repo.root);
    const group = groups.get(top);
    if (group === undefined) groups.set(top, [repo]);
    else group.push(repo);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === "" ? -1 : b === "" ? 1 : byText(a, b)))
    .map(([top, members]) => ({ top, repos: [...members].sort((a, b) => byText(a.name, b.name) || byText(a.root, b.root)) }));
}

/** The repos whose name or path holds `query`, case aside; all of them for an empty one. */
export function filterRepos(repos: readonly RepoRef[], query: string): RepoRef[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...repos];
  return repos.filter((repo) => repo.name.toLowerCase().includes(q) || repoPath(repo).toLowerCase().includes(q));
}

/** `picked` in the order the list shows them — the order they run in; the names the workspace lacks
 *  after them, as they were. Each name once. */
export function inListOrder(picked: Iterable<string>, repos: readonly RepoRef[]): string[] {
  const wanted = new Set(picked);
  const listed = repoGroups(repos).flatMap((group) => group.repos.map((repo) => repo.name));
  const known = new Set(listed);
  const inList = listed.filter((name, i) => wanted.has(name) && listed.indexOf(name) === i);
  return [...inList, ...[...wanted].filter((name) => !known.has(name))];
}
