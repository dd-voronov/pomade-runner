import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyState, placeSkill, readSkillRecord, removeCopy, skillKeeper, SKILL_RECORD } from "./place";
import { skillRecordPath, stateFolderOf } from "../../locations";

const SKILL = "---\nname: pomade-runner-jobs\ndescription: Write Runner jobs.\n---\n\n# Jobs\n";
const OLDER = "---\nname: pomade-runner-jobs\ndescription: Write Runner jobs.\n---\n\n# Jobs, the older version\n";

let dir: string;
let source: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-skill-"));
  source = join(dir, "build/skills/pomade-runner-jobs/SKILL.md");
  await mkdir(join(source, ".."), { recursive: true });
  await writeFile(source, SKILL);
});

afterEach(async () => {
  await chmod(join(dir, "ws"), 0o755).catch(() => undefined);
  await chmod(join(dir, "ws/locked"), 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const copyIn = (folder: string): string => join(dir, "ws", folder, "pomade-runner-jobs");

describe("placing the skill", () => {
  it("copies the installed skill into a skills folder it makes, as a real file", async () => {
    const result = await placeSkill({ source, skillsFolder: join(dir, "ws/Knowledge/_skills/apps"), previous: null });
    expect(result).toEqual({ folder: copyIn("Knowledge/_skills/apps"), outcome: "written", problem: null, previous: null });
    expect(await readFile(join(copyIn("Knowledge/_skills/apps"), "SKILL.md"), "utf8")).toBe(SKILL);
    expect(await readdir(copyIn("Knowledge/_skills/apps"))).toEqual(["SKILL.md"]);
    expect((await stat(join(copyIn("Knowledge/_skills/apps"), "SKILL.md"))).isFile()).toBe(true);
  });

  it("leaves a copy with the installed text untouched, and rewrites one that differs", async () => {
    const skills = join(dir, "ws/skills");
    await placeSkill({ source, skillsFolder: skills, previous: null });
    const file = join(copyIn("skills"), "SKILL.md");
    const before = (await stat(file)).mtimeMs;
    await new Promise((done) => setTimeout(done, 20));
    expect(await placeSkill({ source, skillsFolder: skills, previous: copyIn("skills") })).toMatchObject({ outcome: "unchanged", previous: null });
    expect((await stat(file)).mtimeMs).toBe(before);

    await writeFile(file, OLDER);
    expect(await placeSkill({ source, skillsFolder: skills, previous: copyIn("skills") })).toMatchObject({ outcome: "written" });
    expect(await readFile(file, "utf8")).toBe(SKILL);
  });

  it("moves: the new copy is written, then the copy placed before is removed — its folder alone", async () => {
    await placeSkill({ source, skillsFolder: join(dir, "ws/old"), previous: null });
    await writeFile(join(dir, "ws/old/another.md"), "mine");
    const result = await placeSkill({ source, skillsFolder: join(dir, "ws/new"), previous: copyIn("old") });
    expect(result).toEqual({ folder: copyIn("new"), outcome: "written", problem: null, previous: { folder: copyIn("old"), removed: true } });
    expect(existsSync(copyIn("old"))).toBe(false);
    expect(await readdir(join(dir, "ws/old"))).toEqual(["another.md"]);
    expect(await readFile(join(copyIn("new"), "SKILL.md"), "utf8")).toBe(SKILL);
  });

  it("never removes a folder that is not Runner's copy alone; a previous copy already gone is nothing to move", async () => {
    await placeSkill({ source, skillsFolder: join(dir, "ws/old"), previous: null });
    await writeFile(join(copyIn("old"), "notes.md"), "the Owner's");
    expect((await placeSkill({ source, skillsFolder: join(dir, "ws/new"), previous: copyIn("old") })).previous).toEqual({
      folder: copyIn("old"),
      removed: false,
      left: "it holds something that is not Runner's copy of the skill",
    });
    expect(await readdir(copyIn("old"))).toEqual(["SKILL.md", "notes.md"]);
    expect((await placeSkill({ source, skillsFolder: join(dir, "ws/new"), previous: copyIn("gone") })).previous).toBeNull();
  });

  it("tells Runner's copy from anything else at its name", async () => {
    const at = (name: string): string => join(dir, "ws/kinds", name, "pomade-runner-jobs");
    expect(await copyState(at("missing"))).toBe("missing");
    await mkdir(at("empty"), { recursive: true });
    expect(await copyState(at("empty"))).toBe("empty");
    await mkdir(at("ours"), { recursive: true });
    await writeFile(join(at("ours"), "SKILL.md"), OLDER);
    await writeFile(join(at("ours"), ".DS_Store"), "");
    expect(await copyState(at("ours"))).toBe("ours");
    await mkdir(at("named"), { recursive: true });
    await writeFile(join(at("named"), "SKILL.md"), "---\nname: something-else\n---\n");
    expect(await copyState(at("named"))).toBe("other");
    await mkdir(at("more"), { recursive: true });
    await writeFile(join(at("more"), "SKILL.md"), SKILL);
    await mkdir(join(at("more"), "references"));
    expect(await copyState(at("more"))).toBe("other");
    await mkdir(join(at("link"), ".."), { recursive: true });
    await symlink(at("ours"), at("link"));
    expect(await copyState(at("link"))).toBe("other");
    await mkdir(join(at("file"), ".."), { recursive: true });
    await writeFile(at("file"), SKILL);
    expect(await copyState(at("file"))).toBe("other");
  });

  it("writes nothing over something that is not its copy, and says so", async () => {
    await mkdir(copyIn("theirs"), { recursive: true });
    await writeFile(join(copyIn("theirs"), "SKILL.md"), "---\nname: their-skill\n---\n");
    expect(await placeSkill({ source, skillsFolder: join(dir, "ws/theirs"), previous: null })).toEqual({
      folder: copyIn("theirs"),
      outcome: "failed",
      problem: `${copyIn("theirs")} holds something that is not Runner's copy of the skill; Runner leaves it`,
      previous: null,
    });
    expect(await readFile(join(copyIn("theirs"), "SKILL.md"), "utf8")).toBe("---\nname: their-skill\n---\n");
  });

  it("reports a skills folder it cannot write, and keeps the copy placed before", async () => {
    await placeSkill({ source, skillsFolder: join(dir, "ws/old"), previous: null });
    await mkdir(join(dir, "ws/locked"), { recursive: true });
    await chmod(join(dir, "ws/locked"), 0o555);
    const result = await placeSkill({ source, skillsFolder: join(dir, "ws/locked"), previous: copyIn("old") });
    expect(result).toMatchObject({ outcome: "failed", previous: null });
    expect(result.problem).toMatch(new RegExp(`^cannot write ${join(copyIn("locked"), "SKILL.md")}: EACCES`));
    expect(existsSync(join(copyIn("old"), "SKILL.md"))).toBe(true);
  });

  it("reports an installed skill it cannot read", async () => {
    expect(await placeSkill({ source: join(dir, "nowhere/SKILL.md"), skillsFolder: join(dir, "ws/skills"), previous: null })).toMatchObject({
      outcome: "failed",
      problem: expect.stringMatching(/^cannot read the installed skill: ENOENT/) as string,
    });
    expect(existsSync(join(dir, "ws"))).toBe(false);
  });

  it("removes Runner's copy for uninstall, nothing else", async () => {
    await placeSkill({ source, skillsFolder: join(dir, "ws/skills"), previous: null });
    expect(await removeCopy(copyIn("skills"))).toEqual({ folder: copyIn("skills"), removed: true });
    expect(existsSync(copyIn("skills"))).toBe(false);
    expect(existsSync(join(dir, "ws/skills"))).toBe(true);
    expect(await removeCopy(copyIn("skills"))).toBeNull();
  });
});

describe("the scheduler's hold on the skill", () => {
  it("places it, records where, moves it when the folder changes, and logs a problem once", async () => {
    const lines: string[] = [];
    const record = join(dir, "state", SKILL_RECORD);
    let folder = join(dir, "ws/Knowledge/_skills/apps");
    const keeper = skillKeeper({ source, record, skillsFolder: () => folder, log: (line) => lines.push(line) });

    await keeper.place();
    expect(keeper.report()).toEqual({ folder: copyIn("Knowledge/_skills/apps"), problem: null });
    expect(await readSkillRecord(record)).toBe(copyIn("Knowledge/_skills/apps"));
    await keeper.place();
    expect(lines).toEqual([`skill: placed ${join(copyIn("Knowledge/_skills/apps"), "SKILL.md")}`, `skill: in place at ${join(copyIn("Knowledge/_skills/apps"), "SKILL.md")}`]);

    folder = join(dir, "ws/locked");
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o555);
    await Promise.all([keeper.place(), keeper.place()]);
    expect(keeper.report()).toMatchObject({ folder: copyIn("locked"), problem: expect.stringContaining("EACCES") as string });
    expect(lines.slice(2)).toEqual([expect.stringMatching(/^skill: not placed: cannot write .*EACCES/)]);
    expect(await readSkillRecord(record)).toBe(copyIn("Knowledge/_skills/apps"));

    // Made writable: the next placing moves the skill out of the folder placed before.
    await chmod(folder, 0o755);
    await keeper.place();
    expect(keeper.report()).toEqual({ folder: copyIn("locked"), problem: null });
    expect(lines.slice(3)).toEqual([`skill: placed ${join(copyIn("locked"), "SKILL.md")}`, `skill: removed the copy at ${copyIn("Knowledge/_skills/apps")}`]);
    expect(existsSync(copyIn("Knowledge/_skills/apps"))).toBe(false);
    expect(await readSkillRecord(record)).toBe(copyIn("locked"));
  });

  it("keeps its record where `src/locations.ts` names it", () => {
    expect(skillRecordPath(stateFolderOf(join(dir, "ud")))).toBe(join(dir, "ud/app-state/pomade-runner", SKILL_RECORD));
  });
});
