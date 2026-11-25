// Run history (docs/DESIGN.md "History"): one record per finished run, in Runner's records folder
// in the workspace, and the run's output log beside it — moved there from the state folder, where
// the keeper wrote it while the run went, when the run ends (`keepOutputLog`).
//
// - **Format.** JSON Lines, one file per day of the runs' ends (UTC): `history/YYYY-MM-DD.jsonl`. A
//   record is written once, when its run ends, as one line appended, so a crash can at worst leave
//   a half line at the end of a file. A reader skips a line that is not a record, and the first
//   append to a file that does not end with a newline starts a new line first, so a half line never
//   swallows the next record. The one record written again is a service's crash window's, as its
//   restarts add up (`put`): its line is replaced where it stands, the day file written whole
//   through a temporary file beside it, so no line moves and no reader sees half a file.
// - **Pruning** is by whole days: a day's file and the output logs of runs that started that day
//   go once the day is as many days behind as the settings keep (`history-days`); a log a session
//   still writes stays.
// - **Reading** is newest first, a page at a time; a page ends at a cursor (`<day>:<line>`) the next
//   page starts before. Records are only appended or replaced in place and days only removed whole,
//   so a cursor stays valid while new runs land.
// - **Output.** A record keeps its output log by name (`keptRecord`: `output/<job>/<run>.log`), never
//   by a path, so a workspace copied to another Mac carries none of the first's; read back, it names
//   the log where it is found (`findOutputLog`): kept, else still in the state folder.
// - **The move** of a finished run's log is one rename (a copy, flushed, then the source removed,
//   across volumes), done before its record is written and safe to repeat: a reader never finds a
//   record whose log it cannot resolve.

import { access, appendFile, copyFile, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  findOutputLog,
  historyFolder,
  keptOutputFolder,
  keptOutputLogPath,
  liveOutputFolder,
  liveOutputLogPath,
  outputLogName,
  type RecordsFolder,
  type StateFolder,
} from "../locations";
import type { Log } from "./log";
import { LAST_LINES, parseRunRecord, plainLines, type HistoryPage, type RunOutput, type RunRecord } from "./model";

/** A page of the history's records: a `HistoryPage` but its held rows, which the runs know. */
export type HistoryRecords = Omit<HistoryPage, "held">;

/** The most a page holds. */
export const PAGE_MAX = 200;
/** How much of a log `output` reads: its end. */
export const OUTPUT_MAX_BYTES = 1024 * 1024;
/** How much of a log's end the last lines come from. */
const TAIL_BYTES = 64 * 1024;
/** A kept line is cut to this many characters. */
const LINE_MAX = 400;

const DAY_MS = 86_400_000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** A run's output log, or a git run's result its record never took (a scheduler that stopped in
 *  between). */
