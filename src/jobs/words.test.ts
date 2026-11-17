// A job's trigger in words, for every trigger and a service's chain.

import { describe, expect, it } from "vitest";

import { checkJobs } from "./check";
import { jobTriggerWords } from "./words";

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
      }),
    ).toEqual({
      login: "at Mac login",
      started: "when Pomade starts",
      first: "on the first open of a project",
      "first-p1": "on the first open of project p1",
      created: "when a project is created",
      finished: "when an agent session finishes",
      status: "when a session's status changes to on-hold",
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
        "one/later.md": service("project: p1\nstart: project-first-open\nafter: { job: pull, result: any, action: start }\n"),
      }),
    ).toEqual({
      pull: "daily at 7:00",
      done: "after pull is done",
      failed: "after pull fails",
      any: "after pull finishes",
      web: "always on, from login; restarts after pull is done",
      api: "always on, from login; stops after pull fails",
      db: "always on, from login",
      "one/later": "always on, from its project's first open; starts after pull finishes",
    });
  });
});
