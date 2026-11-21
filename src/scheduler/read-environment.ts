// The environment as it is now (`environment.ts`): read from the Mac, for the scheduler to answer.

import { homedir } from "node:os";

import { skillLinks } from "../jobs/skill/link";
import type { EnvironmentReport } from "./environment";

/** The environment for a workspace (`null`: none known) and a home folder. */
export async function readEnvironment(workspace: string | null, home: string = homedir()): Promise<EnvironmentReport> {
  return { notifications: "unavailable", skill: await skillLinks(home, workspace) };
}
