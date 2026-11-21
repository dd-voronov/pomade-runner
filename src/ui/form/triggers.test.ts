import { describe, expect, it } from "vitest";

import { checkJobs } from "../../jobs/check";
import { describeJobError } from "../../jobs/format";
import type { JobError, JobsSnapshot, ProjectRecord } from "../../jobs/model";
import { parseJobFile } from "../../jobs/parse";
import { blocksSave, editForm, errorShows, errorsByPlace, fieldChanges, formErrors, newForm, setFolder, setValue, switchKind, wouldBe, type FormState } from "./state";
import { agentPicks, chainJobOptions, EVENT_CHOICES, formOffersHook, hookBoxWords, isLoopError, jobName, statusPicks } from "./triggerWords";

const PROJECTS: ProjectRecord[] = [{ id: "p-coda", name: "coda-helper", root: "Projects/coda-helper" }];
const JOBS = "Apps/pomade-runner/jobs";

const BACKUP = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./b.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
const WEB = "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\n---\n";

function snapshotOf(files: Record<string, string>): JobsSnapshot {
  return checkJobs(Object.entries(files).map(([path, text]) => ({ path, text })), { workspace: "/ws", projects: PROJECTS });
}

const SNAPSHOT = snapshotOf({ "backup.md": BACKUP, "web.md": WEB });

function edit(path: string, text: string): FormState {
  const state = editForm(`${JOBS}/${path}`, text);
  if (state === null) throw new Error("not editable");
  return state;
}

function newScript(name: string): FormState {
  let state = switchKind(newForm("script"), "script");
  state = setValue(state, "name", name);
  state = setFolder(state, ".", PROJECTS);
  return setValue(state, "command", "./x.sh");
}

/** Each place's errors, in `pomade-runner check`'s words. */
function shown(state: FormState, snapshot: JobsSnapshot): Record<string, string[]> {
  const places = errorsByPlace(formErrors(state, snapshot, PROJECTS), state.values);
  return Object.fromEntries([...places].map(([place, errors]) => [place, errors.map(describeJobError)]));
}

