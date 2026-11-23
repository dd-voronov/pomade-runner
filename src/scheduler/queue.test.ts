import { describe, expect, it } from "vitest";

import type { OverlapPolicy } from "../jobs/model";
import type { ActiveRun, RunTrigger, SwitchPosition } from "./model";
import { holds, planQueue, type QueueState } from "./queue";

let serial = 0;

function run(job: string, state: "queued" | "running", extra: Partial<ActiveRun> = {}): ActiveRun {
  serial++;
  return {
    job,
    name: job,
    kind: "script",
    project: null,
    folder: "",
    run: `20261118-0700${String(serial).padStart(2, "0")}-abcdef`,
    trigger: "scheduled",
    cause: null,
    dueAt: 0,
    agent: null,
    missed: null,
    state,
    lowPriority: true,
    runAt: null,
    deadline: null,
    waits: null,
    startedAt: state === "running" ? 0 : null,
    session: null,
    log: null,
    limitHit: null,
    warnedAt: null,
    warningDismissed: false,
    ...extra,
  };
}

function state(extra: Partial<QueueState> & { overlaps?: Record<string, OverlapPolicy> } = {}): QueueState {
  const { overlaps = {}, ...rest } = extra;
  return { now: 1000, maxLowPriority: 2, position: "running", warmUp: { over: true }, overlap: (job) => overlaps[job] ?? "skip", pomadeUp: true, ...rest };
}

/** Each queued run's fate: `start`, or what it waits for. */
function fates(active: ActiveRun[], s: QueueState = state()): Record<string, unknown> {
  const plan = planQueue(active, s);
  return Object.fromEntries(active.filter((r) => r.state === "queued").map((r) => [r.job, plan.start.includes(r) ? "start" : plan.waits.get(r)]));
}

const waitingAgent = { agent: "claude", name: "Claude", provider: "claude" as const, mode: "normal", modeName: "Normal", sessionId: null, cwd: "/ws", startedAt: "", exit: "/exit", exitSentAt: null, waiting: { prompt: "permission" as const, since: 0 }, waitedMs: 0 };

