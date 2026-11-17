import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../../app";
import type { RunnerSession, ServicesReport, ServiceStatus, SessionsReport } from "../../keeper/model";
import type { ControlCallResult } from "../../scheduler/control/client";
import type { ControlMethod, ControlMethods, JobEnabled, RunStarted, SchedulerStatus } from "../../scheduler/control/protocol";
import type { HistoryPage, JobListing } from "../../scheduler/model";
import type { ProjectRecord } from "../model";
import { runCli, USAGE } from "./cli";

type StatusResult = ControlCallResult<SchedulerStatus> | null;

interface World {
  status?: StatusResult;
  workspace?: string | null;
  cwd?: string;
  /** Job files by path inside the jobs folder; `null` = no jobs folder. */
  files?: Record<string, string> | null;
  projects?: ProjectRecord[] | null;
  sessions?: ControlCallResult<SessionsReport> | null;
  services?: ControlCallResult<ServicesReport> | null;
  /** The answer to a run, stop or restart; the calls made are collected in `actions`. */
  action?: ControlCallResult<ServiceStatus | RunStarted> | null;
  actions?: { verb: ControlMethod; job: string }[];
  list?: ControlCallResult<JobListing[]> | null;
  history?: ControlCallResult<HistoryPage> | null;
  /** The answer to an enable or disable. */
  enabled?: ControlCallResult<JobEnabled> | null;
  /** The params of every call. */
  calls?: { method: ControlMethod; params: unknown }[];
}

const WS = "/ws";
const JOBS = "/ws/Apps/pomade-runner/jobs";

