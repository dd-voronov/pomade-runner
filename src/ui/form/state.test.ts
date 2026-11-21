import { describe, expect, it } from "vitest";

import { checkJobs } from "../../jobs/check";
import { describeJobError } from "../../jobs/format";
import type { JobsSnapshot, ProjectRecord } from "../../jobs/model";
import {
  blocksSave,
  bodyChange,
  editForm,
  errorShows,
  errorsByPlace,
  fieldChanges,
  followText,
  formErrors,
  hasChanges,
  newBody,
  newForm,
  projectOfFolder,
  setFolder,
  setValue,
  switchKind,
  valuesFromText,
  wouldBe,
  type FormState,
} from "./state";
import { blankSchedule } from "./schedule";

const PROJECTS: ProjectRecord[] = [
  { id: "p-coda", name: "coda-helper", root: "Projects/coda-helper" },
  { id: "p-hunt", name: "job-hunt", root: "Projects/job-hunt" },
  { id: "p-graph", name: "Graphs", root: "Projects/coda-helper/graphs" },
];

const HAND = "---\nkind: service # keeps the web app up\nname: Coda web\nproject: p-coda\nfolder: Projects/coda-helper\ncommand: ./start.sh\nready: { port: 5173 } # vite\nowner: daniil\n---\nNotes for humans.\n";

function snapshotOf(files: Record<string, string>): JobsSnapshot {
  return checkJobs(Object.entries(files).map(([path, text]) => ({ path, text })), { workspace: "/ws", projects: PROJECTS });
}

const EMPTY = snapshotOf({});
const WITH_WEB = snapshotOf({ "coda-helper/coda-web.md": HAND, "backup.md": "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./b.sh\nschedule:\n  daily: { at: 13:00 }\n---\n" });

function fill(state: FormState, values: Partial<Record<"name" | "folder" | "command", string>>): FormState {
  let next = state;
  for (const [field, value] of Object.entries(values) as ["name" | "folder" | "command", string][]) next = field === "folder" ? setFolder(next, value, PROJECTS) : setValue(next, field, value);
  return next;
}

/** Each place's errors, in `pomade-runner check`'s words. */
function shown(state: FormState, snapshot: JobsSnapshot): Record<string, string[]> {
  const places = errorsByPlace(formErrors(state, snapshot, PROJECTS), state.values);
  return Object.fromEntries([...places].map(([place, errors]) => [place, errors.map(describeJobError)]));
}

