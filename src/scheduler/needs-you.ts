// "Needs you" and notices (docs/DESIGN.md "Notifications"): what Runner tells the person, and what
// stays in front of them until they deal with it.
//
// - **A run that ends** is noticed as its job's `notify` says: `always` every run that started,
//   `on-failure` a failed one, `never` none. A skipped or missed run is never noticed.
// - **A failed run** makes its job's Needs-you item (one per job: the latest failure and how many
//   since the item came) unless the job says `notify: never`. The item goes when the person opens
//   the run's result or dismisses it, when a run of the job is done, or when the job's file is gone.
// - **A service that gave up** after a crash loop is an item while it stays `failed` (Start, a fixed
//   or disabled file, or its removal end it), and is noticed once — Needs-you items always notify.
//   It carries the reason its last start failed and whether it has a session to open.
// - Missed runs that wait for the person, agent runs waiting at a prompt, long-run warnings and the
//   jobs the loop guard paused are runs' items (`runs.ts`), noticed with `missedNotice`,
//   `waitingNotice`, `longRunNotice` and `loopNotice`.
//
// The items live in `needs-you.json` in Runner's state folder, with the giving-ups already noticed,
// so a restarted scheduler neither forgets an item nor notices one twice.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { NoticeParams } from "pomade-kit/protocol";

import { promptRoute, runRoute } from "../integrations/runner-api";
import { entryId, type JobsSnapshot, type Notify } from "../jobs/model";
import type { ServicesReport, ServiceStatus } from "../keeper/model";
import { needsYouRecordPath, type RecordsFolder } from "../locations";
import { agentErrorLine } from "./agent-runs";
import type { Log } from "./log";
import { FIRING_LIMIT, FIRING_WINDOW_MS } from "./loop-guard";
import { dayTime, durationWords, failureWords, missedRunsWords, runWords, type ActiveRun, type AgentWait, type NeedsYouItem, type RunRecord } from "./model";
import { plainLine } from "./terminal-text";

/** A failed-run item as it is kept. */
interface Failure {
  name: string;
  project: string | null;
  run: string;
  at: number;
  count: number;
  detail: string;
}

/** What `needs-you.json` keeps. Plain JSON. */
export interface NeedsYouRecords {
  /** Each job's failed-run item, by job id. */
  failures: Record<string, Failure>;
  /** Services whose giving-up was noticed: job id → the last crash it gave up on (epoch ms). */
  gaveUp: Record<string, number>;
}

export interface NeedsYouStore {
  load(): Promise<NeedsYouRecords>;
  save(records: NeedsYouRecords): void;
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailure(value: unknown): Failure | null {
  if (!isRecord(value)) return null;
  const { name, project, run, at, count, detail } = value;
  if (typeof name !== "string" || (project !== null && typeof project !== "string") || typeof run !== "string" || typeof detail !== "string") return null;
  if (typeof at !== "number" || !Number.isFinite(at) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return null;
  return { name, project, run, at, count, detail };
}

/** The records in `<records>/needs-you.json`, replaced whole on every save. */
export function fileNeedsYouStore(records: RecordsFolder, log: Log): NeedsYouStore {
  const file = needsYouRecordPath(records);
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      const records: NeedsYouRecords = { failures: {}, gaveUp: {} };
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return records;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        log(`needs you: ${file} is not readable JSON; starting with no items`);
        return records;
      }
      if (!isRecord(data)) return records;
      if (isRecord(data.failures)) {
        for (const [job, value] of Object.entries(data.failures)) {
          const failure = parseFailure(value);
          if (failure !== null) records.failures[job] = failure;
        }
      }
      if (isRecord(data.gaveUp)) {
        for (const [job, at] of Object.entries(data.gaveUp)) if (typeof at === "number" && Number.isFinite(at)) records.gaveUp[job] = at;
      }
      return records;
    },
    save(records) {
      const data = `${JSON.stringify(records, null, 2)}\n`;
      writing = writing
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, data);
          await rename(`${file}.tmp`, file);
        })
        .catch((err: unknown) => log(`needs you: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`));
    },
    flush: () => writing,
  };
}

