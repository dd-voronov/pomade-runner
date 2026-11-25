// The Mac login (docs/DESIGN.md "Firing hooks", **Mac login**): a scheduler start is a login when
// the Mac's console login is another than the one the scheduler last acted on. The keeper does not
// tell it — it outlives a log-out — so the console login is read from macOS: its `loginwindow`
// process of this user, the console session's leader. macOS starts a new one at every log-out and
// at startup, and it lives as long as the session: the same through a scheduler restart, an update
// of Runner, sleep and fast user switching. Its pid and start time name the console login; the
// time tells apart two boots that gave it the same pid. The login acted on is kept in `login.json`
// in Runner's state folder.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

import { loginRecordPath, type Env, type StateFolder } from "../locations";
import type { Log } from "./log";

/** A console login to use in place of the Mac's: the test seam for a login, which no test can make. */
export const CONSOLE_LOGIN_ENV = "POMADE_RUNNER_CONSOLE_LOGIN";

/** The Mac's console login now: its name · it cannot be told, and why. */
export type ConsoleLogin = { status: "known"; login: string } | { status: "unknown"; why: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A line of `ps -ax -o pid=,uid=,lstart=,comm=` in the C locale. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d\d):(\d\d)\s+(\d{4})\s+(.+?)\s*$/;

/** The console login of user `uid` in the output of `ps -ax -o pid=,uid=,lstart=,comm=` (C
 *  locale, start times in UTC): its `loginwindow`'s pid and start time;
 *  `null` when the user has none. Should there be more than one, the latest started. */
export function loginwindowOf(ps: string, uid: number): string | null {
  let found: { pid: number; at: number } | null = null;
  for (const line of ps.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) continue;
    const [, pid, owner, month, day, hours, minutes, seconds, year, command] = match;
    if (Number(owner) !== uid || basename(command ?? "") !== "loginwindow") continue;
    const monthIndex = MONTHS.indexOf(month ?? "");
    if (monthIndex < 0) continue;
    const at = Date.UTC(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds));
    if (found === null || at > found.at || (at === found.at && Number(pid) > found.pid)) found = { pid: Number(pid), at };
  }
  return found === null ? null : `loginwindow ${found.pid}, since ${new Date(found.at).toISOString()}`;
}

const run = promisify(execFile);
const PS_TIMEOUT_MS = 5_000;

/** The Mac's console login now: `POMADE_RUNNER_CONSOLE_LOGIN` when set, else this user's
 *  `loginwindow` as `ps` lists it. */
export async function consoleLoginOf(env: Env, uid: number = process.getuid?.() ?? -1): Promise<ConsoleLogin> {
  const given = env[CONSOLE_LOGIN_ENV];
  if (given !== undefined && given !== "") return { status: "known", login: given };
  try {
    const { stdout } = await run("/bin/ps", ["-ax", "-o", "pid=,uid=,lstart=,comm="], { env: { ...env, LC_ALL: "C", TZ: "UTC" }, timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    const login = loginwindowOf(stdout, uid);
    return login === null ? { status: "unknown", why: "no loginwindow of this user runs" } : { status: "known", login };
  } catch (err) {
    return { status: "unknown", why: `ps failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The console login the scheduler last acted on, kept in `login.json`. */
export interface LoginRecord {
  /** `null` when none is kept, or the record cannot be read. */
  last(): Promise<string | null>;
  /** Keep `login` as acted on; a write that fails is said in the log. */
  acted(login: string): Promise<void>;
}

export function loginRecord(state: StateFolder, log: Log): LoginRecord {
  const file = loginRecordPath(state);
  return {
    async last() {
      try {
        const data: unknown = JSON.parse(await readFile(file, "utf8"));
        const login = typeof data === "object" && data !== null ? (data as Record<string, unknown>).console : null;
        return typeof login === "string" ? login : null;
      } catch {
        return null;
      }
    },
    async acted(login) {
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, `${JSON.stringify({ console: login }, null, 2)}\n`);
        await rename(`${file}.tmp`, file);
      } catch (err) {
        log(`login: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** Whether a scheduler start is a login, its log line, and the console login to keep as acted on
 *  (`null`: keep the record as it is). */
export interface StartDecision {
  login: boolean;
  line: string;
  record: string | null;
}

const LOGIN = "the staged start begins; the login hooks run after the warm-up";
const NO_LOGIN = "no login: no warm-up, no login hooks";

/** A start is a login when the console login is another than the one last acted on. With none
 *  kept — the first start after Runner is installed or updated to keep one — or a console login
 *  that cannot be told, it is a login when the scheduler had to start the keeper (`startedKeeper`):
 *  an install starts it, an update finds it running. */
export function decideStart(current: ConsoleLogin, last: string | null, startedKeeper: boolean): StartDecision {
  if (current.status === "known" && last !== null) {
    return current.login === last
      ? { login: false, line: `start: the same console login (${current.login}) — ${NO_LOGIN}`, record: null }
      : { login: true, line: `login: a new console login (${current.login}) — ${LOGIN}`, record: current.login };
  }
  const why = current.status === "known" ? "no console login acted on yet" : `the console login cannot be told (${current.why})`;
  const record = current.status === "known" ? current.login : null;
  return startedKeeper
    ? { login: true, line: `login: ${why}, and no keeper was running — ${LOGIN}`, record }
    : { login: false, line: `start: ${why}, and the keeper was running — ${NO_LOGIN}`, record };
}
