// Reading the jobs folder from disk (Node): every `.md` file in it and in its sub-folders, as the
// validator takes them. Works with Pomade closed — the scheduler and the command read the folder
// directly. Hidden files (`.x.md`, editors' `.#x.md`) and other files are not job files. And the one
// write the scheduler makes to a job file: Enable / Disable.

import { readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { setJobFields } from "./edit";
import { JOBS_FOLDER } from "./model";
import type { JobFileInput } from "./parse";

/** The jobs folder of a workspace, absolute. */
export function jobsFolderOf(workspace: string): string {
  return join(workspace, JOBS_FOLDER);
}

/** How deep the reader looks: a file deeper than one sub-folder is still listed, so it is reported. */
const MAX_DEPTH = 3;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The job files under `folder`, paths relative to it, in path order; `null` when the folder does not exist. */
export async function readJobFiles(folder: string): Promise<JobFileInput[] | null> {
  const files: JobFileInput[] = [];
  async function walk(relative: string, depth: number): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(join(folder, relative), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return false;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1);
      } else if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
        try {
          files.push({ path, text: await readFile(join(folder, path), "utf8") });
        } catch (err) {
          // Deleted between the listing and the read: it is gone, not broken.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") files.push({ path, readError: message(err) });
        }
      }
    }
    return true;
  }
  if (!(await walk("", 1))) return null;
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Write `enabled:` into the job file at `path` (workspace-relative), field-only: the rest of the
 *  file stays byte for byte. The file — a link's target, for a linked one — is replaced whole
 *  through a hidden file beside it, which the loader never reads as a job. */
export async function writeEnabled(workspace: string, path: string, enabled: boolean): Promise<void> {
  const file = await realpath(join(workspace, path));
  const result = setJobFields(await readFile(file, "utf8"), { enabled });
  if (!result.ok) throw new Error(result.message);
  if (!result.changed) return;
  const temp = join(dirname(file), `.${basename(file)}.tmp`);
  try {
    await writeFile(temp, result.text);
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
