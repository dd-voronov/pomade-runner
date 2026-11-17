import { describe, expect, it } from "vitest";

import { isServiceActionResult } from "../../keeper/model";
import { isControlMethod, isSchedulerStatus, PARAMS_PARSERS, parseControlRequest, parseControlResponse, RESULT_GUARDS } from "./protocol";

const status = { version: "0.1.0", pid: 7, startedAt: "2026-11-17T08:00:00.000Z", lastTickAt: null, pomade: "disconnected" };

describe("control protocol", () => {
  it("reads a request, ignoring keys it does not know", () => {
    expect(parseControlRequest({ protocol: 1, id: "a", method: "status", extra: true })).toEqual({ protocol: 1, id: "a", method: "status", params: null });
    expect(parseControlRequest({ protocol: 1, id: "a", method: "start", params: { job: "web" } })).toEqual({ protocol: 1, id: "a", method: "start", params: { job: "web" } });
  });

  it("refuses what is not a request", () => {
    for (const data of [null, "status", [], {}, { protocol: "1", id: "a", method: "status" }, { protocol: 1.5, id: "a", method: "status" }, { protocol: 1, id: 1, method: "status" }, { protocol: 1, id: "a" }]) {
      expect(parseControlRequest(data)).toBeNull();
    }
  });

  it("reads both kinds of response", () => {
    expect(parseControlResponse({ protocol: 1, id: "a", ok: true, value: status })).toEqual({ protocol: 1, id: "a", ok: true, value: status });
    const refused = { protocol: 2, id: "a", ok: false, error: { code: "protocol-mismatch", message: "m" } };
    expect(parseControlResponse(refused)).toEqual(refused);
  });

  it("refuses what is not a response", () => {
    for (const data of [null, {}, { protocol: 1, id: "a" }, { protocol: 1, id: "a", ok: false }, { protocol: 1, id: "a", ok: false, error: { code: "nope", message: "m" } }, { id: "a", ok: true, value: 1 }]) {
      expect(parseControlResponse(data)).toBeNull();
    }
  });

  it("checks a status answer's shape", () => {
    expect(isSchedulerStatus(status)).toBe(true);
    expect(isSchedulerStatus({ ...status, lastTickAt: "2026-11-17T08:00:01.000Z", pomade: "connected" })).toBe(true);
    for (const bad of [null, {}, { ...status, pid: "7" }, { ...status, pomade: "maybe" }, { ...status, lastTickAt: 5 }]) {
      expect(isSchedulerStatus(bad)).toBe(false);
    }
  });

  it("checks each method's params", () => {
    expect(PARAMS_PARSERS.status(null)).toBeNull();
    expect(PARAMS_PARSERS.sessions({})).toBeUndefined();
    expect(PARAMS_PARSERS.services(null)).toBeNull();
    for (const method of ["run", "stop", "restart", "enable", "disable", "resumeJob"] as const) {
      expect(PARAMS_PARSERS[method]({ job: "coda/web", extra: 1 })).toEqual({ job: "coda/web" });
      for (const bad of [null, {}, { job: "" }, { job: 3 }, "web"]) expect(PARAMS_PARSERS[method](bad)).toBeUndefined();
    }
    expect(PARAMS_PARSERS.list(null)).toBeNull();
    expect(PARAMS_PARSERS.history({ job: null, limit: 20 })).toEqual({ job: null, limit: 20 });
    expect(PARAMS_PARSERS.history({ job: "backup", limit: 1, extra: true })).toEqual({ job: "backup", limit: 1 });
    for (const bad of [null, {}, { job: null }, { job: "", limit: 5 }, { job: null, limit: 0 }, { job: null, limit: 2.5 }, { job: 3, limit: 5 }]) expect(PARAMS_PARSERS.history(bad)).toBeUndefined();
    expect(PARAMS_PARSERS.runs(null)).toBeNull();
    for (const position of ["running", "pause-low", "pause-all", null]) expect(PARAMS_PARSERS.switch({ position, extra: 1 })).toEqual({ position });
    for (const bad of [null, {}, { position: "paused" }, { position: 1 }]) expect(PARAMS_PARSERS.switch(bad)).toBeUndefined();
  });

  it("checks the switch's and the runs report's answers", () => {
    expect(RESULT_GUARDS.switch({ position: "pause-all", since: 5 })).toBe(true);
    expect(RESULT_GUARDS.switch({ position: "running", since: null })).toBe(true);
    for (const bad of [{}, { position: "off", since: null }, { position: "running" }]) expect(RESULT_GUARDS.switch(bad)).toBe(false);
    expect(RESULT_GUARDS.runs({ active: [], nextUp: [], jobs: [], needsYou: [], switch: { position: "running", since: null } })).toBe(true);
    expect(RESULT_GUARDS.runs({ active: [], nextUp: [], jobs: [], needsYou: [] })).toBe(false);
  });

  it("checks the runs' answers' shapes", () => {
    const base = { job: "backup", name: "Backup", kind: "script", project: null, folder: "", run: "20261117-120000-abcdef", trigger: "scheduled", cause: null, dueAt: 1 };
    const going = { lowPriority: true, runAt: null, deadline: null, waits: null, limitHit: null, warnedAt: null, warningDismissed: false };
    const active = { ...base, ...going, state: "running", startedAt: 2, session: "run:backup:20261117-120000-abcdef", log: "/s/o.log" };
    const record = { ...base, state: "failed", action: null, reason: null, startedAt: 2, endedAt: 3, durationMs: 1, exitCode: 1, signal: null, log: "/s/o.log", lastLines: ["boom"] };
    expect(RESULT_GUARDS.run({ run: active })).toBe(true);
    expect(RESULT_GUARDS.run({ run: { ...active, state: "queued", startedAt: null, session: null, log: null } })).toBe(true);
    for (const bad of [{}, { run: { ...active, state: "done" } }, { run: { ...active, trigger: "cron" } }, { run: { ...active, dueAt: null } }]) expect(RESULT_GUARDS.run(bad)).toBe(false);
    expect(RESULT_GUARDS.history({ records: [record, { ...record, state: "skipped", reason: "previous run still going", startedAt: null, durationMs: null, exitCode: null, log: null, lastLines: [] }], next: "2026-11-17:3" })).toBe(true);
    for (const bad of [{ records: [] }, { records: [{ ...record, lastLines: [1] }], next: null }, { records: [{ ...record, state: "queued" }], next: null }]) expect(RESULT_GUARDS.history(bad)).toBe(false);
    const listing = { job: "backup", name: "Backup", kind: "script", enabled: true, trigger: "daily at 13:00", problem: null, next: 5, finished: false, last: record, service: null };
    expect(RESULT_GUARDS.list([listing, { ...listing, kind: null, trigger: null, problem: "x", last: null }])).toBe(true);
    for (const bad of [{}, [{ ...listing, kind: "cron" }], [{ ...listing, last: {} }]]) expect(RESULT_GUARDS.list(bad)).toBe(false);
    expect(RESULT_GUARDS.enable({ job: "backup", name: "Backup", enabled: false })).toBe(true);
    expect(RESULT_GUARDS.disable({ job: "backup", enabled: false })).toBe(false);
    expect(RESULT_GUARDS.resumeJob({ job: "backup", name: "Backup" })).toBe(true);
    expect(RESULT_GUARDS.resumeJob({ job: "backup" })).toBe(false);
  });

  it("checks a sessions answer's shape", () => {
    const info = { id: "svc:web", title: "Web", command: "./w", cwd: "/ws", pid: 3, startedAt: 1, cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: [] };
    const session = { id: "svc:web", job: "web", kind: "service", run: null, log: null, info };
    const ended = { ...session, info: { ...info, pid: null, state: "exited", exit: { code: null, signal: "SIGHUP", reason: "lost-in-keeper-crash", at: 2 } } };
    for (const keeper of [{ state: "connecting" }, { state: "connected", version: "v", pid: 1 }, { state: "unreachable", reason: "r" }, { state: "rejected", reason: "r" }]) {
      expect(RESULT_GUARDS.sessions({ keeper, sessions: [session, ended] })).toBe(true);
    }
    for (const bad of [
      { keeper: { state: "up" }, sessions: [] },
      { keeper: { state: "connected", version: "v" }, sessions: [] },
      { keeper: { state: "connecting" }, sessions: [{ ...session, kind: "job" }] },
      { keeper: { state: "connecting" }, sessions: [{ ...session, info: { ...info, state: "gone" } }] },
      { keeper: { state: "connecting" }, sessions: [{ ...ended, info: { ...ended.info, exit: { ...ended.info.exit, reason: "boom" } } }] },
      { keeper: { state: "connecting" } },
    ]) {
      expect(RESULT_GUARDS.sessions(bad)).toBe(false);
    }
  });

  it("checks a services answer's shape", () => {
    const info = { id: "svc:web", title: "Web", command: "./w", cwd: "/ws", pid: 3, startedAt: 1, cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: [] };
    const session = { id: "svc:web", job: "web", kind: "service", run: null, log: null, info };
    const service = { job: "web", name: "Web", project: null, state: "running", session, restarts: 2, lastCrashAt: 5, retryAt: null, needsRestart: false, problem: null };
    const report = { keeper: { state: "connected", version: "v", pid: 1 }, services: [service, { ...service, job: "b", state: "waiting", session: null, project: "p", lastCrashAt: null }] };
    expect(RESULT_GUARDS.services(report)).toBe(true);
    for (const method of ["stop", "restart"] as const) expect(RESULT_GUARDS[method](service)).toBe(true);
    expect(RESULT_GUARDS.run({ service })).toBe(true);
    for (const bad of [
      { ...service, state: "sleeping" },
      { ...service, session: { ...session, kind: "job" } },
      { ...service, restarts: "2" },
      { ...service, lastCrashAt: "14:02" },
      { ...service, needsRestart: null },
      { ...service, problem: 1 },
      { ...service, project: undefined },
    ]) {
      expect(RESULT_GUARDS.stop(bad)).toBe(false);
      expect(RESULT_GUARDS.services({ ...report, services: [bad] })).toBe(false);
    }
    expect(RESULT_GUARDS.services({ keeper: { state: "connecting" } })).toBe(false);
    expect(isServiceActionResult({ ok: true, service })).toBe(true);
    expect(isServiceActionResult({ ok: false, reason: "r" })).toBe(true);
    for (const bad of [null, { ok: true, service: {} }, { ok: false }, { ok: "yes", reason: "r" }]) expect(isServiceActionResult(bad)).toBe(false);
  });

  it("knows its methods", () => {
    expect(isControlMethod("status")).toBe(true);
    expect(isControlMethod("sessions")).toBe(true);
    for (const method of ["services", "run", "stop", "restart", "enable", "disable", "list", "history", "runs", "switch"]) expect(isControlMethod(method)).toBe(true);
    expect(isControlMethod("start")).toBe(false);
    expect(isControlMethod("toString")).toBe(false);
  });
});
