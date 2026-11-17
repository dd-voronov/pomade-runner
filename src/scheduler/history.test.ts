// The history store on a temp folder: append-only day files, pages newest first with a cursor that
// stays valid, a half line left by a crash, finding a run, pruning by day with the output logs, and
// a run's output as plain last lines.

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHistory, lastLines, readOutput, type History } from "./history";
import { plainLines, type RunRecord } from "./model";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-17T12:00:00.000Z");

function record(job: string, run: string, endedAt: number, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    job,
    name: job,
    kind: "script",
    project: null,
    folder: "",
    run,
    trigger: "scheduled",
    cause: null,
    dueAt: endedAt - 1000,
    state: "done",
    action: null,
    reason: null,
    startedAt: endedAt - 1000,
    endedAt,
    durationMs: 1000,
    exitCode: 0,
    signal: null,
    log: null,
    lastLines: [],
    git: null,
    ...extra,
  };
}

describe("history", () => {
  let state: string;
  let lines: string[];
  let history: History;

  beforeEach(async () => {
    state = await mkdtemp(join(tmpdir(), "prh-"));
    lines = [];
    history = createHistory(state, (line) => lines.push(line));
  });

  afterEach(async () => {
    await rm(state, { recursive: true, force: true });
  });

  it("appends one line per record to the file of the day the run ended (UTC)", async () => {
    await history.append(record("a", "r1", T0));
    await history.append(record("b", "r2", T0 + 1000));
    await history.append(record("a", "r3", T0 + DAY));
    expect((await readdir(join(state, "history"))).sort()).toEqual(["2026-11-17.jsonl", "2026-11-18.jsonl"]);
    const first = (await readFile(join(state, "history/2026-11-17.jsonl"), "utf8")).split("\n");
    expect(first).toHaveLength(3);
    expect(first[2]).toBe("");
    expect(JSON.parse(first[0] ?? "")).toEqual(record("a", "r1", T0));
  });

  it("pages newest first, of every job or one, and the cursor holds while runs land", async () => {
    for (let i = 0; i < 5; i++) await history.append(record(i % 2 === 0 ? "even" : "odd", `r${i}`, T0 + i * DAY));
    const page = await history.page({ job: null, before: null, limit: 2 });
    expect(page.records.map((r) => r.run)).toEqual(["r4", "r3"]);
    expect(page.next).not.toBeNull();
    await history.append(record("odd", "r5", T0 + 5 * DAY));
    const second = await history.page({ job: null, before: page.next, limit: 2 });
    expect(second.records.map((r) => r.run)).toEqual(["r2", "r1"]);
    const last = await history.page({ job: null, before: second.next, limit: 2 });
    expect(last).toEqual({ records: [record("even", "r0", T0)], next: null });
    expect((await history.page({ job: "even", before: null, limit: 10 })).records.map((r) => r.run)).toEqual(["r4", "r2", "r0"]);
    expect((await history.page({ job: "odd", before: null, limit: 1 })).records.map((r) => r.run)).toEqual(["r5"]);
    expect((await history.page({ job: "nope", before: null, limit: 10 })).records).toEqual([]);
    expect((await history.page({ job: null, before: "nonsense", limit: 1 })).records.map((r) => r.run)).toEqual(["r5"]);
  });

  it("several records of one day page within the day", async () => {
    for (let i = 0; i < 4; i++) await history.append(record("a", `r${i}`, T0 + i * 1000));
    const first = await history.page({ job: null, before: null, limit: 3 });
    expect(first.records.map((r) => r.run)).toEqual(["r3", "r2", "r1"]);
    expect(first.next).toBe("2026-11-17:1");
    expect((await history.page({ job: null, before: first.next, limit: 3 })).records.map((r) => r.run)).toEqual(["r0"]);
  });

  it("skips a half line a crash left, and starts the next record on a line of its own", async () => {
    await history.append(record("a", "r1", T0));
    await appendFile(join(state, "history/2026-11-17.jsonl"), '{"job":"a","run":"half');
    const reopened = createHistory(state, () => undefined);
    await reopened.append(record("a", "r2", T0 + 1000));
    expect((await reopened.page({ job: null, before: null, limit: 10 })).records.map((r) => r.run)).toEqual(["r2", "r1"]);
    await writeFile(join(state, "history/2026-11-17.jsonl"), "not json\n{}\n", { flag: "a" });
    expect((await reopened.page({ job: null, before: null, limit: 10 })).records.map((r) => r.run)).toEqual(["r2", "r1"]);
  });

  it("finds a run's record, newest day first", async () => {
    await history.append(record("a", "r1", T0));
    await history.append(record("b", "r1", T0 + DAY, { state: "failed", exitCode: 1 }));
    expect(await history.find("b", "r1")).toMatchObject({ job: "b", state: "failed" });
    expect(await history.find("a", "r1")).toMatchObject({ job: "a", state: "done" });
    expect(await history.find("a", "r9")).toBeNull();
    expect(await createHistory(join(state, "none"), () => undefined).find("a", "r1")).toBeNull();
  });

  it("prunes the days the setting keeps behind, and their runs' output logs, never a log in use", async () => {
    const HISTORY_DAYS = 30;
    const old = T0 - (HISTORY_DAYS + 1) * DAY;
    await history.append(record("a", "old", old));
    await history.append(record("a", "edge", T0 - HISTORY_DAYS * DAY));
    await history.append(record("a", "new", T0));
    const output = join(state, "output");
    await mkdir(join(output, "a"), { recursive: true });
    await mkdir(join(output, "svc"), { recursive: true });
    await mkdir(join(output, "gone"), { recursive: true });
    const oldRun = "20261016-120000-aaaaaa";
    for (const file of [join(output, "a", `${oldRun}.log`), join(output, "a", "20261117-120000-bbbbbb.log"), join(output, "svc", `${oldRun}.log`), join(output, "gone", `${oldRun}.log`), join(output, "a", "notes.txt")]) {
      await writeFile(file, "x");
    }
    await history.prune(new Date(T0), HISTORY_DAYS, new Set([join(output, "svc", `${oldRun}.log`)]));
    expect((await readdir(join(state, "history"))).sort()).toEqual(["2026-10-18.jsonl", "2026-11-17.jsonl"]);
    expect((await readdir(join(output, "a"))).sort()).toEqual(["20261117-120000-bbbbbb.log", "notes.txt"]);
    expect(await readdir(join(output, "svc"))).toEqual([`${oldRun}.log`]);
    expect((await readdir(output)).sort()).toEqual(["a", "svc"]);
    expect(lines).toEqual(["history: removed the runs of 2026-10-17"]);
    expect((await history.page({ job: null, before: null, limit: 10 })).records.map((r) => r.run)).toEqual(["new", "edge"]);
    await createHistory(join(state, "empty"), () => undefined).prune(new Date(T0), HISTORY_DAYS, new Set());
    // Fewer days kept: the edge day goes too.
    await history.prune(new Date(T0), 7, new Set());
    expect(await readdir(join(state, "history"))).toEqual(["2026-11-17.jsonl"]);
  });

  it("reads a log's end, from a whole line, and says when it cut", async () => {
    const file = join(state, "run.log");
    await writeFile(file, "first line\nsecond line\nthird\n");
    expect(await readOutput(file)).toEqual({ text: "first line\nsecond line\nthird\n", truncated: false });
    expect(await readOutput(file, 15)).toEqual({ text: "third\n", truncated: true });
    expect(await readOutput(join(state, "missing.log"))).toEqual({ text: "", truncated: false });
  });

  it("turns terminal output into plain lines: colours, titles and cursor moves gone, a rewritten line as it ended", () => {
    expect(plainLines("\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07plain\r\nhalf 10%\rhalf 100%\r\n\x1b[2K\x1b[1Gdone\ttab\x07")).toEqual(["red", "plain", "half 100%", "done\ttab"]);
  });

  it("keeps a run's last lines, plain, cut long, without trailing blank lines", async () => {
    const file = join(state, "run.log");
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\r\n");
    await writeFile(file, `${body}\r\n${"x".repeat(500)}\r\n\r\n\r\n`);
    const last = await lastLines(file);
    expect(last).toHaveLength(20);
    expect(last[0]).toBe("line 12");
    expect(last.at(-1)).toBe(`${"x".repeat(399)}…`);
    expect(await lastLines(join(state, "missing.log"))).toEqual([]);
  });
});