describe("a new service", () => {
  it("becomes a job file with the fields it needs, defaults left out, in the project's sub-folder", () => {
    const state = fill(newForm("service"), { name: "Coda web", folder: "Projects/coda-helper", command: "./start.sh" });
    expect(state.values.project).toBe("p-coda");
    expect(wouldBe(state, EMPTY, PROJECTS)).toEqual({
      path: "Apps/pomade-runner/jobs/coda-helper/coda-web.md",
      text: "---\nkind: service\nname: Coda web\nproject: p-coda\nfolder: Projects/coda-helper\nenabled: true\ncommand: ./start.sh\n---\n",
      movesFrom: null,
    });
    expect(formErrors(state, EMPTY, PROJECTS)).toEqual([]);
  });

  it("writes readiness, the start and the policies the person chose", () => {
    let state = fill(newForm("service"), { name: "Web", folder: ".", command: "npm run dev" });
    state = setValue(setValue(state, "ready", "url"), "url", " http://localhost:5173/ ");
    state = setValue(setValue(state, "lowPriority", true), "notify", "never");
    state = setValue(state, "enabled", false);
    expect(wouldBe(state, EMPTY, PROJECTS).text).toBe("---\nkind: service\nname: Web\nfolder: .\nenabled: false\ncommand: npm run dev\nready: { url: http://localhost:5173/ }\nlow-priority: true\nnotify: never\n---\n");
    expect(wouldBe(setValue(state, "ready", "port"), EMPTY, PROJECTS).text).toContain("\nready: {}\n");
    expect(wouldBe(setValue(setValue(state, "ready", "port"), "port", "5173"), EMPTY, PROJECTS).text).toContain("\nready: { port: 5173 }\n");
  });

  it("takes the first free file name its name gives", () => {
    const state = fill(newForm("service"), { name: "Backup service", folder: ".", command: "x" });
    const taken = snapshotOf({ "backup-service.md": "---\nkind: service\nname: Other\nfolder: .\ncommand: y\n---\n" });
    expect(wouldBe(state, taken, PROJECTS).path).toBe("Apps/pomade-runner/jobs/backup-service-2.md");
  });

  it("puts each of the validator's errors on its field, in its words", () => {
    let state = newForm("service");
    state = setValue(setValue(state, "ready", "port"), "port", "99999");
    expect(shown(state, EMPTY)).toEqual({
      name: ["name — is empty. Fix: write it, e.g. name: Coda web."],
      folder: ["folder — is empty. Fix: write it, e.g. folder: Projects/my-project."],
      command: ["command — is empty. Fix: write it, e.g. command: ./start.sh."],
      ready: ['ready.port — 99999 is not a port. Fix: write a whole number from 1 to 65535, e.g. ready: { port: 5173 }.'],
    });
    expect(shown(setValue(state, "port", "abc"), EMPTY).ready).toEqual(['ready.port — "abc" is not a port. Fix: write a whole number from 1 to 65535, e.g. ready: { port: 5173 }.']);
    expect(shown(setValue(state, "port", ""), EMPTY).ready).toEqual(["ready — names no check. Fix: write ready: { port: 5173 } or ready: { url: http://localhost:5173/ } — or remove it: up means still alive after 5 s."]);
  });

  it("says a name is taken as the checker says it, and a folder outside the workspace", () => {
    const state = fill(newForm("service"), { name: "backup", folder: "../elsewhere", command: "x" });
    expect(shown(state, WITH_WEB)).toEqual({
      name: ["name — backup is also the name of Apps/pomade-runner/jobs/backup.md. Fix: give each job its own name — History, notices and `pomade-runner run` tell jobs apart by name."],
      folder: ['folder — "../elsewhere" is outside the workspace. Fix: write a folder inside the workspace, relative to its root, e.g. folder: Projects/my-project (. is the workspace root).'],
    });
  });

  it("a project-first-open start needs a project, said on the start field; one picked is start-project", () => {
    const state = setValue(fill(newForm("service"), { name: "Web", folder: ".", command: "x" }), "start", "project-first-open");
    expect(shown(state, EMPTY)).toEqual({ start: ["start — starts on the first open of a project, and names none. Fix: add start-project: <the project's id> — `pomade-runner projects` lists them — or write start: login."] });
    const picked = setValue(state, "startProject", "p-hunt");
    expect(wouldBe(picked, EMPTY, PROJECTS).text).toContain("\nstart: project-first-open\nstart-project: p-hunt\n");
    expect(formErrors(picked, EMPTY, PROJECTS)).toEqual([]);
    // Back to At login: the start project goes with it.
    expect(wouldBe(setValue(picked, "start", "login"), EMPTY, PROJECTS).text).not.toContain("start");
  });

  it("a project's service starts on its own project's first open unless another is picked", () => {
    const own = setValue(fill(newForm("service"), { name: "Web", folder: "Projects/coda-helper", command: "x" }), "start", "project-first-open");
    expect(own.values.project).toBe("p-coda");
    expect(wouldBe(own, EMPTY, PROJECTS).text).not.toContain("start-project");
    expect(formErrors(own, EMPTY, PROJECTS)).toEqual([]);
    const edited = editForm("Apps/pomade-runner/jobs/coda-helper/web.md", "---\nkind: service\nname: Web\nproject: p-coda\nfolder: .\ncommand: x\nstart: project-first-open\nstart-project: p-hunt # its scraper\n---\n");
    expect(edited?.values).toMatchObject({ start: "project-first-open", startProject: "p-hunt" });
    expect(edited === null ? null : fieldChanges(setValue(edited, "command", "y"))).toEqual({ command: "y" });
  });

  it("shows an empty field's error only once Save was pressed; a filled-in field's at once", () => {
    let state = newForm("service");
    expect(errorShows(state, "name")).toBe(false);
    state = setValue(state, "port", "x");
    state = setValue(state, "ready", "port");
    expect(errorShows(state, "ready")).toBe(true);
    expect(errorShows(setValue(state, "name", "  "), "name")).toBe(false);
    expect(errorShows(state, "file")).toBe(false);
    state = { ...state, tried: true };
    expect(errorShows(state, "name")).toBe(true);
    expect(errorShows(state, "file")).toBe(true);
    expect(blocksSave(state, "file")).toBe(true);
  });
});

