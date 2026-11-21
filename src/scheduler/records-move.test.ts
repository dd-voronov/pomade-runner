// The records' move from a state folder into a workspace's records folder, on temp folders: what
// moves and what stays — a finished run's output log moves, a service's or a run going's stays — the
// logs named by job and run, a move stopped halfway and run again, a second run that does nothing,
// and what the workspace already holds.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileStore } from "../keeper/supervisor";
import { recordsFolderOf, stateFolderOf, type RecordsFolder, type StateFolder } from "../locations";
import { moveRecords } from "./records-move";
import { fileRunsStore } from "./runs";
import { fileSwitchStore } from "./switch";

const RUN = "20261117-080000-a1b2c3";
const line = (job: string, run: string, log: string | null = null): string => JSON.stringify({ job, run, log });

describe("the records' move into the workspace", () => {
  let dir: string;
  let state: StateFolder;
  let records: RecordsFolder;
  let lines: string[];

  /** Every file under `folder`, relative, sorted. */
  async function files(folder: string): Promise<string[]> {
    const found: string[] = [];
    async function walk(relative: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(join(folder, relative), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else found.push(path);
      }
    }
    await walk("");
    return found.sort();
  }

  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  /** A state folder as a scheduler that kept its records there left it. */
  async function oldState(): Promise<void> {
    await put(join(state, "history/2026-11-16.jsonl"), `${line("backup", "r1")}\n`);
    await put(join(state, "history/2026-11-17.jsonl"), `${line("backup", RUN, join(state, `output/backup/${RUN}.log`))}\n${line("web", "r3")}\n`);
    await put(join(state, `output/backup/${RUN}.log`), "backed up\n");
    await put(join(state, `output/pull/${RUN}.json`), "{}");
    await put(join(state, `output/web/${RUN}.log`), "serving\n");
    await put(join(state, "output/slow/20261117-090000-ffffff.log"), "going\n");
    await put(join(state, "runs.json"), JSON.stringify({ active: [JSON.parse(line("slow", "20261117-090000-ffffff", join(state, "output/slow/20261117-090000-ffffff.log"))) as unknown], last: { backup: JSON.parse(line("backup", RUN, join(state, `output/backup/${RUN}.log`))) as unknown }, lookedAt: 1000, held: {} }));
    await put(join(state, "switch.json"), JSON.stringify({ position: "pause-all", since: 5 }));
    await put(join(state, "needs-you.json"), JSON.stringify({ failures: {}, gaveUp: { web: 7 } }));
    await put(
      join(state, "services.json"),
      JSON.stringify({ services: { api: { hold: "stopped-by-you", restarts: 0, lastCrashAt: null, crashes: [], retryAt: null, problem: null }, web: { hold: "failed", restarts: 5, lastCrashAt: 9, crashes: [9], retryAt: null, problem: null } } }),
    );
    await put(join(state, "sessions.json"), "{}");
    await put(join(state, "projects.json"), "{}");
    await put(join(state, "keeper/keeper.out"), "");
  }

  const MOVED = [
    "history/2026-11-16.jsonl",
    "history/2026-11-17.jsonl",
    "needs-you.json",
    `output/backup/${RUN}.log`,
    "runs.json",
    "services.json",
    "switch.json",
  ];
  const STAYS = ["keeper/keeper.out", `output/pull/${RUN}.json`, "output/slow/20261117-090000-ffffff.log", `output/web/${RUN}.log`, "projects.json", "services.json", "sessions.json"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prm-"));
    state = stateFolderOf(join(dir, "ud"));
    records = recordsFolderOf(join(dir, "ws"));
    lines = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("moves history, runs, the switch and Needs you, the finished runs' output logs and the services you stopped; the state folder keeps this Mac's own", async () => {
    await oldState();
    expect(await moveRecords(state, records, (text) => lines.push(text))).toBe(7);
    expect(await files(records)).toEqual(MOVED);
    expect(await files(state)).toEqual(STAYS);
    expect(lines).toEqual([`records: moved 7 files from ${state} into ${records}`]);
    expect(await readFile(join(records, `output/backup/${RUN}.log`), "utf8")).toBe("backed up\n");

    // The records name the output log by job and run, and read back find it in this state folder.
    expect(await readFile(join(records, "history/2026-11-17.jsonl"), "utf8")).toBe(`${line("backup", RUN, `output/backup/${RUN}.log`)}\n${line("web", "r3")}\n`);
    expect(await readFile(join(records, "runs.json"), "utf8")).not.toContain(state);
    expect(JSON.parse(await readFile(join(records, "runs.json"), "utf8"))).toMatchObject({ last: { backup: { log: `output/backup/${RUN}.log` } } });
    expect(await fileSwitchStore(records, () => undefined).load()).toEqual({ position: "pause-all", since: 5 });
    expect((await fileRunsStore(records, state, () => undefined).load()).lookedAt).toBe(1000);
    expect(await fileStore(state, records, () => undefined).load()).toEqual(
      new Map([
        ["api", { hold: "stopped-by-you", restarts: 0, lastCrashAt: null, crashes: [], retryAt: null, problem: null }],
        ["web", { hold: "failed", restarts: 5, lastCrashAt: 9, crashes: [9], retryAt: null, problem: null }],
      ]),
    );
  });

  it("does nothing once moved, and nothing with no state folder at all", async () => {
    await oldState();
    await moveRecords(state, records, () => undefined);
    const before = await files(records);
    expect(await moveRecords(state, records, (text) => lines.push(text))).toBe(0);
    expect(await files(records)).toEqual(before);
    expect(await files(state)).toEqual(STAYS);
    expect(await moveRecords(stateFolderOf(join(dir, "none")), recordsFolderOf(join(dir, "empty")), (text) => lines.push(text))).toBe(0);
    expect(await files(join(dir, "empty"))).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("finishes a move stopped halfway: a file at both places, a temporary copy left behind", async () => {
    await oldState();
    // Stopped after a day was written but before its source went, and in the middle of a write.
    await put(join(records, "history/2026-11-17.jsonl"), `${line("backup", RUN, `output/backup/${RUN}.log`)}\n`);
    await put(join(records, "runs.json.move"), "{ half");
    await moveRecords(state, records, () => undefined);
    expect(await files(records)).toEqual(MOVED);
    expect(await files(state)).toEqual(STAYS);
    expect(await readFile(join(records, "history/2026-11-17.jsonl"), "utf8")).toBe(`${line("backup", RUN, `output/backup/${RUN}.log`)}\n${line("web", "r3")}\n`);
    expect((await fileRunsStore(records, state, () => undefined).load()).lookedAt).toBe(1000);
  });

  it("keeps what the workspace holds already: a day gets only the lines it lacks, its records stay its own, and this Mac's are left unread", async () => {
    await oldState();
    await put(join(records, "history/2026-11-17.jsonl"), `${line("other", "r9")}`);
    await put(join(records, "switch.json"), JSON.stringify({ position: "running", since: null }));
    await put(join(records, "services.json"), JSON.stringify({ stoppedByYou: ["db"] }));
    await moveRecords(state, records, () => undefined);
    expect(await readFile(join(records, "history/2026-11-17.jsonl"), "utf8")).toBe(`${line("other", "r9")}\n${line("backup", RUN, `output/backup/${RUN}.log`)}\n${line("web", "r3")}\n`);
    expect(await fileSwitchStore(records, () => undefined).load()).toEqual({ position: "running", since: null });
    expect(JSON.parse(await readFile(join(records, "services.json"), "utf8"))).toEqual({ stoppedByYou: ["db"] });
    expect(await files(state)).toEqual([...STAYS, "switch.json"]);
  });

  it("says a file it cannot move, and moves it on the next start", async () => {
    await oldState();
    await put(join(dir, "ws/Apps/pomade-runner/records"), "a file where the folder goes");
    await moveRecords(state, records, (text) => lines.push(text));
    expect(lines.some((text) => text.startsWith(`records: cannot move ${join(state, "runs.json")}: `) && text.endsWith("; the next start tries again"))).toBe(true);
    expect(await files(state)).toContain("runs.json");
    await rm(join(dir, "ws/Apps/pomade-runner/records"));
    await moveRecords(state, records, () => undefined);
    expect(await files(records)).toEqual(MOVED);
    expect(await files(state)).toEqual(STAYS);
  });
});
