import { describe, expect, it } from "vitest";

import { isControlMethod, isSchedulerStatus, parseControlRequest, parseControlResponse } from "./protocol";

const status = { version: "0.1.0", pid: 7, startedAt: "2026-11-17T08:00:00.000Z", lastTickAt: null, pomade: "disconnected" };

describe("control protocol", () => {
  it("reads a request, ignoring keys it does not know", () => {
    expect(parseControlRequest({ protocol: 1, id: "a", method: "status", extra: true })).toEqual({ protocol: 1, id: "a", method: "status" });
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

  it("knows its methods", () => {
    expect(isControlMethod("status")).toBe(true);
    expect(isControlMethod("toString")).toBe(false);
  });
});
