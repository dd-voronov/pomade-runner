import { describe, expect, it } from "vitest";

import { elapsedMs, keychainCheckArgv, keychainVerdict } from "./keychain";

describe("the keychain check", () => {
  it("runs `security list-keychains`, or the command line POMADE_RUNNER_KEYCHAIN_CHECK names", () => {
    expect(keychainCheckArgv({})).toEqual(["/usr/bin/security", "list-keychains"]);
    expect(keychainCheckArgv({ POMADE_RUNNER_KEYCHAIN_CHECK: "" })).toEqual(["/usr/bin/security", "list-keychains"]);
    expect(keychainCheckArgv({ POMADE_RUNNER_KEYCHAIN_CHECK: "exit 50" })).toEqual(["/bin/sh", "-c", "exit 50"]);
  });

  it("reads its end by the exit status: 0 is reachable, any other end is not", () => {
    const at = 1;
    expect(keychainVerdict({ code: 0, signal: null, reason: "exited", at })).toEqual({ status: "reachable" });
    expect(keychainVerdict({ code: 50, signal: null, reason: "crashed", at })).toEqual({ status: "unreachable", detail: "exit 50" });
    expect(keychainVerdict({ code: null, signal: "SIGKILL", reason: "crashed", at })).toEqual({ status: "unreachable", detail: "ended by SIGKILL" });
    expect(keychainVerdict({ code: null, signal: null, reason: "lost-in-keeper-crash", at })).toEqual({ status: "unreachable", detail: "ended: lost-in-keeper-crash" });
  });

  it("reads ps's elapsed time", () => {
    expect(elapsedMs("  00:07\n")).toBe(7_000);
    expect(elapsedMs("12:34")).toBe((12 * 60 + 34) * 1000);
    expect(elapsedMs("03:12:34")).toBe(((3 * 60 + 12) * 60 + 34) * 1000);
    expect(elapsedMs("1-03:12:34")).toBe((((24 + 3) * 60 + 12) * 60 + 34) * 1000);
    expect(elapsedMs("")).toBeNull();
    expect(elapsedMs("soon")).toBeNull();
  });
});