/** The notice for a run that ended, as its job's `notify` asks; `null` for none. */
export function runNotice(record: RunRecord, notify: Notify): NoticeParams | null {
  if (record.state === "skipped" || record.state === "missed" || notify === "never") return null;
  if (record.state !== "failed" && notify !== "always") return null;
  const action = { kind: "openApp" as const, route: runRoute(record.job, record.run) };
  const took = record.durationMs === null ? null : `took ${durationWords(record.durationMs)}`;
  if (record.event !== null) {
    // A chain's action on a service: done (noticed with `always`) or failed.
    const words = runWords(record);
    return record.state === "failed" ? { title: `${record.name}: ${words.replace(/ · .*$/, "")}`, body: failureWords(record), action } : { title: `${record.name} ${words}`, action };
  }
  switch (record.state) {
    case "failed": {
      // A git run's reason names each failed repo; its last lines say the same per repo. An agent
      // run's last line is its goodbye to the exit command: the line before that says the error.
      // The notice is plain text: the lines' colours go.
      const plain = record.lastLines.map(plainLine);
      const line =
        record.git !== null
          ? undefined
          : record.agent !== null
            ? agentErrorLine(plain, record.agent.exitSentAt === null ? null : record.agent.exit)
            : plain.reverse().find((text) => text.trim() !== "")?.trim();
      return { title: `${record.name} failed`, body: [failureWords(record), line].filter((part) => part !== undefined).join(" · ").slice(0, 2000), action };
    }
    case "done":
      return { title: `${record.name} done`, ...(took === null ? {} : { body: took }), action };
    case "stopped-by-you":
      return { title: `${record.name} stopped by you`, ...(took === null ? {} : { body: took }), action };
  }
}

/** The notice for a missed run of a `wait-for-me` job, which waits for the person. Its click opens
 *  the run's card, with Run now · Run at… · Skip — Run once · Run all N · Run at… · Skip for more
 *  than one. */
export function missedNotice(run: ActiveRun): NoticeParams {
  const count = run.missed?.count ?? 1;
  return {
    title: `${run.name} · ${missedRunsWords(run.missed) ?? `missed ${dayTime(run.dueAt)}`}`,
    body: count > 1 ? `It waits for you: Run once, Run all ${count}, Run at… or Skip.` : "It waits for you: Run now, Run at… or Skip.",
    action: { kind: "openApp", route: runRoute(run.job, run.run) },
  };
}

/** What an agent run waits at, in words: a Needs-you item's detail. */
export const WAIT_WORDS: Record<AgentWait["prompt"], string> = {
  permission: "waiting for approval",
  trust: "waiting for you to trust its folder",
  question: "waiting for your answer to its question",
  consent: "waiting for you to accept Full autonomy for its agent profile",
  unknown: "waiting at a screen Runner does not know — look at its terminal",
  "not-started": "has not started — look at its terminal",
};

const WAIT_NOTICES: Record<AgentWait["prompt"], { title: string; body: string }> = {
  permission: { title: "needs your approval", body: "The agent waits at a permission prompt. Open it to answer; the time limit is paused meanwhile." },
  trust: { title: "needs your approval", body: "The agent asks whether to trust its folder. Open it to answer; the time limit is paused meanwhile." },
  question: { title: "asks you a question", body: "The agent asks you to pick an option. Open it to answer; the time limit is paused meanwhile." },
  consent: { title: "needs your consent", body: 'Claude asks you to accept its Bypass Permissions mode for this agent profile, once. Open it and pick "Yes, I accept"; the time limit is paused meanwhile.' },
  unknown: { title: "waits at a screen Runner does not know", body: "The agent stopped at a screen Runner does not know. Open it to look; the time limit is paused meanwhile." },
  "not-started": { title: "has not started", body: "The agent stopped at a screen before it began working. Look at its terminal; the time limit is paused meanwhile." },
};

/** The notice for an agent run that waits for the person. Its click opens the run's terminal tab
 *  at the prompt. */
export function waitingNotice(run: ActiveRun, prompt: AgentWait["prompt"]): NoticeParams {
  const words = WAIT_NOTICES[prompt];
  return { title: `${run.name} ${words.title}`, body: words.body, action: { kind: "openApp", route: promptRoute(run.job, run.run) } };
}

/** The notice for a run going longer than the long-run warning: it keeps going. */
export function longRunNotice(run: ActiveRun, ranMs: number): NoticeParams {
  return {
    title: `${run.name} has been running ${durationWords(ranMs)} — still expected?`,
    body: "It keeps running: Runner never stops a run for running long. Open it, or Stop it.",
    action: { kind: "openApp", route: runRoute(run.job, run.run) },
  };
}

/** The notice for a job the loop guard paused. */
export function loopNotice(name: string): NoticeParams {
  return {
    title: `${name} paused: triggered ${FIRING_LIMIT}× in ${FIRING_WINDOW_MS / 60_000} min — looks like a loop`,
    body: "Hooks and chains no longer start it. Resume it in Runner once the loop is fixed.",
    action: { kind: "openApp", route: "" },
  };
}

