// Needs you and notices: which runs are noticed under each `notify`, what makes and resolves an
// item, a service that gave up noticed once — across a restart too — and the records on disk.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NoticeParams } from "pomade-kit/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import type { Notify } from "../jobs/model";
import type { ServicesReport, ServiceStatus } from "../keeper/model";
import type { RunRecord } from "./model";
import { createNeedsYou, fileNeedsYouStore, gaveUpNotice, loopNotice, runNotice, type NeedsYou, type NeedsYouStore } from "./needs-you";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");

function record(state: RunRecord["state"], extra: Partial<RunRecord> = {}): RunRecord {
  return {
    job: "backup",
    name: "Backup",
    kind: "script",
    project: null,
    folder: "",
    run: "20261117-120000-abcdef",
    trigger: "scheduled",
    cause: null,
    dueAt: T0,
    state,
    action: null,
    reason: state === "skipped" ? "previous run still going" : null,
    startedAt: state === "skipped" ? null : T0,
    endedAt: T0 + 12_000,
    durationMs: state === "skipped" ? null : 12_000,
    exitCode: state === "failed" ? 1 : state === "done" ? 0 : null,
    signal: null,
    log: null,
    lastLines: state === "failed" ? ["copying", "rsync: connection refused", ""] : [],
    git: null,
    ...extra,
  };
}

const service = (job: string, extra: Partial<ServiceStatus> = {}): ServiceStatus => ({
  job,
  name: job.toUpperCase(),
  project: null,
  state: "failed",
  session: null,
  restarts: 4,
  lastCrashAt: T0,
  retryAt: null,
  needsRestart: false,
  problem: null,
  ...extra,
});

const report = (...services: ServiceStatus[]): ServicesReport => ({ keeper: { state: "connected", version: "v", pid: 1 }, services });

describe("runNotice", () => {
  const route = "run/backup/20261117-120000-abcdef";

  it("on-failure notices a failed run only: its exit and last line, a click opens its result", () => {
    expect(runNotice(record("failed"), "on-failure")).toEqual({ title: "Backup failed", body: "exit 1 · rsync: connection refused", action: { kind: "openApp", route } });
    expect(runNotice(record("failed", { reason: "lost in a keeper crash", exitCode: null, lastLines: [] }), "on-failure")).toEqual({ title: "Backup failed", body: "lost in a keeper crash", action: { kind: "openApp", route } });
    for (const state of ["done", "skipped", "stopped-by-you"] as const) expect(runNotice(record(state), "on-failure")).toBeNull();
  });

  it("always notices every run that started; never notices none; a skipped run is never noticed", () => {
    expect(runNotice(record("done"), "always")).toEqual({ title: "Backup done", body: "took 12 s", action: { kind: "openApp", route } });
    expect(runNotice(record("stopped-by-you"), "always")).toEqual({ title: "Backup stopped by you", body: "took 12 s", action: { kind: "openApp", route } });
    expect(runNotice(record("failed", { startedAt: null, durationMs: null }), "always")).toMatchObject({ title: "Backup failed" });
    expect(runNotice(record("skipped"), "always")).toBeNull();
    for (const state of ["done", "failed", "skipped", "stopped-by-you"] as const) expect(runNotice(record(state), "never")).toBeNull();
  });

  it("a chain's action on a service: failed is noticed with its reason; done only with always", () => {
    const action = (state: RunRecord["state"], reason: string | null = null): RunRecord =>
      record(state, { kind: "service", job: "web", name: "Web", trigger: "chain", action: "restart", reason, startedAt: null, durationMs: null, exitCode: null, lastLines: [] });
    const webRoute = "run/web/20261117-120000-abcdef";
    expect(runNotice(action("failed", "no such folder"), "on-failure")).toEqual({ title: "Web: restart failed", body: "no such folder", action: { kind: "openApp", route: webRoute } });
    expect(runNotice(action("done"), "on-failure")).toBeNull();
    expect(runNotice(action("done"), "always")).toEqual({ title: "Web restarted", action: { kind: "openApp", route: webRoute } });
    expect(runNotice(action("skipped", "it is not running"), "always")).toBeNull();
  });

  it("a loop-guard pause opens Runner", () => {
    expect(loopNotice("Lint")).toEqual({ title: "Lint paused: triggered 10× in 10 min — looks like a loop", body: expect.stringContaining("Resume") as string, action: { kind: "openApp", route: "" } });
  });

  it("a service that gave up opens Runner", () => {
    expect(gaveUpNotice(service("web"))).toEqual({ title: "WEB gave up", body: expect.stringContaining("crashed 5 times within a minute") as string, action: { kind: "openApp", route: "" } });
  });
});

/** Records kept in memory. */
function memoryStore(): NeedsYouStore & { saved: unknown } {
  const store = {
    saved: { failures: {}, gaveUp: {} } as unknown,
    load: () => Promise.resolve(structuredClone(store.saved) as never),
    save(records: unknown) {
      store.saved = structuredClone(records);
    },
    flush: () => Promise.resolve(),
  };
  return store;
}