describe("the folder fills in the project", () => {
  it("the deepest project whose root holds the folder; none leaves the project as it is", () => {
    expect(projectOfFolder("Projects/coda-helper", PROJECTS)?.id).toBe("p-coda");
    expect(projectOfFolder("Projects/coda-helper/web/", PROJECTS)?.id).toBe("p-coda");
    expect(projectOfFolder("Projects/coda-helper/graphs/x", PROJECTS)?.id).toBe("p-graph");
    expect(projectOfFolder("Projects/coda-helperx", PROJECTS)).toBeUndefined();
    const state = setValue(newForm("service"), "project", "p-hunt");
    expect(setFolder(state, "Scripts", PROJECTS).values.project).toBe("p-hunt");
    expect(setFolder(state, "Projects/coda-helper", PROJECTS).values.project).toBe("p-coda");
  });
});

describe("switching kind", () => {
  it("keeps the person's edits and resets the defaults they left alone", () => {
    let state = setValue(fill(newForm("service"), { name: "Web" }), "notify", "never");
    expect(state.values.lowPriority).toBe(false);
    state = switchKind(state, "script");
    expect(state.values).toMatchObject({ kind: "script", name: "Web", lowPriority: true, notify: "never" });
    state = switchKind(state, "agent");
    expect(state.values).toMatchObject({ lowPriority: true, notify: "never" });
    state = switchKind(setValue(state, "lowPriority", true), "service");
    expect(state.values).toMatchObject({ kind: "service", lowPriority: true, notify: "never", name: "Web" });
    expect(switchKind(newForm("script"), "service").values).toMatchObject({ lowPriority: false, notify: "on-failure" });
  });
});

