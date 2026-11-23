// Which Pomade start this is, whether a workspace's "Pomade started" hooks fired for it, and which of
// its projects were opened since (docs/DESIGN.md "Firing hooks"). `pomade.ready` is sticky — a
// scheduler that connects, or connects again, while the same Pomade runs hears it at once — so the
// event alone does not say Pomade just started. A Pomade start is named by its socket: Pomade
// creates it at every start and removes it when it quits, so the file's inode and birth time differ
// from one start to the next; a socket left by a Pomade that crashed answers no connection, and
// names no start. The start each workspace fired for, and the projects opened in it, are
// kept in `pomade-started.json` in Runner's state folder: a scheduler restarted while Pomade runs
// fires nothing again, and knows which projects were opened.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";

import { readHostRecord, type Env } from "pomade-kit/node";
import { POMADE_ENV } from "pomade-kit/protocol";

import { pomadeStartedRecordPath, type StateFolder } from "../locations";
import type { Log } from "../scheduler/log";

/** How long a socket has to accept a connection to count as Pomade's. */
const ANSWER_MS = 2_000;

/** Whether something listens on the socket `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ANSWER_MS);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The running Pomade's start, named by its socket file; `null` when the socket is not found or
 *  nothing listens on it. */
export async function pomadeStartOf(env: Env): Promise<string | null> {
  const socket = env[POMADE_ENV.socket] || readHostRecord(env)?.socket;
  if (socket === undefined) return null;
  try {
    const found = await stat(socket);
    return (await answers(socket)) ? `${found.dev}:${found.ino}:${Math.round(found.birthtimeMs)}` : null;
  } catch {
    return null;
  }
}

export interface PomadeStarts {
  /** Whether `start` is new for `workspace`: `true` once, then it is kept as fired — with no project
   *  opened in it yet. */
  firstReady(workspace: string, start: string): Promise<boolean>;
  /** The projects opened in `workspace` since `start`, as kept; none for a start not kept. */
  opened(workspace: string, start: string): Promise<string[]>;
  /** Keep `project` as opened in `workspace` since `start`, the start kept for it. */
  open(workspace: string, start: string, project: string): Promise<void>;
  flush(): Promise<void>;
}

/** What `pomade-started.json` keeps: each workspace's start, and the projects opened in it. */
interface Kept {
  fired: Record<string, string>;
  opened: Record<string, string[]>;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const section = (data: unknown, key: string): Record<string, unknown> => {
  const value = typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : null;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

export function pomadeStarts(state: StateFolder, log: Log): PomadeStarts {
  const file = pomadeStartedRecordPath(state);
  let loading: Promise<Kept> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const read = async (): Promise<Kept> => {
    try {
      const data: unknown = JSON.parse(await readFile(file, "utf8"));
      return {
        fired: Object.fromEntries(Object.entries(section(data, "fired")).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        opened: Object.fromEntries(Object.entries(section(data, "opened")).filter((entry): entry is [string, string[]] => strings(entry[1]))),
      };
    } catch {
      // None fired yet, or unreadable: the next ready is a start.
      return { fired: {}, opened: {} };
    }
  };
  /** The record, read once: every caller works on the same one. */
  const load = (): Promise<Kept> => (loading ??= read());
  const save = (next: Kept): void => {
    const data = `${JSON.stringify(next, null, 2)}\n`;
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, data);
        await rename(`${file}.tmp`, file);
      })
      .catch((err: unknown) => log(`pomade started: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`));
  };
  return {
    async firstReady(workspace, start) {
      const kept = await load();
      if (kept.fired[workspace] === start) return false;
      kept.fired[workspace] = start;
      kept.opened[workspace] = [];
      save(kept);
      return true;
    },
    async opened(workspace, start) {
      const kept = await load();
      return kept.fired[workspace] === start ? [...(kept.opened[workspace] ?? [])] : [];
    },
    async open(workspace, start, project) {
      const kept = await load();
      const list = kept.opened[workspace] ?? [];
      if (kept.fired[workspace] !== start || list.includes(project)) return;
      kept.opened[workspace] = [...list, project];
      save(kept);
    },
    flush: () => writing,
  };
}