describe("needs you", () => {
  let posted: NoticeParams[];
  let changes: number;
  let store: ReturnType<typeof memoryStore>;
  let needsYou: NeedsYou;

  async function open(): Promise<NeedsYou> {
    needsYou = createNeedsYou({ store, log: () => undefined, post: (notice) => posted.push(notice), onChange: () => changes++ });
    await needsYou.load();
    return needsYou;
  }

  beforeEach(async () => {
    posted = [];
    changes = 0;
    store = memoryStore();
    await open();
  });

  it("a failed run makes its job's item, one per job, counting the failures; a done run resolves it", () => {
    needsYou.runFinished(record("failed"), "on-failure");
    expect(posted.map((notice) => notice.title)).toEqual(["Backup failed"]);
    expect(needsYou.items()).toEqual([
      { id: "run-failed:backup", kind: "run-failed", job: "backup", name: "Backup", project: null, run: "20261117-120000-abcdef", at: T0 + 12_000, count: 1, detail: "exit 1" },
    ]);
    needsYou.runFinished(record("failed", { run: "20261117-130000-abcdef", endedAt: T0 + 3_600_000, exitCode: 2 }), "on-failure");
    expect(needsYou.items()).toMatchObject([{ id: "run-failed:backup", run: "20261117-130000-abcdef", count: 2, detail: "exit 2" }]);
    needsYou.runFinished(record("skipped"), "on-failure");
    needsYou.runFinished(record("stopped-by-you"), "on-failure");
    expect(needsYou.items()).toHaveLength(1);
    needsYou.runFinished(record("done"), "on-failure");
    expect(needsYou.items()).toEqual([]);
    expect(posted).toHaveLength(2);
    expect(changes).toBe(3);
  });

  it("notify: never makes neither a notice nor an item; always notices the done run too", () => {
    needsYou.runFinished(record("failed"), "never");
    expect(needsYou.items()).toEqual([]);
    expect(posted).toEqual([]);
    needsYou.runFinished(record("done"), "always");
    expect(posted.map((notice) => notice.title)).toEqual(["Backup done"]);
  });

  it("an item goes when it is opened or dismissed; only failed-run items are dismissed", () => {
    needsYou.runFinished(record("failed"), "on-failure");
    needsYou.services(report(service("web")));
    expect(needsYou.dismiss("service-failed:web")).toBe(false);
    expect(needsYou.dismiss("run-failed:nope")).toBe(false);
    expect(needsYou.dismiss("run-failed:backup")).toBe(true);
    expect(needsYou.items().map((item) => item.id)).toEqual(["service-failed:web"]);
    expect(needsYou.dismiss("run-failed:backup")).toBe(false);
  });

  it("a gone job's item goes; one whose file is still there stays", () => {
    needsYou.runFinished(record("failed"), "on-failure");
    needsYou.runFinished(record("failed", { job: "other", name: "Other" }), "on-failure");
    needsYou.jobs({ workspace: null, projectsChecked: false, jobs: [] });
    expect(needsYou.items()).toHaveLength(2);
    needsYou.jobs(checkJobs([{ path: "other.md", text: "---\nkind: nope\n---\n" }], { workspace: "/ws", projects: null }));
    expect(needsYou.items().map((item) => item.job)).toEqual(["other"]);
  });

  it("a service that gave up is an item while it stays failed, noticed once — after a restart too — and again on a later give-up", async () => {
    needsYou.services(report(service("web"), service("api", { state: "running" })));
    expect(needsYou.items()).toEqual([{ id: "service-failed:web", kind: "service-failed", job: "web", name: "WEB", project: null, at: T0, detail: "crashed 5 times within a minute" }]);
    needsYou.services(report(service("web")));
    expect(posted.map((notice) => notice.title)).toEqual(["WEB gave up"]);
    await open();
    needsYou.services(report(service("web")));
    expect(posted).toHaveLength(1);
    needsYou.services(report(service("web", { state: "running" })));
    expect(needsYou.items()).toEqual([]);
    needsYou.services(report(service("web", { lastCrashAt: T0 + 60_000 })));
    expect(posted).toHaveLength(2);
  });

  it("lists items newest first", () => {
    needsYou.services(report(service("web", { lastCrashAt: T0 + 1 })));
    needsYou.runFinished(record("failed", { endedAt: T0 + 5 }), "on-failure");
    needsYou.runFinished(record("failed", { job: "old", endedAt: T0 - 5 }), "on-failure");
    expect(needsYou.items().map((item) => item.id)).toEqual(["run-failed:backup", "service-failed:web", "run-failed:old"]);
  });

  it("keeps its records in needs-you.json, and starts empty from a missing or broken file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prn-"));
    try {
      const lines: string[] = [];
      const file = fileNeedsYouStore(dir, (line) => lines.push(line));
      expect(await file.load()).toEqual({ failures: {}, gaveUp: {} });
      const kept = { failures: { backup: { name: "Backup", project: null, run: "r", at: 1, count: 2, detail: "exit 1" } }, gaveUp: { web: 5 } };
      file.save(kept);
      await file.flush();
      expect(await file.load()).toEqual(kept);
      await writeFile(join(dir, "needs-you.json"), JSON.stringify({ failures: { a: { name: "A" }, b: { ...kept.failures.backup, count: 0 } }, gaveUp: { web: "x" } }));
      expect(await file.load()).toEqual({ failures: {}, gaveUp: {} });
      await writeFile(join(dir, "needs-you.json"), "nope");
      expect(await file.load()).toEqual({ failures: {}, gaveUp: {} });
      expect(lines).toEqual([`needs you: ${join(dir, "needs-you.json")} is not readable JSON; starting with no items`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("follows each notify value", () => {
    const cases: [Notify, RunRecord["state"], boolean, boolean][] = [
      ["on-failure", "failed", true, true],
      ["on-failure", "done", false, false],
      ["always", "failed", true, true],
      ["always", "done", true, false],
      ["always", "stopped-by-you", true, false],
      ["never", "failed", false, false],
      ["never", "done", false, false],
    ];
    for (const [notify, state, notice, item] of cases) {
      posted = [];
      store = memoryStore();
      needsYou = createNeedsYou({ store, log: () => undefined, post: (n) => posted.push(n), onChange: () => undefined });
      needsYou.runFinished(record(state), notify);
      expect([notify, state, posted.length === 1, needsYou.items().length === 1]).toEqual([notify, state, notice, item]);
    }
  });
});

