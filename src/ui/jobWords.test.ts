import { WORKSPACE_PROJECT_ID, type ProjectRef } from "pomade-kit/protocol";
import { describe, expect, it } from "vitest";

import type { GitJob, ScriptJob, ServiceJob } from "../jobs/model";
import type { ServiceStatus } from "../keeper/model";
import type { ActiveRun, JobRuns, RunRecord } from "../scheduler/model";
import { nextUpWords } from "./panelWords";
import { aheadWhen, gitDetail, lastLook, newJobRoute, nextLook } from "./jobWords";

const now = new Date(2026, 10, 17, 12, 48).getTime();
const at = (day: number, hours: number, minutes: number): number => new Date(2026, 10, day, hours, minutes).getTime();

const script: ScriptJob = {
  id: "backup",
  path: "Apps/pomade-runner/jobs/backup.md",
  name: "Backup",
  project: null,
  enabled: true,
  notify: "on-failure",
  lowPriority: true,
  body: "",
  kind: "script",
  folder: "",
  command: "./backup.sh",
  trigger: { kind: "schedule", schedule: {} as Extract<ScriptJob["trigger"], { kind: "schedule" }>["schedule"], words: "daily at 13:00" },
  missed: "run-on-wake",
  worthUntil: "next-run",
  overlap: "skip",
  timeLimitMinutes: null,
};
const hook: ScriptJob = { ...script, trigger: { kind: "hook", hook: { event: "login", project: null, agent: null, status: null } } };
const service: ServiceJob = { ...script, kind: "service", start: "login", ready: { kind: "alive" }, after: null } as unknown as ServiceJob;
const git: GitJob = { ...script, kind: "git", git: { operation: "commit-push", repos: ["Knowledge", "Notes"] } } as unknown as GitJob;

const record = (state: RunRecord["state"], extra: Partial<RunRecord> = {}): RunRecord => ({
  job: "backup",
  name: "Backup",
  kind: "script",
  project: null,
  folder: "",
  run: "20261117-111700-abcdef",
  trigger: "scheduled",
  cause: null,
  dueAt: at(17, 11, 17),
  agent: null,
  missed: null,
  state,
  action: null,
  reason: null,
  startedAt: at(17, 11, 17),
  endedAt: at(17, 11, 20),
  durationMs: 3000,
  exitCode: state === "failed" ? 1 : 0,
  signal: null,
  log: null,
  lastLines: [],
  git: null,
  limitHit: null,
  ...extra,
});

const active = (state: ActiveRun["state"], extra: Partial<ActiveRun> = {}): ActiveRun => ({
  job: "backup",
  name: "Backup",
  kind: "script",
  project: null,
  folder: "",
  run: "20261117-121900-aaaaaa",
  trigger: "scheduled",
  cause: null,
  dueAt: at(17, 12, 31),
  agent: null,
  missed: null,
  state,
  lowPriority: true,
  runAt: null,
  deadline: null,
  waits: null,
  startedAt: state === "running" ? at(17, 12, 31) : null,
  session: null,
  log: null,
  limitHit: null,
  warnedAt: null,
  warningDismissed: false,
  ...extra,
});

const runs = (extra: Partial<JobRuns> = {}): JobRuns => ({ job: "backup", next: null, finished: false, last: null, held: false, ...extra });