const RUN_FILE_RE = /^(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{6}\.(?:log|json)$/;

export interface History {
  /** Write a finished run's record. Writes happen in order and never overlap. */
  append(record: RunRecord): Promise<void>;
  /** Write a record that may be written already — a crash window's, as its restarts add up: the
   *  line of the same job and run is replaced where it stands, in the newest day file that has it;
   *  without one, the record is appended. */
  put(record: RunRecord): Promise<void>;
  /** Records newest first, of every job or of `job` — and of the ids it had before (`formerly`) —
   *  starting before the cursor `before`. */
  page(options: { job: string | null; formerly?: readonly string[]; before: string | null; limit: number }): Promise<HistoryRecords>;
  /** A run's record; `null` when there is none (yet, or any more). */
  find(job: string, run: string): Promise<RunRecord | null>;
  /** The service event that ended the session the event `run` of `job` started; `null` when there
   *  is none (yet, or any more), or `run` started no session. */
  sessionEnd(job: string, run: string): Promise<RunRecord | null>;
  /** Remove the days `keepDays` behind `now`, with their runs' output logs, kept or in the state
   *  folder — except the logs in `inUse`. */
  prune(now: Date, keepDays: number, inUse: ReadonlySet<string>): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const dayOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

function parseLine(line: string): RunRecord | null {
  if (line === "") return null;
  try {
    const value: unknown = JSON.parse(line);
    return parseRunRecord(value);
  } catch {
    return null;
  }
}

/** A run with an output log, or without one (`log: null`). */
interface Logged {
  job: string;
  run: string;
  log: string | null;
}

/** A run as the records folder keeps it: its output log by name, not by a path on this Mac. */
export function keptRecord<T extends Logged>(record: T): T {
  return record.log === null ? record : { ...record, log: outputLogName(record.job, record.run) };
}

/** A kept record with its output log where a reader finds it. */
export async function foundRecord<T extends Logged>(records: RecordsFolder, state: StateFolder, record: T): Promise<T> {
  return record.log === null ? record : { ...record, log: await findOutputLog(records, state, record.job, record.run) };
}

const exists = (path: string): Promise<boolean> => access(path).then(
  () => true,
  () => false,
);

/** Move a finished run's output log from the state folder into the records folder; where it is
 *  kept, or `null` when it is in neither. Done again after an interruption, it finishes the move. */
export async function keepOutputLog(records: RecordsFolder, state: StateFolder, job: string, run: string): Promise<string | null> {
  const live = liveOutputLogPath(state, job, run);
  const kept = keptOutputLogPath(records, job, run);
  if (!(await exists(live))) return (await exists(kept)) ? kept : null;
  await mkdir(dirname(kept), { recursive: true });
  try {
    await rename(live, kept);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    const part = `${kept}.part`;
    await copyFile(live, part);
    const handle = await open(part, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(part, kept);
    await rm(live, { force: true });
  }
  return kept;
}

/** A cursor: the day file and the line a page starts before. */
function parseCursor(cursor: string | null): { day: string; line: number } | null {
  const match = cursor === null ? null : /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(cursor);
  return match === null ? null : { day: match[1] ?? "", line: Number(match[2]) };
}

export function createHistory(records: RecordsFolder, state: StateFolder, log: Log): History {
  const folder = historyFolder(records);
  let writing: Promise<void> = Promise.resolve();
  /** Day files whose end this process has checked for a half line. */
  const checked = new Set<string>();

  async function days(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return [];
    }
    return names.flatMap((name) => DAY_FILE_RE.exec(name)?.[1] ?? []).sort();
  }

  async function lines(day: string): Promise<string[]> {
    try {
      return (await readFile(join(folder, `${day}.jsonl`), "utf8")).split("\n");
    } catch {
      return [];
    }
  }

  /** Whether the file ends in the middle of a line. */
  async function endsMidLine(file: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(file, "r");
    } catch {
      return false;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  }

  async function appendNow(record: RunRecord): Promise<void> {
    const day = dayOf(record.endedAt);
    const file = join(folder, `${day}.jsonl`);
    const line = `${JSON.stringify(keptRecord(record))}\n`;
    await mkdir(folder, { recursive: true });
    let text = line;
    if (!checked.has(day)) {
      if (await endsMidLine(file)) text = `\n${line}`;
      checked.add(day);
    }
    await appendFile(file, text);
  }

  /** Replace the line of `record`'s job and run in the newest day file that has it; whether one did. */
  async function replaceNow(record: RunRecord): Promise<boolean> {
    const needle = JSON.stringify(record.run);
    for (const day of (await days()).reverse()) {
      const text = await lines(day);
      for (let index = text.length - 1; index >= 0; index--) {
        const line = text[index] ?? "";
        if (!line.includes(needle)) continue;
        const found = parseLine(line);
        if (found?.job !== record.job || found.run !== record.run) continue;
        text[index] = JSON.stringify(keptRecord(record));
        const file = join(folder, `${day}.jsonl`);
        await writeFile(`${file}.tmp`, text.join("\n"));
        await rename(`${file}.tmp`, file);
        return true;
      }
    }
    return false;
  }

  async function find(job: string, run: string): Promise<RunRecord | null> {
    const needle = JSON.stringify(run);
    for (const day of (await days()).reverse()) {
      const text = await lines(day);
      for (let index = text.length - 1; index >= 0; index--) {
        const line = text[index] ?? "";
        if (!line.includes(needle)) continue;
        const record = parseLine(line);
        if (record?.job === job && record.run === run) return foundRecord(records, state, record);
      }
    }
    return null;
  }

  /** Run `work` after every write before it; a write that fails is logged. */
  function write(work: () => Promise<void>): Promise<void> {
    writing = writing.then(work).catch((err: unknown) => log(`history: cannot write to ${folder}: ${errorText(err)}`));
    return writing;
  }

  return {
    append: (record) => write(() => appendNow(record)),

    put: (record) =>
      write(async () => {
        if (!(await replaceNow(record))) await appendNow(record);
      }),

    async page({ job, formerly = [], before, limit }) {
      const ids = job === null ? null : new Set([job, ...formerly]);
      const want = Math.max(1, Math.min(PAGE_MAX, limit));
      const cursor = parseCursor(before);
      const found: RunRecord[] = [];
      const all = (await days()).reverse();
      for (const day of all) {
        if (cursor !== null && day > cursor.day) continue;
        const text = await lines(day);
        const start = cursor !== null && day === cursor.day ? Math.min(cursor.line, text.length) : text.length;
        for (let index = start - 1; index >= 0; index--) {
          const record = parseLine(text[index] ?? "");
          if (record === null || (ids !== null && !ids.has(record.job))) continue;
          if (found.length === want) return { records: await Promise.all(found.map((each) => foundRecord(records, state, each))), next: `${day}:${index + 1}` };
          found.push(record);
        }
      }
      return { records: await Promise.all(found.map((each) => foundRecord(records, state, each))), next: null };
    },

    find,

    async sessionEnd(job, run) {
      const session = (await find(job, run))?.event?.session ?? null;
      if (session === null) return null;
      const needle = JSON.stringify(job);
      for (const day of (await days()).reverse()) {
        const text = await lines(day);
        for (let index = text.length - 1; index >= 0; index--) {
          const line = text[index] ?? "";
          if (!line.includes(needle)) continue;
          const record = parseLine(line);
          if (record?.job === job && record.event?.ended.includes(session) === true) return record;
        }
      }
      return null;
    },

    async prune(now, keepDays, inUse) {
      const cutoff = dayOf(now.getTime() - keepDays * DAY_MS);
      for (const day of await days()) {
        if (day >= cutoff) continue;
        await rm(join(folder, `${day}.jsonl`), { force: true });
        checked.delete(day);
        log(`history: removed the runs of ${day}`);
      }
      for (const output of [keptOutputFolder(records), liveOutputFolder(state)]) {
        let jobs: string[];
        try {
          jobs = await readdir(output);
        } catch {
          continue;
        }
        for (const job of jobs) {
          let logs: string[];
          try {
            logs = await readdir(join(output, job));
          } catch {
            continue;
          }
          let left = logs.length;
          for (const name of logs) {
            const match = RUN_FILE_RE.exec(name);
            const file = join(output, job, name);
            if (match === null || `${match[1]}-${match[2]}-${match[3]}` >= cutoff || inUse.has(file)) continue;
            await rm(file, { force: true });
            left--;
          }
          if (left === 0) await rmdir(join(output, job)).catch(() => undefined);
        }
      }
    },
  };
}

/** The end of a log, at most `maxBytes` of it; an empty, missing output when the file cannot be
 *  read. */
export async function readOutput(file: string, maxBytes = OUTPUT_MAX_BYTES): Promise<RunOutput> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return { text: "", truncated: false, missing: true };
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // A cut in the middle of a character or a line: start at the next whole line.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: length < size, missing: false };
  } finally {
    await handle.close();
  }
}

/** The last `count` lines of a run's output, plain, each cut to `LINE_MAX` characters; trailing
 *  empty lines left out. */
export async function lastLines(file: string, count = LAST_LINES): Promise<string[]> {
  const { text } = await readOutput(file, TAIL_BYTES);
  const plain = plainLines(text);
  while (plain.length > 0 && (plain.at(-1) ?? "").trim() === "") plain.pop();
  return plain.slice(-count).map((line) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line));
}
