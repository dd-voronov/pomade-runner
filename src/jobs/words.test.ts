// A job's trigger in words, for every trigger and a service's chain.

import { describe, expect, it } from "vitest";

import { checkJobs } from "./check";
import { parseSchedule } from "pomade-kit/schedule";

import { jobTriggerWords, scheduleWords } from "./words";

const words = (files: Record<string, string>): Record<string, string> => {
  const snapshot = checkJobs(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    { workspace: "/ws", projects: [{ id: "p1", name: "One", root: "Projects/one" }] },
  );
  return Object.fromEntries(snapshot.jobs.map((entry) => (entry.valid ? [entry.job.id, jobTriggerWords(entry.job)] : [entry.invalid.id, `invalid: ${entry.invalid.errors[0]?.problem ?? ""}`])));
};

let names = 0;
const script = (trigger: string): string => `---\nkind: script\nname: Job ${++names}\nfolder: .\ncommand: ./x.sh\n${trigger}\n---\n`;
const service = (extra: string): string => `---\nkind: service\nname: Job ${++names}\nfolder: .\ncommand: ./x.sh\n${extra}---\n`;

describe("a job's trigger in words", () => {
  it("says each hook", () => {
    expect(
      words({
        "login.md": script("hook: { event: login }"),
        "started.md": script("hook: { event: pomade-started }"),
        "first.md": script("hook: { event: project-first-open }"),
        "first-p1.md": script("hook: { event: project-first-open, project: p1 }"),
        "created.md": script("hook: { event: project-created }"),
        "finished.md": script("hook: { event: session-finished }"),
        "status.md": script("hook: { event: session-status, status: on-hold }"),
        "finished-f.md": script("hook: { event: session-finished, agent: claude, project: p1 }"),
        "status-f.md": script("hook: { event: session-status, status: done, agent: opus-coder }"),
        "status-skip.md": script("hook: { event: session-status, status: done-skip, project: p1 }"),
      }),
    ).toEqual({
      login: "at Mac login",
      started: "when Pomade starts",
      first: "on first open of a project",
      "first-p1": "on first open of p1",
      created: "when a project is created",
      finished: "after an agent session finishes",
      status: "when a session is marked On hold",
      "finished-f": "after a claude session finishes in p1",
      "status-f": "when an opus-coder session is marked Done",
      "status-skip": "when a session is marked Done–skip/Failed in p1",
    });
  });

  it("says each chain, a schedule, and a service with its chain's action", () => {
    expect(
      words({
        "pull.md": script("schedule:\n  daily: { at: 7:00 }"),
        "done.md": script("after: { job: pull }"),
        "failed.md": script("after: { job: pull, result: failed }"),
        "any.md": script("after: { job: pull, result: any }"),
        "web.md": service("after: { job: pull }\n"),
        "api.md": service("after: { job: pull, result: failed, action: stop }\n"),
        "db.md": service(""),
        "watch.md": service("start: pomade-started\n"),
        "one/later.md": service("project: p1\nstart: project-first-open\nafter: { job: pull, result: any, action: start }\n"),
      }),
    ).toEqual({
      pull: "daily at 7:00",
      done: "after pull is done",
      failed: "after pull fails",
      any: "after pull finishes",
      web: "always on · starts on Mac startup · restarts after pull is done",
      api: "always on · starts on Mac startup · stops after pull fails",
      db: "always on · starts on Mac startup",
      watch: "while Pomade is running",
      "one/later": "from first open of p1 while Pomade is running · starts after pull finishes",
    });
  });

  it("says a job with no trigger manual, whatever its kind", () => {
    expect(
      words({
        "by-hand.md": script(""),
        "agent.md": `---\nkind: agent\nname: Job ${++names}\nfolder: .\nagent: claude\n---\nGo.\n`,
        "git.md": `---\nkind: git\nname: Job ${++names}\ngit: { operation: pull, repos: [K] }\n---\n`,
      }),
    ).toEqual({ "by-hand": "manual", agent: "manual", git: "manual" });
  });

  it("says a job and a project by their names when the caller knows them", () => {
    const snapshot = checkJobs(
      [
        { path: "pull.md", text: script("schedule:\n  daily: { at: 7:00 }") },
        { path: "web.md", text: service("after: { job: pull }\n") },
        { path: "tests.md", text: script("after: { job: pull, result: any }") },
        { path: "first.md", text: script("hook: { event: project-first-open, project: p1 }") },
        { path: "every.md", text: script("hook: { event: project-opened, project: p1 }") },
        { path: "any.md", text: script("hook: { event: project-opened }") },
        { path: "later.md", text: service("start: project-first-open\nstart-project: p1\n") },
      ],
      { workspace: "/ws", projects: [{ id: "p1", name: "One", root: "Projects/one" }] },
    );
    const named = { job: (id: string) => (id === "pull" ? "Pull coda-helper" : id), project: (id: string) => (id === "p1" ? "One" : id) };
    const said = Object.fromEntries(snapshot.jobs.map((entry) => (entry.valid ? [entry.job.id, jobTriggerWords(entry.job, named)] : [entry.invalid.id, ""])));
    const { web, tests, first, every, any, later } = said;
    expect(web).toBe("always on · starts on Mac startup · restarts after Pull coda-helper is done");
    expect(tests).toBe("after Pull coda-helper finishes");
    expect(first).toBe("on first open of One");
    expect(every).toBe("whenever One is opened");
    expect(any).toBe("whenever a project is opened");
    expect(later).toBe("from first open of One while Pomade is running");
  });
});