describe("editing a job file", () => {
  const PATH = "Apps/pomade-runner/jobs/coda-helper/coda-web.md";
  const edit = (): FormState => {
    const state = editForm(PATH, HAND);
    if (state === null) throw new Error("not editable");
    return state;
  };

  it("reads the values the file says", () => {
    expect(edit().values).toEqual({
      kind: "service",
      name: "Coda web",
      project: "p-coda",
      folder: "Projects/coda-helper",
      enabled: true,
      command: "./start.sh",
      start: "login",
      startProject: "",
      ready: "port",
      port: "5173",
      url: "",
      trigger: "schedule",
      schedule: blankSchedule(),
      hookEvent: "login",
      hookProject: "",
      hookAgent: "",
      hookStatus: "done",
      serviceChain: false,
      chainJob: "",
      chainResult: "done",
      chainAction: "restart",
      missed: "run-on-wake",
      worth: "next-run",
      worthAt: "12:00",
      overlap: "skip",
      lowPriority: false,
      timeLimit: "",
      notify: "on-failure",
      operation: "commit-push",
      repos: [],
      agent: "claude",
      mode: "normal",
      prompt: expect.any(String) as string,
    });
    expect(valuesFromText("---\nkind: [x\n---\n")).toBeNull();
    expect(valuesFromText("---\nkind: servce\n---\n")).toBeNull();
    expect(valuesFromText("---\nkind: service\nnotify: loud\nready: { url: http://x/ }\n---\n")).toMatchObject({ notify: "on-failure", ready: "url", url: "http://x/" });
  });

  it("writes only the changed fields: comments, an unknown field and the body stay byte for byte", () => {
    let state = edit();
    expect(hasChanges(state)).toBe(false);
    expect(fieldChanges(state)).toEqual({});
    state = setValue(state, "command", "npm run dev");
    state = setValue(state, "notify", "always");
    expect(fieldChanges(state)).toEqual({ command: "npm run dev", notify: "always" });
    expect(wouldBe(state, WITH_WEB, PROJECTS)).toEqual({
      path: PATH,
      text: HAND.replace("./start.sh", "npm run dev").replace("owner: daniil\n", "owner: daniil\nnotify: always\n"),
      movesFrom: null,
    });
    // Back to what the file says: nothing to write.
    expect(hasChanges(setValue(setValue(state, "command", "./start.sh"), "notify", "on-failure"))).toBe(false);
  });

  it("removes a field set back to its default, and readiness switched to alive", () => {
    const state = setValue(edit(), "ready", "alive");
    expect(fieldChanges(state)).toEqual({ ready: undefined });
    expect(wouldBe(state, WITH_WEB, PROJECTS).text).toBe(HAND.replace("ready: { port: 5173 } # vite\n", ""));
  });

  it("a new project moves the file to that project's sub-folder, under its file name; the job's own name is no clash", () => {
    const state = setFolder(edit(), "Projects/job-hunt", PROJECTS);
    const file = wouldBe(state, WITH_WEB, PROJECTS);
    expect(file).toMatchObject({ path: "Apps/pomade-runner/jobs/job-hunt/coda-web.md", movesFrom: PATH });
    expect(file.text).toContain("project: p-hunt\nfolder: Projects/job-hunt\n");
    expect(formErrors(state, WITH_WEB, PROJECTS).map((error) => error.field)).toEqual(["owner"]);
    expect(wouldBe(setValue(edit(), "project", null), WITH_WEB, PROJECTS)).toMatchObject({ path: "Apps/pomade-runner/jobs/coda-web.md", movesFrom: PATH });
  });

  it("puts a problem the form has no field for on the file, and it does not keep Save from writing", () => {
    const state = edit();
    const places = errorsByPlace(formErrors(state, WITH_WEB, PROJECTS), state.values);
    expect([...places.keys()]).toEqual(["file"]);
    expect(places.get("file")?.map(describeJobError)).toEqual(["owner — owner is not a job field. Fix: remove it — the pomade-runner-jobs skill lists every field."]);
    expect(errorShows(state, "file")).toBe(true);
    expect(blocksSave(state, "file")).toBe(false);
    expect(blocksSave(state, "name")).toBe(true);
  });

  it("follows the file on disk: untouched fields take its values, the person's edits stay and clash", () => {
    let state = setValue(edit(), "command", "npm run dev");
    state = followText(state, HAND.replace("Coda web", "Coda site").replace("./start.sh", "./serve.sh"));
    expect(state.values).toMatchObject({ name: "Coda site", command: "npm run dev" });
    expect(state.clashes).toEqual(["command"]);
    expect(fieldChanges(state)).toEqual({ command: "npm run dev" });
    // A text the form cannot read keeps the values and takes the text.
    const broken = followText(state, "---\nkind: [x\n---\n");
    expect(broken.values).toEqual(state.values);
    expect(broken.text).toBe("---\nkind: [x\n---\n");
  });
});

