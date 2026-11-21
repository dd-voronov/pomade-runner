// The records' move into the workspace (docs/DESIGN.md "Data and locations"): what a state folder
// still holds of the Owner's records — run history, `runs.json`, `switch.json`, `needs-you.json`,
// the services the Owner stopped — goes into the workspace's records folder when the scheduler
// starts on that workspace, so nothing already recorded is lost — with the output logs of the runs
// already finished. A run going keeps writing its log in the state folder and moves it at its end;
// services' output and git results stay.
//
// - **Safe to stop halfway.** Every file reaches its place whole — written into a temporary file
//   beside it and renamed — before its source is removed, so a move stopped at any point loses
//   nothing and the next start finishes it.
// - **Logs by name.** A moved record names its output log by job and run (`output/<job>/<run>.log`)
//   instead of by a path on this Mac; the logs of the finished runs the moved records name move
//   beside them (`keepOutputLog`), each one rename.
// - **A no-op afterwards.** A moved file is gone from the state folder; with nothing left there the
//   move only looks.
// - **What the workspace already has stays.** A day of history both hold gets the lines it lacks; a
//   `runs.json`, `switch.json` or `needs-you.json` already there is the workspace's own, and this
//   Mac's is left where it was, unread. The services the Owner stopped are read out of this Mac's
//   `services.json`, which stays — its crash counts are this Mac's — unless the workspace keeps its
//   own list already.

import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { serviceHoldsText } from "../keeper/supervisor";
import {
  historyFolder,
  liveOutputLogPath,
  needsYouRecordPath,
  outputLogName,
  runsRecordPath,
  serviceHoldsPath,
  supervisionRecordPath,
  switchRecordPath,
  type RecordsFolder,
  type StateFolder,
} from "../locations";
import { keepOutputLog } from "./history";
import type { Log } from "./log";

// The state folder's own names for what it held: the move is what still reads them there.
const historyIn = (state: StateFolder): string => join(state, "history");
const asIs = (text: string): string => text;
const recordFilesIn = (state: StateFolder, records: RecordsFolder): [from: string, to: string, kept: (text: string) => string][] => [
  [join(state, "runs.json"), runsRecordPath(records), keptRuns],
  [join(state, "switch.json"), switchRecordPath(records), asIs],
  [join(state, "needs-you.json"), needsYouRecordPath(records), asIs],
];

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function list(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort();
  } catch {
    return [];
  }
}

/** Write `text` to `file` whole, through a temporary file beside it. */
async function replace(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.move`, text);
  await rename(`${file}.move`, file);
}

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A run as the records folder keeps it: its output log by name, not by a path on this Mac. */
function keptRun(value: unknown): unknown {
  if (!isJson(value) || typeof value.log !== "string" || typeof value.job !== "string" || typeof value.run !== "string") return value;
  return { ...value, log: outputLogName(value.job, value.run) };
}

/** A line of history as the records folder keeps it; a line that is not JSON as it is. */
function keptLine(line: string): string {
  try {
    return JSON.stringify(keptRun(JSON.parse(line)));
  } catch {
    return line;
  }
}

/** `runs.json` as the records folder keeps it: the runs going and each job's latest by name. */
function keptRuns(text: string): string {
  const data: unknown = JSON.parse(text);
  if (!isJson(data)) return text;
  const active = Array.isArray(data.active) ? data.active.map(keptRun) : data.active;
  const last = isJson(data.last) ? Object.fromEntries(Object.entries(data.last).map(([job, run]) => [job, keptRun(run)])) : data.last;
  return `${JSON.stringify({ ...data, active, last }, null, 2)}\n`;
}

/** A day of history: the source's lines the target lacks are added; then the source goes. */
async function moveDay(from: string, to: string): Promise<void> {
  let target = "";
  try {
    target = await readFile(to, "utf8");
  } catch {
    // Not there yet: the day is the source's alone.
  }
  const have = new Set(target.split("\n"));
  const missing = (await readFile(from, "utf8")).split("\n").filter((line) => line !== "").map(keptLine).filter((line) => !have.has(line));
  if (missing.length > 0) await replace(to, `${target}${target === "" || target.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
  await rm(from, { force: true });
}

/** The finished runs with an output log that the records folder's history and `runs.json` name. */
async function finishedRuns(records: RecordsFolder): Promise<{ job: string; run: string }[]> {
  const found = new Map<string, { job: string; run: string }>();
  const add = (value: unknown): void => {
    if (isJson(value) && typeof value.job === "string" && typeof value.run === "string" && typeof value.log === "string") found.set(`${value.job}\n${value.run}`, { job: value.job, run: value.run });
  };
  for (const name of await list(historyFolder(records))) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(historyFolder(records), name), "utf8")).split("\n")) {
      try {
        add(JSON.parse(line));
      } catch {
        // Not a record.
      }
    }
  }
  try {
    const data: unknown = JSON.parse(await readFile(runsRecordPath(records), "utf8"));
    if (isJson(data) && isJson(data.last)) Object.values(data.last).forEach(add);
  } catch {
    // No runs.json, or not JSON: its runs are in the history too.
  }
  return [...found.values()];
}

/** Move what `state` holds of the records into `records`; how many files moved. A file that cannot
 *  move is said in the log and stays for the next start. */
export async function moveRecords(state: StateFolder, records: RecordsFolder, log: Log): Promise<number> {
  let moved = 0;
  const attempt = async (what: string, step: () => Promise<boolean>): Promise<void> => {
    try {
      if (await step()) moved++;
    } catch (err) {
      log(`records: cannot move ${what}: ${errorText(err)}; the next start tries again`);
    }
  };

  for (const name of await list(historyIn(state))) {
    if (!name.endsWith(".jsonl")) continue;
    const from = join(historyIn(state), name);
    await attempt(from, async () => {
      await moveDay(from, join(historyFolder(records), name));
      return true;
    });
  }
  await rmdir(historyIn(state)).catch(() => undefined);

  for (const [from, to, kept] of recordFilesIn(state, records)) {
    await attempt(from, async () => {
      if (!(await exists(from)) || (await exists(to))) return false;
      await replace(to, kept(await readFile(from, "utf8")));
      await rm(from, { force: true });
      return true;
    });
  }

  for (const { job, run } of await finishedRuns(records)) {
    await attempt(`the output log of ${job} ${run}`, async () => {
      const live = liveOutputLogPath(state, job, run);
      if (!(await exists(live))) return false;
      await keepOutputLog(records, state, job, run);
      return true;
    });
  }

  const holds = serviceHoldsPath(records);
  await attempt(holds, async () => {
    const machine = supervisionRecordPath(state);
    if ((await exists(holds)) || !(await exists(machine))) return false;
    const data: unknown = JSON.parse(await readFile(machine, "utf8"));
    const services = typeof data === "object" && data !== null ? (data as Record<string, unknown>).services : null;
    const stopped = typeof services === "object" && services !== null ? Object.entries(services).flatMap(([job, record]) => ((record as Record<string, unknown> | null)?.hold === "stopped-by-you" ? [job] : [])) : [];
    if (stopped.length === 0) return false;
    await replace(holds, serviceHoldsText(stopped));
    return true;
  });

  if (moved > 0) log(`records: moved ${moved} file${moved === 1 ? "" : "s"} from ${state} into ${records}`);
  return moved;
}
