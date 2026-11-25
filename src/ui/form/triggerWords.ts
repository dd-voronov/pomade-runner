// The job form's hooks and chains in words, pure: the events the form offers, the jobs a chain can
// follow, the trigger in words under the editor, and which checker error is a chain that loops back.

import { LOOP_PROBLEM } from "../../jobs/check";
import type { RosterAgent } from "pomade-kit/protocol";

import { SESSION_STATUS_WORDS, SESSION_STATUSES, type ChainResult, type JobError, type JobsSnapshot, type ProjectRecord, type ServiceAction } from "../../jobs/model";
import { chainWords, hookWords, RESULT_WORDS } from "../../jobs/words";
import type { HelpKey } from "../help";
import type { SelectOption } from "../kit";
import type { FormValues } from "./state";

/** The Event list's entry for a chain: "Another job finished". */
export const CHAIN_CHOICE = "chain";

/** The Event list: the hooks the engine fires, then the chain — always last. */
export const EVENT_CHOICES: readonly { value: string; label: string; help: HelpKey }[] = [
  { value: "login", label: "Mac login", help: "hk.login" },
  { value: "pomade-started", label: "Pomade started", help: "hk.pomade-started" },
  { value: "project-first-open", label: "First open of a project since Pomade started", help: "hk.project-first-open" },
  { value: "project-opened", label: "Project opened (every time)", help: "hk.project-opened" },
  { value: "project-created", label: "Project created", help: "hk.project-created" },
  { value: "session-finished", label: "Agent session finished", help: "hk.session-finished" },
  { value: "session-status", label: "Session status changed to…", help: "hk.session-status" },
  { value: CHAIN_CHOICE, label: "Another job finished", help: "hk.job-finished" },
];

/** Whether the form edits a hook on `event`; any other is said in words and changed in the file. */
export function formOffersHook(event: string): boolean {
  return event !== CHAIN_CHOICE && EVENT_CHOICES.some((choice) => choice.value === event);
}

const RESULTS: readonly ChainResult[] = ["done", "failed", "any"];

/** A script's chain result, as its choice says it: "Is done · Fails · Finishes either way". */
export const RESULT_CHOICES: readonly { value: ChainResult; label: string }[] = RESULTS.map((value) => ({ value, label: RESULT_WORDS[value].replace(/^./, (first) => first.toUpperCase()) }));

/** A service's chain, as its line reads: "Also restart it after Pull is done". */
export const ACTION_OPTIONS: readonly { value: ServiceAction; label: string }[] = [
  { value: "restart", label: "restart it" },
  { value: "start", label: "start it" },
  { value: "stop", label: "stop it" },
];
export const SERVICE_RESULT_OPTIONS: readonly { value: ChainResult; label: string }[] = RESULTS.map((value) => ({ value, label: RESULT_WORDS[value] }));

/** A job's name by its id in the snapshot; `null` when no job has it. */
export function jobName(snapshot: JobsSnapshot, id: string): string | null {
  for (const entry of snapshot.jobs) {
    if (entry.valid && entry.job.id === id) return entry.job.name;
    if (!entry.valid && entry.invalid.id === id) return entry.invalid.name;
  }
  return null;
}

/**
 * The jobs a chain can follow, by name: every valid job but the one edited (`self`, its id) and the
 * services — a service never finishes. The picker's first entry asks for a choice; a job the file
 * names that is not among them stays, by its id, so the picker shows what the file says.
 */
export function chainJobOptions(snapshot: JobsSnapshot, self: string | null, current: string, placeholder: string): SelectOption[] {
  const jobs = snapshot.jobs
    .flatMap((entry) => (entry.valid && entry.job.kind !== "service" && entry.job.id !== self ? [{ value: entry.job.id, label: entry.job.name }] : []))
    .sort((a, b) => a.label.localeCompare(b.label));
  const options: SelectOption[] = [{ value: "", label: placeholder }, ...jobs];
  if (current !== "" && !jobs.some((job) => job.value === current)) options.push({ value: current, label: current });
  return options;
}

/** A project picker's choices: Pomade's projects by name; `placeholder` first while none is picked,
 *  and a project the file names that Pomade does not list, by its id. */
