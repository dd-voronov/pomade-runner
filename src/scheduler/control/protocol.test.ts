import { describe, expect, it } from "vitest";

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
    expect(PARAMS_PARSERS.start({ job: "coda/web", extra: 1 })).toEqual({ job: "coda/web" });
    for (const bad of [null, {}, { job: "" }, { job: 3 }, "web"]) expect(PARAMS_PARSERS.start(bad)).toBeUndefined();
  });

  it("checks a sessions answer's shape", () => {
    const info = { id: "svc:web", title: "Web", command: "./w", cwd: "/ws", pid: 3, startedAt: 1, cols: 80, rows: 24, state: "running", exit: null, clients: 0, actions: [] };
    const session = { id: "svc:web", job: "web", kind: "service", run: null, log: null, info };
    const ended = { ...session, info: { ...info, pid: null, state: "exited", exit: { code: null, signal: "SIGHUP", reason: "lost-in-keeper-crash", at: 2 } } };
    for (const keeper of [{ state: "connecting" }, { state: "connected", version: "v", pid: 1 }, { state: "unreachable", reason: "r" }, { state: "rejected", reason: "r" }]) {
      expect(RESULT_GUARDS.sessions({ keeper, sessions: [session, ended] })).toBe(true);
    }
    expect(RESULT_GUARDS.start(session)).toBe(true);
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

  it("knows its methods", () => {
    expect(isControlMethod("status")).toBe(true);
    expect(isControlMethod("sessions")).toBe(true);
    expect(isControlMethod("start")).toBe(true);
    expect(isControlMethod("toString")).toBe(false);
  });
});