describe("a script on a hook or a chain, made in the form", () => {
  it("at Mac login: the file has the hook, no schedule and no missed-run policy, and the checker reads it as the login hook", () => {
    const state = setValue(newScript("Mount"), "trigger", "hook");
    const file = wouldBe(state, SNAPSHOT, PROJECTS);
    expect(file.text).toBe("---\nkind: script\nname: Mount\nfolder: .\nenabled: true\ncommand: ./x.sh\nhook: { event: login }\n---\n");
    expect(formErrors(state, SNAPSHOT, PROJECTS)).toEqual([]);
    expect(parseJobFile({ path: "mount.md", text: file.text }).job).toMatchObject({ trigger: { kind: "hook", hook: { event: "login", project: null } } });
  });

  it("on Pomade's events: the event in hook:, a first open's project with it, each as the checker reads a hand-written one", () => {
    const hooked = (event: string, project = ""): FormState => setValue(setValue(setValue(newScript("Hook"), "trigger", "hook"), "hookEvent", event), "hookProject", project);
    const text = (state: FormState): string => wouldBe(state, SNAPSHOT, PROJECTS).text;
    expect(text(hooked("pomade-started"))).toContain("\nhook: { event: pomade-started }\n");
    expect(text(hooked("project-created"))).toContain("\nhook: { event: project-created }\n");
    expect(text(hooked("project-first-open"))).toContain("\nhook: { event: project-first-open }\n");
    expect(text(hooked("project-first-open", "p-coda"))).toContain("\nhook: { event: project-first-open, project: p-coda }\n");
    // The project is a first open's alone.
    expect(text(hooked("project-created", "p-coda"))).toContain("\nhook: { event: project-created }\n");
    for (const event of ["pomade-started", "project-created", "project-first-open"]) expect(formErrors(hooked(event), SNAPSHOT, PROJECTS)).toEqual([]);
    expect(parseJobFile({ path: "hook.md", text: text(hooked("project-first-open", "p-coda")) }).job).toMatchObject({ trigger: { kind: "hook", hook: { event: "project-first-open", project: "p-coda" } } });
  });

  it("on the agents' events: a status change's status, then the project and agent filters picked, each as the checker reads a hand-written one", () => {
    const hooked = (event: string, filters: { project?: string; agent?: string; status?: string } = {}): FormState => {
      let state = setValue(setValue(newScript("Hook"), "trigger", "hook"), "hookEvent", event);
      if (filters.project !== undefined) state = setValue(state, "hookProject", filters.project);
      if (filters.agent !== undefined) state = setValue(state, "hookAgent", filters.agent);
      if (filters.status !== undefined) state = setValue(state, "hookStatus", filters.status);
      return state;
    };
    const text = (state: FormState): string => wouldBe(state, SNAPSHOT, PROJECTS).text;
    expect(text(hooked("session-finished"))).toContain("\nhook: { event: session-finished }\n");
    expect(text(hooked("session-finished", { project: "p-coda", agent: "claude" }))).toContain("\nhook: { event: session-finished, project: p-coda, agent: claude }\n");
    // A status is a status change's alone; it starts at Done.
    expect(text(hooked("session-finished", { status: "on-hold" }))).toContain("\nhook: { event: session-finished }\n");
    expect(text(hooked("session-status"))).toContain("\nhook: { event: session-status, status: done }\n");
    expect(text(hooked("session-status", { status: "on-hold", agent: "codex" }))).toContain("\nhook: { event: session-status, status: on-hold, agent: codex }\n");
    // The agent is the session hooks' alone.
    expect(text(hooked("project-first-open", { agent: "claude", project: "p-coda" }))).toContain("\nhook: { event: project-first-open, project: p-coda }\n");
    for (const state of [hooked("session-finished", { agent: "claude" }), hooked("session-status", { project: "p-coda" })]) expect(formErrors(state, SNAPSHOT, PROJECTS)).toEqual([]);
    expect(parseJobFile({ path: "hook.md", text: text(hooked("session-status", { status: "done-skip", project: "p-coda", agent: "claude" })) }).job).toMatchObject({
      trigger: { kind: "hook", hook: { event: "session-status", status: "done-skip", project: "p-coda", agent: "claude" } },
    });
  });

  it("after another job: the job and the result in after:, as a hand-written chain has them", () => {
    let state = setValue(newScript("Cleanup"), "trigger", "chain");
    state = setValue(setValue(state, "chainJob", "backup"), "chainResult", "failed");
    const file = wouldBe(state, SNAPSHOT, PROJECTS);
    expect(file.text).toBe("---\nkind: script\nname: Cleanup\nfolder: .\nenabled: true\ncommand: ./x.sh\nafter: { job: backup, result: failed }\n---\n");
    expect(formErrors(state, SNAPSHOT, PROJECTS)).toEqual([]);
    expect(parseJobFile({ path: "cleanup.md", text: file.text }).job).toMatchObject({ trigger: { kind: "chain", chain: { job: "backup", result: "failed" } } });
  });

  it("a chain with no job chosen asks for one on the job's picker — once Save is pressed", () => {
    const state = setValue(newScript("Cleanup"), "trigger", "chain");
    expect(shown(state, SNAPSHOT)).toEqual({ chainJob: ["after — names no job. Fix: add the job to follow: after: { job: backup, result: done }."] });
    expect(errorShows(state, "chainJob")).toBe(false);
    expect(errorShows({ ...state, tried: true }, "chainJob")).toBe(true);
    expect(blocksSave(state, "chainJob")).toBe(true);
  });
});

