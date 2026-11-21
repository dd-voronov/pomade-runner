// Jobs whose ids changed — their project moved, and its jobs' sub-folder with it ("Project
// renamed") — kept in `renamed.json` in the records folder: old id → new id. History is written
// once and never rewritten, so a moved job's earlier records keep its old id; reading a job's
// history takes in the ids it had (`formerIds`).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { renamedJobsPath, type RecordsFolder } from "../locations";
import type { Log } from "./log";

export interface RenamedJobs {
  load(): Promise<void>;
  /** Jobs' ids changed, old → new. */
  add(ids: ReadonlyMap<string, string>): void;
  /** The ids `job` had before, through every move; none that a job has now (`current`). */
  formerIds(job: string, current: ReadonlySet<string>): string[];
  flush(): Promise<void>;
}

export function renamedJobs(records: RecordsFolder, log: Log): RenamedJobs {
  const file = renamedJobsPath(records);
  let renamed = new Map<string, string>();
  let writing: Promise<void> = Promise.resolve();
  /** Where an old id leads now, through every later move; a loop ends where it began. */
  const lead = (id: string): string => {
    let at = id;
    const seen = new Set([id]);
    for (let next = renamed.get(at); next !== undefined && !seen.has(next); next = renamed.get(at)) {
      seen.add(next);
      at = next;
    }
    return at;
  };
  return {
    async load() {
      try {
        const data: unknown = JSON.parse(await readFile(file, "utf8"));
        const map = typeof data === "object" && data !== null ? (data as Record<string, unknown>).renamed : null;
        if (typeof map === "object" && map !== null) renamed = new Map(Object.entries(map).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      } catch {
        // None moved yet, or unreadable: histories read by the jobs' ids as they are.
      }
    },
    add(ids) {
      // A job that moves to an id makes that id its own: where the id led before is stale.
      for (const to of ids.values()) renamed.delete(to);
      for (const [from, to] of ids) if (from !== to) renamed.set(from, to);
      const data = `${JSON.stringify({ renamed: Object.fromEntries([...renamed].sort(([a], [b]) => (a < b ? -1 : 1))) }, null, 2)}\n`;
      writing = writing
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, data);
          await rename(`${file}.tmp`, file);
        })
        .catch((err: unknown) => log(`renamed jobs: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`));
    },
    formerIds: (job, current) => [...renamed.keys()].filter((id) => id !== job && !current.has(id) && lead(id) === job),
    flush: () => writing,
  };
}
