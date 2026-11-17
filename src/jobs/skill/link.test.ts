import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import manifest from "../../../app/manifest.json" with { type: "json" };
import { APP_ID, linkSkill, placesFor, SKILL_NAME, skillFolders, unlinkSkill, type SkillPlaces } from "./link";

describe("linking the skill", () => {
  let dir: string;
  let places: SkillPlaces;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-"));
    const ws = join(dir, "ws");
    places = { skill: join(dir, "ud/apps/pomade-runner/skills/pomade-runner-jobs"), home: join(dir, "home"), workspace: ws, state: join(dir, "ud/app-state/pomade-runner"), today: "2026-11-17" };
    await mkdir(places.skill, { recursive: true });
    await writeFile(join(places.skill, "SKILL.md"), "---\nname: pomade-runner-jobs\n---\n");
    for (const agent of ["claude-coder", "claude-libra", "_shared", "notes"]) await mkdir(join(ws, "Agents", agent), { recursive: true });
    await writeFile(join(ws, "Agents/claude-coder/CLAUDE.md"), "");
    await writeFile(join(ws, "Agents/claude-libra/CLAUDE.md"), "");
    await writeFile(join(ws, "Agents/_shared/CLAUDE.md"), "");
    await mkdir(join(ws, "Agents/claude-coder/skills"));
    await mkdir(join(ws, "Knowledge/00-Inbox"), { recursive: true });
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("names the manifest's skill and app", () => {
    expect(manifest.skills).toEqual([`skills/${SKILL_NAME}`]);
    expect(APP_ID).toBe(manifest.id);
  });

  it("finds ~/.claude/skills and each agent folder with a CLAUDE.md", async () => {
    expect(await skillFolders(places.home, places.workspace)).toEqual([
      join(dir, "home/.claude/skills"),
      join(dir, "ws/Agents/claude-coder/skills"),
      join(dir, "ws/Agents/claude-libra/skills"),
    ]);
    expect(await skillFolders(places.home, null)).toEqual([join(dir, "home/.claude/skills")]);
    expect(await skillFolders(places.home, join(dir, "nowhere"))).toHaveLength(1);
  });

  it("links everywhere, creating missing skills folders, and drops the note once", async () => {
    const report = await linkSkill(places);
    const note = join(dir, "ws/Knowledge/00-Inbox/2026-11-17-pomade-runner-jobs-skill.md");
    expect(report).toEqual([
      `linked ${join(dir, "home/.claude/skills/pomade-runner-jobs")}`,
      `linked ${join(dir, "ws/Agents/claude-coder/skills/pomade-runner-jobs")}`,
      `linked ${join(dir, "ws/Agents/claude-libra/skills/pomade-runner-jobs")}`,
      `note for the skills map: ${note}`,
    ]);
    expect(await readlink(join(dir, "ws/Agents/claude-libra/skills/pomade-runner-jobs"))).toBe(places.skill);
    expect(await readFile(note, "utf8")).toContain(`**Installed copy:** \`${places.skill}\``);

    await rm(note);
    expect(await linkSkill(places)).toEqual([
      `already linked ${join(dir, "home/.claude/skills/pomade-runner-jobs")}`,
      `already linked ${join(dir, "ws/Agents/claude-coder/skills/pomade-runner-jobs")}`,
      `already linked ${join(dir, "ws/Agents/claude-libra/skills/pomade-runner-jobs")}`,
    ]);
    expect(await readdir(join(dir, "ws/Knowledge/00-Inbox"))).toEqual([]);
  });

  it("repoints a link to another Pomade's copy, and leaves anything else alone", async () => {
    const coder = join(dir, "ws/Agents/claude-coder/skills/pomade-runner-jobs");
    await symlink("/Users/x/Library/Application Support/Pomade/apps/pomade-runner/skills/pomade-runner-jobs", coder);
    await mkdir(join(dir, "ws/Agents/claude-libra/skills/pomade-runner-jobs"), { recursive: true });
    await mkdir(join(dir, "home/.claude/skills"), { recursive: true });
    await symlink("/somewhere/else", join(dir, "home/.claude/skills/pomade-runner-jobs"));
    expect((await linkSkill(places)).slice(0, 3)).toEqual([
      `left alone ${join(dir, "home/.claude/skills/pomade-runner-jobs")}: it links to /somewhere/else`,
      `relinked ${coder}`,
      `left alone ${join(dir, "ws/Agents/claude-libra/skills/pomade-runner-jobs")}: it is not a link`,
    ]);
    expect(await readlink(coder)).toBe(places.skill);
  });

  it("says so when there is no inbox, and drops the note once there is one", async () => {
    await rm(join(dir, "ws/Knowledge"), { recursive: true });
    expect((await linkSkill(places)).at(-1)).toBe("no Knowledge/00-Inbox in the workspace: no note for the skills map");
    await mkdir(join(dir, "ws/Knowledge/00-Inbox"), { recursive: true });
    expect((await linkSkill(places)).at(-1)).toMatch(/^note for the skills map: /);
  });

  it("refuses to link a skill that is not installed", async () => {
    await rm(places.skill, { recursive: true });
    await expect(linkSkill(places)).rejects.toThrow(/no SKILL.md/);
  });

  it("unlinks only the links to this copy", async () => {
    await linkSkill(places);
    const home = join(dir, "home/.claude/skills/pomade-runner-jobs");
    await rm(home);
    await symlink("/somewhere/else", home);
    expect(await unlinkSkill(places)).toEqual([`unlinked ${join(dir, "ws/Agents/claude-coder/skills/pomade-runner-jobs")}`, `unlinked ${join(dir, "ws/Agents/claude-libra/skills/pomade-runner-jobs")}`]);
    expect((await lstat(home)).isSymbolicLink()).toBe(true);
    expect(await unlinkSkill(places)).toEqual([]);
  });

  it("finds the places of the dev or the stable Pomade from the environment", () => {
    const env = { POMADE_USER_DATA: "/ud", POMADE_WORKSPACE: "/ws" };
    expect(placesFor(false, env)).toMatchObject({ skill: "/ud/apps/pomade-runner/skills/pomade-runner-jobs", workspace: "/ws", state: "/ud/app-state/pomade-runner" });
    expect(placesFor(true, {}).skill).toMatch(/\/Library\/Application Support\/Pomade\/apps\/pomade-runner\/skills\/pomade-runner-jobs$/);
    expect(placesFor(false, {}).skill).toMatch(/\/Library\/Application Support\/pomade-dev\//);
  });
});
