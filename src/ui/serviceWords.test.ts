import { describe, expect, it } from "vitest";

import type { ServiceStatus } from "../keeper/model";
import { serviceActions, serviceLook, serviceWords, upChangeIn, upWords, whenWords } from "./serviceWords";

const base: ServiceStatus = { job: "web", name: "Web", project: null, state: "running", session: null, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null };

describe("a service in words", () => {
  it("names the state alone when nothing else happened", () => {
    expect(serviceWords(base)).toBe("Running");
    expect(serviceWords({ ...base, state: "stopped-by-you" })).toBe("Stopped by you");
    expect(serviceWords({ ...base, state: "waiting" })).toBe("Waits for its project to open");
  });

  it("adds the restarts, the last crash on this Mac's clock, and a pending restart", () => {
    const crash = new Date(2026, 10, 17, 14, 2, 30).getTime();
    expect(serviceWords({ ...base, restarts: 3, lastCrashAt: crash })).toBe("Running · restarted 3× · last crash 14:02");
    expect(serviceWords({ ...base, state: "failed", restarts: 4, lastCrashAt: crash })).toBe("Failed: crashed 5 times in a minute · restarted 4× · last crash 14:02");
    expect(serviceWords({ ...base, needsRestart: true })).toBe("Running · restart to apply its file");
  });
});

describe("a service row's actions", () => {
  it("offers Stop while it runs, Start when Start would start it, and Open terminal only with a session to show", () => {
    const ended = { id: "svc:web", job: "web", kind: "service", run: null, log: null, info: { id: "svc:web", title: "Web", command: "./web.sh", cwd: "/ws", pid: null, startedAt: 1, cols: 80, rows: 24, state: "exited", exit: { at: 2, code: 130, signal: null, reason: "stopped-by-you" }, clients: 0, actions: [] } } as unknown as NonNullable<ServiceStatus["session"]>;
    const offered = (state: ServiceStatus["state"], session: ServiceStatus["session"] = null, enabled = true): [string | null, boolean] => {
      const { toggle, terminal } = serviceActions({ ...base, state, session }, enabled);
      return [toggle, terminal];
    };
    expect(offered("running", ended)).toEqual(["stop", true]);
    expect(offered("starting", ended)).toEqual(["stop", true]);
    // Never started: Start, and no terminal — there is nothing to show.
    for (const state of ["waiting", "queued", "stopped-by-you", "failed", "restarting"] as const) expect(offered(state)).toEqual(["start", false]);
    // Ended: its tab keeps its last output.
    expect(offered("stopped-by-you", ended)).toEqual(["start", true]);
    expect(offered("failed", ended)).toEqual(["start", true]);
    // Start would be refused: none.
    for (const state of ["disabled", "invalid", "removed", "waiting-for-pomade"] as const) expect(offered(state)).toEqual([null, false]);
    expect(offered("disabled", ended)).toEqual([null, true]);
    // Its job turned off, a report a tick old still says it would start: no Start either.
    for (const state of ["waiting", "queued", "stopped-by-you", "failed"] as const) expect(offered(state, null, false)).toEqual([null, false]);
    expect(offered("running", ended, false)).toEqual(["stop", true]);
  });
});

