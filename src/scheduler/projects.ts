// Pomade's projects as the scheduler last heard them, kept in `projects.json` in Runner's state
// folder: a scheduler started at login, before Pomade, still knows each project's folder for a
// run's `POMADE_PROJECT_PATH`.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProjectRecord } from "../jobs/model";
import type { Log } from "./log";

export interface ProjectsMemory {
  load(): Promise<void>;
  /** Pomade's projects, as just read. */
  remember(projects: readonly ProjectRecord[]): void;
  /** A project's root, workspace-relative; `null` when it is not known. */
  root(id: string): string | null;
  flush(): Promise<void>;
}

function isProject(value: unknown): value is ProjectRecord {
  if (typeof value !== "object" || value === null) return false;
  const { id, name, root } = value as Record<string, unknown>;
  return typeof id === "string" && typeof name === "string" && typeof root === "string";
}

export function projectsMemory(state: string, log: Log): ProjectsMemory {
  const file = join(state, "projects.json");
  let projects: readonly ProjectRecord[] = [];
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      try {
        const data: unknown = JSON.parse(await readFile(file, "utf8"));
        const list = typeof data === "object" && data !== null ? (data as Record<string, unknown>).projects : null;
        if (Array.isArray(list)) projects = list.filter(isProject);
      } catch {
        // None heard yet, or unreadable: the next connection to Pomade tells.
      }
    },
    remember(next) {
      if (JSON.stringify(next) === JSON.stringify(projects)) return;
      projects = [...next];
      const data = `${JSON.stringify({ projects }, null, 2)}\n`;
      writing = writing
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, data);
          await rename(`${file}.tmp`, file);
        })
        .catch((err: unknown) => log(`projects: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`));
    },
    root: (id) => projects.find((project) => project.id === id)?.root ?? null,
    flush: () => writing,
  };
}
