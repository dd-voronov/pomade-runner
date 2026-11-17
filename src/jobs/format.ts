// A job error as one line a person or an agent can act on — the wording `pomade-runner check`
// prints and the UI shows.

import type { JobError } from "./model";

/** `field — problem. Fix: fix.` — the error without its place. */
export function describeJobError(error: JobError): string {
  const subject = error.field === "" ? error.problem : `${error.field} — ${error.problem}`;
  return `${subject}. Fix: ${error.fix}.`;
}

/** `path:line: field — problem. Fix: fix.`; `path` is how the caller names the file. */
export function formatJobError(error: JobError, path: string = error.path): string {
  return `${path}:${error.line}: ${describeJobError(error)}`;
}