describe("a once schedule in words", () => {
  const once = (at: string): Parameters<typeof scheduleWords>[0] => {
    const read = parseSchedule({ once: at }, { resolution: "time" });
    if (!read.ok) throw new Error("not a schedule");
    return read.schedule;
  };
  const local = (date: string, time: string): Date => new Date(`${date}T${time}`);

  it("today's and tomorrow's date are said as such; any other keeps the kit's words", () => {
    const now = local("2026-11-17", "12:48:00");
    expect(scheduleWords(once("2026-11-17 23:00"), now)).toBe("once, today at 23:00");
    expect(scheduleWords(once("2026-11-18 7:00"), now)).toBe("once, tomorrow at 7:00");
    expect(scheduleWords(once("2026-11-19 7:00"), now)).toBe("once on Nov 19, 2026 at 7:00");
    expect(scheduleWords(once("2026-11-16 23:00"), now)).toBe("once on Nov 16, 2026 at 23:00");
  });

  it("the midnight edges: the last second of a day, the first of the next, a month's end", () => {
    const schedule = once("2026-11-18 7:00");
    expect(scheduleWords(schedule, local("2026-11-17", "23:59:59"))).toBe("once, tomorrow at 7:00");
    expect(scheduleWords(schedule, local("2026-11-18", "00:00:00"))).toBe("once, today at 7:00");
    expect(scheduleWords(schedule, local("2026-11-18", "23:59:59"))).toBe("once, today at 7:00");
    expect(scheduleWords(schedule, local("2026-11-19", "00:00:00"))).toBe("once on Nov 18, 2026 at 7:00");
    expect(scheduleWords(once("2026-12-01 9:00"), local("2026-11-30", "23:59:59"))).toBe("once, tomorrow at 9:00");
    expect(scheduleWords(once("2027-01-01 9:00"), local("2026-12-31", "23:59:59"))).toBe("once, tomorrow at 9:00");
  });

  it("the other shapes are the kit's", () => {
    const read = parseSchedule({ daily: { at: "7:00" } }, { resolution: "time" });
    if (!read.ok) throw new Error("not a schedule");
    expect(scheduleWords(read.schedule, local("2026-11-17", "12:00:00"))).toBe("daily at 7:00");
  });

  it("a job's trigger says it against the day it is asked on", () => {
    const text = "---\nkind: script\nname: Once\nfolder: .\ncommand: ./x.sh\nschedule:\n  once: 2026-11-17 23:00\n---\n";
    const snapshot = checkJobs([{ path: "once.md", text }], { workspace: "/ws", projects: [] });
    const job = snapshot.jobs[0];
    if (job === undefined || !job.valid) throw new Error("not valid");
    expect(jobTriggerWords(job.job, {}, local("2026-11-17", "08:00:00"))).toBe("once, today at 23:00");
    expect(jobTriggerWords(job.job, {}, local("2026-11-16", "23:59:59"))).toBe("once, tomorrow at 23:00");
    expect(jobTriggerWords(job.job, {}, local("2026-11-18", "00:00:00"))).toBe("once on Nov 17, 2026 at 23:00");
  });
});
