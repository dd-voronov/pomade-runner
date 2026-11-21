// The form's side of job files, through the Host API: create a job file in the right folder under
// a free slug, write field-only changes to it, and follow it on disk. The file on disk is the truth
// (PLATFORM rule 8): the form re-reads it whenever it changes, whoever changed it.

import { HostError, type HostClient } from "pomade-kit/sdk";

import { jobFileCandidates, newJobText, setJobFields, type FieldChanges, type FieldInput } from "../jobs/edit";
import { JOBS_FOLDER } from "../jobs/model";

export interface NewJob {
  /** The project's jobs sub-folder; `null` for a workspace job. */
  folder: string | null;
  fields: Readonly<Record<string, FieldInput>> & { name: string };
  body: string;
}

/** Create the job's file under the first free slug its name gives; resolves with its path. */
export async function createJobFile(host: HostClient, job: NewJob): Promise<string> {
  const content = newJobText(job.fields, job.body);
  for (const path of jobFileCandidates(job.folder, job.fields.name)) {
    try {
      await host.files.create({ path, content });
      return path;
    } catch (err) {
      if (!(err instanceof HostError && err.code === "already-exists")) throw err;
    }
  }
  throw new Error("unreachable: the candidates never end");
}

/** Write field changes (and the body, when given) to a job file; resolves with whether it changed. */
export async function updateJobFile(host: HostClient, path: string, changes: FieldChanges, body?: string): Promise<boolean> {
  const { content } = await host.files.readFile({ path });
  const result = setJobFields(content, changes);
  if (!result.ok) throw new Error(`${path}: ${result.message}`);
  if (result.changed) await host.files.write({ path, content: result.text });
  if (body !== undefined) await host.files.setBody({ path, body });
  return result.changed || body !== undefined;
}

/**
 * Follow a job file: `onText` gets its text now and after every change on disk, `null` while it
 * does not exist. The jobs folder is watched, not the file, so a save by atomic rename is seen. A
 * read after a change that fails for another reason goes to `onError`; the first read's failure
 * rejects the call.
 */
export async function followJobFile(host: HostClient, path: string, onText: (text: string | null) => void, onError: (err: unknown) => void): Promise<{ close(): Promise<void> }> {
  let reads = 0;
  const read = async (): Promise<void> => {
    const n = ++reads;
    let text: string | null;
    try {
      text = (await host.files.readFile({ path })).content;
    } catch (err) {
      if (!(err instanceof HostError && err.code === "not-found")) throw err;
      text = null;
    }
    if (n === reads) onText(text);
  };
  const watch = await host.files.watch({ path: JOBS_FOLDER, recursive: true }, (changes) => {
    if (changes.some((c) => c.path === path || c.oldPath === path)) read().catch(onError);
  });
  await read();
  return { close: () => watch.close() };
}