/** The notice for a service that gave up after a crash loop. */
export function gaveUpNotice(service: ServiceStatus): NoticeParams {
  return {
    title: `${service.name} gave up`,
    body: `${service.problem === null ? "It crashed 5 times within a minute" : `It could not start: ${service.problem}`}, so Runner stopped restarting it. Start runs it again.`,
    action: { kind: "openApp", route: "" },
  };
}

export interface NeedsYouOptions {
  store: NeedsYouStore;
  log: Log;
  /** Post a notice. */
  post(notice: NoticeParams): void;
  /** The items changed. */
  onChange(): void;
}

export interface NeedsYou {
  load(): Promise<void>;
  /** A run's record landed: notice it, and add or resolve its job's item. */
  runFinished(record: RunRecord, notify: Notify): void;
  /** Follow the services: a crash loop that gave up is an item, noticed once. */
  services(report: ServicesReport): void;
  /** Follow the job files: a gone job's item goes. */
  jobs(snapshot: JobsSnapshot): void;
  /** Resolve an item by its id (opened or dismissed); whether there was one. A service's item
   *  stays until the service leaves `failed`. */
  dismiss(id: string): boolean;
  /** Newest first. */
  items(): NeedsYouItem[];
  close(): Promise<void>;
}

const failedId = (job: string): string => `run-failed:${job}`;
const serviceId = (job: string): string => `service-failed:${job}`;

export function createNeedsYou(options: NeedsYouOptions): NeedsYou {
  const { store, log } = options;
  let failures = new Map<string, Failure>();
  let gaveUp = new Map<string, number>();
  let failed: ServiceStatus[] = [];

  const save = (): void => store.save({ failures: Object.fromEntries(failures), gaveUp: Object.fromEntries(gaveUp) });
  const changed = (): void => {
    save();
    options.onChange();
  };

  return {
    async load() {
      const records = await store.load();
      failures = new Map(Object.entries(records.failures));
      gaveUp = new Map(Object.entries(records.gaveUp));
    },

    runFinished(record, notify) {
      const notice = runNotice(record, notify);
      if (notice !== null) options.post(notice);
      if (record.state === "failed" && notify !== "never") {
        const count = (failures.get(record.job)?.count ?? 0) + 1;
        failures.set(record.job, { name: record.name, project: record.project, run: record.run, at: record.endedAt, count, detail: failureWords(record) });
        log(`needs you: ${record.job} failed (${count}×)`);
        changed();
      } else if (record.state === "done" && failures.delete(record.job)) {
        log(`needs you: ${record.job} done; its failure is resolved`);
        changed();
      }
    },

    services(report) {
      const now = report.services.filter((service) => service.state === "failed");
      let dirty = JSON.stringify(now.map((s) => [s.job, s.name, s.project, s.lastCrashAt])) !== JSON.stringify(failed.map((s) => [s.job, s.name, s.project, s.lastCrashAt]));
      failed = now;
      for (const service of now) {
        const at = service.lastCrashAt ?? 0;
        if (gaveUp.get(service.job) === at) continue;
        gaveUp.set(service.job, at);
        log(`needs you: service ${service.job} gave up`);
        options.post(gaveUpNotice(service));
        dirty = true;
      }
      for (const job of [...gaveUp.keys()]) {
        if (now.some((service) => service.job === job)) continue;
        gaveUp.delete(job);
        dirty = true;
      }
      if (dirty) changed();
    },

    jobs(snapshot) {
      if (snapshot.workspace === null) return;
      const present = new Set(snapshot.jobs.map(entryId));
      let dirty = false;
      for (const job of [...failures.keys()]) {
        if (present.has(job)) continue;
        failures.delete(job);
        dirty = true;
      }
      if (dirty) changed();
    },

    dismiss(id) {
      const job = id.startsWith("run-failed:") ? id.slice("run-failed:".length) : null;
      if (job === null || !failures.delete(job)) return false;
      log(`needs you: ${job} resolved`);
      changed();
      return true;
    },

    items() {
      const items: NeedsYouItem[] = [
        ...[...failures].map(([job, failure]): NeedsYouItem => ({ id: failedId(job), kind: "run-failed", job, ...failure })),
        ...failed.map(
          (service): NeedsYouItem => ({
            id: serviceId(service.job),
            kind: "service-failed",
            job: service.job,
            name: service.name,
            project: service.project,
            at: service.lastCrashAt ?? 0,
            detail: service.problem ?? "crashed 5 times within a minute",
            problem: service.problem,
            session: service.session !== null,
          }),
        ),
      ];
      return items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    },

    close: () => store.flush(),
  };
}
