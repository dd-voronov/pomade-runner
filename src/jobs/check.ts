// Every job file of a workspace, checked together: each file on its own (`parse.ts`), then what
// needs the others — chains that name a job, chains that loop back, names used twice — and, when
// Pomade's projects are known, project ids and the sub-folder each project job sits in. The one
// validator the scheduler, the `pomade-runner check` command and the UI share. Pure.

import { baseName } from "pomade-kit/protocol";

import { closest, parseJobFile, type JobFileInput, type ParsedJobFile } from "./parse";
import { JOBS_FOLDER, type JobEntry, type JobError, type JobsSnapshot, type ProjectRecord } from "./model";

export interface CheckContext {
  /** The workspace root (absolute), passed through to the snapshot. */
  workspace: string | null;
  /** Pomade's projects; `null` when they are not known (Pomade closed), so project ids go unchecked. */
  projects: readonly ProjectRecord[] | null;
}

/** The sub-folder of the jobs folder a project's jobs sit in: its folder's name. */
export function projectJobsFolder(project: ProjectRecord): string {
  return baseName(project.root);
}

function add(file: ParsedJobFile, line: number, field: string, problem: string, fix: string): void {
  file.errors.push({ path: file.path, line, field, problem, fix });
}

function checkChains(files: readonly ParsedJobFile[]): void {
  const byId = new Map(files.map((file) => [file.id, file]));
  for (const file of files) {
    if (file.after === null) continue;
    const { job, line } = file.after;
    const target = byId.get(job);
    if (job === file.id) {
      add(file, line, "after.job", "the job follows itself, so it would run forever", "name another job, or remove after:");
    } else if (target === undefined) {
      const guess = closest(job, [...byId.keys()]);
      add(file, line, "after.job", `no job has the id ${job}`, guess ? `write ${guess}` : `write the id of a job in ${JOBS_FOLDER}: its path there without .md, e.g. backup or coda-helper/git-pull`);
    } else if (target.kind === "service") {
      add(file, line, "after.job", `${job} is a service, and a service never finishes`, "follow a script, agent or git job");
    }
  }
  // Each job follows at most one other, so a loop is found by walking forward from each job. A
  // service is never followed (it never finishes), so no loop passes through one.
  const reported = new Set<string>();
  for (const start of files) {
    const seen: string[] = [];
    let current: ParsedJobFile | undefined = start;
    while (current?.after && current.kind !== "service" && !seen.includes(current.id)) {
      seen.push(current.id);
      current = byId.get(current.after.job);
    }
    if (current === undefined || current !== start || seen.length < 2 || reported.has(start.id)) continue;
    const loop = [...seen, start.id].join(" → ");
    for (const id of seen) {
      reported.add(id);
      const member = byId.get(id);
      if (member?.after) {
        add(member, member.after.line, "after.job", `the chain loops back: ${loop}`, "remove after: from one of these jobs, or point it at a job outside the loop");
      }
    }
  }
}

function checkNames(files: readonly ParsedJobFile[]): void {
  const byName = new Map<string, ParsedJobFile[]>();
  for (const file of files) {
    if (file.name === null) continue;
    const key = file.name.value.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), file]);
  }
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    for (const file of same) {
      const others = same.filter((other) => other !== file).map((other) => other.path);
      add(file, file.name?.line ?? 1, "name", `${file.name?.value ?? ""} is also the name of ${others.join(", ")}`, "give each job its own name — History, notices and `pomade-runner run` tell jobs apart by name");
    }
  }
}

function checkProjects(files: readonly ParsedJobFile[], projects: readonly ProjectRecord[]): void {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const listFix = "write the id of one of Pomade's projects — `pomade-runner projects` lists them";
  for (const file of files) {
    if (file.project !== null) {
      const project = byId.get(file.project.value);
      if (project === undefined) {
        const byFolder = file.folder === null ? undefined : projects.find((p) => projectJobsFolder(p) === file.folder);
        add(file, file.project.line, "project", `Pomade has no project with the id ${file.project.value}`, byFolder ? `write project: ${byFolder.id} (${byFolder.name})` : listFix);
      } else if (file.folder !== null && projectJobsFolder(project) !== file.folder) {
        const folder = projectJobsFolder(project);
        add(file, file.project.line, "project", `the job belongs to ${project.name}, whose jobs sit in ${JOBS_FOLDER}/${folder}/`, `move the file to ${JOBS_FOLDER}/${folder}/${baseName(file.path)}, or fix project:`);
      }
    }
    if (file.hookProject !== null && !byId.has(file.hookProject.value)) {
      add(file, file.hookProject.line, "hook.project", `Pomade has no project with the id ${file.hookProject.value}`, listFix);
    }
  }
}

function entry(file: ParsedJobFile): JobEntry {
  if (file.job !== null && file.errors.length === 0) return { valid: true, job: file.job };
  const errors: JobError[] = [...file.errors].sort((a, b) => a.line - b.line);
  return {
    valid: false,
    invalid: { id: file.id, path: file.path, name: file.name?.value ?? null, kind: file.kind, project: file.project?.value ?? null, errors },
  };
}

/** Check the job files of a workspace together; `files` are paths inside the jobs folder. */
export function checkJobs(files: readonly JobFileInput[], context: CheckContext): JobsSnapshot {
  const parsed = files.map(parseJobFile).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  checkChains(parsed);
  checkNames(parsed);
  if (context.projects !== null) checkProjects(parsed, context.projects);
  return { workspace: context.workspace, projectsChecked: context.projects !== null, jobs: parsed.map(entry) };
}
