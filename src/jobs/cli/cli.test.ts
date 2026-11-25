import { describe, expect, it } from "vitest";

import type { GitRunStep } from "pomade-kit/protocol";

import { APP_VERSION } from "../../app";
import type { RunnerSession, ServicesReport, ServiceStatus, SessionsReport } from "../../keeper/model";
import type { ControlCallResult } from "../../scheduler/control/client";
import type { ControlMethod, ControlMethods, JobEnabled, JobResumed, MissedSettled, RunStarted, SchedulerStatus } from "../../scheduler/control/protocol";
import { dayTime, type ActiveRun, type HistoryPage, type JobListing, type RunRecord, type RunsReport, type SwitchState } from "../../scheduler/model";
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
  runs?: ControlCallResult<RunsReport> | null;
  switch?: ControlCallResult<SwitchState> | null;
  /** The answer to resumeJob. */
  resumed?: ControlCallResult<JobResumed> | null;
  /** The answer to missed. */
  missed?: ControlCallResult<MissedSettled> | null;
  /** The settings file's text; `null` (the default) = none. */
  settings?: string | null;
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
          case "runs":
            return world.runs;
          case "switch":
            return world.switch;
          case "resumeJob":
            world.actions?.push({ verb: method, job: (params as { job: string }).job });
            return world.resumed;
          case "missed":
            return world.missed;
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
    readSettings: (workspace) => {
      expect(workspace).toBe(WS);
      return Promise.resolve(world.settings ?? null);
    },
    projects: () => Promise.resolve(world.projects === undefined ? null : world.projects),
    exists: (path) => !path.includes("/elsewhere/"),
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

  it("check checks the settings file too, alone when it is the file given", async () => {
    const settings = "warm-up: 2\nhistory-days: 30\n";
    expect(await run(["check"], undefined, { files: { "a.md": job("A") }, projects: [], settings })).toMatchObject({
      code: 1,
      out: "Apps/pomade-runner/settings.yaml:1: warm-up — 2 has no unit. Fix: add one: warm-up: 2m (minutes) or 2h (hours).\n1 problem in Apps/pomade-runner/settings.yaml.\n",
    });
    expect(await run(["check"], undefined, { files: { "a.md": job("A") }, projects: [], settings: "warm-up: 5m\n" })).toMatchObject({
      code: 0,
      out: "1 job file in Apps/pomade-runner/jobs and Apps/pomade-runner/settings.yaml: no problems.\n",
    });
    expect(await run(["check", "Apps/pomade-runner/settings.yaml"], undefined, { files: { "b.md": job("B", "\nnotify: loud") }, projects: [], settings })).toMatchObject({
      code: 1,
      out: "Apps/pomade-runner/settings.yaml:1: warm-up — 2 has no unit. Fix: add one: warm-up: 2m (minutes) or 2h (hours).\n1 problem in Apps/pomade-runner/settings.yaml.\n",
    });
    const both = await run(["check"], undefined, { files: { "b.md": job("B", "\nnotify: loud") }, projects: [], settings });
    expect(both.out).toMatch(/\n2 problems in 1 of 1 job file in Apps\/pomade-runner\/jobs and Apps\/pomade-runner\/settings\.yaml\.\n$/);
  });

  it("check without a workspace, or with an option, cannot run: exit 2", async () => {
    expect(await run(["check"], undefined, { workspace: null })).toMatchObject({ code: 2, out: "", err: expect.stringContaining("no workspace") as string });
    expect(await run(["check", "--all"])).toMatchObject({ code: 2, err: 'pomade-runner check: unexpected "--all". Run `pomade-runner --help` for what it takes.\n' });
  });

  it("projects lists each project's id and jobs sub-folder, and needs Pomade", async () => {
    const r = await run(["projects"], undefined, { projects: [{ id: "p1", name: "Blog Helper", root: "Projects/blog" }] });
    expect(r).toMatchObject({
      code: 0,
      out: "p1  Blog Helper  (Projects/blog)  → Apps/pomade-runner/jobs/blog/\n",
    });
    expect(await run(["projects"], undefined, { projects: [] })).toMatchObject({ code: 0, out: "Pomade has no projects.\n" });
    expect(await run(["projects"])).toMatchObject({ code: 1, err: expect.stringContaining("Pomade is not running") as string });
    expect(await run(["projects", "x"])).toMatchObject({ code: 2 });
  });

  it("sessions lists the keeper and each session with its job, state and output log", async () => {
    const info = { title: "Dev server", command: "./start.sh", cwd: "/ws/Projects/blog", pid: 501, startedAt: Date.parse("2026-11-17T08:00:00.000Z"), cols: 80, rows: 24, state: "running" as const, exit: null, clients: 1, actions: [] };
    const web: RunnerSession = { id: "svc:blog.web", job: "blog/web", kind: "service", run: "20261117-080000-abcdef", log: "/ud/output/blog.web/20261117-080000-abcdef.log", info: { ...info, id: "svc:blog.web" } };
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
        "svc:blog.web  job blog/web  running, pid 501, since 2026-11-17T08:00:00.000Z  output /ud/output/blog.web/20261117-080000-abcdef.log\n",
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
    const info = { title: "Dev server", command: "./start.sh", cwd: "/ws/Projects/blog", pid: 501, startedAt: Date.parse("2026-11-17T08:00:00.000Z"), cols: 80, rows: 24, state: "running" as const, exit: null, clients: 0, actions: [] };
    const session: RunnerSession = { id: "svc:blog.web", job: "blog/web", kind: "service", run: null, log: null, info: { ...info, id: "svc:blog.web" } };
    const base: ServiceStatus = { job: "blog/web", name: "Dev server", project: "p1", state: "running", session, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null };
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
        { ...base, job: "f2", name: "F2", state: "waiting-for-pomade", session: null },
        { ...base, job: "g", name: "G", state: "disabled", session: null },
        { ...base, job: "h", name: "h", state: "invalid" },
        { ...base, job: "i", name: "i", state: "invalid", session: null },
        { ...base, job: "j", name: "J", state: "removed" },
      ];
      const r = await run(["services"], undefined, { services: { status: "ok", value: { keeper: { state: "connected", version: "v9", pid: 77 }, services, openedProjects: [] } } });
      expect(r.code).toBe(0);
      expect(r.out.split("\n")).toEqual([
        "keeper: running — version v9, pid 77",
        "blog/web  Dev server  running, pid 501, since 2026-11-17T08:00:00.000Z · restarted 2× · last crash 2026-11-17T07:59:00.000Z · its job file changed: restart to apply it",
        "a  A  starting, pid 501, since 2026-11-17T08:00:00.000Z",
        "b  B  queued to start",
        "c  C  restarting at 2026-11-17T08:00:05.000Z · restarted 1× · last crash 2026-11-17T08:00:04.000Z",
        "d  D  failed: 5 crashes within a minute · restarted 4× · last crash 2026-11-17T08:00:30.000Z · last start failed: no such folder",
        "e  E  stopped by you",
        "f  F  waits for its project to open",
        "f2  F2  waits for Pomade to start",
        "g  G  disabled in its file",
        "h  h  its job file is invalid — see pomade-runner check; still running, pid 501, since 2026-11-17T08:00:00.000Z",
        "i  i  its job file is invalid — see pomade-runner check",
        "j  J  its job file is gone; stopping",
        "",
      ]);
      expect((await run(["services"], undefined, { services: { status: "ok", value: { keeper: { state: "connecting" }, services: [], openedProjects: [] } } })).out).toBe("keeper: connecting\nNo services.\n");
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
        const r = await run([command, "Dev server"], undefined, { action: { status: "ok", value }, actions });
        expect(r).toEqual({ code: 0, out: "blog/web  Dev server  starting, pid 501, since 2026-11-17T08:00:00.000Z\n", err: "", asked: 0 });
        expect(actions.at(-1)).toEqual({ verb: command, job: "Dev server" });
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
    const base = { job: "backup", name: "Backup", kind: "script" as const, project: null, folder: "", run: "20261117-120000-abcdef", trigger: "scheduled" as const, cause: null, dueAt: at("12:00:00"), agent: null, missed: null, series: null };
    const failed = { ...base, state: "failed" as const, action: null, reason: null, startedAt: at("12:00:00"), endedAt: at("12:00:03"), durationMs: 3000, exitCode: 1, signal: null, log: "/ud/output/backup/r.log", lastLines: [], git: null, limitHit: null };
    const listing: JobListing = { job: "backup", name: "Backup", kind: "script", enabled: true, trigger: "daily at 13:00", problem: null, next: at("13:00:00"), finished: false, last: failed, service: null };
    const fresh = { lowPriority: true, runAt: null, deadline: null, waits: null, limitHit: null, warnedAt: null, warningDismissed: false };

    it("runs prints the switch, the runs going with what each waits for, and what needs you", async () => {
      const going: ActiveRun = { ...base, ...fresh, state: "running", startedAt: at("12:00:00"), session: "run:backup:r", log: "/o.log" };
      const report: RunsReport = {
        active: [
          going,
          { ...going, job: "c", name: "C", run: "r2", state: "queued", startedAt: null, session: null, log: null, waits: { kind: "slot", ahead: 1 } },
          { ...going, job: "w", name: "Weekly", run: "r3", state: "missed-waiting", startedAt: null, session: null, log: null, dueAt: at("02:00:00") },
        ],
        nextUp: [],
        jobs: [],
        needsYou: [
          { id: "missed:w", kind: "missed", job: "w", name: "Weekly", project: null, run: "r3", at: at("02:00:00"), missed: null, detail: "missed Tue 03:00" },
          { id: "long-run:backup:r", kind: "long-run", job: "backup", name: "Backup", project: null, run: "r", at: at("15:00:00"), startedAt: at("12:00:00"), detail: "running 3 h — still expected?" },
          { id: "loop-paused:lint", kind: "loop-paused", job: "lint", name: "Lint", project: null, at: at("15:00:00"), detail: "triggered 10× in 10 min — looks like a loop" },
        ],
        switch: { position: "pause-low", since: at("11:00:00") },
        heldRuns: 4,
      };
      expect(await run(["runs"], undefined, { runs: { status: "ok", value: report } })).toMatchObject({
        code: 0,
        out:
          "switch: Pause low-priority — runs of low-priority jobs are held, 4 runs so far; Run now still runs, services keep running (since 2026-11-17T11:00:00.000Z)\n" +
          "backup  Backup  run 20261117-120000-abcdef  running, since 2026-11-17T12:00:00.000Z\n" +
          "c  C  run r2  queued · 1 ahead\n" +
          "w  Weekly  run r3  missed · waiting for you, due 2026-11-17T02:00:00.000Z\n" +
          "needs you: Weekly — missed Tue 03:00; it waits for you: pomade-runner missed w run-once|run-at <time>|skip, or in Runner\n" +
          "needs you: Backup — running 3 h — still expected?\n" +
          "needs you: Lint — paused: triggered 10× in 10 min — looks like a loop; pomade-runner resume-job lint lets hooks and chains fire it again\n",
      });
      const quiet = { ...report, active: [], needsYou: [], switch: { position: "running" as const, since: null }, heldRuns: 0 };
      expect((await run(["runs"], undefined, { runs: { status: "ok", value: quiet } })).out).toBe("switch: Running — scheduled runs run\nNo runs going.\n");
      expect(await run(["runs"])).toMatchObject({ code: 1, err: expect.stringContaining("it runs the jobs") as string });
      expect(await run(["runs", "x"])).toMatchObject({ code: 2 });
    });

    it("pause and resume set the switch", async () => {
      const calls: { method: ControlMethod; params: unknown }[] = [];
      const since = at("11:00:00");
      expect((await run(["pause"], undefined, { switch: { status: "ok", value: { position: "pause-all", since } }, calls })).out).toBe(
        "switch: Pause all — every scheduled run is held; Run now still runs, services keep running (since 2026-11-17T11:00:00.000Z)\n",
      );
      await run(["pause", "all"], undefined, { switch: { status: "ok", value: { position: "pause-all", since } }, calls });
      await run(["pause", "low"], undefined, { switch: { status: "ok", value: { position: "pause-low", since } }, calls });
      expect((await run(["resume"], undefined, { switch: { status: "ok", value: { position: "running", since } }, calls })).out).toBe("switch: Running — scheduled runs run (since 2026-11-17T11:00:00.000Z)\n");
      expect(calls.map((call) => call.params)).toEqual([{ position: "pause-all" }, { position: "pause-all" }, { position: "pause-low" }, { position: "running" }]);
      expect(await run(["pause", "some"])).toMatchObject({ code: 2, err: 'pomade-runner pause: unexpected "some". Usage: pomade-runner pause [low|all].\n' });
      expect(await run(["resume", "lint"])).toMatchObject({ code: 2, err: 'pomade-runner resume: unexpected "lint". Usage: pomade-runner resume — for a job the loop guard paused: pomade-runner resume-job <job>.\n' });
      expect(await run(["pause", "low", "x"])).toMatchObject({ code: 2 });
      expect(await run(["resume"])).toMatchObject({ code: 1, err: expect.stringContaining("it holds the switch") as string });
    });

    it("list prints every job: kind, trigger in words, next run and last result; a service's state; an invalid file's problem", async () => {
      const info = { id: "svc:web", title: "Web", command: "./w", cwd: "/ws", pid: 7, startedAt: at("08:00:00"), cols: 80, rows: 24, state: "running" as const, exit: null, clients: 0, actions: [] };
      const web: ServiceStatus = { job: "web", name: "Web", project: null, state: "running", session: { id: "svc:web", job: "web", kind: "service", run: null, log: null, info }, restarts: 0, lastCrashAt: null, retryAt: null, needsRestart: false, problem: null };
      const value: JobListing[] = [
        listing,
        { ...listing, job: "off", name: "Off", enabled: false, next: null, last: null },
        { ...listing, job: "tonight", name: "Tonight", trigger: "once on 2026-11-17 at 23:00", next: null, finished: true, last: { ...failed, state: "done", exitCode: 0, durationMs: 850 } },
        { ...listing, job: "hooked", name: "Hooked", trigger: "at Mac login", next: null, last: { ...failed, state: "skipped", reason: "previous run still going", startedAt: null, durationMs: null } },
        { ...listing, job: "slow", name: "Slow", trigger: "at Mac login", next: null, last: { ...failed, reason: "stopped: time limit, 45 min", exitCode: null, signal: "SIGTERM", durationMs: 2_700_000, limitHit: 45 } },
        { ...listing, job: "web", name: "Web", kind: "service", trigger: "always on · starts at login", next: null, last: null, service: web },
        {
          ...listing,
          job: "pull",
          name: "Pull",
          kind: "git",
          next: null,
          last: { ...failed, kind: "git", state: "done", exitCode: 0, git: { op: "pull", job: "Pull", at: "2026-11-17T12:00:00.000Z", results: [{ repo: "notes", path: "/ws/notes", op: "pull", status: "done", reason: null, commit: null, steps: [{ step: "pull", outcome: "done", detail: "got 2 commits from origin/main", commits: 2 } as GitRunStep] }] } },
        },
        { ...listing, job: "bad", name: "bad", kind: null, enabled: false, trigger: null, problem: "bad.md:2: kind — missing.", next: null, last: null },
      ];
      const r = await run(["list"], undefined, { list: { status: "ok", value } });
      expect(r.code).toBe(0);
      expect(r.out.split("\n")).toEqual([
        "backup  Backup  script  daily at 13:00  next 2026-11-17T13:00:00.000Z · last failed · exit 1, 2026-11-17T12:00:03.000Z, took 3 s",
        "off  Off  script  daily at 13:00  disabled · never ran",
        "tonight  Tonight  script  once on 2026-11-17 at 23:00  finished · last done, 2026-11-17T12:00:03.000Z, took 850 ms",
        "hooked  Hooked  script  at Mac login  no next run · last skipped · previous run still going, 2026-11-17T12:00:03.000Z",
        "slow  Slow  script  at Mac login  no next run · last stopped: time limit, 45 min, 2026-11-17T12:00:03.000Z, took 45 min",
        "web  Web  service  always on · starts at login  running, pid 7, since 2026-11-17T08:00:00.000Z",
        "pull  Pull  git  daily at 13:00  no next run · last done · 2 commits pulled, 2026-11-17T12:00:03.000Z, took 3 s",
        "bad  bad  invalid — bad.md:2: kind — missing.",
        "",
      ]);
      expect((await run(["list"], undefined, { list: { status: "ok", value: [] } })).out).toBe("No jobs.\n");
      expect(await run(["list"])).toMatchObject({ code: 1, err: "pomade-runner list: the scheduler is not running — it holds the jobs; Pomade runs it as Runner's background part.\n" });
      expect(await run(["list", "x"])).toMatchObject({ code: 2 });
    });

    it("history prints the latest runs, of every job or one — a git run with a line per repo", async () => {
      const calls: { method: ControlMethod; params: unknown }[] = [];
      const chained = { ...failed, job: "web", name: "Web", kind: "service" as const, trigger: "chain" as const, cause: { kind: "chain" as const, job: "x", name: "X", run: "r0", result: "done" as const }, state: "done" as const, action: "restart" as const, startedAt: null, durationMs: null, exitCode: null, log: null };
      const records = [
        failed,
        { ...failed, job: "x", name: "X", trigger: "manual" as const, state: "done" as const, exitCode: 0, log: null },
        chained,
        { ...chained, job: "mount", name: "Mount", kind: "script" as const, trigger: "hook" as const, cause: { kind: "hook" as const, event: "login" as const, context: {} }, action: null },
        { ...failed, job: "copied", name: "Copied", log: "/elsewhere/output/copied/r.log" },
      ];
      const r = await run(["history"], undefined, { history: { status: "ok", value: { held: [], records, next: null } }, calls });
      expect(r.out).toBe(
        "backup  Backup  scheduled  failed · exit 1, 2026-11-17T12:00:03.000Z, took 3 s  output /ud/output/backup/r.log\n" +
          "x  X  manual  done, 2026-11-17T12:00:03.000Z, took 3 s\n" +
          "web  Web  chain: after X  restarted, 2026-11-17T12:00:03.000Z\n" +
          "mount  Mount  hook: Mac login  done, 2026-11-17T12:00:03.000Z\n" +
          "copied  Copied  scheduled  failed · exit 1, 2026-11-17T12:00:03.000Z, took 3 s  output not on this Mac\n",
      );
      expect(calls).toEqual([{ method: "history", params: { job: null, limit: 20 } }]);
      expect((await run(["history", "backup"], undefined, { history: { status: "ok", value: { held: [], records: [], next: null } }, calls })).out).toBe("No runs of backup yet.\n");
      expect(calls.at(-1)).toEqual({ method: "history", params: { job: "backup", limit: 20 } });
      expect((await run(["history"], undefined, { history: { status: "ok", value: { held: [], records: [], next: null } } })).out).toBe("No runs yet.\n");
      const steps = [{ step: "commit" as const, outcome: "done" as const, detail: "committed a1b2c3d (1 file)" }, { step: "push" as const, outcome: "done" as const, detail: "pushed 1 commit" }];
      const results = [
        { repo: "notes", path: "/ws/notes", op: "commit-push" as const, status: "done" as const, reason: null, steps, commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
        { repo: "blog", path: "/ws/Projects/blog", op: "commit-push" as const, status: "skipped" as const, reason: "agent working", steps: [], commit: null },
      ];
      const git = { ...failed, job: "notes", name: "notes", kind: "git" as const, state: "done" as const, exitCode: 0, log: null, git: { op: "commit-push" as const, job: "notes", at: "2026-11-17T12:00:00.000Z", results } };
      expect((await run(["history"], undefined, { history: { status: "ok", value: { held: [], records: [git], next: null } } })).out).toBe(
        "notes  notes  scheduled  done · a1b2c3d, 2026-11-17T12:00:03.000Z, took 3 s\n    notes · committed a1b2c3d · pushed\n    blog · skipped · agent working\n",
      );
      // A pull says what it got, summed over its repos; unknown on any repo (an older Pomade), plain "done".
      const pull = (...counts: (number | undefined)[]) => ({
        ...git,
        git: { ...git.git, op: "pull" as const, results: counts.map((commits, index) => ({ repo: `r${index}`, path: `/ws/r${index}`, op: "pull" as const, status: "done" as const, reason: null, commit: null, steps: [{ step: "pull" as const, outcome: "done" as const, detail: "pulled", ...(commits === undefined ? {} : { commits }) }] })) },
      });
      const first = async (record: RunRecord) => (await run(["history"], undefined, { history: { status: "ok", value: { held: [], records: [record], next: null } } })).out.split("\n")[0];
      expect(await first(pull(2))).toBe("notes  notes  scheduled  done · 2 commits pulled, 2026-11-17T12:00:03.000Z, took 3 s");
      expect(await first(pull(1, 0))).toBe("notes  notes  scheduled  done · 1 commit pulled, 2026-11-17T12:00:03.000Z, took 3 s");
      expect(await first(pull(0))).toBe("notes  notes  scheduled  done · up to date, 2026-11-17T12:00:03.000Z, took 3 s");
      expect(await first(pull(2, undefined))).toBe("notes  notes  scheduled  done, 2026-11-17T12:00:03.000Z, took 3 s");
      // A job the switch holds leads, with its runs held so far; it alone is not "No runs yet".
      const held = { state: "held" as const, job: "lint", name: "Lint", kind: "script" as const, project: null, folder: "", missed: { count: 2, first: new Date(2026, 10, 17, 17, 40).getTime(), last: new Date(2026, 10, 17, 17, 42).getTime() } };
      expect((await run(["history"], undefined, { history: { status: "ok", value: { held: [held], records: [git], next: null } } })).out).toBe(
        "lint  Lint  scheduled  held · 2 runs so far, 17:40–17:42\nnotes  notes  scheduled  done · a1b2c3d, 2026-11-17T12:00:03.000Z, took 3 s\n    notes · committed a1b2c3d · pushed\n    blog · skipped · agent working\n",
      );
      expect((await run(["history", "lint"], undefined, { history: { status: "ok", value: { held: [{ ...held, missed: { ...held.missed, count: 1, first: held.missed.last } }], records: [], next: null } } })).out).toBe(
        "lint  Lint  scheduled  held · 1 run so far, 17:42\n",
      );
      expect(await run(["history", "a", "b"])).toMatchObject({ code: 2, err: expect.stringContaining('unexpected "b"') as string });
      expect(await run(["history"])).toMatchObject({ code: 1, err: expect.stringContaining("it keeps the history") as string });
    });

    it("run starts a script's run, or queues it, and prints it", async () => {
      const going: ActiveRun = { ...base, ...fresh, trigger: "manual", state: "running", startedAt: 1, session: "run:backup:r", log: "/ud/output/backup/r.log" };
      expect((await run(["run", "backup"], undefined, { action: { status: "ok", value: { run: going } } })).out).toBe("backup  Backup  run 20261117-120000-abcdef  running, output /ud/output/backup/r.log\n");
      const queued: ActiveRun = { ...going, state: "queued", startedAt: null, session: null, log: null };
      expect((await run(["run", "backup"], undefined, { action: { status: "ok", value: { run: { ...queued, waits: { kind: "previous-run" } } } } })).out).toBe(
        "backup  Backup  run 20261117-120000-abcdef  queued · after the previous run\n",
      );
      expect((await run(["run", "backup"], undefined, { action: { status: "ok", value: { run: { ...queued, waits: { kind: "slot", ahead: 2 } } } } })).out).toBe("backup  Backup  run 20261117-120000-abcdef  queued · 2 ahead\n");
      expect(await run(["run", "backup"], undefined, { action: { status: "failed", code: "refused", message: 'cannot run "backup": "Backup" is running, and its overlap is skip' } })).toMatchObject({
        code: 1,
        err: 'pomade-runner run: cannot run "backup": "Backup" is running, and its overlap is skip.\n',
      });
    });

    it("resume-job lifts the loop guard's pause of a job", async () => {
      const calls: { method: ControlMethod; params: unknown }[] = [];
      expect((await run(["resume-job", "Lint"], undefined, { resumed: { status: "ok", value: { job: "lint", name: "Lint" } }, calls })).out).toBe("lint  Lint  resumed: hooks and chains fire it again\n");
      expect(calls).toEqual([{ method: "resumeJob", params: { job: "Lint" } }]);
      expect(await run(["resume-job", "lint"], undefined, { resumed: { status: "failed", code: "refused", message: 'cannot resume "lint": "lint" is not paused' } })).toMatchObject({
        code: 1,
        err: 'pomade-runner resume-job: cannot resume "lint": "lint" is not paused.\n',
      });
      expect(await run(["resume-job"])).toMatchObject({ code: 2, err: "pomade-runner resume-job: names no job. Usage: pomade-runner resume-job <job> — its id or its name.\n" });
      expect(await run(["resume-job", "lint"])).toMatchObject({ code: 1, err: expect.stringContaining("it runs the jobs") as string });
    });

    it("T-026 · missed settles a job's missed runs: run-all queues every one, run-once, run-at <time> and skip as in Runner", async () => {
      const calls: { method: ControlMethod; params: unknown }[] = [];
      const settled = (at: number | null, runs: number): ControlCallResult<MissedSettled> => ({ status: "ok", value: { job: "weekly", at, runs } });
      expect(await run(["missed", "Weekly", "run-all"], undefined, { missed: settled(1, 3), calls })).toMatchObject({ code: 0, out: "weekly  3 runs queued, one after another\n" });
      expect(await run(["missed", "weekly", "run-once"], undefined, { missed: settled(1, 1), calls })).toMatchObject({ code: 0, out: "weekly  runs once now\n" });
      expect(await run(["missed", "weekly", "run-at", "tomorrow 9:00"], undefined, { missed: settled(at("23:00:00"), 1), calls })).toMatchObject({ code: 0, out: `weekly  runs at ${dayTime(at("23:00:00"))}\n` });
      expect(await run(["missed", "weekly", "skip"], undefined, { missed: settled(null, 0), calls })).toMatchObject({ code: 0, out: "weekly  skipped: recorded as missed · skipped by you\n" });
      expect(calls).toEqual([
        { method: "missed", params: { job: "Weekly", choice: { kind: "run-all" } } },
        { method: "missed", params: { job: "weekly", choice: { kind: "run-now" } } },
        { method: "missed", params: { job: "weekly", choice: { kind: "run-at", at: "tomorrow 9:00" } } },
        { method: "missed", params: { job: "weekly", choice: { kind: "skip" } } },
      ]);
      expect(await run(["missed", "weekly", "run-all"], undefined, { missed: { status: "failed", code: "refused", message: 'cannot settle the missed runs of "weekly": no missed run of "weekly" waits for you' } })).toMatchObject({
        code: 1,
        err: 'pomade-runner missed: cannot settle the missed runs of "weekly": no missed run of "weekly" waits for you.\n',
      });
      const usage = "Usage: pomade-runner missed <job> run-once|run-all|run-at <time>|skip.\n";
      expect(await run(["missed"])).toMatchObject({ code: 2, err: `pomade-runner missed: names no job. ${usage}` });
      expect(await run(["missed", "weekly"])).toMatchObject({ code: 2, err: `pomade-runner missed: names no choice. ${usage}` });
      expect(await run(["missed", "weekly", "all"])).toMatchObject({ code: 2, err: `pomade-runner missed: unknown choice "all". ${usage}` });
      expect(await run(["missed", "weekly", "run-at"])).toMatchObject({ code: 2, err: `pomade-runner missed: run-at names no time. ${usage}` });
      expect(await run(["missed", "weekly", "skip", "now"])).toMatchObject({ code: 2, err: `pomade-runner missed: unexpected "now". ${usage}` });
      expect(await run(["missed", "weekly", "run-all"])).toMatchObject({ code: 1, err: expect.stringContaining("it runs the jobs") as string });
      expect((await run(["--help"])).out).toContain("pomade-runner missed <job> <choice>");
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