describe("the queue", () => {
  it("while Pomade is not up, agent runs wait for it, in their order and holding no slot; scripts and git runs go on", () => {
    const agent = (job: string): ActiveRun => run(job, "queued", { kind: "agent" });
    const down = state({ pomadeUp: false, maxLowPriority: 1 });
    expect(fates([agent("a"), run("s", "queued"), agent("b"), run("g", "queued", { kind: "git", lowPriority: false })], down)).toEqual({ a: { kind: "pomade" }, s: "start", b: { kind: "pomade" }, g: "start" });
    // Up, they start in their order, the slot first come first served.
    expect(fates([agent("a"), agent("b")], state({ maxLowPriority: 1 }))).toEqual({ a: "start", b: { kind: "slot", ahead: 1 } });
    // The switch and the previous run hold first.
    expect(fates([agent("a")], state({ pomadeUp: false, position: "pause-all" }))).toEqual({ a: { kind: "switch", position: "pause-all" } });
    expect(fates([run("p", "running", { kind: "agent" }), agent("p")], state({ pomadeUp: false }))).toEqual({ p: { kind: "previous-run" } });
  });

  it("an agent run waiting for you at a prompt holds no slot; answered, it counts again", () => {
    const waiting = run("w", "running", { kind: "agent", agent: waitingAgent });
    expect(fates([waiting, run("a", "running"), run("b", "queued")])).toEqual({ b: "start" });
    expect(fates([{ ...waiting, agent: { ...waitingAgent, waiting: null } }, run("a", "running"), run("b", "queued")])).toEqual({ b: { kind: "slot", ahead: 1 } });
  });

  it("three low-priority runs due at once: two start, the third is queued · 1 ahead; then 2, 3 ahead", () => {
    expect(fates([run("a", "queued"), run("b", "queued"), run("c", "queued")])).toEqual({ a: "start", b: "start", c: { kind: "slot", ahead: 1 } });
    expect(fates([run("a", "queued"), run("b", "queued"), run("c", "queued"), run("d", "queued"), run("e", "queued")])).toEqual({
      a: "start",
      b: "start",
      c: { kind: "slot", ahead: 1 },
      d: { kind: "slot", ahead: 2 },
      e: { kind: "slot", ahead: 3 },
    });
  });

  it("running low-priority runs take the slots; a run that is not low-priority never takes or waits for one", () => {
    const active = [run("a", "running"), run("b", "running"), run("git", "queued", { lowPriority: false }), run("c", "queued")];
    expect(fates(active)).toEqual({ git: "start", c: { kind: "slot", ahead: 1 } });
    expect(fates([run("big", "running", { lowPriority: false }), run("c", "queued"), run("d", "queued")])).toEqual({ c: "start", d: "start" });
    expect(fates([run("a", "running"), run("c", "queued")], state({ maxLowPriority: 1 }))).toEqual({ c: { kind: "slot", ahead: 1 } });
    expect(fates([run("a", "running"), run("c", "queued")], state({ maxLowPriority: 3 }))).toEqual({ c: "start" });
  });

  it("first come first served among slot-waiting runs; one waiting for something else lets the next go", () => {
    const active = [run("a", "running"), run("x", "queued", { runAt: 5000 }), run("b", "queued"), run("c", "queued")];
    expect(fates(active)).toEqual({ x: { kind: "time", at: 5000 }, b: "start", c: { kind: "slot", ahead: 1 } });
  });

  it("Run at… waits for its time, then goes through the queue", () => {
    const at = run("weekly", "queued", { runAt: 2000, trigger: "caught-up" });
    expect(fates([at])).toEqual({ weekly: { kind: "time", at: 2000 } });
    expect(fates([at], state({ now: 2000 }))).toEqual({ weekly: "start" });
    expect(fates([run("a", "running"), run("b", "running"), at], state({ now: 2000 }))).toEqual({ weekly: { kind: "slot", ahead: 1 } });
  });

  it("the switch holds every run but Run now: Pause all everything, Pause low-priority the low-priority ones", () => {
    const active = [run("summary", "queued"), run("git", "queued", { lowPriority: false }), run("now", "queued", { trigger: "manual" })];
    expect(fates(active, state({ position: "pause-low" }))).toEqual({ summary: { kind: "switch", position: "pause-low" }, git: "start", now: "start" });
    expect(fates(active, state({ position: "pause-all" }))).toEqual({ summary: { kind: "switch", position: "pause-all" }, git: { kind: "switch", position: "pause-all" }, now: "start" });
    const cases: [SwitchPosition, RunTrigger, boolean, boolean][] = [
      ["running", "scheduled", true, false],
      ["pause-low", "scheduled", true, true],
      ["pause-low", "caught-up", false, false],
      ["pause-all", "caught-up", false, true],
      ["pause-all", "manual", true, false],
    ];
    for (const [position, trigger, lowPriority, held] of cases) expect(holds(position, { trigger, lowPriority })).toBe(held);
  });

  it("a caught-up run waits for the warm-up; an on-time run does not", () => {
    const active = [run("late", "queued", { trigger: "caught-up" }), run("now", "queued")];
    expect(fates(active, state({ warmUp: { over: false, until: null } }))).toEqual({ late: { kind: "warm-up", until: null }, now: "start" });
    expect(fates(active, state({ warmUp: { over: false, until: 9000 } }))).toEqual({ late: { kind: "warm-up", until: 9000 }, now: "start" });
    expect(fates(active)).toEqual({ late: "start", now: "start" });
  });

  it("a run of a job that has one running waits for it, unless the job's overlap is parallel; a gone job's run starts, to be skipped", () => {
    const active = [run("slow", "running"), run("slow", "queued")];
    expect(fates(active, state({ overlaps: { slow: "queue" } }))).toEqual({ slow: { kind: "previous-run" } });
    expect(fates(active, state({ overlaps: { slow: "parallel" } }))).toEqual({ slow: "start" });
    expect(fates(active, state({ overlap: () => undefined }))).toEqual({ slow: "start" });
    // Two queued runs of one parallel job both start, slots allowing.
    expect(fates([run("p", "queued"), run("p", "queued")], state({ overlaps: { p: "parallel" } }))).toEqual({ p: "start" });
    expect(planQueue([run("p", "queued"), run("p", "queued")], state({ overlaps: { p: "queue" } })).start).toHaveLength(1);
  });

  it("a missed run waiting for the person neither starts nor takes a slot", () => {
    const active = [run("weekly", "queued", { state: "missed-waiting" }), run("a", "queued"), run("b", "queued")];
    expect(planQueue(active, state()).start.map((r) => r.job)).toEqual(["a", "b"]);
    expect(planQueue(active, state()).waits.size).toBe(0);
  });
});
