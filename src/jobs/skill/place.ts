// The agent skill in the workspace's skills folder (docs/ARCHITECTURE.md "The agent skill"). Runner keeps a
// copy of its installed build's skill at `<skills folder>/pomade-runner-jobs/SKILL.md` — a real file,
// since the skills folder may sit in its own git repository synced to other Macs — and gives it to no
// agent: which agents get it is the person's choice. The scheduler places it at every start (an
// install or an update restarts it), when the `skills-folder` setting changes, and when Settings asks
// about it. A copy is written only when its text differs; the copy at the folder placed before is
// removed once the new one is written. Runner touches only a `pomade-runner-jobs/` folder it can tell
// is its own copy, never anything else in a skills folder.
//
// Self-contained — Node's built-ins and `pomade-kit` only — so `./uninstall` runs it straight from
// the repo under Node's type stripping, to remove the copy this Mac placed:
//   node src/jobs/skill/place.ts remove [--stable]

import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pomadeUserData } from "pomade-kit/node";

export const SKILL_NAME = "pomade-runner-jobs";
const SKILL_FILE = "SKILL.md";
const APP_ID = "pomade-runner";
/** The record, in Runner's state folder, of the copy this Mac placed (`src/locations.ts`
 *  `skillRecordPath` names the same file). */
export const SKILL_RECORD = "skill.json";
/** What may sit beside `SKILL.md` in Runner's copy without making it someone else's: Finder's. */
const LITTER = new Set([".DS_Store"]);

/** Whether `text` is this skill: its frontmatter names it. */
function namesTheSkill(text: string): boolean {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return block !== null && new RegExp(`^name:\\s*["']?${SKILL_NAME}["']?\\s*$`, "m").test(block[1] ?? "");
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a `pomade-runner-jobs` folder is: missing, Runner's copy (a folder holding only a
 *  `SKILL.md` that names this skill), an empty folder, or something else, which Runner leaves. */
export async function copyState(folder: string): Promise<"missing" | "ours" | "empty" | "other"> {
  let stat;
  try {
    stat = await lstat(folder);
  } catch {
    return "missing";
  }
  if (!stat.isDirectory()) return "other";
  const entries = (await readdir(folder)).filter((name) => !LITTER.has(name));
  if (entries.length === 0) return "empty";
  if (entries.length !== 1 || entries[0] !== SKILL_FILE) return "other";
  const file = join(folder, SKILL_FILE);
  if (!(await lstat(file)).isFile()) return "other";
  return namesTheSkill(await readFile(file, "utf8")) ? "ours" : "other";
}

/** What placing the skill did. */
export interface SkillPlacement {
  /** The copy's folder, absolute: `<skills folder>/pomade-runner-jobs`. */
  folder: string;
  /** `written`: the copy is new or was rewritten; `unchanged`: it already held the installed text;
   *  `failed`: it could not be written (`problem` says why). */
  outcome: "written" | "unchanged" | "failed";
  problem: string | null;
  /** The copy placed before, at another folder: removed, or left (`left` says why); `null` when
   *  there was none to move. */
  previous: { folder: string; removed: true } | { folder: string; removed: false; left: string } | null;
}

/** Place the skill whose installed file is `source` into `skillsFolder`, and remove the copy at
 *  `previous` (a `pomade-runner-jobs` folder placed before) once it is written. */
export async function placeSkill(options: { source: string; skillsFolder: string; previous: string | null }): Promise<SkillPlacement> {
  const folder = join(options.skillsFolder, SKILL_NAME);
  const failed = (problem: string): SkillPlacement => ({ folder, outcome: "failed", problem, previous: null });
  let text: string;
  try {
    text = await readFile(options.source, "utf8");
  } catch (err) {
    return failed(`cannot read the installed skill: ${reason(err)}`);
  }
  let outcome: "written" | "unchanged";
  try {
    const state = await copyState(folder);
    if (state === "other") return failed(`${folder} holds something that is not Runner's copy of the skill; Runner leaves it`);
    const file = join(folder, SKILL_FILE);
    if (state === "ours" && (await readFile(file, "utf8")) === text) outcome = "unchanged";
    else {
      await mkdir(folder, { recursive: true });
      const temp = join(folder, `.${SKILL_FILE}.tmp`);
      await writeFile(temp, text);
      await rename(temp, file);
      outcome = "written";
    }
  } catch (err) {
    return failed(`cannot write ${join(folder, SKILL_FILE)}: ${reason(err)}`);
  }
  if (options.previous === null || options.previous === folder) return { folder, outcome, problem: null, previous: null };
  return { folder, outcome, problem: null, previous: await removeCopy(options.previous) };
}