describe("editing a script's hook or chain", () => {
  const FIRST_OPEN = "---\nkind: script\nname: Scraper\nfolder: .\ncommand: ./s.sh\nhook: { event: project-first-open, project: p-coda } # job-hunt\n---\n";
  const SESSION = "---\nkind: script\nname: Lint\nfolder: .\ncommand: ./l.sh\nhook: { event: session-finished, agent: claude } # after claude\n---\n";
  const CHAIN = "---\nkind: script\nname: Tests\nfolder: .\ncommand: ./t.sh\nafter: { job: backup } # nightly\n---\n";

  it("a hook on an event the form does not offer stays byte for byte, filter and comment too", () => {
    const state = edit("lint.md", SESSION.replace("session-finished", "session-opened"));
    expect(state.values).toMatchObject({ trigger: "hook", hookEvent: "session-opened" });
    expect(formOffersHook(state.values.hookEvent)).toBe(false);
    const next = setValue(state, "command", "./lint.sh");
    expect(fieldChanges(next)).toEqual({ command: "./lint.sh" });
    // To a schedule and back: nothing of the hook is written.
    expect(fieldChanges(setValue(setValue(state, "trigger", "schedule"), "trigger", "hook"))).toEqual({});
  });

  it("a first open reads its project; another project, or any, rewrites hook:; an edit elsewhere keeps it byte for byte", () => {
    const state = edit("scraper.md", FIRST_OPEN);
    expect(state.values).toMatchObject({ trigger: "hook", hookEvent: "project-first-open", hookProject: "p-coda" });
    expect(formOffersHook(state.values.hookEvent)).toBe(true);
    expect(fieldChanges(setValue(state, "command", "./scrape.sh"))).toEqual({ command: "./scrape.sh" });
    expect(fieldChanges(setValue(state, "hookProject", "p-hunt"))).toEqual({ hook: { event: "project-first-open", project: "p-hunt" } });
    expect(wouldBe(setValue(state, "hookProject", ""), SNAPSHOT, PROJECTS).text).toContain("\nhook: { event: project-first-open } # job-hunt\n");
  });

  it("an agent session hook reads its filters; another agent or status rewrites hook:; an edit elsewhere keeps it byte for byte", () => {
    const state = edit("lint.md", SESSION);
    expect(state.values).toMatchObject({ trigger: "hook", hookEvent: "session-finished", hookProject: "", hookAgent: "claude" });
    expect(formOffersHook(state.values.hookEvent)).toBe(true);
    expect(fieldChanges(setValue(state, "command", "./lint.sh"))).toEqual({ command: "./lint.sh" });
    expect(fieldChanges(setValue(state, "hookAgent", ""))).toEqual({ hook: { event: "session-finished" } });
    expect(wouldBe(setValue(state, "hookProject", "p-coda"), SNAPSHOT, PROJECTS).text).toContain("\nhook: { event: session-finished, project: p-coda, agent: claude } # after claude\n");
    const status = edit("analyze.md", "---\nkind: script\nname: Analyze\nfolder: .\ncommand: ./a.sh\nhook: { event: session-status, status: on-hold }\n---\n");
    expect(status.values).toMatchObject({ hookEvent: "session-status", hookStatus: "on-hold", hookAgent: "" });
    expect(fieldChanges(setValue(status, "hookStatus", "done"))).toEqual({ hook: { event: "session-status", status: "done" } });
  });

  it("to a schedule: the hook goes, the schedule comes", () => {
    const changes = fieldChanges(setValue(edit("scraper.md", FIRST_OPEN), "trigger", "schedule"));
    expect(Object.keys(changes)).toEqual(["schedule", "hook"]);
    expect(changes.hook).toBeUndefined();
  });

  it("a chain reads its job and result; a new result rewrites after:; to the login hook, after: goes", () => {
    const state = edit("tests.md", CHAIN);
    expect(state.values).toMatchObject({ trigger: "chain", chainJob: "backup", chainResult: "done" });
    expect(fieldChanges(setValue(state, "command", "./t2.sh"))).toEqual({ command: "./t2.sh" });
    expect(wouldBe(setValue(state, "chainResult", "any"), SNAPSHOT, PROJECTS).text).toBe(CHAIN.replace("{ job: backup }", "{ job: backup, result: any }"));
    const login = setValue(setValue(state, "trigger", "hook"), "hookEvent", "login");
    expect(fieldChanges(login)).toEqual({ hook: { event: "login" }, after: undefined });
  });

  it("a chain that leads back to itself is refused on its job's picker, naming both jobs, and Save is held", () => {
    const a = "---\nkind: script\nname: A\nfolder: .\ncommand: ./a.sh\nschedule:\n  daily: { at: 9:00 }\n---\n";
    const b = "---\nkind: script\nname: B\nfolder: .\ncommand: ./b.sh\nafter: { job: a }\n---\n";
    const snapshot = snapshotOf({ "a.md": a, "b.md": b });
    const state = setValue(setValue(edit("a.md", a), "trigger", "chain"), "chainJob", "b");
    const errors = formErrors(state, snapshot, PROJECTS);
    expect(shown(state, snapshot)).toEqual({ chainJob: ["after.job — the chain loops back: a → b → a. Fix: remove after: from one of these jobs, or point it at a job outside the loop."] });
    expect(errors.some(isLoopError)).toBe(true);
    expect(errorShows(state, "chainJob")).toBe(true);
    expect(blocksSave(state, "chainJob")).toBe(true);
  });
});

