// Pomade opened for agent runs, on stand-ins: the launch, Runner's connection, Pomade's ready, the
// Agents app's roster and a clock the test moves.

import type { LaunchResult } from "pomade-kit/node";
import type { HostClient } from "pomade-kit/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeAgents } from "../scheduler/runs-fixture";
import { AgentsError } from "./agents";
import { pomadeOpener, type PomadeForRuns } from "./pomade-open";

describe("Pomade opened for agent runs", () => {
  let time: number;
  let connected: boolean;
  let ready: boolean;
  let agents: FakeAgents;
  let launches: number;
  let closed: number;
  let reconnects: number;
  let lines: string[];
  let launch: () => Promise<LaunchResult>;
  /** What happens at each poll while the opener waits: the test's script of Pomade starting. */
  let onPoll: (() => void)[];
  let opener: PomadeForRuns;

  const answered = (launched: boolean, pid?: number): Promise<LaunchResult> => {
    const host = { close: () => void closed++ } as unknown as HostClient;
    return Promise.resolve({ status: "connected", host, launched, ...(pid === undefined ? {} : { pid }) });
  };

  beforeEach(() => {
    time = 0;
    connected = false;
    ready = false;
    agents = new FakeAgents();
    launches = 0;
    closed = 0;
    reconnects = 0;
    lines = [];
    onPoll = [];
    launch = () => answered(true, 4242);
    opener = pomadeOpener({
      launch: () => {
        launches++;
        return launch();
      },
      connected: () => connected,
      agents: () => (connected && ready ? agents : null),
      reconnect: () => void reconnects++,
      log: (line) => lines.push(line),
      upWaitMs: 10_000,
      pollMs: 1000,
      now: () => time,
      sleep: (ms) => {
        time += ms;
        onPoll.shift()?.();
        return Promise.resolve();
      },
    });
  });

  it("launches Pomade, closes the probe connection, reconnects at once, and is up once Runner is connected, Pomade ready and the Agents app answers", async () => {
    expect(opener.up()).toBe(false);
    onPoll = [() => (connected = true), () => (ready = true)];
    const opening = opener.open();
    expect(opener.up()).toBe(false);
    expect(await opening).toBeNull();
    expect([launches, closed, reconnects]).toEqual([1, 1, 1]);
    expect(lines).toEqual(["Pomade: opening it for an agent run", "Pomade: opened (pid 4242); waiting until it is ready"]);
    expect(opener.up()).toBe(true);
  });

  it("runs that open it meanwhile share the one launch", async () => {
    onPoll = [() => ((connected = true), (ready = true))];
    const [first, second] = await Promise.all([opener.open(), opener.open()]);
    expect([first, second, launches]).toEqual([null, null, 1]);
  });

  it("does not launch Pomade when Runner is connected to it; waits for its ready", async () => {
    connected = true;
    onPoll = [() => (ready = true)];
    expect(await opener.open()).toBeNull();
    expect([launches, reconnects]).toEqual([0, 0]);
  });

  it("a launch that fails or is refused says why", async () => {
    launch = () => Promise.resolve({ status: "failed", reason: "this Pomade recorded no way to launch it (no host.json)" });
    expect(await opener.open()).toBe("Pomade could not be opened: this Pomade recorded no way to launch it (no host.json)");
    launch = () => Promise.resolve({ status: "failed", reason: "Pomade did not become ready in time" });
    expect(await opener.open()).toBe("Pomade could not be opened: Pomade did not become ready in time");
    launch = () => Promise.resolve({ status: "rejected", reason: "unauthorized", hostApi: 1 });
    expect(await opener.open()).toBe("Pomade refused Runner (unauthorized)");
    launch = () => Promise.reject(new Error("spawn EACCES"));
    expect(await opener.open()).toBe("Pomade could not be opened: spawn EACCES");
    expect(launches).toBe(4);
    expect(opener.up()).toBe(false);
  });

  it("a Pomade that never gets ready fails at the bound, saying what it waited for", async () => {
    expect(await opener.open()).toBe("Pomade opened, but after 10 s Runner cannot connect to it");
    expect(time).toBe(10_000);
    connected = true;
    expect(await opener.open()).toBe("Pomade is running, but after 10 s it has not finished starting");
    ready = true;
    agents.fail = new AgentsError("absent", "the Agents app (pomade-agents) is not running");
    expect(await opener.open()).toBe("Pomade is running, but after 10 s the Agents app (pomade-agents) is not running");
    // An Agents app that comes up within the bound is enough.
    onPoll = [() => (agents.fail = null)];
    expect(await opener.open()).toBeNull();
  });
});
