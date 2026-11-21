import { describe, expect, it } from "vitest";

import { checkJobs } from "../jobs/check";
import type { ServiceActionResult } from "../keeper/model";
import { deleteJob, STOP_WAIT_MS, type DeleteJobDeps } from "./delete";
import type { ActiveRun } from "./model";

const SERVICE = "---\nkind: service\nname: Coda web\nfolder: .\ncommand: ./start.sh\n---\n";
const SCRIPT = "---\nkind: script\nname: Backup\nfolder: .\ncommand: ./backup.sh\nschedule:\n  daily: { at: 13:00 }\n---\n";
const BROKEN = "---\nkind: service\nname: Broken\n---\n";

const running = (job: string, state: ActiveRun["state"]): ActiveRun => ({
  job,
  name: job,
  kind: "script",
  project: null,
  folder: "",
  run: "20261117-120000-abcdef",
  trigger: "manual",
  cause: null,
  dueAt: 1,
  agent: null,
  state,
  lowPriority: true,
  runAt: null,
  deadline: null,
  waits: null,
  startedAt: state === "running" ? 1 : null,
  session: state === "running" ? "run:x" : null,
  log: null,
  limitHit: null,
  warnedAt: null,
  warningDismissed: false,
});

/** A workspace with `files` and services that run: what each step did, in order, in `steps`. */
function world(files: Record<string, string>, options: { live?: string[]; active?: ActiveRun[]; endsAfter?: number; stop?: ServiceActionResult; workspace?: string | null } = {}) {
  const steps: string[] = [];
  const live = new Set(options.live ?? []);
  let clock = 0;
  let refreshes = 0;
  const snapshot = { ...checkJobs(Object.entries(files).map(([path, text]) => ({ path, text })), { workspace: "/ws", projects: null }), workspace: options.workspace === undefined ? "/ws" : options.workspace };
  const deps: DeleteJobDeps = {
    jobs: () => snapshot,
    active: () => options.active ?? [],
    serviceRunning: (job) => live.has(job),
    stopService: (job) => {
      steps.push(`stop ${job}`);
      return Promise.resolve(options.stop ?? ({ ok: true, service: {} } as ServiceActionResult));
    },
    refreshSessions: () => {
      refreshes += 1;
      // The session ends after `endsAfter` refreshes (1 by default).
      if (refreshes >= (options.endsAfter ?? 1)) live.clear();
      steps.push(`refresh sessions${live.size === 0 ? ": ended" : ""}`);
      return Promise.resolve();
    },
    removeFile: (workspace, path) => {
      steps.push(`remove ${workspace}/${path}`);
      return Promise.resolve();
    },
    refreshJobs: () => {
      steps.push("refresh jobs");
      return Promise.resolve();
    },
    log: (message) => steps.push(`log: ${message}`),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  };
  return { deps, steps };
}

describe("deleting a job", () => {
  it("removes a script's file, by its id or its name, and reads the folder again", async () => {
    for (const ref of ["backup", "BACKUP"]) {
      const { deps, steps } = world({ "backup.md": SCRIPT });
      expect(await deleteJob(ref, deps)).toEqual({ ok: true, job: "backup", path: "Apps/pomade-runner/jobs/backup.md", stopped: false });
      expect(steps).toEqual(["remove /ws/Apps/pomade-runner/jobs/backup.md", "log: job backup: deleted", "refresh jobs"]);
    }
  });

  it("stops a running service first, waits for its session to end, then removes the file", async () => {
    const { deps, steps } = world({ "web.md": SERVICE }, { live: ["web"], endsAfter: 3 });
    expect(await deleteJob("Coda web", deps)).toEqual({ ok: true, job: "web", path: "Apps/pomade-runner/jobs/web.md", stopped: true });
    expect(steps).toEqual([
      "stop web",
      "refresh sessions",
      "refresh sessions",
      "refresh sessions: ended",
      "remove /ws/Apps/pomade-runner/jobs/web.md",
      "log: job web: deleted, its service stopped first",
      "refresh jobs",
    ]);
  });

  it("removes a service that does not run without stopping anything, and an invalid file too", async () => {
    const { deps, steps } = world({ "web.md": SERVICE, "broken.md": BROKEN });
    expect(await deleteJob("web", deps)).toMatchObject({ ok: true, stopped: false });
    expect(await deleteJob("Broken", deps)).toMatchObject({ ok: true, job: "broken", stopped: false });
    expect(steps.filter((step) => step.startsWith("stop"))).toEqual([]);
  });

  it("stops the session of an invalid service file before removing it", async () => {
    const { deps, steps } = world({ "broken.md": BROKEN }, { live: ["broken"] });
    expect(await deleteJob("broken", deps)).toMatchObject({ ok: true, stopped: true });
    expect(steps.slice(0, 3)).toEqual(["stop broken", "refresh sessions: ended", "remove /ws/Apps/pomade-runner/jobs/broken.md"]);
  });

  it("keeps the file when the service does not stop in time, or Stop is refused", async () => {
    const slow = world({ "web.md": SERVICE }, { live: ["web"], endsAfter: Number.POSITIVE_INFINITY });
    expect(await deleteJob("web", slow.deps)).toEqual({ ok: false, reason: '"Coda web" did not stop, so its file is kept' });
    expect(slow.steps.some((step) => step.startsWith("remove"))).toBe(false);
    expect(slow.steps.filter((step) => step.startsWith("refresh sessions")).length).toBeGreaterThan(STOP_WAIT_MS / 100);

    const refused = world({ "web.md": SERVICE }, { live: ["web"], stop: { ok: false, reason: "the keeper is not running" } });
    expect(await deleteJob("web", refused.deps)).toEqual({ ok: false, reason: 'cannot stop "Coda web": the keeper is not running' });
    expect(refused.steps).toEqual(["stop web"]);
  });

  it("is refused while a run of the job is going; a queued or waiting run does not hold it", async () => {
    const going = world({ "backup.md": SCRIPT }, { active: [running("backup", "running")] });
    expect(await deleteJob("backup", going.deps)).toEqual({ ok: false, reason: 'a run of "Backup" is going; stop it first, then delete the job' });
    expect(going.steps).toEqual([]);
    const queued = world({ "backup.md": SCRIPT }, { active: [running("backup", "queued"), running("backup", "missed-waiting"), running("other", "running")] });
    expect(await deleteJob("backup", queued.deps)).toMatchObject({ ok: true });
  });

  it("refuses an unknown job, or one with no workspace known", async () => {
    expect(await deleteJob("nope", world({ "backup.md": SCRIPT }).deps)).toEqual({ ok: false, reason: 'no job "nope"' });
    expect(await deleteJob("backup", world({ "backup.md": SCRIPT }, { workspace: null }).deps)).toEqual({ ok: false, reason: "no workspace is known" });
  });

  it("says why the file could not be removed", async () => {
    const { deps } = world({ "backup.md": SCRIPT });
    deps.removeFile = () => Promise.reject(new Error("EACCES: permission denied"));
    expect(await deleteJob("backup", deps)).toEqual({ ok: false, reason: "cannot remove Apps/pomade-runner/jobs/backup.md: EACCES: permission denied" });
  });
});
