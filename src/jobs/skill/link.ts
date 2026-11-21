// Giving the pomade-runner-jobs skill to the agents — the install script's step (Pomade itself
// links skills nowhere, HOST-API §2 "Skills"). The skill's folder in the installed build is linked
// into `~/.claude/skills/` and into the `skills/` folder of every agent under
// `<workspace>/Agents/` (a folder with a `CLAUDE.md`, as Pomade's own roster counts agents).
// Linking again changes nothing; unlinking removes only links to this Pomade's copy. The first link
// also drops a note into `<workspace>/Knowledge/00-Inbox/` for the skills map.
//
// Run by `./install` and `./uninstall` straight from the repo, under Node's type stripping:
//   node src/jobs/skill/link.ts link|unlink [--stable]

import { lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { pomadeUserData, resolveWorkspace } from "pomade-kit/node";

export const SKILL_NAME = "pomade-runner-jobs";
export const APP_ID = "pomade-runner";

/** Where a skill folder of this app sits inside an installed build, whichever Pomade's. */
const OURS = `/apps/${APP_ID}/skills/${SKILL_NAME}`;

export interface SkillPlaces {
  /** The skill's folder in the installed build: what every link points at. */
  skill: string;
  /** The user's home: `~/.claude/skills/` is there. */
  home: string;
  /** The workspace root; `null` when none is known (only `~/.claude/skills/` is linked then). */
  workspace: string | null;
  /** Runner's machine-local state folder: remembers that the pointer note was dropped. */
  state: string;
  /** Today, `YYYY-MM-DD`, for the note's name. */
  today: string;
}

const NOTE_MARKER = "skill-pointer-note";

/** The skills folders the skill is linked into: the user's, then each agent's. */
export async function skillFolders(home: string, workspace: string | null): Promise<string[]> {
  const folders = [join(home, ".claude", "skills")];
  if (workspace === null) return folders;
  const agents = join(workspace, "Agents");
  let entries;
  try {
    entries = await readdir(agents, { withFileTypes: true });
  } catch {
    return folders;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (existsSync(join(agents, entry.name, "CLAUDE.md"))) folders.push(join(agents, entry.name, "skills"));
  }
  return folders;
}

/** How many of the skills folders hold a link to this app's copy of the skill (any Pomade's). */
export async function skillLinks(home: string, workspace: string | null): Promise<{ linked: number; folders: number }> {
  const folders = await skillFolders(home, workspace);
  let linked = 0;
  for (const folder of folders) {
    try {
      if ((await readlink(join(folder, SKILL_NAME))).endsWith(OURS)) linked += 1;
    } catch {
      // Not there, or not a link.
    }
  }
  return { linked, folders: folders.length };
}

async function linkAt(folder: string, skill: string): Promise<string> {
  const path = join(folder, SKILL_NAME);
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    await mkdir(folder, { recursive: true });
    await symlink(skill, path);
    return `linked ${path}`;
  }
  if (!stat.isSymbolicLink()) return `left alone ${path}: it is not a link`;
  const target = await readlink(path);
  if (target === skill) return `already linked ${path}`;
  if (!target.endsWith(OURS)) return `left alone ${path}: it links to ${target}`;
  await rm(path);
  await symlink(skill, path);
  return `relinked ${path}`;
}

const NOTE = (places: SkillPlaces, linked: readonly string[]): string => `# Skill: ${SKILL_NAME} (Pomade Runner)

For the skills map. Runner — the Pomade app \`pomade-runner\` — ships an agent skill that teaches agents
to write Runner's job files: services, scheduled or hook-triggered scripts, unattended agent runs and
scheduled git operations, in \`<workspace>/Apps/pomade-runner/jobs/\`, checked with
\`pomade-runner check\`.

- **Master copy:** \`Projects/pomade-runner/app/skills/${SKILL_NAME}/SKILL.md\` (versioned with the job format).
- **Installed copy:** \`${places.skill}\` — every link points here; \`./install\` in the Runner repo updates it.
- **Linked into:**
${linked.map((folder) => `  - \`${folder}\``).join("\n")}
- **Removed by** \`./uninstall\` in the Runner repo (the links only).
`;

/** Link the skill everywhere; returns one line per place, and about the note. */
export async function linkSkill(places: SkillPlaces): Promise<string[]> {
  if (!existsSync(join(places.skill, "SKILL.md"))) throw new Error(`no SKILL.md in ${places.skill} — install Runner first`);
  const folders = await skillFolders(places.home, places.workspace);
  const report: string[] = [];
  for (const folder of folders) report.push(await linkAt(folder, places.skill));

  const marker = join(places.state, NOTE_MARKER);
  const inbox = places.workspace === null ? null : join(places.workspace, "Knowledge", "00-Inbox");
  if (existsSync(marker)) return report;
  if (inbox === null || !existsSync(inbox)) {
    report.push("no Knowledge/00-Inbox in the workspace: no note for the skills map");
    return report;
  }
  const note = join(inbox, `${places.today}-${SKILL_NAME}-skill.md`);
  await writeFile(note, NOTE(places, folders), { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  await mkdir(places.state, { recursive: true });
  await writeFile(marker, `${note}\n`);
  report.push(`note for the skills map: ${note}`);
  return report;
}

/** Remove the links to this Pomade's copy of the skill; anything else is left. */
export async function unlinkSkill(places: SkillPlaces): Promise<string[]> {
  const report: string[] = [];
  for (const folder of await skillFolders(places.home, places.workspace)) {
    const path = join(folder, SKILL_NAME);
    try {
      if ((await lstat(path)).isSymbolicLink() && (await readlink(path)) === places.skill) {
        await rm(path);
        report.push(`unlinked ${path}`);
      }
    } catch {
      // Nothing there.
    }
  }
  return report;
}

/** The places for the Pomade the install script targets: dev by default, `--stable`. */
export function placesFor(stable: boolean, env: NodeJS.ProcessEnv = process.env): SkillPlaces {
  const userData = pomadeUserData({ stable, env });
  const home = homedir();
  const pomadeHome = env.POMADE_HOME ?? join(home, stable ? ".pomade" : ".pomade-dev");
  return {
    skill: join(userData, "apps", APP_ID, "skills", SKILL_NAME),
    home,
    workspace: resolveWorkspace({ ...env, POMADE_HOME: pomadeHome }),
    state: join(userData, "app-state", APP_ID),
    today: new Date().toLocaleDateString("sv-SE"),
  };
}

async function main(args: readonly string[]): Promise<number> {
  const [action, ...rest] = args;
  const stable = rest.includes("--stable");
  if ((action !== "link" && action !== "unlink") || rest.some((arg) => arg !== "--stable")) {
    console.error("usage: node src/jobs/skill/link.ts link|unlink [--stable]");
    return 2;
  }
  const places = placesFor(stable);
  const report = action === "link" ? await linkSkill(places) : await unlinkSkill(places);
  for (const line of report) console.log(`skill ${SKILL_NAME}: ${line}`);
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      console.error(`skill ${SKILL_NAME}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
