// Hook matching: an event fires the jobs whose hook names it and whose filters it passes.

import { describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import { hooked, LOGIN, POMADE_STARTED, projectFiring, sessionFiring, type HookFiring } from "./hooks";
import { runTriggerWords } from "./model";

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
    "pull.md": "---\nkind: git\nname: Pull\ngit: { operation: pull, repos: [notes] }\nhook: { event: login }\n---\n",
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

  it("Pomade's events as the firing path takes them: the project's id for the filter, its id and folder for the runs, its name for the cause", () => {
    expect(hooked(snapshot, POMADE_STARTED).map((job) => job.id)).toEqual(["started"]);
    const one = { id: "p1", name: "One", root: "Projects/one" };
    const opened = projectFiring("project-first-open", one, "/ws");
    expect(opened).toEqual({ event: "project-first-open", project: "p1", agent: null, status: null, context: { POMADE_PROJECT: "p1", POMADE_PROJECT_PATH: "/ws/Projects/one" }, projectName: "One" });
    expect(hooked(snapshot, opened).map((job) => job.id)).toEqual(["first-any", "first-p1"]);
    expect(projectFiring("project-created", one, null).context).toEqual({ POMADE_PROJECT: "p1" });
    expect(hooked(snapshot, projectFiring("project-created", one, "/ws")).map((job) => job.id)).toEqual(["created"]);
  });

  it("a hook run's cause in words: the event, and its project by the name it had", () => {
    const hook = (event: HookFiring["event"], projectName?: string): string => runTriggerWords({ trigger: "hook", cause: { kind: "hook", event, context: {}, ...(projectName === undefined ? {} : { projectName }) } });
    expect(hook("login")).toBe("hook: Mac login");
    expect(hook("pomade-started")).toBe("hook: Pomade started");
    expect(hook("project-first-open", "blog")).toBe("hook: first open of blog");
    expect(hook("project-first-open")).toBe("hook: first open of a project");
    expect(hook("project-created", "blog")).toBe("hook: project blog created");
    expect(hook("project-created")).toBe("hook: project created");
    expect(hook("session-finished", "One")).toBe("hook: agent session finished");
    expect(hook("session-status")).toBe("hook: session status changed");
    const marked = (status: string): string => runTriggerWords({ trigger: "hook", cause: { kind: "hook", event: "session-status", context: { POMADE_SESSION_STATUS: status } } });
    expect(["done", "on-hold", "done-skip", "active", "parked"].map(marked)).toEqual(["hook: session marked Done", "hook: session marked On hold", "hook: session marked Done–skip/Failed", "hook: session marked Active", "hook: session status changed"]);
  });

  it("the agents' events as the firing path takes them: the session's project, agent and new status for the filters, the session for the runs", () => {
    const session = { sessionId: "s-1", agent: "claude", project: { id: "p1", root: "Projects/one" }, transcript: "/t/s-1.jsonl", status: "done" as const };
    const finished = sessionFiring("session-finished", session, "/ws", "One");
    expect(finished).toEqual({
      event: "session-finished",
      project: "p1",
      agent: "claude",
      status: null,
      context: { POMADE_PROJECT: "p1", POMADE_PROJECT_PATH: "/ws/Projects/one", POMADE_SESSION_ID: "s-1", POMADE_AGENT: "claude", POMADE_SESSION_STATUS: "done", POMADE_SESSION_TRANSCRIPT: "/t/s-1.jsonl" },
      projectName: "One",
    });
    expect(hooked(snapshot, finished).map((job) => job.id)).toEqual(["finished-any", "finished-claude-p1"]);
    const status = sessionFiring("session-status", { ...session, agent: "codex", project: null }, "/ws", null);
    expect(status).toEqual({ event: "session-status", project: null, agent: "codex", status: "done", context: { POMADE_SESSION_ID: "s-1", POMADE_AGENT: "codex", POMADE_SESSION_STATUS: "done", POMADE_SESSION_TRANSCRIPT: "/t/s-1.jsonl" } });
    expect(hooked(snapshot, status).map((job) => job.id)).toEqual(["status-done-codex", "status-done"]);
    expect(sessionFiring("session-status", session, null, null).context.POMADE_PROJECT_PATH).toBeUndefined();
    expect(sessionFiring("session-status", session, null, null).projectName).toBeUndefined();
  });
});
