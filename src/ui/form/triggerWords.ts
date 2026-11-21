// The job form's hooks and chains in words, pure: the events the form offers, the jobs a chain can
// follow, the trigger in words under the editor, and which checker error is a chain that loops back.

import { LOOP_PROBLEM } from "../../jobs/check";
import type { ChainResult, JobError, JobsSnapshot, ServiceAction } from "../../jobs/model";
import { chainWords } from "../../jobs/words";
import type { HelpKey } from "../help";
import type { SelectOption } from "../kit";
import type { FormValues } from "./state";

/** The Event list's entry for a chain: "Another job finished". */
export const CHAIN_CHOICE = "chain";

/** The Event list: the hooks the engine fires, then the chain — always last. */
export const EVENT_CHOICES: readonly { value: string; label: string; help: HelpKey }[] = [
  { value: "login", label: "Mac login", help: "hk.login" },
  { value: CHAIN_CHOICE, label: "Another job finished", help: "hk.job-finished" },
];

/** Whether the form edits a hook on `event`; any other is said in words and changed in the file. */
export function formOffersHook(event: string): boolean {
  return event !== CHAIN_CHOICE && EVENT_CHOICES.some((choice) => choice.value === event);
}

/** A script's chain result, as its choice says it. */
export const RESULT_CHOICES: readonly { value: ChainResult; label: string }[] = [
  { value: "done", label: "Is done" },
  { value: "failed", label: "Fails" },
  { value: "any", label: "Either" },
];

/** A service's chain, as its line reads: "Also restart it after Pull is done". */
export const ACTION_OPTIONS: readonly { value: ServiceAction; label: string }[] = [
  { value: "restart", label: "restart it" },
  { value: "start", label: "start it" },
  { value: "stop", label: "stop it" },
];
export const SERVICE_RESULT_OPTIONS: readonly { value: ChainResult; label: string }[] = [
  { value: "done", label: "is done" },
  { value: "failed", label: "fails" },
  { value: "any", label: "finishes" },
];

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

export function hookBoxWords(values: FormValues, snapshot: JobsSnapshot, warmUpMinutes: number | null): HookBoxWords {
  if (values.trigger === "chain") {
    const job = values.chainJob.trim();
    if (job === "") return { title: "Runs after another job finishes", sub: "A chain. History will show “chain: after …”." };
    const name = jobName(snapshot, job) ?? job;
    return { title: `Runs ${chainWords({ job, result: values.chainResult }, { job: () => name })}`, sub: `A chain. History will show “chain: after ${name}”.` };
  }
  return { title: "Runs at Mac login", sub: `Once per login, ${warmUpWords(warmUpMinutes)}.` };
}

/** Whether a checker error is a chain that loops back. */
export function isLoopError(error: JobError): boolean {
  return error.problem.startsWith(LOOP_PROBLEM);
}