describe("the policies: missed-run, worth-until, time limit", () => {
  const PATH = "Apps/pomade-runner/jobs/librarian.md";
  const FILE = (extra: string): string => `---\nkind: script # tidy\nname: Librarian\nfolder: .\ncommand: ./l.sh\nschedule:\n  weekly: { days: [sun], at: 3:00 }\n${extra}---\nNotes.\n`;
  const edit = (extra: string): FormState => {
    const state = editForm(PATH, FILE(extra));
    if (state === null) throw new Error("not editable");
    return state;
  };
  const written = (state: FormState): string => wouldBe(state, EMPTY, PROJECTS).text;

  it("reads them from the file: the policy, a time of day as written, the limit as written", () => {
    expect(edit("").values).toMatchObject({ missed: "run-on-wake", worth: "next-run", worthAt: "12:00", timeLimit: "" });
    expect(edit("missed: wait-for-me\ntime-limit: 1h30m\n").values).toMatchObject({ missed: "wait-for-me", timeLimit: "1h30m" });
    expect(edit("worth-until: 7:30\n").values).toMatchObject({ missed: "run-on-wake", worth: "time", worthAt: "7:30" });
    expect(edit("worth-until: next-run\n").values).toMatchObject({ worth: "next-run", worthAt: "12:00" });
    expect(edit("time-limit:\n").values.timeLimit).toBe("");
    // A policy the format lacks stands at the default; the checker's error is shown on its row.
    expect(edit("missed: sometimes\n").values.missed).toBe("run-on-wake");
  });

  it("writes each one field-only: the comment, the other fields and the body stay", () => {
    let state = setValue(edit(""), "missed", "wait-for-me");
    expect(fieldChanges(state)).toEqual({ missed: "wait-for-me" });
    expect(written(state)).toBe(FILE("missed: wait-for-me\n"));
    state = setValue(edit(""), "timeLimit", " 45m ");
    expect(fieldChanges(state)).toEqual({ "time-limit": "45m" });
    expect(written(state)).toBe(FILE("time-limit: 45m\n"));
    state = setValue(setValue(edit(""), "worth", "time"), "worthAt", "12:00");
    expect(fieldChanges(state)).toEqual({ "worth-until": "12:00" });
    expect(written(state)).toBe(FILE("worth-until: 12:00\n"));
    // Back to the default, or emptied: the field leaves the file.
    expect(written(setValue(edit("missed: skip\n"), "missed", "run-on-wake"))).toBe(FILE(""));
    expect(written(setValue(edit("time-limit: 45m\n"), "timeLimit", ""))).toBe(FILE(""));
    expect(written(setValue(edit("worth-until: 12:00\n"), "worth", "next-run"))).toBe(FILE(""));
    expect(hasChanges(setValue(setValue(edit("time-limit: 45m\n"), "timeLimit", "1h"), "timeLimit", "45m"))).toBe(false);
  });

  it("worth-until goes with run-on-wake: another policy takes it out of the file, and back it returns", () => {
    let state = setValue(edit("worth-until: 12:00\n"), "missed", "wait-for-me");
    expect(fieldChanges(state)).toEqual({ missed: "wait-for-me", "worth-until": undefined });
    expect(written(state)).toBe(FILE("missed: wait-for-me\n"));
    state = setValue(state, "missed", "run-on-wake");
    expect(fieldChanges(state)).toEqual({});
    expect(written(setValue(edit("missed: skip\n"), "missed", "run-on-wake"))).toBe(FILE(""));
  });

  it("a new script writes them after the schedule, in the format's order, and a hook writes no missed policy", () => {
    let state = fill(switchKind(newForm("service"), "script"), { name: "Sync", folder: ".", command: "./s.sh" });
    state = setValue(setValue(setValue(state, "missed", "run-on-wake"), "worth", "time"), "worthAt", "12:00");
    state = setValue(setValue(state, "timeLimit", "2h"), "overlap", "queue");
    expect(wouldBe(state, EMPTY, PROJECTS).text).toBe("---\nkind: script\nname: Sync\nfolder: .\nenabled: true\ncommand: ./s.sh\nschedule:\n  daily: { at: 9:00 }\nworth-until: 12:00\noverlap: queue\ntime-limit: 2h\n---\n");
    expect(formErrors(state, EMPTY, PROJECTS)).toEqual([]);
    const hook = editForm("Apps/pomade-runner/jobs/mount.md", "---\nkind: script\nname: Mount\nfolder: .\ncommand: ./m.sh\nhook: { event: login }\n---\n");
    if (hook === null) throw new Error("not editable");
    expect(wouldBe(setValue(setValue(hook, "missed", "skip"), "timeLimit", "5m"), EMPTY, PROJECTS).text).toBe("---\nkind: script\nname: Mount\nfolder: .\ncommand: ./m.sh\nhook: { event: login }\ntime-limit: 5m\n---\n");
  });

  it("a service writes none of them", () => {
    const state = setValue(setValue(fill(newForm("service"), { name: "Web", folder: ".", command: "x" }), "timeLimit", "5m"), "missed", "skip");
    expect(wouldBe(state, EMPTY, PROJECTS).text).toBe("---\nkind: service\nname: Web\nfolder: .\nenabled: true\ncommand: x\n---\n");
  });

  it("each of the validator's errors on its row, in its words", () => {
    const state = setValue(setValue(setValue(edit(""), "timeLimit", "soon"), "worth", "time"), "worthAt", "noon");
    expect(shown(state, EMPTY)).toEqual({
      worthAt: ['worth-until — "noon" is not a time of day. Fix: write a time like worth-until: 12:00 (H:MM, 24-hour), or worth-until: next-run.'],
      timeLimit: ['time-limit — "soon" is not a duration. Fix: write minutes or hours, e.g. time-limit: 45m, 2h or 1h30m — or leave it empty for no limit.'],
    });
    expect(shown(setValue(edit(""), "timeLimit", "90"), EMPTY).timeLimit).toEqual(["time-limit — 90 has no unit. Fix: add one: time-limit: 90m (minutes) or 90h (hours)."]);
    // An empty time of day is an error too, not "the next run".
    expect(shown(setValue(setValue(edit(""), "worth", "time"), "worthAt", " "), EMPTY).worthAt).toHaveLength(1);
  });

  it("an error about a control the form does not draw is the file's: a stray worth-until, a missed policy on a hook", () => {
    const stray = edit("missed: skip\nworth-until: 12:00\n");
    expect(shown(stray, EMPTY)).toEqual({ file: ["worth-until — only applies with missed: run-on-wake. Fix: remove it, or set missed: run-on-wake."] });
    const hook = editForm("Apps/pomade-runner/jobs/mount.md", "---\nkind: script\nname: Mount\nfolder: .\ncommand: ./m.sh\nhook: { event: login }\nmissed: skip\n---\n");
    if (hook === null) throw new Error("not editable");
    expect(Object.keys(shown(hook, EMPTY))).toEqual(["file"]);
  });

  it("switching kind resets a missed policy the person did not set, and keeps one they did", () => {
    const state = setValue(switchKind(newForm("service"), "script"), "missed", "skip");
    expect(switchKind(state, "service").values.missed).toBe("skip");
    expect(switchKind(switchKind(newForm("service"), "script"), "service").values.missed).toBe("run-on-wake");
  });
});

