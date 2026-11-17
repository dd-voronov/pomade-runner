import { SESSION_ID_PATTERN } from "pomade-kit/protocol";
import { describe, expect, it } from "vitest";

import { decodeJobId, encodeJobId, jobIdFits, MAX_ENCODED_JOB_ID, newRunId, sessionIdOf, sessionOwner } from "./ids";

const RUN = "20261117-080000-a1b2c3";

describe("session ids", () => {
  it("name a service by its job, the same every time", () => {
    expect(sessionIdOf({ kind: "service", job: "backup" })).toBe("svc:backup");
    expect(sessionIdOf({ kind: "service", job: "coda-helper/coda-web" })).toBe("svc:coda-helper.coda-web");
  });

  it("name a run by its job and run id", () => {
    expect(sessionIdOf({ kind: "run", job: "coda-helper/nightly", run: RUN })).toBe(`run:coda-helper.nightly:${RUN}`);
    expect(sessionIdOf({ kind: "run", job: "nightly", run: "today" })).toBeNull();
  });

  it("encode every character a project's folder may hold, so the id is always a keeper session id", () => {
    const jobs = ["My Project/web", "Café/web", "a.b/web", "x_y/web", "a:b/web", "日本/web", "emoji 🍅/web", "Upper-Case/web"];
    for (const job of jobs) {
      for (const id of [sessionIdOf({ kind: "service", job }), sessionIdOf({ kind: "run", job, run: RUN })]) {
        expect(id).toMatch(SESSION_ID_PATTERN);
      }
    }
    expect(encodeJobId("Café/web")).toBe("Caf_c3_a9.web");
    expect(encodeJobId("a.b/x_y")).toBe("a_2eb.x_5fy");
  });

  it("are reversible: the session id says whose session it is", () => {
    const jobs = ["backup", "coda-helper/coda-web", "My Project/web", "Café/web", "a.b/web", "x_y/web", "a:b/web", "日本/web", "emoji 🍅/web"];
    for (const job of jobs) {
      expect(decodeJobId(encodeJobId(job))).toBe(job);
      expect(sessionOwner(sessionIdOf({ kind: "service", job }) ?? "")).toEqual({ kind: "service", job });
      expect(sessionOwner(sessionIdOf({ kind: "run", job, run: RUN }) ?? "")).toEqual({ kind: "run", job, run: RUN });
    }
  });

  it("never give two jobs the same id", () => {
    const jobs = ["a/b", "a.b", "a_b", "a_2eb", "a-b", "a/b-c", "a.b/c", "a/b.c", "A/b", "a/B"];
    const ids = jobs.map((job) => sessionIdOf({ kind: "service", job }));
    expect(new Set(ids).size).toBe(jobs.length);
  });

  it("refuse ids Runner does not make", () => {
    for (const id of ["ticker", "svc:", "svc:a__2e", "svc:a_2E", "svc:_41", "svc:a b", "run:web", "run:web:today", `run::${RUN}`, "svc:_ff", "job:web"]) {
      expect(sessionOwner(id)).toBeNull();
    }
  });

  it("fit the keeper's 128 characters: a job id is refused when its runs' ids would not", () => {
    const longest = "a".repeat(MAX_ENCODED_JOB_ID);
    expect(jobIdFits(longest)).toBe(true);
    expect(sessionIdOf({ kind: "run", job: longest, run: RUN })).toHaveLength(128);
    expect(jobIdFits(`${longest}a`)).toBe(false);
    expect(sessionIdOf({ kind: "service", job: `${longest}a` })).toBeNull();
    expect(jobIdFits(`${"é".repeat(16)}/web`)).toBe(true);
    expect(jobIdFits(`${"é".repeat(17)}/web`)).toBe(false);
  });
});

describe("run ids", () => {
  it("sort by start time (UTC) and carry six random hex digits", () => {
    expect(newRunId(new Date("2026-11-17T08:05:09.123Z"), () => "a1b2c3")).toBe("20261117-080509-a1b2c3");
    expect(() => newRunId(new Date("2026-11-17T08:05:09.123Z"), () => "xyz")).toThrow("not a run id");
  });
});
