// Run history (docs/DESIGN.md "History"): one record per finished run, in Runner's state folder,
// and the run's output log beside it.
//
// - **Format.** Append-only JSON Lines, one file per day of the runs' ends (UTC):
//   `history/YYYY-MM-DD.jsonl`. A record is written once, when its run ends, as one line; nothing
//   is ever rewritten, so a crash can at worst leave a half line at the end of a file. A reader
//   skips a line that is not a record, and the first append to a file that does not end with a
//   newline starts a new line first, so a half line never swallows the next record.
// - **Pruning** is by whole days: a day's file and the output logs of runs that started that day
//   go once the day is as many days behind as the settings keep (`history-days`); a log a session
//   still writes stays.
// - **Reading** is newest first, a page at a time; a page ends at a cursor (`<day>:<line>`) the next
//   page starts before. Records are only appended and days only removed whole, so a cursor stays
//   valid while new runs land.

import { appendFile, mkdir, open, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

import type { Log } from "./log";
import { isRunRecord, LAST_LINES, plainLines, type HistoryPage, type RunOutput, type RunRecord } from "./model";

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
const RUN_LOG_RE = /^(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{6}\.log$/;

export interface History {
  /** Write a finished run's record. Appends happen in order and never overlap. */
  append(record: RunRecord): Promise<void>;
  /** Records newest first, of every job or of `job`, starting before the cursor `before`. */
  page(options: { job: string | null; before: string | null; limit: number }): Promise<HistoryPage>;
  /** A run's record; `null` when there is none (yet, or any more). */
  find(job: string, run: string): Promise<RunRecord | null>;
  /** Remove the days `keepDays` behind `now`, with their runs' output logs — except the logs in
   *  `inUse`. */
  prune(now: Date, keepDays: number, inUse: ReadonlySet<string>): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const dayOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

function parseLine(line: string): RunRecord | null {
  if (line === "") return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRunRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A cursor: the day file and the line a page starts before. */
function parseCursor(cursor: string | null): { day: string; line: number } | null {
  const match = cursor === null ? null : /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(cursor);
  return match === null ? null : { day: match[1] ?? "", line: Number(match[2]) };
}

export function createHistory(state: string, log: Log): History {
  const folder = join(state, "history");
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

  return {
    append(record) {
      const day = dayOf(record.endedAt);
      const file = join(folder, `${day}.jsonl`);
      const line = `${JSON.stringify(record)}\n`;
      const done = writing.then(async () => {
        await mkdir(folder, { recursive: true });
        let text = line;
        if (!checked.has(day)) {
          if (await endsMidLine(file)) text = `\n${line}`;
          checked.add(day);
        }
        await appendFile(file, text);
      });
      writing = done.catch((err: unknown) => log(`history: cannot write ${file}: ${errorText(err)}`));
      return writing;
    },

    async page({ job, before, limit }) {
      const want = Math.max(1, Math.min(PAGE_MAX, limit));
      const cursor = parseCursor(before);
      const records: RunRecord[] = [];
      const all = (await days()).reverse();
      for (const day of all) {
        if (cursor !== null && day > cursor.day) continue;
        const text = await lines(day);
        const start = cursor !== null && day === cursor.day ? Math.min(cursor.line, text.length) : text.length;
        for (let index = start - 1; index >= 0; index--) {
          const record = parseLine(text[index] ?? "");
          if (record === null || (job !== null && record.job !== job)) continue;
          if (records.length === want) return { records, next: `${day}:${index + 1}` };
          records.push(record);
        }
      }
      return { records, next: null };
    },

    async find(job, run) {
      const needle = JSON.stringify(run);
      for (const day of (await days()).reverse()) {
        const text = await lines(day);
        for (let index = text.length - 1; index >= 0; index--) {
          const line = text[index] ?? "";
          if (!line.includes(needle)) continue;
          const record = parseLine(line);
          if (record?.job === job && record.run === run) return record;
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
      const output = join(state, "output");
      let jobs: string[];
      try {
        jobs = await readdir(output);
      } catch {
        return;
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
          const match = RUN_LOG_RE.exec(name);
          const file = join(output, job, name);
          if (match === null || `${match[1]}-${match[2]}-${match[3]}` >= cutoff || inUse.has(file)) continue;
          await rm(file, { force: true });
          left--;
        }
        if (left === 0) await rmdir(join(output, job)).catch(() => undefined);
      }
    },
  };
}

/** The end of a log, at most `maxBytes` of it; an empty output when the file cannot be read. */
export async function readOutput(file: string, maxBytes = OUTPUT_MAX_BYTES): Promise<RunOutput> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return { text: "", truncated: false };
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // A cut in the middle of a character or a line: start at the next whole line.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: length < size };
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