describe("a job's last result", () => {
  const look = (last: RunRecord | null, going: ActiveRun[] = []) => lastLook(script, { runs: runs({ last }), active: going, service: undefined }, now);

  it("says a job that never ran, with no run to open", () => {
    expect(look(null)).toMatchObject({ tone: "hollow", words: "never ran", help: null, sub: "", run: null });
  });

  it("chips each result with its status, when it started and how long it took, and opens its run", () => {
    expect(look(record("done"))).toMatchObject({ tone: "ok", words: "done", help: "st.done", sub: "today 11:17 · 3s", run: "20261117-111700-abcdef" });
    // The prototype's: to the second, and a trigger that is not the job's own.
    expect(look(record("done", { trigger: "caught-up", startedAt: at(17, 8, 32), durationMs: 252_000 }))).toMatchObject({ sub: "today 8:32 · 4m 12s · caught up" });
    expect(look(record("done", { trigger: "manual" }))).toMatchObject({ sub: "today 11:17 · 3s · manual" });
    expect(look(record("done", { trigger: "hook" }))).toMatchObject({ sub: "today 11:17 · 3s" });
    expect(look(record("failed"))).toMatchObject({ tone: "danger", words: "failed · exit 1", help: "st.failed" });
    expect(look(record("failed", { reason: "stopped: time limit, 45 min", exitCode: null, signal: "SIGTERM", limitHit: 45 }))).toMatchObject({ tone: "danger", words: "stopped: time limit, 45 min", help: "st.limit" });
    expect(look(record("failed", { reason: "stopped by Runner" }))).toMatchObject({ tone: "danger", words: "failed · stopped by Runner", help: "st.failed" });
    expect(look(record("stopped-by-you"))).toMatchObject({ tone: "hollow", words: "stopped by you", help: "st.byyou" });
  });

  it("says a done git run's commit instead of how long it took; a run with no commit, or one that failed, its duration", () => {
    const repo = (commit: string | null) => ({ repo: "Knowledge", path: "/ws/Knowledge", op: "commit-push" as const, status: "done" as const, reason: null, steps: [], commit });
    const git = (commits: (string | null)[]) => ({ op: "commit-push" as const, job: "K", at: "2026-11-17T11:20:00.000Z", results: commits.map(repo) });
    expect(look(record("done", { git: git([null, "a1b2c3d4e5f6", "9f8e7d6c5b4a"]) }))).toMatchObject({ words: "done", sub: "today 11:17 · a1b2c3d" });
    expect(look(record("done", { git: git([null]) }))).toMatchObject({ sub: "today 11:17 · 3s" });
    expect(look(record("failed", { git: git(["9f8e7d6c5b4a"]), reason: "Knowledge: push rejected" }))).toMatchObject({ sub: "today 11:17 · 3s" });
  });

  it("gives a run that never started its reason and no duration", () => {
    const due = at(16, 20, 0);
    expect(look(record("skipped", { reason: "previous run still going", durationMs: null, startedAt: null, dueAt: due, endedAt: due }))).toMatchObject({
      tone: "hollow",
      words: "skipped · previous run still going",
      help: "st.skipped",
      sub: "yesterday 20:00",
    });
    expect(look(record("missed", { reason: "skipped", durationMs: null }))).toMatchObject({ words: "missed · skipped", help: "st.missed" });
  });

  it("shows a run going, queued or waiting for the person ahead of the last finished one", () => {
    expect(look(record("done"), [active("running")])).toMatchObject({ tone: "accent", live: true, words: "running", help: "st.running", sub: "17m", run: "20261117-121900-aaaaaa" });
    expect(look(record("done"), [active("running", { trigger: "manual", startedAt: at(17, 9, 46) })])).toMatchObject({ words: "running", sub: "3h 02m · manual" });
    expect(look(record("done"), [active("queued", { dueAt: at(17, 12, 46), waits: { kind: "slot", ahead: 1 } })])).toMatchObject({ tone: "hollow", words: "queued · 1 ahead", help: "st.queued", sub: "since 12:46" });
    expect(look(null, [active("missed-waiting", { dueAt: at(17, 3, 0) })])).toMatchObject({ tone: "warning", words: "missed · waiting for you", sub: "today 3:00" });
    expect(look(null, [active("queued"), active("running", { run: "r2" })])).toMatchObject({ words: "running", run: "r2" });
    const waiting = active("running", { kind: "agent", agent: { ...{ agent: "claude", name: "claude", provider: "claude" as const, mode: "normal", modeName: "Normal", sessionId: "s1", cwd: "/ws", startedAt: "2026-11-17T11:31:00.000Z", exit: "/exit", exitSentAt: null, waitedMs: 0 }, waiting: { prompt: "permission", since: at(17, 12, 40) } } });
    expect(look(record("done"), [waiting])).toMatchObject({ tone: "warning", live: false, words: "waiting for you", help: "st.waiting", sub: "started 12:31 · 17m" });
  });

  it("says a job the loop guard paused, after any run going, with no run to open", () => {
    const paused = (going: ActiveRun[] = []) => lastLook(script, { runs: runs({ last: record("done") }), active: going, service: undefined, pausedAt: at(16, 18, 40) }, now);
    expect(paused()).toMatchObject({ tone: "warning", words: "paused · looks like a loop", help: "st.paused", sub: "yesterday 18:40 · 10× in 10 min", run: null });
    expect(paused([active("running")])).toMatchObject({ words: "running" });
  });

  it("says a service by its state, with no run to open", () => {
    const status: ServiceStatus = { job: "backup", name: "Backup", project: null, state: "failed", session: null, restarts: 4, lastCrashAt: at(17, 11, 20), retryAt: null, needsRestart: false, problem: null };
    expect(lastLook(service, { runs: undefined, active: [], service: status }, now)).toMatchObject({ tone: "danger", words: "failed · gave up", help: "st.svcfailed", run: null });
    expect(lastLook(service, { runs: undefined, active: [], service: undefined }, now)).toMatchObject({ words: "queued", help: "st.svcqueued" });
    expect(lastLook({ ...service, enabled: false }, { runs: undefined, active: [], service: undefined }, now)).toMatchObject({ words: "disabled" });
  });
});