export function projectPicks(records: readonly ProjectRecord[], current: string, placeholder: string | null): SelectOption[] {
  const options: SelectOption[] = records.map((project) => ({ value: project.id, label: project.name }));
  if (current !== "" && !records.some((project) => project.id === current)) options.push({ value: current, label: current });
  return current === "" && placeholder !== null ? [{ value: "", label: placeholder }, ...options] : options;
}

/** A status hook's Status picker: the Agents app's statuses, by its names; a status the file names
 *  that is not one of them stays, as written. */
export function statusPicks(current: string): SelectOption[] {
  const options: SelectOption[] = SESSION_STATUSES.map((status) => ({ value: status, label: SESSION_STATUS_WORDS[status] }));
  if (current !== "" && !(SESSION_STATUSES as readonly string[]).includes(current)) options.push({ value: current, label: current });
  return options;
}

/** An agent session hook's Only agent picker: Any agent, then the roster's agents by id; an agent
 *  the file names that the roster does not list (or with the roster not at hand), by its id. */
export function agentPicks(roster: readonly RosterAgent[], current: string): SelectOption[] {
  const options: SelectOption[] = [{ value: "", label: "Any agent" }, ...roster.map((agent) => ({ value: agent.id, label: agent.id }))];
  if (current !== "" && !roster.some((agent) => agent.id === current)) options.push({ value: current, label: current });
  return options;
}

/** The trigger in words under the hook editor: what fires the job, and a line on how it runs. */
export interface HookBoxWords {
  title: string;
  sub: string;
}

/** The warm-up in words: "after the 2-minute warm-up"; `null` minutes (the settings not heard) says
 *  only "after the warm-up". */
function warmUpWords(minutes: number | null): string {
  if (minutes === null) return "after the warm-up";
  if (minutes === 0) return "once the services are up";
  return `after the ${minutes}-minute warm-up`;
}

/** Pomade's hooks fire only while it runs: nothing is missed. */
const POMADE_HOOK_SUB = "Fires only while Pomade is running, so there are no missed runs.";

export function hookBoxWords(values: FormValues, snapshot: JobsSnapshot, warmUpMinutes: number | null, projects: readonly ProjectRecord[]): HookBoxWords {
  if (values.trigger === "chain") {
    const job = values.chainJob.trim();
    if (job === "") return { title: "Runs after another job finishes", sub: "A chain. History will show “chain: after …”." };
    const name = jobName(snapshot, job) ?? job;
    return { title: `Runs ${chainWords({ job, result: values.chainResult }, { job: () => name })}`, sub: `A chain. History will show “chain: after ${name}”.` };
  }
  switch (values.hookEvent) {
    case "pomade-started":
      return { title: "Runs when Pomade starts", sub: POMADE_HOOK_SUB };
    case "project-first-open": {
      const id = values.hookProject.trim();
      const name = id === "" ? "a project" : (projects.find((project) => project.id === id)?.name ?? id);
      return { title: `Runs on first open of ${name}`, sub: POMADE_HOOK_SUB };
    }
    case "project-opened": {
      const id = values.hookProject.trim();
      const name = id === "" ? "a project" : (projects.find((project) => project.id === id)?.name ?? id);
      return { title: `Runs whenever ${name} is opened`, sub: POMADE_HOOK_SUB };
    }
    case "project-created":
      return { title: "Runs when a project is created", sub: POMADE_HOOK_SUB };
    case "session-finished":
    case "session-status": {
      const pick = (value: string): string | null => (value.trim() === "" ? null : value.trim());
      const status = SESSION_STATUSES.find((one) => one === values.hookStatus.trim());
      const words = hookWords(
        { event: values.hookEvent, project: pick(values.hookProject), agent: pick(values.hookAgent), status: values.hookEvent === "session-status" ? (status ?? null) : null },
        { project: (id) => projects.find((project) => project.id === id)?.name ?? id },
      );
      return { title: `Runs ${words}`, sub: POMADE_HOOK_SUB };
    }
    default:
      return { title: "Runs at Mac login", sub: `Once per login, ${warmUpWords(warmUpMinutes)}.` };
  }
}

/** Whether a checker error is a chain that loops back. */
export function isLoopError(error: JobError): boolean {
  return error.problem.startsWith(LOOP_PROBLEM);
}