describe("a service's chain", () => {
  it("is off until added; added, after: holds the job, the result and the action; removed, it goes", () => {
    let state = setFolder(setValue(setValue(newForm("service"), "name", "Web 2"), "command", "./w.sh"), ".", PROJECTS);
    expect(wouldBe(state, SNAPSHOT, PROJECTS).text).not.toContain("after");
    state = setValue(setValue(setValue(state, "serviceChain", true), "chainJob", "backup"), "chainAction", "stop");
    const text = wouldBe(state, SNAPSHOT, PROJECTS).text;
    expect(text).toContain("\nafter: { job: backup, result: done, action: stop }\n");
    expect(formErrors(state, SNAPSHOT, PROJECTS)).toEqual([]);
    expect(parseJobFile({ path: "web-2.md", text }).job).toMatchObject({ kind: "service", after: { job: "backup", result: "done", action: "stop" } });
    expect(wouldBe(setValue(state, "serviceChain", false), SNAPSHOT, PROJECTS).text).not.toContain("after");
  });

  it("an edit reads it, changes only it, and its errors show on its job's picker", () => {
    const hand = "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\nafter: { job: backup, action: start } # warm it\n---\n";
    const state = edit("web.md", hand);
    expect(state.values).toMatchObject({ serviceChain: true, chainJob: "backup", chainResult: "done", chainAction: "start" });
    expect(fieldChanges(setValue(state, "command", "./w.sh"))).toEqual({ command: "./w.sh" });
    expect(fieldChanges(setValue(state, "serviceChain", false))).toEqual({ after: undefined });
    const missing = setValue(state, "chainJob", "nope");
    expect(Object.keys(shown(missing, SNAPSHOT))).toEqual(["chainJob"]);
  });

  it("an after: error on a service with no chain drawn is the file's", () => {
    const state = setValue(edit("web.md", "---\nkind: service\nname: Web\nfolder: .\ncommand: ./web.sh\nafter: { job: nope }\n---\n"), "command", "./w.sh");
    expect(errorsByPlace(formErrors(state, SNAPSHOT, PROJECTS), { ...state.values, serviceChain: false }).has("file")).toBe(true);
  });
});

