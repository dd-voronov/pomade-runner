import { describe, expect, it } from "vitest";

import { readEnvironment } from "./read-environment";

describe("reading the environment", () => {
  it("places the skill first and names its folder and problem workspace-relative", async () => {
    let placed = 0;
    const skill = {
      place: () => {
        placed += 1;
        return Promise.resolve();
      },
      report: () => ({
        folder: "/ws/Skills/pomade-runner-jobs",
        problem: "cannot write /ws/Skills/pomade-runner-jobs/SKILL.md: EACCES: permission denied, mkdir '/ws/Skills/pomade-runner-jobs'",
      }),
    };
    expect(await readEnvironment("/ws", skill)).toEqual({
      notifications: "unavailable",
      skill: { folder: "Skills/pomade-runner-jobs", problem: "cannot write Skills/pomade-runner-jobs/SKILL.md: EACCES: permission denied, mkdir 'Skills/pomade-runner-jobs'" },
    });
    expect(placed).toBe(1);
    expect(await readEnvironment("/ws", { ...skill, report: () => ({ folder: "/ws/Knowledge/_skills/apps/pomade-runner-jobs", problem: null }) })).toMatchObject({
      skill: { folder: "Knowledge/_skills/apps/pomade-runner-jobs", problem: null },
    });
  });
});
