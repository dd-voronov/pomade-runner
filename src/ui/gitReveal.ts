// Open in Git on a failed repo of a git run's card: which project's Git panel shows the repo, and
// whether this Pomade serves `git.reveal` at all.
//
// The SDK says nothing of which methods a host serves, so `git.reveal` is feature-detected: once per
// UI session — on the first card that could offer it — a probe call with an empty `path`, which a
// Pomade that serves the call refuses as `invalid-params` (or `not-found`) before it does anything,
// and an older one as `unknown-method`. Nothing moves in Pomade either way. The verdict is kept for
// the session; an answer that says neither (not ready, no answer in time) is not kept, so the next
// card asks again.

import { useEffect, useState } from "react";
import { WORKSPACE_PROJECT_ID, type ErrorCode, type GitRepoState, type ProjectRef } from "pomade-kit/protocol";
import { HostError, type HostClient } from "pomade-kit/sdk";

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

/** What a probe's answer says of the call: Pomade has it, has not, or cannot tell yet. */
export function revealVerdict(answer: { ok: true } | { ok: false; code: ErrorCode | null }): boolean | null {
  if (answer.ok) return true;
  if (answer.code === "invalid-params" || answer.code === "not-found") return true;
  if (answer.code === "unknown-method" || answer.code === "capability-denied") return false;
  return null;
}

const probes = new WeakMap<HostClient, Promise<boolean | null>>();

function probe(host: HostClient): Promise<boolean | null> {
  const known = probes.get(host);
  if (known !== undefined) return known;
  const asked = host.git.reveal("").then(
    () => revealVerdict({ ok: true }),
    (err: unknown) => revealVerdict({ ok: false, code: err instanceof HostError ? err.code : null }),
  );
  probes.set(host, asked);
  void asked.then((verdict) => {
    if (verdict === null) probes.delete(host);
  });
  return asked;
}

/** Whether this Pomade serves `git.reveal`: false until the probe says it does. `ask` false sends no
 *  probe (a card with no failed repo). */
export function useGitRevealServed(host: HostClient, ask: boolean): boolean {
  const [served, setServed] = useState(false);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void probe(host).then((verdict) => {
      if (live) setServed(verdict === true);
    });
    return () => {
      live = false;
    };
  }, [host, ask]);
  return served;
}
