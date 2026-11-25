// The parts of Pomade's interface that Runner uses ahead of its `pomade-kit` pin: declared here, in
// one place, until the pin reaches the kit release that brings them (`pomade-kit` v0.18.0); then
// each goes and its users import the kit's.
//
// - **`git.reveal`** (`pomade:T-320`) — the Host API call that takes the person to a repo in
//   Pomade's Git panel. Mirrors the kit's `git.reveal` entry of the method map and the SDK's
//   `host.git.reveal`. A Pomade without it answers `unknown-method`.
// - **`GitRunStep.commits`** (`pomade:T-321`) — the commits a done `pull` step got (0 = up to
//   date). Mirrors the kit's optional `GitRunStep.commits`. Absent means unknown, never 0: a failed
//   pull, another step and every Pomade before it print none. The kit's `isGitRunOutput` passes the
//   field through, so a record holds it as `pomade-git` printed it.

import type { GitRunOutput, GitRunStep } from "pomade-kit/protocol";

/** The Host API method that reveals a repo in Pomade's Git panel. */
export const GIT_REVEAL_METHOD = "git.reveal";

/** `git.reveal`'s params (the kit's `GitRevealParams`): the repo's working-tree root, absolute — a
 *  `GitRunResult.path` — and the project whose Git panel shows it (default the active project; an
 *  unknown id is `not-found`). The result is `{}`. */
export interface GitRevealParams {
  path: string;
  projectId?: string;
}

/** The commits a step got, as `pomade-git` printed them: a done pull's non-negative integer; `null`
 *  for unknown — no such field, a value that is not one, or any other step. */
export function stepCommits(step: GitRunStep): number | null {
  if (step.step !== "pull" || step.outcome !== "done") return null;
  const value = (step as GitRunStep & { commits?: unknown }).commits;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The commits a git run pulled, summed over its repos' done pulls; `null` when it made no done pull,
 *  or when any done pull's count is unknown. */
export function pulledCommits(output: GitRunOutput | null): number | null {
  const pulls = (output?.results ?? []).flatMap((result) => result.steps.filter((step) => step.step === "pull" && step.outcome === "done"));
  if (pulls.length === 0) return null;
  let sum = 0;
  for (const step of pulls) {
    const commits = stepCommits(step);
    if (commits === null) return null;
    sum += commits;
  }
  return sum;
}