/** Remove the copy at `folder` when it is Runner's; anything else stays. `null` when nothing is there. */
export async function removeCopy(folder: string): Promise<SkillPlacement["previous"]> {
  try {
    const state = await copyState(folder);
    if (state === "missing") return null;
    if (state === "other") return { folder, removed: false, left: "it holds something that is not Runner's copy of the skill" };
    await rm(folder, { recursive: true, force: true });
    return { folder, removed: true };
  } catch (err) {
    return { folder, removed: false, left: reason(err) };
  }
}

/** The copy's folder this Mac placed last, from the record; `null` when none is recorded. */
export async function readSkillRecord(record: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(record, "utf8"));
    const folder = typeof parsed === "object" && parsed !== null ? (parsed as { folder?: unknown }).folder : undefined;
    return typeof folder === "string" ? folder : null;
  } catch {
    return null;
  }
}

export async function writeSkillRecord(record: string, folder: string | null): Promise<void> {
  if (folder === null) {
    await rm(record, { force: true });
    return;
  }
  await mkdir(join(record, ".."), { recursive: true });
  await writeFile(record, `${JSON.stringify({ folder })}\n`);
}

/** The skill where it is now, for Settings: the copy's folder, and why it could not be written. */
export interface SkillPlace {
  folder: string;
  problem: string | null;
}

export interface SkillKeeper {
  /** Place the skill into the skills folder the settings name now; one placing at a time. */
  place(): Promise<void>;
  /** The latest placing's folder and problem. */
  report(): SkillPlace;
}

/** The scheduler's hold on the skill: places it, moves it when the skills folder changes, records
 *  where it is, and logs what it did — a problem once, until it changes. `skillsFolder` is absolute. */
export function skillKeeper(options: { source: string; record: string; skillsFolder(): string; log(line: string): void }): SkillKeeper {
  /** The latest placing's; `null` before the first. */
  let current: SkillPlace | null = null;
  let logged: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  const say = (line: string): void => {
    if (line === logged) return;
    logged = line;
    options.log(`skill: ${line}`);
  };

  async function placeNow(): Promise<void> {
    const previous = await readSkillRecord(options.record);
    const result = await placeSkill({ source: options.source, skillsFolder: options.skillsFolder(), previous });
    current = { folder: result.folder, problem: result.problem };
    if (result.outcome === "failed") {
      say(`not placed: ${result.problem ?? ""}`);
      return;
    }
    if (result.outcome === "written") say(`placed ${join(result.folder, SKILL_FILE)}`);
    else say(`in place at ${join(result.folder, SKILL_FILE)}`);
    if (result.previous?.removed === true) options.log(`skill: removed the copy at ${result.previous.folder}`);
    else if (result.previous?.removed === false) options.log(`skill: left ${result.previous.folder}: ${result.previous.left}`);
    if (previous !== result.folder) {
      try {
        await writeSkillRecord(options.record, result.folder);
      } catch (err) {
        options.log(`skill: cannot record where it is: ${reason(err)}`);
      }
    }
  }

  return {
    place() {
      queue = queue.then(placeNow, placeNow);
      return queue;
    },
    report: () => current ?? { folder: join(options.skillsFolder(), SKILL_NAME), problem: null },
  };
}

/** `./uninstall`'s step: remove the copy this Mac placed, recorded in the state folder of the Pomade
 *  the script targets (dev by default, `--stable`). */
async function main(args: readonly string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "remove" || rest.some((arg) => arg !== "--stable")) {
    console.error("usage: node src/jobs/skill/place.ts remove [--stable]");
    return 2;
  }
  const record = join(pomadeUserData({ stable: rest.includes("--stable") }), "app-state", APP_ID, SKILL_RECORD);
  const folder = await readSkillRecord(record);
  const removed = folder === null ? null : await removeCopy(folder);
  if (removed === null) console.log(`skill ${SKILL_NAME}: no copy to remove`);
  else if (removed.removed) console.log(`skill ${SKILL_NAME}: removed ${removed.folder}`);
  else console.log(`skill ${SKILL_NAME}: left ${removed.folder}: ${removed.left}`);
  await writeSkillRecord(record, null);
  return 0;
}

// Run as a script only: the scheduler's bundle carries this file too, under its own name.
if (import.meta.filename === process.argv[1] && process.argv[1].endsWith("place.ts")) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      console.error(`skill ${SKILL_NAME}: ${reason(err)}`);
      process.exitCode = 1;
    },
  );
}
