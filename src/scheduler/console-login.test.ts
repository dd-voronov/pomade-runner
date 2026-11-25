// The Mac's console login, read from `ps`, the one acted on kept in the state folder, and whether a
// scheduler start is a login.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loginRecordPath, stateFolderOf, type StateFolder } from "../locations";
import { consoleLoginOf, decideStart, loginRecord, loginwindowOf } from "./console-login";

const LOGINWINDOW = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow";
/** A UTC date-time, as the console login names it. */
const since = (utc: string): string => new Date(`${utc}Z`).toISOString();

describe("console login", () => {
  describe("loginwindowOf", () => {
    const ps = [
      `    1     0 Mon Aug 31 00:50:12 2026     /sbin/launchd`,
      `  402     0 Mon Aug 31 00:50:20 2026     ${LOGINWINDOW}`,
      `76407   501 Wed Nov 25 13:46:11 2026     ${LOGINWINDOW}`,
      `76410   501 Wed Nov 25 13:46:12 2026     /usr/libexec/loginwindowhelper`,
      `80001   502 Thu Nov  5 09:01:02 2026     ${LOGINWINDOW}`,
      "",
    ].join("\n");

    it("names this user's loginwindow by its pid and start time", () => {
      expect(loginwindowOf(ps, 501)).toBe(`loginwindow 76407, since ${since("2026-11-25T13:46:11")}`);
    });

    it("tells apart the users of fast user switching, and reads a one-digit day", () => {
      expect(loginwindowOf(ps, 502)).toBe(`loginwindow 80001, since ${since("2026-11-05T09:01:02")}`);
    });

    it("names none for a user with no loginwindow — the login window's own runs as root", () => {
      expect(loginwindowOf(ps, 503)).toBeNull();
      expect(loginwindowOf("", 501)).toBeNull();
    });

    it("a loginwindow with the same pid after a restart is another login", () => {
      const before = loginwindowOf(`  600   501 Mon Aug 31 00:51:20 2026     ${LOGINWINDOW}\n`, 501);
      const after = loginwindowOf(`  600   501 Tue Dec  1 08:00:05 2026     ${LOGINWINDOW}\n`, 501);
      expect(before).not.toBe(after);
    });

    it("of two, the latest started", () => {
      expect(loginwindowOf(`  600   501 Mon Aug 31 00:51:20 2026     ${LOGINWINDOW}\n  700   501 Mon Aug 31 00:52:20 2026     ${LOGINWINDOW}\n`, 501)).toMatch(/^loginwindow 700,/);
    });
  });

  describe("consoleLoginOf", () => {
    it("takes POMADE_RUNNER_CONSOLE_LOGIN when it is set", async () => {
      expect(await consoleLoginOf({ POMADE_RUNNER_CONSOLE_LOGIN: "login 2" })).toEqual({ status: "known", login: "login 2" });
    });

    it("reads ps: a user with no loginwindow has a console login that cannot be told", async () => {
      expect(await consoleLoginOf({}, 99_999)).toEqual({ status: "unknown", why: "no loginwindow of this user runs" });
    });
  });

  describe("the login acted on", () => {
    let dir: string;
    let state: StateFolder;
    let lines: string[];

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "prl-"));
      state = stateFolderOf(dir);
      lines = [];
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("is kept in login.json; none before", async () => {
      const record = loginRecord(state, (line) => lines.push(line));
      expect(await record.last()).toBeNull();
      await record.acted("loginwindow 7, since x");
      expect(await loginRecord(state, () => undefined).last()).toBe("loginwindow 7, since x");
      expect(JSON.parse(await readFile(loginRecordPath(state), "utf8"))).toEqual({ console: "loginwindow 7, since x" });
      expect(lines).toEqual([]);
    });

    it("an unreadable record is none", async () => {
      const record = loginRecord(state, () => undefined);
      await record.acted("a");
      await writeFile(loginRecordPath(state), "{");
      expect(await record.last()).toBeNull();
    });

    it("a write that fails is said in the log", async () => {
      await writeFile(join(dir, "app-state"), "");
      await loginRecord(state, (line) => lines.push(line)).acted("a");
      expect(lines).toEqual([expect.stringMatching(/^login: cannot write .*login\.json: /)]);
    });
  });

  describe("decideStart", () => {
    const known = (login: string) => ({ status: "known", login }) as const;
    const unknown = { status: "unknown", why: "ps failed" } as const;

    it("another console login than the one acted on is a login, the keeper running or not; it is kept", () => {
      for (const started of [true, false]) {
        expect(decideStart(known("b"), "a", started)).toEqual({ login: true, line: "login: a new console login (b) — the staged start begins; the login hooks run after the warm-up", record: "b" });
      }
    });

    it("the same console login is no login, the keeper running or not", () => {
      for (const started of [true, false]) {
        expect(decideStart(known("a"), "a", started)).toEqual({ login: false, line: "start: the same console login (a) — no login: no warm-up, no login hooks", record: null });
      }
    });

    it("with none acted on yet, the keeper decides — an install starts it, an update finds it running — and the console login is kept", () => {
      expect(decideStart(known("a"), null, true)).toMatchObject({ login: true, record: "a" });
      expect(decideStart(known("a"), null, false)).toEqual({ login: false, line: "start: no console login acted on yet, and the keeper was running — no login: no warm-up, no login hooks", record: "a" });
    });

    it("a console login that cannot be told leaves it to the keeper, and keeps nothing", () => {
      expect(decideStart(unknown, "a", true)).toEqual({ login: true, line: "login: the console login cannot be told (ps failed), and no keeper was running — the staged start begins; the login hooks run after the warm-up", record: null });
      expect(decideStart(unknown, "a", false)).toMatchObject({ login: false, record: null });
    });
  });
});
