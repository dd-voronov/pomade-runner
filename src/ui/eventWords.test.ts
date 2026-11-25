// What a service event's card says: its cause beside the time and in a sentence, and how the session
// it started ended, for every cause.

import { describe, expect, it } from "vitest";

import type { RunRecord, ServiceEvent } from "../scheduler/model";
import { causeMeta, causeSentence, endedAt, endedByWords, endedWhen } from "./eventWords";
import type { EventRecord } from "./runLook";

const at = (local: string): number => new Date(local).getTime();

function event(what: ServiceEvent["what"], cause: ServiceEvent["cause"], more: Partial<ServiceEvent> = {}, rest: Partial<RunRecord> = {}): EventRecord {
  return {
    job: "web",
    name: "Web",
    kind: "service",
    project: null,
    folder: "",
    run: "20261125-091900-aaaaaa",
    trigger: "manual",
    cause: null,
    dueAt: at("2026-11-25T11:19:00"),
    agent: null,
    missed: null,
    series: null,
    state: "done",
    reason: null,
    startedAt: null,
    endedAt: at("2026-11-25T11:20:00"),
    durationMs: null,
    exitCode: null,
    signal: null,
    log: null,
    lastLines: [],
    git: null,
    limitHit: null,
    ...rest,
    event: { what, cause, detail: null, session: null, ended: [], restarts: 0, ends: [], ...more },
  };
}

describe("a service event's card", () => {
  it("says the cause beside the time: by you, first open of a project, else the cause's words", () => {
    expect(causeMeta(event("started", "you"))).toBe("by you");
    expect(causeMeta(event("started", "first-open", { detail: "shop" }))).toBe("first open of shop");
    expect(causeMeta(event("started", "first-open"))).toBe("first open");
    expect(causeMeta(event("stopped", "pomade-quit"))).toBe("Pomade quit");
    expect(causeMeta(event("started", "login"))).toBe("Mac startup");
  });

  it("says the cause in a sentence", () => {
    const chain = { trigger: "chain" as const, cause: { kind: "chain" as const, job: "pull", name: "Pull", run: "r", result: "done" as const } };
    expect(
      [
        event("restarted", "crash", { restarts: 1 }),
        event("restarted", "crash", { restarts: 4 }),
        event("gave-up", "crash", {}, { state: "failed" }),
        event("gave-up", "crash", {}, { state: "failed", reason: "no such folder" }),
        event("started", "login"),
        event("started", "first-open", { detail: "shop" }),
        event("started", "pomade-started"),
        event("stopped", "pomade-quit"),
        event("started", "you"),
        event("stopped", "you"),
        event("stopped", "you", { detail: "tab" }),
        event("restarted", "you"),
        event("restarted", "chain", {}, chain),
        event("restarted", "chain", {}, { ...chain, state: "skipped", reason: "it is not running" }),
        event("started", "chain", {}, { ...chain, state: "failed", reason: "no such folder", cause: { ...chain.cause, result: "failed" } }),
        event("restarted", "keeper"),
        event("stopped", "keeper"),
        event("started", "job-file", { detail: "created" }),
        event("stopped", "job-file", { detail: "disabled" }),
        event("stopped", "job-file", { detail: "removed" }),
        event("restarted", "job-file", { detail: "moved" }),
      ].map(causeSentence),
    ).toEqual([
      "It ended by itself; Runner restarted it.",
      "It ended by itself 4 times between 11:19 and 11:20; Runner restarted it each time.",
      "It crashed 5 times within 1 minute, so Runner stopped restarting it.",
      "It could not start: no such folder. It failed 5 times within 1 minute, so Runner stopped trying.",
      "You logged in to the Mac; Runner started its always-on services one by one.",
      "You opened shop for the first time since Pomade started.",
      "Pomade started at 11:19; Web runs while Pomade runs.",
      "Pomade quit at 11:19; Web runs only while Pomade runs.",
      "You pressed Start.",
      "You pressed Stop. It stays stopped until you press Start.",
      "You stopped it in its terminal tab (Ctrl+C, or the tab’s Stop). It stays stopped until you press Start.",
      "You pressed Restart: Runner stopped it and started it again with its job file as it is now.",
      "Pull was done at 11:19, and Web restarts after it.",
      "Pull was done at 11:19, and Web restarts after it — but it is not running, so the chain did nothing.",
      "Pull failed at 11:19, and Web starts after it — the start failed: no such folder.",
      "Runner’s keeper, which holds the services’ terminals, ended, and the session with it; Runner started it again.",
      "Runner’s keeper, which holds the services’ terminals, ended, and the session with it; it was not due to start again.",
      "Its job file was made or turned on, so it started.",
      "Its job file was turned off (enabled: false).",
      "Its job file was deleted.",
      "Its project moved, so Runner restarted it under its new id.",
    ]);
  });

  it("says how the event that ended a session ended it, and when", () => {
    expect(
      [
        event("restarted", "crash", { restarts: 2 }),
        event("gave-up", "crash"),
        event("stopped", "you"),
        event("stopped", "chain"),
        event("restarted", "chain"),
        event("restarted", "you"),
        event("stopped", "pomade-quit"),
        event("restarted", "keeper"),
        event("stopped", "job-file", { detail: "disabled" }),
        event("stopped", "job-file", { detail: "removed" }),
      ].map(endedByWords),
    ).toEqual(["it crashed", "it crashed; Runner gave up", "stopped by you", "stopped by a chain", "restarted by a chain", "restarted by you", "Pomade quit", "the keeper ended", "turned off in its file", "its file was deleted"]);
    const now = at("2026-11-25T12:47:00");
    expect(endedWhen(at("2026-11-25T11:20:00"), now)).toBe("11:20");
    expect(endedWhen(at("2026-11-24T19:05:00"), now)).toBe("yesterday 19:05");
    // A crash window's first crash ended the session before it, at its first restart.
    const window = event("restarted", "crash", { restarts: 3, ended: [1, 2, 3] });
    expect(endedAt(window, 1)).toBe(window.dueAt);
    expect(endedAt(window, 3)).toBe(window.endedAt);
    expect(endedAt(event("stopped", "you", { ended: [9] }), 9)).toBe(at("2026-11-25T11:19:00"));
  });
});
