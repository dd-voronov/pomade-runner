import { describe, expect, it } from "vitest";

import { checkJobs } from "../../jobs/check";
import { describeJobError } from "../../jobs/format";
import type { JobsSnapshot, ProjectRecord } from "../../jobs/model";
import {
  blocksSave,
  customised,
  editForm,
  errorShows,
  errorsByPlace,
  fieldChanges,
  followText,
  formErrors,
  hasChanges,
  newForm,
  projectOfFolder,
  setFolder,
  setValue,
  switchKind,
  valuesFromText,
  wouldBe,
  type FormState,
} from "./state";

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
  const places = errorsByPlace(formErrors(state, snapshot, PROJECTS), state.values.kind);
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

  it("a project-first-open start needs a project, said on the start field", () => {
    const state = setValue(fill(newForm("service"), { name: "Web", folder: ".", command: "x" }), "start", "project-first-open");
    expect(shown(state, EMPTY)).toEqual({ start: ["start — starts on the first open of its project, and the job has no project. Fix: add project: <the project's id>, or write start: login."] });
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
      ready: "port",
      port: "5173",
      url: "",
      lowPriority: false,
      notify: "on-failure",
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
    const places = errorsByPlace(formErrors(state, WITH_WEB, PROJECTS), "service");
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

  it("says when the policies are not the kind's defaults", () => {
    expect(customised(edit().values)).toBe(false);
    expect(customised(setValue(edit(), "lowPriority", true).values)).toBe(true);
  });
});