describe("a git job", () => {
  const GIT = "---\nkind: git # Knowledge twice daily\nname: Knowledge commit & push\nproject: p-coda\ngit: { operation: pull, repos: [Knowledge, coda-helper] } # rails\nschedule:\n  daily: { at: [13:00, 20:00] }\n---\nKeep it.\n";

  it("a new one writes its operation and repos, its trigger and no folder; Skip, normal priority and On failure are its defaults", () => {
    let state = setFolder(switchKind(fill(newForm("script"), { name: "Knowledge commit & push" }), "git"), "Projects/coda-helper", PROJECTS);
    expect(state.values).toMatchObject({ missed: "skip", lowPriority: false, notify: "on-failure", operation: "commit-push" });
    state = setValue(state, "repos", ["Knowledge", "coda-helper"]);
    expect(wouldBe(state, EMPTY, PROJECTS)).toMatchObject({
      path: "Apps/pomade-runner/jobs/coda-helper/knowledge-commit-push.md",
      text: "---\nkind: git\nname: Knowledge commit & push\nproject: p-coda\nenabled: true\ngit: { operation: commit-push, repos: [Knowledge, coda-helper] }\nschedule:\n  daily: { at: 9:00 }\n---\n",
    });
    expect(shown(state, EMPTY)).toEqual({});
  });

  it("with no repo picked, the checker's error is on the repos", () => {
    const state = setValue(fill(newForm("git"), { name: "Pull" }), "repos", []);
    expect(shown(state, EMPTY)).toEqual({ repos: ["git.repos — names no repos. Fix: list the repos by the name Pomade's Git panel shows: repos: [Knowledge, coda-helper]."] });
    expect(errorShows(state, "repos")).toBe(false);
    expect(errorShows({ ...state, tried: true }, "repos")).toBe(true);
    expect(errorShows(setValue(state, "repos", ["Knowledge"]), "repos")).toBe(true);
  });

  it("reads its operation and repos — a lone name too — and edits them field-only: the comment-free rest and the body stay", () => {
    const state = editForm("Apps/pomade-runner/jobs/coda-helper/knowledge.md", GIT);
    expect(state?.values).toMatchObject({ kind: "git", operation: "pull", repos: ["Knowledge", "coda-helper"], missed: "skip", trigger: "schedule" });
    expect(valuesFromText("---\nkind: git\nname: P\ngit: { operation: fetch, repos: Knowledge }\n---\n")).toMatchObject({ operation: "fetch", repos: ["Knowledge"] });
    if (state === null) throw new Error("unreadable");
    expect(hasChanges(state)).toBe(false);
    const edited = setValue(setValue(state, "operation", "commit-push"), "repos", ["coda-helper"]);
    expect(fieldChanges(edited)).toEqual({ git: { operation: "commit-push", repos: ["coda-helper"] } });
    expect(wouldBe(edited, EMPTY, PROJECTS).text).toBe(GIT.replace("git: { operation: pull, repos: [Knowledge, coda-helper] } # rails", "git: { operation: commit-push, repos: [coda-helper] } # rails"));
  });

  it("switching a script to git takes its folder and command out of the file", () => {
    const script = editForm("Apps/pomade-runner/jobs/backup.md", "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./b.sh\nschedule:\n  daily: { at: 13:00 }\n---\n");
    if (script === null) throw new Error("unreadable");
    const git = setValue(switchKind(script, "git"), "repos", ["Knowledge"]);
    expect(fieldChanges(git)).toMatchObject({ kind: "git", folder: undefined, command: undefined, git: { operation: "commit-push", repos: ["Knowledge"] } });
    expect(shown(git, EMPTY)).toEqual({});
  });
});

