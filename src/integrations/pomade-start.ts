// Which Pomade start this is, and whether a workspace's "Pomade started" hooks fired for it
// (docs/DESIGN.md "Firing hooks"). `pomade.ready` is sticky — a scheduler that connects, or
// connects again, while the same Pomade runs hears it at once — so the event alone does not say
// Pomade just started. A Pomade start is named by its socket: Pomade creates it at every start and
// removes it when it quits, so the file's inode and birth time differ from one start to the next.
// The start each workspace fired for is kept in `pomade-started.json` in Runner's state folder:
// a scheduler restarted while Pomade runs fires nothing again.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { readHostRecord, type Env } from "pomade-kit/node";
import { POMADE_ENV } from "pomade-kit/protocol";

import { pomadeStartedRecordPath, type StateFolder } from "../locations";
import type { Log } from "../scheduler/log";

/** The running Pomade's start, named by its socket file; `null` when the socket is not found. */
export async function pomadeStartOf(env: Env): Promise<string | null> {
  const socket = env[POMADE_ENV.socket] || readHostRecord(env)?.socket;
  if (socket === undefined) return null;
  try {
    const found = await stat(socket);
    return `${found.dev}:${found.ino}:${Math.round(found.birthtimeMs)}`;
  } catch {
    return null;
  }
}

export interface PomadeStarts {
  /** Whether `start` is new for `workspace`: `true` once, then it is kept as fired. */
  firstReady(workspace: string, start: string): Promise<boolean>;
  flush(): Promise<void>;
}

export function pomadeStarts(state: StateFolder, log: Log): PomadeStarts {
  const file = pomadeStartedRecordPath(state);
  let fired: Record<string, string> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const load = async (): Promise<Record<string, string>> => {
    try {
      const data: unknown = JSON.parse(await readFile(file, "utf8"));
      const list = typeof data === "object" && data !== null ? (data as Record<string, unknown>).fired : null;
      if (typeof list === "object" && list !== null) return Object.fromEntries(Object.entries(list).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      // None fired yet, or unreadable: the next ready is a start.
    }
    return {};
  };
  return {
    async firstReady(workspace, start) {
      fired ??= await load();
      if (fired[workspace] === start) return false;
      fired[workspace] = start;
      const data = `${JSON.stringify({ fired }, null, 2)}\n`;
      writing = writing
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, data);
          await rename(`${file}.tmp`, file);
        })
        .catch((err: unknown) => log(`pomade started: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    },
    flush: () => writing,
  };
}
