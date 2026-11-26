// Runner's names for the keeper's sessions and for runs (docs/ARCHITECTURE.md "Sessions"). A job id is a
// path (`blog/dev-server`), and a keeper session id allows only letters, digits and `._:-`, so
// the job id is encoded into it, reversibly: the session id alone says which job it belongs to.
// Pure.

import { SESSION_ID_PATTERN } from "pomade-kit/protocol";

/** A service's one session: `svc:<encoded job id>`, the same across restarts. */
const SERVICE_PREFIX = "svc:";
/** One run's session: `run:<encoded job id>:<run id>`. */
const RUN_PREFIX = "run:";

/** A session id's length limit (`SESSION_ID_PATTERN`). */
const SESSION_ID_MAX = 128;

/** A run id: `YYYYMMDD-HHMMSS-` (UTC) and six hex digits. It sorts by start time and names the
 *  run's output log. */
const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const RUN_ID_LENGTH = 22;

/** The longest encoded job id that leaves room for a run session's prefix and run id. */
export const MAX_ENCODED_JOB_ID = SESSION_ID_MAX - RUN_PREFIX.length - 1 - RUN_ID_LENGTH;

/** Characters a job id keeps as they are; `/` becomes `.`, and every other character becomes `_`
 *  and two hex digits per UTF-8 byte (`é` → `_c3_a9`). `.` and `_` never stand for themselves, so
 *  two job ids never share an encoding. */
const KEPT = /[A-Za-z0-9-]/;

export function encodeJobId(jobId: string): string {
  let out = "";
  for (const char of jobId) {
    if (KEPT.test(char)) out += char;
    else if (char === "/") out += ".";
    else for (const byte of new TextEncoder().encode(char)) out += `_${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** The job id an encoding stands for; `null` when it is not one `encodeJobId` makes. */
export function decodeJobId(encoded: string): string | null {
  if (!/^(?:[A-Za-z0-9.-]|_[0-9a-f]{2})+$/.test(encoded)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; ) {
    const char = encoded.charAt(i);
    if (char === "_") {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      bytes.push((char === "." ? "/" : char).charCodeAt(0));
      i += 1;
    }
  }
  let jobId: string;
  try {
    jobId = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
  return encodeJobId(jobId) === encoded ? jobId : null;
}

/** Whether a job's sessions can be named: its encoded id fits `MAX_ENCODED_JOB_ID`. */
export function jobIdFits(jobId: string): boolean {
  return encodeJobId(jobId).length <= MAX_ENCODED_JOB_ID;
}

/** A new run id for a run starting at `now`; `random` gives the six hex digits. */
export function newRunId(now: Date, random: () => string): string {
  const iso = now.toISOString();
  const runId = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${random()}`;
  if (!RUN_ID_RE.test(runId)) throw new Error(`not a run id: ${runId}`);
  return runId;
}

export type SessionOwner = { kind: "service"; job: string } | { kind: "run"; job: string; run: string };

/** The session id of a service, or of one run of a job; `null` when the job id is too long. */
export function sessionIdOf(owner: SessionOwner): string | null {
  const encoded = encodeJobId(owner.job);
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_JOB_ID) return null;
  if (owner.kind === "service") return `${SERVICE_PREFIX}${encoded}`;
  if (!RUN_ID_RE.test(owner.run)) return null;
  return `${RUN_PREFIX}${encoded}:${owner.run}`;
}

/** Whose session `id` is; `null` for an id Runner does not make. */
export function sessionOwner(id: string): SessionOwner | null {
  if (!SESSION_ID_PATTERN.test(id)) return null;
  if (id.startsWith(SERVICE_PREFIX)) {
    const job = decodeJobId(id.slice(SERVICE_PREFIX.length));
    return job === null ? null : { kind: "service", job };
  }
  if (id.startsWith(RUN_PREFIX)) {
    const rest = id.slice(RUN_PREFIX.length);
    const colon = rest.lastIndexOf(":");
    const job = colon === -1 ? null : decodeJobId(rest.slice(0, colon));
    const run = rest.slice(colon + 1);
    return job === null || !RUN_ID_RE.test(run) ? null : { kind: "run", job, run };
  }
  return null;
}