describe("an agent job", () => {
  it("becomes a job file with its agent, mode and prompt as the body; Normal and the kind's defaults left out", () => {
    let state = fill(switchKind(newForm("service"), "agent"), { name: "Morning summary", folder: "." });
    expect(state.values).toMatchObject({ lowPriority: true, notify: "always", missed: "run-on-wake" });
    state = setValue(state, "prompt", "  Write my morning summary.\n\n1. Read today's items.\n");
    expect(newBody(state.values)).toBe("Write my morning summary.\n\n1. Read today's items.\n");
    expect(wouldBe(state, EMPTY, PROJECTS).text).toBe(
      "---\nkind: agent\nname: Morning summary\nfolder: .\nenabled: true\nagent: claude\nschedule:\n  daily: { at: 9:00 }\n---\nWrite my morning summary.\n\n1. Read today's items.\n",
    );
    state = setValue(state, "mode", "full-autonomy");
    expect(wouldBe(state, EMPTY, PROJECTS).text).toContain("agent: claude\nmode: full-autonomy\n");
  });

  it("an empty prompt is the prompt's error, in the checker's words", () => {
    const state = { ...fill(switchKind(newForm("service"), "agent"), { name: "Summary", folder: "." }), tried: true };
    expect(shown(state, EMPTY).prompt).toEqual(["body — an agent job's prompt is its body, and the body is empty. Fix: write what the agent should do below the closing --- line."]);
    expect(blocksSave(state, "prompt")).toBe(true);
  });

  it("editing writes the prompt as the body, field-only otherwise; the fields stay", () => {
    const text = "---\nkind: agent # 7:00 summary\nname: Summary\nfolder: .\nagent: claude\nschedule:\n  daily: { at: 7:00 }\n---\nWrite my summary.\n";
    let state = editForm("Apps/pomade-runner/jobs/summary.md", text);
    if (state === null) throw new Error("cannot edit");
    expect(state.values).toMatchObject({ agent: "claude", mode: "normal", prompt: "Write my summary." });
    expect(hasChanges(state)).toBe(false);
    expect(bodyChange(state)).toBeUndefined();
    state = setValue(state, "prompt", "Write my summary, in 12 lines.");
    expect(hasChanges(state)).toBe(true);
    expect(fieldChanges(state)).toEqual({});
    expect(bodyChange(state)).toBe("Write my summary, in 12 lines.\n");
    expect(wouldBe(state, snapshotOf({ "summary.md": text }), PROJECTS).text).toBe(text.replace("Write my summary.", "Write my summary, in 12 lines."));
    state = setValue(state, "mode", "full-autonomy");
    expect(fieldChanges(state)).toEqual({ mode: "full-autonomy" });
  });
});