describe("a service's look in the Services view and Running now", () => {
  const now = new Date(2026, 10, 17, 12, 48).getTime();
  const session = (startedAt: number, exitAt: number | null = null): NonNullable<ServiceStatus["session"]> => ({
    id: "svc:web",
    job: "web",
    kind: "service",
    run: null,
    log: null,
    info: {
      id: "svc:web",
      title: "Web",
      command: "./web.sh",
      cwd: "/ws",
      pid: exitAt === null ? 7 : null,
      startedAt,
      cols: 80,
      rows: 24,
      state: exitAt === null ? "running" : "exited",
      exit: exitAt === null ? null : { code: 0, signal: null, reason: "stopped-by-you", at: exitAt },
      clients: 0,
      actions: [],
    },
  });
  const port = { kind: "port", port: 5173 } as const;

  it("running: up for how long, with its crashes on the second line — and in the panel only as news", () => {
    const up = now - (3 * 24 + 4) * 3_600_000;
    const crash = new Date(2026, 10, 16, 14, 2).getTime();
    expect(serviceLook({ ...base, session: session(up), restarts: 3, lastCrashAt: crash }, port, now)).toMatchObject({
      on: true,
      tone: "ok",
      help: "st.up",
      words: "running · up 3d 4h",
      sub: "restarted 3× · last crash 14:02",
      subHelp: "st.restarted",
      short: "up 3d 4h",
      news: "restarted 3× · last crash 14:02",
    });
    expect(serviceLook({ ...base, session: session(now - 125_000) }, port, now)).toMatchObject({ words: "running · up 2m", sub: "no crashes", subHelp: null, news: null });
    expect(serviceLook({ ...base, session: session(now - 7_500_000), needsRestart: true }, port, now)).toMatchObject({ sub: "no crashes · restart to apply its file", news: "restart to apply its file" });
  });

  it("starting: what it waits for, by its readiness", () => {
    expect(serviceLook({ ...base, state: "starting" }, port, now)).toMatchObject({ on: true, tone: "accent", live: true, help: "st.starting", words: "starting", sub: "waiting for port 5173", news: "waiting for port 5173" });
    expect(serviceLook({ ...base, state: "starting" }, { kind: "url", url: "http://localhost:4000/health" }, now).sub).toBe("waiting for http://localhost:4000/health");
    expect(serviceLook({ ...base, state: "starting" }, { kind: "alive" }, now).sub).toBe("up once it has run 5 s");
  });

  it("failed, stopped by you, and the rest: Start, each with its help and when", () => {
    const crash = new Date(2026, 10, 17, 11, 20).getTime();
    expect(serviceLook({ ...base, state: "failed", restarts: 4, lastCrashAt: crash }, port, now)).toMatchObject({ on: false, tone: "danger", help: "st.svcfailed", words: "failed · gave up", sub: "crashed 5× in 1 min · today 11:20" });
    expect(serviceLook({ ...base, state: "failed", problem: "no folder Projects/x" }, port, now).sub).toBe("no folder Projects/x");
    const stopped = new Date(2026, 10, 16, 18, 10).getTime();
    expect(serviceLook({ ...base, state: "stopped-by-you", session: session(stopped - 60_000, stopped) }, port, now)).toMatchObject({ tone: "hollow", help: "st.stopped", words: "stopped by you", sub: "yesterday 18:10" });
    expect(serviceLook({ ...base, state: "queued" }, port, now)).toMatchObject({ on: false, help: "st.svcqueued", words: "queued" });
    expect(serviceLook({ ...base, state: "waiting" }, port, now)).toMatchObject({ help: "st.svcwaiting", words: "waiting for first open", sub: "starts on first open" });
    expect(serviceLook({ ...base, state: "waiting" }, port, now, "blog")).toMatchObject({ words: "waiting for first open", sub: "starts on first open of blog" });
    expect(serviceLook({ ...base, state: "waiting-for-pomade" }, port, now)).toMatchObject({ help: "st.svcwaitpomade", tone: "hollow", words: "waiting for Pomade", sub: "starts when Pomade starts" });
    expect(serviceLook({ ...base, state: "waiting-for-pomade" }, port, now, "blog")).toMatchObject({ words: "waiting for Pomade", sub: "starts on first open of blog" });
    expect(serviceLook({ ...base, state: "disabled" }, port, now)).toMatchObject({ help: "st.disabled", words: "disabled", sub: "" });
    expect(serviceLook({ ...base, state: "restarting", restarts: 1, lastCrashAt: crash }, port, now)).toMatchObject({ tone: "warning", words: "restarting", sub: "restarted 1× · last crash 11:20" });
  });
});

describe("times in words", () => {
  const now = new Date(2026, 10, 17, 12, 48).getTime();
  it("a past moment by its day", () => {
    expect(whenWords(new Date(2026, 10, 17, 9, 2).getTime(), now)).toBe("today 9:02");
    expect(whenWords(new Date(2026, 10, 16, 18, 10).getTime(), now)).toBe("yesterday 18:10");
    expect(whenWords(new Date(2026, 10, 13, 6, 58).getTime(), now)).toBe("Fri 6:58");
    expect(whenWords(new Date(2026, 10, 2, 9, 10).getTime(), now)).toBe("2 Nov 9:10");
  });

  it("how long, in its two largest units", () => {
    expect([0, 59_999, 180_000, 3_600_000 * 3 + 120_000, 86_400_000 * 3 + 3_600_000 * 4 + 59_000].map(upWords)).toEqual(["0s", "59s", "3m", "3h 02m", "3d 4h"]);
  });
});

describe("when a run's time next reads differently", () => {
  const START = 1_000_000;
  const wait = (elapsed: number): number => upChangeIn(START, START + elapsed);

  it("waits for the run's next whole second under a minute, then for the next 10 s of its time", () => {
    expect([wait(0), wait(1), wait(500), wait(999), wait(1000), wait(23_400), wait(59_900), wait(60_000), wait(61_000), wait(65_500), wait(119_999), wait(3_600_000)]).toEqual([
      1000, 999, 500, 1, 1000, 600, 100, 10_000, 9000, 4500, 1, 10_000,
    ]);
  });

  it("reads a start still ahead of the clock as just started", () => {
    expect(upChangeIn(START, START - 5000)).toBe(1000);
  });

  it("changes its words exactly when it says so, and never waits longer than 10 s", () => {
    for (const elapsed of [0, 0.5, 17.3, 59, 59.999, 60, 61, 100, 119.9, 120, 600]) {
      const ms = elapsed * 1000;
      const before = upWords(ms);
      const after = upChangeIn(START, START + ms);
      expect(after).toBeLessThanOrEqual(ms < 60_000 ? 1000 : 10_000);
      if (ms < 60_000) {
        expect(upWords(ms + after - 1)).toBe(before);
        expect(upWords(ms + after)).not.toBe(before);
      }
    }
  });
});
