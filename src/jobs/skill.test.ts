// The agent skill's examples are real job files: they are checked here by the validator, so the
// skill cannot drift from the format.

import { readFileSync } from "node:fs";

import { readFrontmatter } from "pomade-kit/protocol";
import { describe, expect, it } from "vitest";

import manifest from "../../app/manifest.json" with { type: "json" };
import { checkJobs } from "./check";
import { formatJobError } from "./format";
import { JOB_KINDS, JOBS_FOLDER } from "./model";

const SKILL_FOLDER = manifest.skills[0] ?? "";
const SKILL = readFileSync(new URL(`../../app/${SKILL_FOLDER}/SKILL.md`, import.meta.url), "utf8");

/** Every `File: \`<path>\`` line followed by a ```markdown block. */
function examples(): Array<{ path: string; text: string }> {
  return [...SKILL.matchAll(/^File: `([^`]+)`\n\n```markdown\n([\s\S]*?)```$/gm)].map((m) => ({ path: m[1] ?? "", text: m[2] ?? "" }));
}

describe("the pomade-runner-jobs skill", () => {
  it("is the skill the manifest ships, named after its folder, with a description", () => {
    expect(SKILL_FOLDER).toBe("skills/pomade-runner-jobs");
    const read = readFrontmatter(SKILL);
    expect("frontmatter" in read ? read.frontmatter : read).toMatchObject({ name: "pomade-runner-jobs", description: expect.stringContaining("pomade-runner check") as string });
    const description = "frontmatter" in read ? String(read.frontmatter?.description) : "";
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("has one example per kind, and every example is a valid job file where it says it lives", () => {
    const files = examples();
    expect(files.length).toBeGreaterThanOrEqual(JOB_KINDS.length);
    for (const { path } of files) expect(path.startsWith(`${JOBS_FOLDER}/`)).toBe(true);
    const snapshot = checkJobs(
      files.map(({ path, text }) => ({ path: path.slice(JOBS_FOLDER.length + 1), text })),
      { workspace: null, projects: [{ id: "V1StGXR8_Z5jdHi6B-myT", name: "Coda Helper", root: "Projects/coda-helper" }] },
    );
    const problems = snapshot.jobs.flatMap((entry) => (entry.valid ? [] : entry.invalid.errors.map((e) => formatJobError(e))));
    expect(problems).toEqual([]);
    const kinds = new Set(snapshot.jobs.map((entry) => (entry.valid ? entry.job.kind : null)));
    expect([...kinds].sort()).toEqual([...JOB_KINDS].sort());
    const triggers = new Set(snapshot.jobs.flatMap((entry) => (entry.valid && entry.job.kind !== "service" ? [entry.job.trigger.kind] : [])));
    expect([...triggers].sort()).toEqual(["chain", "hook", "manual", "schedule"]);
  });

  it("tells the agent to run pomade-runner check", () => {
    expect(SKILL).toContain("pomade-runner check");
  });
});
