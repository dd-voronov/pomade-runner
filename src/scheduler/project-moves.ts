// A project renamed or moved in Pomade (docs/ARCHITECTURE.md "Project renamed"): its jobs are bound to it
// by the stable id, so they keep working; what names its folder follows it. Runner compares
// Pomade's projects as it hears them with the ones it heard before — on `project.renamed`, and on
// every connection, so a move made while the scheduler was down is followed too — and for each
// project whose folder changed:
//
// - every job file whose `folder` is the project's folder, or inside it, is rewritten to the new
//   one (field-only: the rest of the file stays byte for byte);
// - its jobs' sub-folder is renamed after the folder's new last segment, when that changed — the
//   jobs' ids change with it (`blog/web` → `blog-2/web`), and the scheduler carries each job's
//   state to its new id (`JobMoves`).
//
// A pure part (what moves) and the files' writes.

import { access, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { projectJobsFolder } from "../jobs/check";
import { readJobDocument } from "../jobs/document";
import { setJobFields } from "../jobs/edit";
import { jobsFolderOf, readJobFiles, replaceFile } from "../jobs/folder";
import type { ProjectRecord } from "../jobs/model";
import type { Log } from "./log";

/** A project whose folder changed: as it was, and as it is. */
export interface ProjectMove {
  previous: ProjectRecord;
  project: ProjectRecord;
}

/** Job ids that change, old → new. */
export type JobMoves = ReadonlyMap<string, string>;

/** The projects whose folder changed between two lists of the same workspace. */
export function projectMoves(previous: readonly ProjectRecord[], next: readonly ProjectRecord[]): ProjectMove[] {
  const before = new Map(previous.map((project) => [project.id, project]));
  return next.flatMap((project) => {
    const was = before.get(project.id);
    return was !== undefined && was.root !== project.root && was.root !== "" && project.root !== "" ? [{ previous: was, project }] : [];
  });
}

/** A job's folder after its project moved from `from` to `to`; `null` when it is not inside it. */
export function movedFolder(folder: string, from: string, to: string): string | null {
  const path = folder.trim().replace(/\/+$/, "");
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

/** The job ids a sub-folder rename changes: every job of `ids` in `from`'s sub-folder. */
export function subFolderMoves(ids: readonly string[], from: string, to: string): Map<string, string> {
  return new Map(ids.flatMap((id) => (id.startsWith(`${from}/`) ? [[id, `${to}/${id.slice(from.length + 1)}`] as const] : [])));
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a move does to the jobs folder, planned before it is done: the sub-folders and the job ids
 *  that change; `null` ids when the sub-folder stays (same last segment, none, or the new one taken). */
export interface MovePlan {
  move: ProjectMove;
  from: string;
  to: string;
  ids: JobMoves | null;
}

export async function planMove(workspace: string, move: ProjectMove, ids: readonly string[], log: Log): Promise<MovePlan> {
  const from = projectJobsFolder(move.previous);
  const to = projectJobsFolder(move.project);
  const plan: MovePlan = { move, from, to, ids: null };
  if (from === to) return plan;
  const jobs = jobsFolderOf(workspace);
  if (!(await exists(join(jobs, from)))) return plan;
  if (await exists(join(jobs, to))) {
    log(`project ${move.project.name}: its jobs stay in jobs/${from}/ — jobs/${to}/ is there already; move them by hand`);
    return plan;
  }
  return { ...plan, ids: subFolderMoves(ids, from, to) };
}

/** Do a planned move: the job files' folders, then the sub-folder. */
export async function applyMove(workspace: string, plan: MovePlan, log: Log): Promise<void> {
  const { previous, project } = plan.move;
  const jobs = jobsFolderOf(workspace);
  for (const file of (await readJobFiles(jobs)) ?? []) {
    if (!("text" in file)) continue;
    const read = readJobDocument(file.text);
    const folder = read.ok ? read.doc.fields.folder : undefined;
    const next = typeof folder === "string" ? movedFolder(folder, previous.root, project.root) : null;
    if (next === null) continue;
    const written = setJobFields(await readFile(join(jobs, file.path), "utf8"), { folder: next });
    if (!written.ok || !written.changed) continue;
    try {
      await replaceFile(join(jobs, file.path), written.text);
      log(`project ${project.name} moved: jobs/${file.path} now runs in ${next}`);
    } catch (err) {
      log(`project ${project.name} moved: cannot write jobs/${file.path} — ${errorText(err)}`);
    }
  }
  if (plan.ids === null) return;
  try {
    await rename(join(jobs, plan.from), join(jobs, plan.to));
    log(`project ${project.name} moved: its jobs are in jobs/${plan.to}/ now`);
  } catch (err) {
    log(`project ${project.name} moved: cannot rename jobs/${plan.from}/ — ${errorText(err)}`);
  }
}