async function run(args: string[], status: StatusResult = { status: "not-running" }, world: World = {}) {
  let out = "";
  let err = "";
  let asked = 0;
  const files = world.files === undefined ? {} : world.files;
  const code = await runCli(args, {
    out: (text) => (out += text),
    err: (text) => (err += text),
    cwd: world.cwd ?? WS,
    ask: <M extends ControlMethod>(method: M, params: unknown): Promise<ControlCallResult<ControlMethods[M]> | null> => {
      world.calls?.push({ method, params });
      const answer = (): ControlCallResult<unknown> | null | undefined => {
        switch (method) {
          case "status":
            asked++;
            return status;
          case "sessions":
            return world.sessions;
          case "services":
            return world.services;
          case "list":
            return world.list;
          case "history":
            return world.history;
          case "enable":
          case "disable":
            return world.enabled;
          case "run":
          case "stop":
          case "restart":
            world.actions?.push({ verb: method, job: (params as { job: string }).job });
            return world.action;
        }
      };
      const given = answer();
      return Promise.resolve((given === undefined ? { status: "not-running" } : given) as ControlCallResult<ControlMethods[M]> | null);
    },
    workspace: () => (world.workspace === undefined ? WS : world.workspace),
    // `/ws/…` is the real path of `/link/ws/…`, as `/private/var` is of macOS's `/var`.
    realPath: (path) => path.replace(/^\/link\//, "/"),
    readJobFiles: (folder) => {
      expect(folder).toBe(JOBS);
      return Promise.resolve(files === null ? null : Object.entries(files).map(([path, text]) => ({ path, text })));
    },
    projects: () => Promise.resolve(world.projects === undefined ? null : world.projects),
  });
  return { code, out, err, asked };
}

const job = (name: string, extra = ""): string => `---\nkind: script\nname: ${name}\nfolder: .\ncommand: ./x.sh\nhook: { event: login }${extra}\n---\n`;

const running: SchedulerStatus = { version: "0.1.0", pid: 4242, startedAt: "2026-11-17T08:00:00.000Z", lastTickAt: null, pomade: "connected" };

describe("pomade-runner", () => {
  it("prints the usage for --help, -h and no arguments", async () => {
    for (const args of [["--help"], ["-h"], []]) {
      expect(await run(args)).toEqual({ code: 0, out: USAGE, err: "", asked: 0 });
    }
  });

  it("--version prints the version and a running scheduler", async () => {
    const r = await run(["--version"], { status: "ok", value: running });
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `pomade-runner ${APP_VERSION}\nscheduler: running — 0.1.0, pid 4242, since 2026-11-17T08:00:00.000Z, connected to Pomade\n`,
    );
    expect(r.err).toBe("");
  });

  it("--version says how the scheduler stands with Pomade", async () => {
    const closed = await run(["--version"], { status: "ok", value: { ...running, pomade: "disconnected" } });
    expect(closed.out).toContain(", Pomade closed\n");
    const refused = await run(["--version"], { status: "ok", value: { ...running, pomade: "rejected" } });
    expect(refused.out).toContain(", refused by Pomade\n");
  });

  it("--version still answers when the scheduler is not running, not answering or not findable", async () => {
    expect((await run(["--version"])).out).toBe(`pomade-runner ${APP_VERSION}\nscheduler: not running\n`);
    const failed = await run(["--version"], { status: "failed", code: "protocol-mismatch", message: "the scheduler speaks control protocol 2, the caller 1" });
    expect(failed.code).toBe(0);
    expect(failed.out).toContain("scheduler: not answering — the scheduler speaks control protocol 2, the caller 1\n");
    const outside = await run(["--version"], null);
    expect(outside.code).toBe(0);
    expect(outside.out).toContain("scheduler: unknown — pomade-runner was not started through Pomade's command folder\n");
  });

  it("refuses an unknown command or option with exit code 2", async () => {
    const command = await run(["frobnicate"]);
    expect(command).toEqual({
      code: 2,
      out: "",
      err: 'pomade-runner: unknown command "frobnicate". Run `pomade-runner --help` for what it takes.\n',
      asked: 0,
    });
    const option = await run(["--frob"]);
    expect(option.code).toBe(2);
    expect(option.err).toContain('unknown option "--frob"');
  });

  it("check reports every problem as path:line: field — problem. Fix: …, and exits 1", async () => {
    const r = await run(["check"], undefined, { files: { "a.md": job("A"), "b.md": job("B", "\nnotify: loud"), "c.md": job("C", "\ncolor: red\noverlap: wait") } });
    expect(r).toEqual({
      code: 1,
      err: "",
      asked: 0,
      out: [
        "Apps/pomade-runner/jobs/b.md:7: notify — \"loud\" is not allowed. Fix: use one of always, on-failure or never.",
        "Apps/pomade-runner/jobs/c.md:7: color — color is not a job field. Fix: remove it — the pomade-runner-jobs skill lists every field.",
        "Apps/pomade-runner/jobs/c.md:8: overlap — \"wait\" is not allowed. Fix: use one of skip, parallel or queue.",
        "3 problems in 2 of 3 job files in Apps/pomade-runner/jobs.",
        "Project ids were not checked: Pomade is closed. Run it again with Pomade open to check them too.",
        "",
      ].join("\n"),
    });
  });

  it("check says so when every file is fine, and prints paths from where it runs", async () => {
    const r = await run(["check"], undefined, { files: { "a.md": job("A") }, projects: [], cwd: JOBS });
    expect(r).toMatchObject({ code: 0, out: "1 job file in .: no problems.\n" });
    const elsewhere = await run(["check"], undefined, { files: { "b.md": job("B", "\nnotify: loud") }, projects: [], cwd: "/tmp" });
    expect(elsewhere.out).toContain("/ws/Apps/pomade-runner/jobs/b.md:7: notify");
    const none = await run(["check"], undefined, { files: null, projects: [] });
    expect(none).toMatchObject({ code: 0, out: "0 job files in Apps/pomade-runner/jobs: no problems.\n" });
  });

  it("check checks project ids while Pomade runs", async () => {
    const r = await run(["check"], undefined, { files: { "alpha/a.md": job("A", "\nproject: nope") }, projects: [{ id: "p1", name: "Alpha", root: "Projects/alpha" }] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Apps/pomade-runner/jobs/alpha/a.md:7: project — Pomade has no project with the id nope. Fix: write project: p1 (Alpha).\n");
    expect(r.out).not.toContain("not checked");
  });

  it("check with files checks only those, against the others", async () => {
    const files = { "a.md": job("A", "\nafter: { job: b }").replace("hook: { event: login }\n", ""), "b.md": job("B", "\nnotify: loud"), "c.md": job("C", "\ncolor: red") };
    const r = await run(["check", "a.md", "Apps/pomade-runner/jobs/b.md"], undefined, { files, projects: [], cwd: WS });
    expect(r.out).toBe(
      'Apps/pomade-runner/jobs/b.md:7: notify — "loud" is not allowed. Fix: use one of always, on-failure or never.\n1 problem in 1 of 2 job files.\n'.replace(
        /^/,
        "a.md: not a job file — Runner reads job files only from /ws/Apps/pomade-runner/jobs. Fix: move it there (a project job into its project's sub-folder), as <slug>.md.\n",
      ).replace("1 problem in", "2 problems in").replace("of 2 job files", "of 1 job file"),
    );
    const named = await run(["check", "/link/ws/Apps/pomade-runner/jobs/a.md"], undefined, { files, projects: [] });
    expect(named).toMatchObject({ code: 0, out: "1 job file: no problems.\n" });
    const missing = await run(["check", "/ws/Apps/pomade-runner/jobs/zz.md"], undefined, { files, projects: [] });
    expect(missing).toMatchObject({ code: 1, out: "Apps/pomade-runner/jobs/zz.md: no such job file. Fix: check the path, or write the file first.\n1 problem.\n" });
  });

  it("check without a workspace, or with an option, cannot run: exit 2", async () => {
    expect(await run(["check"], undefined, { workspace: null })).toMatchObject({ code: 2, out: "", err: expect.stringContaining("no workspace") as string });
    expect(await run(["check", "--all"])).toMatchObject({ code: 2, err: 'pomade-runner check: unexpected "--all". Run `pomade-runner --help` for what it takes.\n' });
  });

  it("projects lists each project's id and jobs sub-folder, and needs Pomade", async () => {
    const r = await run(["projects"], undefined, { projects: [{ id: "p1", name: "Coda Helper", root: "Projects/coda-helper" }] });
    expect(r).toMatchObject({
      code: 0,
      out: "p1  Coda Helper  (Projects/coda-helper)  → Apps/pomade-runner/jobs/coda-helper/\n",
    });
    expect(await run(["projects"], undefined, { projects: [] })).toMatchObject({ code: 0, out: "Pomade has no projects.\n" });
    expect(await run(["projects"])).toMatchObject({ code: 1, err: expect.stringContaining("Pomade is not running") as string });
    expect(await run(["projects", "x"])).toMatchObject({ code: 2 });
  });

  it("sessions lists the keeper and each session with its job, state and output log", async () => {
    const info = { title: "Coda web", command: "./start.sh", cwd: "/ws/Projects/coda", pid: 501, startedAt: Date.parse("2026-11-17T08:00:00.000Z"), cols: 80, rows: 24, state: "running" as const, exit: null, clients: 1, actions: [] };
    const web: RunnerSession = { id: "svc:coda.web", job: "coda/web", kind: "service", run: "20261117-080000-abcdef", log: "/ud/output/coda.web/20261117-080000-abcdef.log", info: { ...info, id: "svc:coda.web" } };
    const ended: RunnerSession = {
      id: "svc:api",
      job: "api",
      kind: "service",
      run: null,
      log: null,
      info: { ...info, id: "svc:api", pid: null, state: "exited", exit: { code: 137, signal: "SIGKILL", reason: "crashed", at: Date.parse("2026-11-17T08:01:00.000Z") } },
    };
    const r = await run(["sessions"], undefined, { sessions: { status: "ok", value: { keeper: { state: "connected", version: "3ec9b16fc34c", pid: 77 }, sessions: [web, ended] } } });
    expect(r).toEqual({
      code: 0,
      out:
        "keeper: running — version 3ec9b16fc34c, pid 77\n" +
        "svc:api  job api  ended: crashed — code 137, SIGKILL, at 2026-11-17T08:01:00.000Z\n" +
        "svc:coda.web  job coda/web  running, pid 501, since 2026-11-17T08:00:00.000Z  output /ud/output/coda.web/20261117-080000-abcdef.log\n",
      err: "",
      asked: 0,
    });
    const empty = await run(["sessions"], undefined, { sessions: { status: "ok", value: { keeper: { state: "unreachable", reason: "ENOENT" }, sessions: [] } } });
    expect(empty.out).toBe("keeper: not reachable — ENOENT\nNo sessions.\n");
    const refused = await run(["sessions"], undefined, { sessions: { status: "ok", value: { keeper: { state: "rejected", reason: "not the owner" }, sessions: [] } } });
    expect(refused.out).toContain("keeper: refused the scheduler — not the owner\n");
    const connecting = await run(["sessions"], undefined, { sessions: { status: "ok", value: { keeper: { state: "connecting" }, sessions: [] } } });
    expect(connecting.out).toContain("keeper: connecting\n");
  });

  it("sessions needs the scheduler: exit 1 when it is not running or does not answer; exit 2 on an argument", async () => {
    expect(await run(["sessions"])).toMatchObject({ code: 1, out: "", err: "pomade-runner sessions: the scheduler is not running — it holds the sessions; Pomade runs it as Runner's background part.\n" });
    expect(await run(["sessions"], undefined, { sessions: { status: "failed", code: "unknown-method", message: 'no method "sessions"' } })).toMatchObject({
      code: 1,
      err: 'pomade-runner sessions: the scheduler did not answer — no method "sessions".\n',
    });
    expect(await run(["sessions"], undefined, { sessions: null })).toMatchObject({ code: 1, err: expect.stringContaining("not started through Pomade's command folder") as string });
    expect(await run(["sessions", "x"])).toMatchObject({ code: 2 });
  });

  describe("services", () => {
    const info = { title: "Coda web", command: "./start.sh", cwd: "/ws/Projects/coda", pid: 501, startedAt: Date.parse("2026-11-17T08:00:00.000Z"), cols: 80, rows: 24, state: "running" as const, exit: null, clients: 0, actions: [] };
    const session: RunnerSession = { id: "svc:coda.web", job: "coda/web", kind: "service", run: null, log: null, info: { ...info, id: "svc:coda.web" } };
    const base: ServiceStatus = { job: "coda/web", name: "Coda web", project: "p1", state: "running", session, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null };
    const at = (time: string): number => Date.parse(`2026-11-17T${time}.000Z`);

    it("lists every service with its state, restarts and last crash", async () => {
      const services: ServiceStatus[] = [
        { ...base, restarts: 2, lastCrashAt: at("07:59:00"), needsRestart: true },
        { ...base, job: "a", name: "A", state: "starting" },
        { ...base, job: "b", name: "B", state: "queued", session: null },
        { ...base, job: "c", name: "C", state: "restarting", session: null, retryAt: at("08:00:05"), restarts: 1, lastCrashAt: at("08:00:04") },
        { ...base, job: "d", name: "D", state: "failed", session: null, restarts: 4, lastCrashAt: at("08:00:30"), problem: "no such folder" },
        { ...base, job: "e", name: "E", state: "stopped-by-you", session: null },
        { ...base, job: "f", name: "F", state: "waiting", session: null },
        { ...base, job: "g", name: "G", state: "disabled", session: null },
        { ...base, job: "h", name: "h", state: "invalid" },
        { ...base, job: "i", name: "i", state: "invalid", session: null },
        { ...base, job: "j", name: "J", state: "removed" },
      ];
      const r = await run(["services"], undefined, { services: { status: "ok", value: { keeper: { state: "connected", version: "v9", pid: 77 }, services } } });
      expect(r.code).toBe(0);
      expect(r.out.split("\n")).toEqual([
        "keeper: running — version v9, pid 77",
        "coda/web  Coda web  running, pid 501, since 2026-11-17T08:00:00.000Z · restarted 2× · last crash 2026-11-17T07:59:00.000Z · its job file changed: restart to apply it",
        "a  A  starting, pid 501, since 2026-11-17T08:00:00.000Z",
        "b  B  queued to start",
        "c  C  restarting at 2026-11-17T08:00:05.000Z · restarted 1× · last crash 2026-11-17T08:00:04.000Z",
        "d  D  failed: 5 crashes within a minute · restarted 4× · last crash 2026-11-17T08:00:30.000Z · last start failed: no such folder",
        "e  E  stopped by you",
        "f  F  waits for its project to open",
        "g  G  disabled in its file",
        "h  h  its job file is invalid — see pomade-runner check; still running, pid 501, since 2026-11-17T08:00:00.000Z",
        "i  i  its job file is invalid — see pomade-runner check",
        "j  J  its job file is gone; stopping",
        "",
      ]);
      expect((await run(["services"], undefined, { services: { status: "ok", value: { keeper: { state: "connecting" }, services: [] } } })).out).toBe("keeper: connecting\nNo services.\n");
    });

    it("needs the scheduler: exit 1 when it is not running or does not answer; exit 2 on an argument", async () => {
      expect(await run(["services"])).toMatchObject({ code: 1, err: "pomade-runner services: the scheduler is not running — it supervises the services; Pomade runs it as Runner's background part.\n" });
      expect(await run(["services"], undefined, { services: { status: "failed", code: "unknown-method", message: 'no method "services"' } })).toMatchObject({
        code: 1,
        err: 'pomade-runner services: the scheduler did not answer — no method "services".\n',
      });
      expect(await run(["services"], undefined, { services: null })).toMatchObject({ code: 1, err: expect.stringContaining("not started through Pomade's command folder") as string });
      expect(await run(["services", "web"])).toMatchObject({ code: 2 });
    });

    it("run, stop and restart ask the scheduler and print where the service stands", async () => {
      const actions: { verb: ControlMethod; job: string }[] = [];
      const starting = { ...base, state: "starting" as const };
      for (const [command, value] of [["run", { service: starting }], ["stop", starting], ["restart", starting]] as const) {
        const r = await run([command, "Coda web"], undefined, { action: { status: "ok", value }, actions });
        expect(r).toEqual({ code: 0, out: "coda/web  Coda web  starting, pid 501, since 2026-11-17T08:00:00.000Z\n", err: "", asked: 0 });
        expect(actions.at(-1)).toEqual({ verb: command, job: "Coda web" });
      }
    });

    it("run, stop and restart say why the scheduler refused, and need a service named", async () => {
      expect(await run(["run", "web"], undefined, { action: { status: "failed", code: "refused", message: 'cannot start "web": "Web" is running' } })).toMatchObject({
        code: 1,
        out: "",
        err: 'pomade-runner run: cannot start "web": "Web" is running.\n',
      });
      expect(await run(["stop", "web"])).toMatchObject({ code: 1, err: expect.stringContaining("pomade-runner stop: the scheduler is not running") as string });
      expect(await run(["restart"])).toMatchObject({ code: 2, err: "pomade-runner restart: names no service. Usage: pomade-runner restart <service> — its id or its name.\n" });
      expect(await run(["run"])).toMatchObject({ code: 2, err: "pomade-runner run: names no job. Usage: pomade-runner run <job> — its id or its name.\n" });
      expect(await run(["run", "--now"])).toMatchObject({ code: 2, err: expect.stringContaining('pomade-runner run: unexpected "--now"') as string });
      expect(await run(["stop", "a", "b"])).toMatchObject({ code: 2, err: expect.stringContaining('pomade-runner stop: unexpected "b"') as string });
    });
  });

  describe("runs", () => {
    const at = (time: string): number => Date.parse(`2026-11-17T${time}.000Z`);
    const base = { job: "backup", name: "Backup", kind: "script" as const, project: null, folder: "", run: "20261117-120000-abcdef", trigger: "scheduled" as const, dueAt: at("12:00:00") };
    const failed = { ...base, state: "failed" as const, reason: null, startedAt: at("12:00:00"), endedAt: at("12:00:03"), durationMs: 3000, exitCode: 1, signal: null, log: "/ud/output/backup/r.log", lastLines: [] };
    const listing: JobListing = { job: "backup", name: "Backup", kind: "script", enabled: true, trigger: "daily at 13:00", problem: null, next: at("13:00:00"), finished: false, last: failed, service: null };

    it("list prints every job: kind, trigger in words, next run and last result; a service's state; an invalid file's problem", async () => {
      const info = { id: "svc:web", title: "Web", command: "./w", cwd: "/ws", pid: 7, startedAt: at("08:00:00"), cols: 80, rows: 24, state: "running" as const, exit: null, clients: 0, actions: [] };
      const web: ServiceStatus = { job: "web", name: "Web", project: null, state: "running", session: { id: "svc:web", job: "web", kind: "service", run: null, log: null, info }, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null };
      const value: JobListing[] = [
        listing,
        { ...listing, job: "off", name: "Off", enabled: false, next: null, last: null },
        { ...listing, job: "tonight", name: "Tonight", trigger: "once on 2026-11-17 at 23:00", next: null, finished: true, last: { ...failed, state: "done", exitCode: 0, durationMs: 850 } },
        { ...listing, job: "hooked", name: "Hooked", trigger: "on login", next: null, last: { ...failed, state: "skipped", reason: "previous run still going", startedAt: null, durationMs: null } },
        { ...listing, job: "web", name: "Web", kind: "service", trigger: "always on, from login", next: null, last: null, service: web },
        { ...listing, job: "bad", name: "bad", kind: null, enabled: false, trigger: null, problem: "bad.md:2: kind — missing.", next: null, last: null },
      ];
      const r = await run(["list"], undefined, { list: { status: "ok", value } });
      expect(r.code).toBe(0);
      expect(r.out.split("\n")).toEqual([
        "backup  Backup  script  daily at 13:00  next 2026-11-17T13:00:00.000Z · last failed · exit 1, 2026-11-17T12:00:03.000Z, took 3 s",
        "off  Off  script  daily at 13:00  disabled · never ran",
        "tonight  Tonight  script  once on 2026-11-17 at 23:00  finished · last done, 2026-11-17T12:00:03.000Z, took 850 ms",
        "hooked  Hooked  script  on login  no next run · last skipped · previous run still going, 2026-11-17T12:00:03.000Z",
        "web  Web  service  always on, from login  running, pid 7, since 2026-11-17T08:00:00.000Z",
        "bad  bad  invalid — bad.md:2: kind — missing.",
        "",
      ]);
      expect((await run(["list"], undefined, { list: { status: "ok", value: [] } })).out).toBe("No jobs.\n");
      expect(await run(["list"])).toMatchObject({ code: 1, err: "pomade-runner list: the scheduler is not running — it holds the jobs; Pomade runs it as Runner's background part.\n" });
      expect(await run(["list", "x"])).toMatchObject({ code: 2 });
    });

    it("history prints the latest runs, of every job or one", async () => {
      const calls: { method: ControlMethod; params: unknown }[] = [];
      const r = await run(["history"], undefined, { history: { status: "ok", value: { records: [failed, { ...failed, job: "x", name: "X", trigger: "manual", state: "done", exitCode: 0, log: null }], next: null } }, calls });
      expect(r.out).toBe("backup  Backup  scheduled  failed · exit 1, 2026-11-17T12:00:03.000Z, took 3 s  output /ud/output/backup/r.log\nx  X  manual  done, 2026-11-17T12:00:03.000Z, took 3 s\n");
      expect(calls).toEqual([{ method: "history", params: { job: null, limit: 20 } }]);
      expect((await run(["history", "backup"], undefined, { history: { status: "ok", value: { records: [], next: null } }, calls })).out).toBe("No runs of backup yet.\n");
      expect(calls.at(-1)).toEqual({ method: "history", params: { job: "backup", limit: 20 } });
      expect((await run(["history"], undefined, { history: { status: "ok", value: { records: [], next: null } } })).out).toBe("No runs yet.\n");
      expect(await run(["history", "a", "b"])).toMatchObject({ code: 2, err: expect.stringContaining('unexpected "b"') as string });
      expect(await run(["history"])).toMatchObject({ code: 1, err: expect.stringContaining("it keeps the history") as string });
    });

    it("run starts a script's run, or queues it, and prints it", async () => {
      const going = { ...base, trigger: "manual" as const, state: "running" as const, startedAt: 1, session: "run:backup:r", log: "/ud/output/backup/r.log" };
      expect((await run(["run", "backup"], undefined, { action: { status: "ok", value: { run: going } } })).out).toBe("backup  Backup  run 20261117-120000-abcdef  running, output /ud/output/backup/r.log\n");
      expect((await run(["run", "backup"], undefined, { action: { status: "ok", value: { run: { ...going, state: "queued", startedAt: null, session: null, log: null } } } })).out).toBe(
        "backup  Backup  run 20261117-120000-abcdef  queued after the run going\n",
      );
      expect(await run(["run", "backup"], undefined, { action: { status: "failed", code: "refused", message: 'cannot run "backup": "Backup" is running, and its overlap is skip' } })).toMatchObject({
        code: 1,
        err: 'pomade-runner run: cannot run "backup": "Backup" is running, and its overlap is skip.\n',
      });
    });

    it("enable and disable write the job's file and print it", async () => {
      const calls: { method: ControlMethod; params: unknown }[] = [];
      expect((await run(["disable", "Backup"], undefined, { enabled: { status: "ok", value: { job: "backup", name: "Backup", enabled: false } }, calls })).out).toBe("backup  Backup  disabled\n");
      expect((await run(["enable", "backup"], undefined, { enabled: { status: "ok", value: { job: "backup", name: "Backup", enabled: true } }, calls })).out).toBe("backup  Backup  enabled\n");
      expect(calls).toEqual([
        { method: "disable", params: { job: "Backup" } },
        { method: "enable", params: { job: "backup" } },
      ]);
      expect(await run(["enable"])).toMatchObject({ code: 2, err: "pomade-runner enable: names no job. Usage: pomade-runner enable <job> — its id or its name.\n" });
      expect(await run(["disable", "x"])).toMatchObject({ code: 1, err: expect.stringContaining("it holds the jobs") as string });
    });
  });
});
