// The environment as it is now (`environment.ts`): read from the Mac, for the scheduler to answer.

import { relative } from "node:path";

import type { SkillKeeper } from "../jobs/skill/place";
import type { EnvironmentReport } from "./environment";

/** The environment for a workspace: the skill is placed again first, so a skills folder that became
 *  writable, or a copy removed by hand, is put right when Settings asks. */
export async function readEnvironment(workspace: string, skill: SkillKeeper): Promise<EnvironmentReport> {
  await skill.place();
  const { folder, problem } = skill.report();
  // Settings names places in the workspace by their workspace-relative paths.
  return { notifications: "unavailable", skill: { folder: relative(workspace, folder), problem: problem?.replaceAll(`${workspace}/`, "") ?? null } };
}
