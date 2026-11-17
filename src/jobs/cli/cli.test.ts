import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../../app";
import type { ControlCallResult } from "../../scheduler/control/client";
import type { SchedulerStatus } from "../../scheduler/control/protocol";
import { runCli, USAGE } from "./cli";

type StatusResult = ControlCallResult<SchedulerStatus> | null;

async function run(args: string[], status: StatusResult = { status: "not-running" }) {
  let out = "";
  let err = "";
  let asked = 0;
  const code = await runCli(args, {
    out: (text) => (out += text),
    err: (text) => (err += text),
    schedulerStatus: () => {
      asked++;
      return Promise.resolve(status);
    },
  });
  return { code, out, err, asked };
}

const running: SchedulerStatus = { version: "0.1.0", pid: 4242, startedAt: "2026-11-17T08:00:00.000Z", lastTickAt: null, pomade: "connected" };

describe("pomade-runner", () => {
  it("prints the usage for --help, -h and no arguments", async () => {
    for (const args of [["--help"], ["-h"], []]) {
      expect(await run(args)).toEqual({ code: 0, out: USAGE, err: "", asked: 0 });
    }
  });

  it("--version prints the version and a running scheduler", async () => {
    const r = await run(["--version"], { status: "ok", value: running });
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `pomade-runner ${APP_VERSION}\nscheduler: running — 0.1.0, pid 4242, since 2026-11-17T08:00:00.000Z, connected to Pomade\n`,
    );
    expect(r.err).toBe("");
  });

  it("--version says how the scheduler stands with Pomade", async () => {
    const closed = await run(["--version"], { status: "ok", value: { ...running, pomade: "disconnected" } });
    expect(closed.out).toContain(", Pomade closed\n");
    const refused = await run(["--version"], { status: "ok", value: { ...running, pomade: "rejected" } });
    expect(refused.out).toContain(", refused by Pomade\n");
  });

  it("--version still answers when the scheduler is not running, not answering or not findable", async () => {
    expect((await run(["--version"])).out).toBe(`pomade-runner ${APP_VERSION}\nscheduler: not running\n`);
    const failed = await run(["--version"], { status: "failed", code: "protocol-mismatch", message: "the scheduler speaks control protocol 2, the caller 1" });
    expect(failed.code).toBe(0);
    expect(failed.out).toContain("scheduler: not answering — the scheduler speaks control protocol 2, the caller 1\n");
    const outside = await run(["--version"], null);
    expect(outside.code).toBe(0);
    expect(outside.out).toContain("scheduler: unknown — pomade-runner was not started through Pomade's command folder\n");
  });

  it("refuses an unknown command or option with exit code 2", async () => {
    const command = await run(["frobnicate"]);
    expect(command).toEqual({
      code: 2,
      out: "",
      err: 'pomade-runner: unknown command "frobnicate". Run `pomade-runner --help` for what it takes.\n',
      asked: 0,
    });
    const option = await run(["--frob"]);
    expect(option.code).toBe(2);
    expect(option.err).toContain('unknown option "--frob"');
  });
});
