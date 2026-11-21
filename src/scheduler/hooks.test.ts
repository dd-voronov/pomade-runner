// Hook matching: an event fires the jobs whose hook names it and whose filters it passes.

import { describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import { hooked, LOGIN, type HookFiring } from "./hooks";

const script = (name: string, hook: string, extra = ""): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./x.sh\nhook: ${hook}\n${extra}---\n`;

const snapshot = checkJobs(
  Object.entries({
    "login.md": script("Login", "{ event: login }"),
    "login-off.md": script("Login off", "{ event: login }", "enabled: false\n"),
    "started.md": script("Started", "{ event: pomade-started }"),
    "created.md": script("Created", "{ event: project-created }"),
    "first-any.md": script("First any", "{ event: project-first-open }"),
    "first-p1.md": script("First p1", "{ event: project-first-open, project: p1 }"),
    "finished-any.md": script("Finished any", "{ event: session-finished }"),
    "finished-claude-p1.md": script("Finished claude p1", "{ event: session-finished, project: p1, agent: claude }"),
    "status-done.md": script("Status done", "{ event: session-status, status: done }"),
    "status-done-codex.md": script("Status done codex", "{ event: session-status, status: done, agent: codex }"),
    "scheduled.md": "---\nkind: script\nname: Scheduled\nfolder: .\ncommand: ./x.sh\nschedule:\n  daily: { at: 7:00 }\n---\n",
    "agent.md": "---\nkind: agent\nname: Agent\nfolder: .\nagent: claude\nhook: { event: login }\n---\nGo.\n",
    "pull.md": "---\nkind: git\nname: Pull\ngit: { operation: pull, repos: [Knowledge] }\nhook: { event: login }\n---\n",
  }).map(([path, text]) => ({ path, text })),
  { workspace: "/ws", projects: [{ id: "p1", name: "One", root: "Projects/one" }] },
);

const event = (firing: Partial<HookFiring> & Pick<HookFiring, "event">): string[] => hooked(snapshot, { project: null, agent: null, status: null, context: {}, ...firing }).map((job) => job.id);

describe("hooks", () => {
  it("every file is valid", () => {
    expect(snapshot.jobs.filter((entry) => !entry.valid)).toEqual([]);
  });

  it("login fires the enabled scripts, agent and git jobs on login, and nothing else", () => {
    expect(hooked(snapshot, LOGIN).map((job) => job.id)).toEqual(["agent", "login", "pull"]);
    expect(LOGIN).toEqual({ event: "login", project: null, agent: null, status: null, context: {} });
  });

  it("an event without filters fires its jobs", () => {
    expect(event({ event: "pomade-started" })).toEqual(["started"]);
    expect(event({ event: "project-created", project: "p9" })).toEqual(["created"]);
  });

  it("a project filter takes its project; none takes any", () => {
    expect(event({ event: "project-first-open", project: "p1" })).toEqual(["first-any", "first-p1"]);
    expect(event({ event: "project-first-open", project: "p2" })).toEqual(["first-any"]);
  });

  it("project and agent filters must both pass", () => {
    expect(event({ event: "session-finished", project: "p1", agent: "claude" })).toEqual(["finished-any", "finished-claude-p1"]);
    expect(event({ event: "session-finished", project: "p1", agent: "codex" })).toEqual(["finished-any"]);
    expect(event({ event: "session-finished", project: null, agent: "claude" })).toEqual(["finished-any"]);
  });

  it("a status hook fires on its status only", () => {
    expect(event({ event: "session-status", status: "done", agent: "codex" })).toEqual(["status-done-codex", "status-done"]);
    expect(event({ event: "session-status", status: "done", agent: "claude" })).toEqual(["status-done"]);
    expect(event({ event: "session-status", status: "on-hold" })).toEqual([]);
  });
});