describe("triggerWords", () => {
  it("offers every hook the engine fires — Mac login, Pomade's and the agents' — in the prototype's order, and not the chain's own entry", () => {
    expect(EVENT_CHOICES.map((choice) => choice.label)).toEqual(["Mac login", "Pomade started", "First open of a project since Pomade started", "Project created", "Agent session finished", "Session status changed to…", "Another job finished"]);
    expect(["login", "pomade-started", "project-first-open", "project-created", "session-finished", "session-status"].map(formOffersHook)).toEqual([true, true, true, true, true, true]);
    expect(["chain", "session-opened", ""].map(formOffersHook)).toEqual([false, false, false]);
  });

  it("the agent session pickers: the statuses by the Agents app's names, Any agent then the roster by id; a value the file names stays", () => {
    expect(statusPicks("done")).toEqual([
      { value: "active", label: "Active" },
      { value: "on-hold", label: "On hold" },
      { value: "done", label: "Done" },
      { value: "done-skip", label: "Done–skip/Failed" },
    ]);
    expect(statusPicks("parked").at(-1)).toEqual({ value: "parked", label: "parked" });
    const roster = [{ id: "claude", name: "Claude", command: "claude", provider: "claude" as const, configDir: "/h/.claude" }];
    expect(agentPicks(roster, "")).toEqual([
      { value: "", label: "Any agent" },
      { value: "claude", label: "claude" },
    ]);
    expect(agentPicks([], "codex").map((option) => option.value)).toEqual(["", "codex"]);
  });

  it("the chain's picker: valid jobs that finish, by name, without the job itself; a job the file names stays, by id", () => {
    const snapshot = snapshotOf({ "backup.md": BACKUP, "web.md": WEB, "zeta.md": BACKUP.replace("Backup", "Archive"), "bad.md": "---\nkind: script\nname: Bad\n---\n" });
    expect(chainJobOptions(snapshot, null, "", "Choose a job…")).toEqual([
      { value: "", label: "Choose a job…" },
      { value: "zeta", label: "Archive" },
      { value: "backup", label: "Backup" },
    ]);
    expect(chainJobOptions(snapshot, "backup", "gone", "x").map((option) => option.value)).toEqual(["", "zeta", "gone"]);
    expect(jobName(snapshot, "bad")).toBe("Bad");
    expect(jobName(snapshot, "gone")).toBeNull();
  });

  it("the trigger in words: the login hook with the warm-up as the settings say it; Pomade's with no missed runs; a chain with its job's name", () => {
    const login = setValue(newScript("Mount"), "trigger", "hook").values;
    const pomade = "Fires only while Pomade is running, so there are no missed runs.";
    expect(hookBoxWords({ ...login, hookEvent: "pomade-started" }, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs when Pomade starts", sub: pomade });
    expect(hookBoxWords({ ...login, hookEvent: "project-created" }, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs when a project is created", sub: pomade });
    expect(hookBoxWords({ ...login, hookEvent: "project-first-open" }, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs on first open of a project", sub: pomade });
    expect(hookBoxWords({ ...login, hookEvent: "project-first-open", hookProject: "p-coda" }, SNAPSHOT, 2, PROJECTS).title).toBe("Runs on first open of coda-helper");
    expect(hookBoxWords({ ...login, hookEvent: "project-first-open", hookProject: "p-gone" }, SNAPSHOT, 2, PROJECTS).title).toBe("Runs on first open of p-gone");
    expect(hookBoxWords({ ...login, hookEvent: "session-finished" }, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs after an agent session finishes", sub: pomade });
    expect(hookBoxWords({ ...login, hookEvent: "session-finished", hookAgent: "claude", hookProject: "p-coda", hookStatus: "on-hold" }, SNAPSHOT, 2, PROJECTS).title).toBe("Runs after a claude session finishes in coda-helper");
    expect(hookBoxWords({ ...login, hookEvent: "session-status" }, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs when a session is marked Done", sub: pomade });
    expect(hookBoxWords({ ...login, hookEvent: "session-status", hookStatus: "on-hold", hookAgent: "opus", hookProject: "p-gone" }, SNAPSHOT, 2, PROJECTS).title).toBe("Runs when an opus session is marked On hold in p-gone");
    expect(hookBoxWords(login, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs at Mac login", sub: "Once per login, after the 2-minute warm-up." });
    expect(hookBoxWords(login, SNAPSHOT, 0, PROJECTS).sub).toBe("Once per login, once the services are up.");
    expect(hookBoxWords(login, SNAPSHOT, null, PROJECTS).sub).toBe("Once per login, after the warm-up.");
    const chain = { ...login, trigger: "chain" as const };
    expect(hookBoxWords(chain, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs after another job finishes", sub: "A chain. History will show “chain: after …”." });
    expect(hookBoxWords({ ...chain, chainJob: "backup", chainResult: "failed" }, SNAPSHOT, 2, PROJECTS)).toEqual({ title: "Runs after Backup fails", sub: "A chain. History will show “chain: after Backup”." });
    expect(hookBoxWords({ ...chain, chainJob: "gone", chainResult: "any" }, SNAPSHOT, 2, PROJECTS).title).toBe("Runs after gone finishes");
  });

  it("a loop is told from the checker's other chain errors", () => {
    const error = (problem: string): JobError => ({ path: "a.md", line: 6, field: "after.job", problem, fix: "" });
    expect(isLoopError(error("the chain loops back: a → b → a"))).toBe(true);
    expect(isLoopError(error("no job has the id x"))).toBe(false);
  });
});
