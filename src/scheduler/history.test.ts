// The history store on a temp folder: day files appended to — a crash window's record put again in
// place — pages newest first with a cursor that stays valid, a half line left by a crash, finding a
// run and the event that ended a session, pruning by day with the output logs, and a run's output as
// last lines with their colours.

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { keptOutputLogPath, liveOutputLogPath, recordsFolderOf, stateFolderOf, type RecordsFolder, type StateFolder } from "../locations";
import { createHistory, keepOutputLog, lastLines, readOutput, type History } from "./history";
import type { RunRecord } from "./model";

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
    agent: null,
    missed: null,
    series: null,
    state: "done",
    event: null,
    reason: null,
    startedAt: endedAt - 1000,
    endedAt,
    durationMs: 1000,
    exitCode: 0,
    signal: null,
    log: null,
    lastLines: [],
    git: null,
    limitHit: null,
    ...extra,
  };
}

describe("history", () => {
  let dir: string;
  let records: RecordsFolder;
  let state: StateFolder;
  let lines: string[];
  let history: History;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prh-"));
    records = recordsFolderOf(join(dir, "ws"));
    state = stateFolderOf(join(dir, "ud"));
    lines = [];
    history = createHistory(records, state, (line) => lines.push(line));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends one line per record to the file of the day the run ended (UTC)", async () => {
    await history.append(record("a", "r1", T0));
    await history.append(record("b", "r2", T0 + 1000));
    await history.append(record("a", "r3", T0 + DAY));
    expect((await readdir(join(records, "history"))).sort()).toEqual(["2026-11-17.jsonl", "2026-11-18.jsonl"]);
    const first = (await readFile(join(records, "history/2026-11-17.jsonl"), "utf8")).split("\n");
    expect(first).toHaveLength(3);
    expect(first[2]).toBe("");
    expect(JSON.parse(first[0] ?? "")).toEqual(record("a", "r1", T0));
  });

  it("puts a crash window's record again where it stands — a later day too — and appends one not written yet", async () => {
    const event = (restarts: number, endedAt: number): RunRecord =>
      record("web", "w1", endedAt, { kind: "service", startedAt: null, durationMs: null, event: { what: "restarted", cause: "crash", detail: null, session: restarts, ended: [], restarts, ends: [] } });
    await history.put(event(1, T0));
    await history.append(record("a", "r1", T0 + 1000));
    const before = await history.page({ job: null, before: null, limit: 1 });
    await history.put(event(2, T0 + 2000));
    await history.put(event(3, T0 + DAY));
    const text = (await readFile(join(records, "history/2026-11-17.jsonl"), "utf8")).split("\n");
    expect(text).toHaveLength(3);
    expect(JSON.parse(text[0] ?? "")).toEqual(event(3, T0 + DAY));
    expect(await readdir(join(records, "history"))).toEqual(["2026-11-17.jsonl"]);
    // No line moved: the cursor of a page read before still holds.
    expect((await history.page({ job: null, before: before.next, limit: 5 })).records).toEqual([event(3, T0 + DAY)]);
    expect(await history.find("web", "w1")).toEqual(event(3, T0 + DAY));
  });

  it("finds the event that ended the session an event started", async () => {
    const event = (run: string, at: number, session: number | null, ended: number[]): RunRecord =>
      record("web", run, at, { kind: "service", startedAt: null, durationMs: null, event: { what: session === null ? "stopped" : "started", cause: "you", detail: null, session, ended, restarts: 0, ends: [] } });
    await history.append(event("e1", T0, 7, []));
    await history.append(record("other", "x", T0 + 500, { event: null }));
    expect(await history.sessionEnd("web", "e1")).toBeNull();
    await history.append(event("e2", T0 + DAY, null, [7]));
    expect(await history.sessionEnd("web", "e1")).toEqual(event("e2", T0 + DAY, null, [7]));
    expect(await history.sessionEnd("web", "e2")).toBeNull();
    expect(await history.sessionEnd("web", "none")).toBeNull();
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

  it("a git run's record keeps what each pull got (`commits`), as `pomade-git` printed it", async () => {
    const steps = [{ step: "pull" as const, outcome: "done" as const, detail: "got 2 commits from origin/main", commits: 2 }];
    const git = { op: "pull" as const, job: "Pull", at: "2026-11-17T11:59:59.000Z", results: [{ repo: "notes", path: "/ws/notes", op: "pull" as const, status: "done" as const, reason: null, steps, commit: null }] };
    await history.append(record("pull", "r1", T0, { kind: "git", git }));
    const [read] = (await history.page({ job: null, before: null, limit: 1 })).records;
    expect(read?.git?.results[0]?.steps[0]).toEqual(steps[0]);
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
    await appendFile(join(records, "history/2026-11-17.jsonl"), '{"job":"a","run":"half');
    const reopened = createHistory(records, state, () => undefined);
    await reopened.append(record("a", "r2", T0 + 1000));
    expect((await reopened.page({ job: null, before: null, limit: 10 })).records.map((r) => r.run)).toEqual(["r2", "r1"]);
    await writeFile(join(records, "history/2026-11-17.jsonl"), "not json\n{}\n", { flag: "a" });
    expect((await reopened.page({ job: null, before: null, limit: 10 })).records.map((r) => r.run)).toEqual(["r2", "r1"]);
  });

  it("keeps a record's output log by name, and reads it back where it is: kept, else still in the state folder", async () => {
    await history.append(record("blog/web", "r1", T0, { log: "/Users/other/Library/Application Support/pomade/app-state/pomade-runner/output/blog.web/r1.log" }));
    await history.append(record("a", "r2", T0 + 1000));
    const names = (await readFile(join(records, "history/2026-11-17.jsonl"), "utf8")).split("\n").map((line) => (line === "" ? null : (JSON.parse(line) as RunRecord).log));
    expect(names).toEqual(["output/blog.web/r1.log", null, null]);
    const kept = keptOutputLogPath(records, "blog/web", "r1");
    const live = liveOutputLogPath(state, "blog/web", "r1");
    // In neither place: where it would be kept, which reads as missing.
    expect((await history.page({ job: null, before: null, limit: 10 })).records.map((r) => r.log)).toEqual([null, kept]);
    await mkdir(dirname(live), { recursive: true });
    await writeFile(live, "x");
    expect(await history.find("blog/web", "r1")).toMatchObject({ log: live });
    await mkdir(dirname(kept), { recursive: true });
    await writeFile(kept, "x");
    expect(await history.find("blog/web", "r1")).toMatchObject({ log: kept });
  });

  it("moves a finished run's log into the records folder once, and finishes a move done again", async () => {
    const live = liveOutputLogPath(state, "blog/web", "r1");
    const kept = keptOutputLogPath(records, "blog/web", "r1");
    expect(await keepOutputLog(records, state, "blog/web", "r1")).toBeNull();
    await mkdir(dirname(live), { recursive: true });
    await writeFile(live, "output\n");
    expect(await keepOutputLog(records, state, "blog/web", "r1")).toBe(kept);
    expect(await readFile(kept, "utf8")).toBe("output\n");
    await expect(readFile(live)).rejects.toThrow();
    expect(await keepOutputLog(records, state, "blog/web", "r1")).toBe(kept);
    expect(await readFile(kept, "utf8")).toBe("output\n");
  });

  it("finds a run's record, newest day first", async () => {
    await history.append(record("a", "r1", T0));
    await history.append(record("b", "r1", T0 + DAY, { state: "failed", exitCode: 1 }));
    expect(await history.find("b", "r1")).toMatchObject({ job: "b", state: "failed" });
    expect(await history.find("a", "r1")).toMatchObject({ job: "a", state: "done" });
    expect(await history.find("a", "r9")).toBeNull();
    expect(await createHistory(recordsFolderOf(join(dir, "none")), state, () => undefined).find("a", "r1")).toBeNull();
  });

  it("prunes the days the setting keeps behind, and their runs' output logs — kept or in the state folder — never a log in use", async () => {
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
    const kept = join(records, "output");
    await mkdir(join(kept, "a"), { recursive: true });
    for (const file of [join(kept, "a", `${oldRun}.log`), join(kept, "a", "20261117-120000-cccccc.log")]) await writeFile(file, "x");
    await history.prune(new Date(T0), HISTORY_DAYS, new Set([join(output, "svc", `${oldRun}.log`)]));
    expect((await readdir(join(records, "history"))).sort()).toEqual(["2026-10-18.jsonl", "2026-11-17.jsonl"]);
    expect((await readdir(join(output, "a"))).sort()).toEqual(["20261117-120000-bbbbbb.log", "notes.txt"]);
    expect(await readdir(join(output, "svc"))).toEqual([`${oldRun}.log`]);
    expect((await readdir(output)).sort()).toEqual(["a", "svc"]);
    expect(await readdir(join(kept, "a"))).toEqual(["20261117-120000-cccccc.log"]);
    expect(lines).toEqual(["history: removed the runs of 2026-10-17"]);
    expect((await history.page({ job: null, before: null, limit: 10 })).records.map((r) => r.run)).toEqual(["new", "edge"]);
    await createHistory(recordsFolderOf(join(dir, "empty")), stateFolderOf(join(dir, "empty")), () => undefined).prune(new Date(T0), HISTORY_DAYS, new Set());
    // Fewer days kept: the edge day goes too.
    await history.prune(new Date(T0), 7, new Set());
    expect(await readdir(join(records, "history"))).toEqual(["2026-11-17.jsonl"]);
  });

  it("reads a log's end, from a whole line, and says when it cut", async () => {
    const file = join(dir, "run.log");
    await writeFile(file, "first line\nsecond line\nthird\n");
    expect(await readOutput(file)).toEqual({ text: "first line\nsecond line\nthird\n", truncated: false, missing: false });
    expect(await readOutput(file, 15)).toEqual({ text: "third\n", truncated: true, missing: false });
    expect(await readOutput(join(state, "missing.log"))).toEqual({ text: "", truncated: false, missing: true });
  });

  it("keeps a run's last lines, plain, cut long, without trailing blank lines", async () => {
    const file = join(dir, "run.log");
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\r\n");
    await writeFile(file, `${body}\r\n${"x".repeat(500)}\r\n\r\n\r\n`);
    const last = await lastLines(file);
    expect(last).toHaveLength(20);
    expect(last[0]).toBe("line 12");
    expect(last.at(-1)).toBe(`${"x".repeat(399)}…`);
    expect(await lastLines(join(state, "missing.log"))).toEqual([]);
  });

  it("keeps a run's last lines with the colours the program printed, each line on its own, cut by its text", async () => {
    const file = join(dir, "run.log");
    await writeFile(file, `\x1b]0;title\x07\x1b[1;31mFAIL one\r\ntwo\x1b[0m plain\r\n\x1b[32m${"y".repeat(500)}\x1b[0m\r\n`);
    expect(await lastLines(file)).toEqual(["\x1b[1;31mFAIL one\x1b[0m", "\x1b[1;31mtwo\x1b[0m plain", `\x1b[32m${"y".repeat(399)}…\x1b[0m`]);
  });
});
