// The scheduler's live view of the job files: it reads the jobs folder of the current workspace,
// watches it, and checks every file on each change, so an edit by hand, by an agent or by the form
// applies within a second — with Pomade open or closed. The folder is read whole each time: a
// save by atomic rename, a half-written file (it is read again when the write ends), a folder that
// appears later or a workspace switch all come out right. A watch event refreshes at once; every
// tick refreshes too, so a missed event costs at most a tick. Invalid files stay listed with their
// errors.

import { watch, type FSWatcher } from "node:fs";

import { checkJobs } from "./check";
import { jobsFolderOf, readJobFiles } from "./folder";
import type { JobsSnapshot, ProjectRecord } from "./model";

export interface JobsLoaderOptions {
  /** The workspace root now (absolute), or `null`; asked on every refresh, so a switch is followed. */
  workspace(): string | null;
  /** The checked jobs changed. */
  onChange(snapshot: JobsSnapshot): void;
  log(message: string): void;
  /** How long a burst of watch events settles before the folder is read. */
  settleMs?: number;
}

export interface JobsLoader {
  snapshot(): JobsSnapshot;
  /** Read and check the folder again; resolves once done (refreshes never overlap). */
  refresh(): Promise<void>;
  /** Pomade's projects, for checking project ids; `null` when not known. */
  setProjects(projects: readonly ProjectRecord[] | null): void;
  stop(): void;
}

const SETTLE_MS = 30;

export function createJobsLoader(options: JobsLoaderOptions): JobsLoader {
  const settleMs = options.settleMs ?? SETTLE_MS;
  let snapshot: JobsSnapshot = { workspace: null, projectsChecked: false, jobs: [] };
  let serialized = JSON.stringify(snapshot);
  let projects: readonly ProjectRecord[] | null = null;
  let workspace: string | null = null;
  let watcher: FSWatcher | null = null;
  let settle: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const unwatch = (): void => {
    watcher?.close();
    watcher = null;
  };

  const onEvent = (): void => {
    if (settle !== null) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      void refresh();
    }, settleMs);
  };

  function ensureWatch(folder: string): void {
    if (watcher !== null) return;
    try {
      watcher = watch(folder, { recursive: true }, onEvent);
      // The folder went away (deleted, or a volume unmounted): the tick watches it again when it is back.
      watcher.on("error", unwatch);
    } catch {
      watcher = null;
    }
  }

  async function load(): Promise<void> {
    const current = options.workspace();
    if (current !== workspace) {
      unwatch();
      workspace = current;
      options.log(current === null ? "jobs: no workspace" : `jobs: workspace ${current}`);
    }
    const folder = current === null ? null : jobsFolderOf(current);
    let files = null;
    if (folder !== null) {
      try {
        files = await readJobFiles(folder);
      } catch (err) {
        options.log(`jobs: cannot read ${folder}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (files === null) unwatch();
      else ensureWatch(folder);
    }
    if (stopped) return;
    const next = checkJobs(files ?? [], { workspace: current, projects });
    const text = JSON.stringify(next);
    if (text === serialized) return;
    snapshot = next;
    serialized = text;
    const invalid = next.jobs.filter((entry) => !entry.valid).length;
    options.log(`jobs: ${next.jobs.length} job file${next.jobs.length === 1 ? "" : "s"}, ${invalid} invalid`);
    options.onChange(next);
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      // A refresh asked for while one runs reads the folder once more after it.
      const pending = (): boolean => again && !stopped;
      do {
        again = false;
        await load();
      } while (pending());
      running = null;
    })();
    return running;
  }

  return {
    snapshot: () => snapshot,
    refresh,
    setProjects(next) {
      projects = next;
      void refresh();
    },
    stop() {
      stopped = true;
      if (settle !== null) clearTimeout(settle);
      unwatch();
    },
  };
}