describe("a job's next run", () => {
  it("says a disabled job, ahead of any other state", () => {
    expect(nextLook({ ...script, enabled: false }, runs({ next: at(17, 13, 0) }), true, now)).toEqual({ words: "disabled", sub: null, none: true, held: false });
    expect(nextLook({ ...service, enabled: false }, undefined, false, now).words).toBe("disabled");
  });

  it("says a job the loop guard paused", () => {
    expect(nextLook(script, runs({ next: at(17, 13, 0) }), true, now)).toEqual({ words: "paused", sub: null, none: true, held: false });
  });

  it("says a service always on, and a hook or a chain on event", () => {
    expect(nextLook(service, undefined, false, now)).toEqual({ words: "always on", sub: null, none: true, held: false });
    for (const start of ["pomade-started", "project-first-open"] as const) expect(nextLook({ ...service, start }, undefined, false, now)).toEqual({ words: "with Pomade", sub: null, none: true, held: false });
    expect(nextLook(hook, runs(), false, now)).toEqual({ words: "on event", sub: null, none: true, held: false });
    expect(nextLook({ ...hook, trigger: { kind: "chain", chain: { job: "pull", result: "any" } } }, runs(), false, now).words).toBe("on event");
  });

  it("says a manual job's Next run on Run now", () => {
    expect(nextLook({ ...hook, trigger: { kind: "manual" } }, runs(), false, now)).toEqual({ words: "on Run now", sub: null, none: true, held: false });
    // The switch never holds a job that runs only by hand.
    expect(nextLook({ ...hook, trigger: { kind: "manual" } }, runs({ held: true }), false, now).held).toBe(false);
  });

  it("gives a schedule's next time, and how soon under an hour", () => {
    expect(nextLook(script, runs({ next: at(17, 13, 0) }), false, now)).toEqual({ words: "Today 13:00", sub: "in 12 min", none: false, held: false });
    expect(nextLook(script, runs({ next: at(17, 15, 0) }), false, now)).toEqual({ words: "Today 15:00", sub: null, none: false, held: false });
    expect(nextLook(script, runs({ next: at(18, 7, 0) }), false, now)).toEqual({ words: "Tomorrow 7:00", sub: null, none: false, held: false });
    expect(nextLook(script, runs({ next: at(17, 12, 48) }), false, now).sub).toBe("now");
  });

  it("says a job the switch holds held, with its next time and countdown; never on a disabled or paused job", () => {
    expect(nextLook(script, runs({ next: at(17, 13, 0), held: true }), false, now)).toEqual({ words: "Today 13:00", sub: "in 12 min", none: false, held: true });
    expect(nextLook({ ...script, enabled: false }, runs({ next: at(17, 13, 0), held: true }), false, now).held).toBe(false);
    expect(nextLook(script, runs({ next: at(17, 13, 0), held: true }), true, now).held).toBe(false);
  });

  it("says the same countdown as the panel's Next up, to the second", () => {
    const next = (seconds: number): string | null => nextLook(script, runs({ next: now + seconds * 1000 }), false, now).sub;
    expect([-1, 0, 56, 59, 60, 61, 90, 119, 120, 3599, 3600].map(next)).toEqual([
      "now",
      "now",
      "in 56 s",
      "in 59 s",
      "in 1 min",
      "in 2 min",
      "in 2 min",
      "in 2 min",
      "in 2 min",
      "in 1 h",
      null,
    ]);
    for (const seconds of [-1, 0, 30, 56, 60, 61, 90, 119, 120, 600, 3599]) expect(nextUpWords(now + seconds * 1000, now)).toBe(next(seconds));
  });

  it("says a schedule with nothing ahead finished, and one not yet reported a dash", () => {
    expect(nextLook(script, runs({ finished: true }), false, now)).toEqual({ words: "finished", sub: null, none: true, held: false });
    expect(nextLook(script, undefined, false, now).words).toBe("—");
  });
});

describe("a moment ahead", () => {
  it("is today, tomorrow, a weekday within the week, else the date", () => {
    expect(aheadWhen(at(17, 23, 5), now)).toBe("today 23:05");
    expect(aheadWhen(at(18, 7, 0), now)).toBe("tomorrow 7:00");
    expect(aheadWhen(at(22, 3, 0), now)).toBe("Sun 3:00");
    expect(aheadWhen(at(25, 3, 0), now)).toBe("Wed 25 Nov 3:00");
  });
});

describe("a git job's detail", () => {
  it("names the operation and the repos, and says a repo the workspace lacks once they are known", () => {
    expect(gitDetail(git, null)).toEqual({ text: "Commit & push · Knowledge, Notes", missing: [] });
    expect(gitDetail(git, new Set(["Knowledge"]))).toEqual({ text: "Commit & push · Knowledge, Notes (not in this workspace)", missing: ["Notes"] });
    expect(gitDetail({ ...git, git: { operation: "pull", repos: ["/abs/repo"] } }, new Set())).toEqual({ text: "Pull · /abs/repo", missing: [] });
  });
});

describe("where New job starts", () => {
  const project: ProjectRef = { id: "coda-helper", kind: "project", name: "coda-helper", root: "Projects/coda-helper" };
  it("is the open project while the chip is on, else a project-less form", () => {
    expect(newJobRoute(true, project)).toBe("new/coda-helper");
    expect(newJobRoute(false, project)).toBe("new");
    expect(newJobRoute(true, null)).toBe("new");
  });

  it("never starts in the Workspace, which is no project", () => {
    expect(newJobRoute(true, { id: WORKSPACE_PROJECT_ID, kind: "workspace", name: "Workspace", root: "" })).toBe("new");
  });
});
