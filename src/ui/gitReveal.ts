// Open in Git on a failed repo of a git run's card: which project's Git panel shows the repo. Pure.

import { WORKSPACE_PROJECT_ID, type GitRepoState, type ProjectRef } from "pomade-kit/protocol";

/** Whether a project's folder holds a repo whose root is `root` (both workspace-relative). */
function holds(project: ProjectRef, root: string): boolean {
  return project.root === "" || root === project.root || root.startsWith(`${project.root}/`);
}

/** The repo's root, workspace-relative, from Pomade's repos by its absolute path (`GitRunResult.path`);
 *  `null` when Pomade has no repo there. */
export function repoRoot(path: string, repos: readonly GitRepoState[]): string | null {
  const clean = path.replace(/\/+$/, "");
  return repos.find((repo) => repo.absPath.replace(/\/+$/, "") === clean)?.root ?? null;
}

/** The project to reveal a repo in: the job's own (`jobProject`) when its folder holds the repo; else
 *  the first project, by id, whose folder holds it; else the Workspace project — also for a repo whose
 *  root is unknown (`null`). */
export function revealProject(root: string | null, jobProject: string | null, projects: readonly ProjectRef[]): string {
  if (root === null) return WORKSPACE_PROJECT_ID;
  const own = projects.find((project) => project.id === jobProject);
  if (own !== undefined && holds(own, root)) return own.id;
  const first = [...projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).find((project) => holds(project, root));
  return first?.id ?? WORKSPACE_PROJECT_ID;
}
