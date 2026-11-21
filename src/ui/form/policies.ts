// The job form's policies in words, pure: each policy's words in the one-sentence summary and
// whether it is the kind's default; the summary bolds the others. Each reads the form's values. Its
// row — the control — is in `kinds.tsx`.

import type { MissedPolicy, Notify, OverlapPolicy } from "../../jobs/model";
import type { FormState, FormValues } from "./state";

export interface PolicyWords {
  key: string;
  /** Its words in the summary ("normal priority"); `null` leaves it out. */
  words(state: FormState): string | null;
  /** Whether the value is the kind's default. */
  isDefault(state: FormState, defaults: FormValues): boolean;
}

export const LOW_PRIORITY_WORDS: PolicyWords = {
  key: "lowPriority",
  words: ({ values }) => (values.lowPriority ? "low priority" : "normal priority"),
  isDefault: ({ values }, defaults) => values.lowPriority === defaults.lowPriority,
};

const NOTIFY_TEXT: Record<Notify, string> = { "on-failure": "notifies on failure", always: "always notifies", never: "never notifies" };

export const NOTIFY_WORDS: PolicyWords = {
  key: "notify",
  words: ({ values }) => NOTIFY_TEXT[values.notify],
  isDefault: ({ values }, defaults) => values.notify === defaults.notify,
};

const OVERLAP_TEXT: Record<OverlapPolicy, string> = { skip: "never overlaps itself", parallel: "may overlap itself", queue: "queues behind itself" };

export const OVERLAP_WORDS: PolicyWords = {
  key: "overlap",
  words: ({ values }) => OVERLAP_TEXT[values.overlap],
  isDefault: ({ values }, defaults) => values.overlap === defaults.overlap,
};

const MISSED_TEXT: Record<MissedPolicy, string> = { "run-on-wake": "if missed, run on wake", "wait-for-me": "if missed, wait for me", skip: "if missed, skip" };

/** A job on a schedule says what a missed run becomes; a hook or a chain has no missed runs. */
export const MISSED_WORDS: PolicyWords = {
  key: "missed",
  words: ({ values }) => {
    if (values.trigger !== "schedule") return null;
    const until = values.worthAt.trim();
    return values.missed === "run-on-wake" && values.worth === "time" && until !== "" ? `${MISSED_TEXT["run-on-wake"]} until ${until}` : MISSED_TEXT[values.missed];
  },
  isDefault: ({ values }, defaults) => values.missed === defaults.missed && !(values.missed === "run-on-wake" && values.worth === "time"),
};

export const TIME_LIMIT_WORDS: PolicyWords = {
  key: "timeLimit",
  words: ({ values }) => (values.timeLimit.trim() === "" ? "no time limit" : `stops after ${values.timeLimit.trim()}`),
  isDefault: ({ values }) => values.timeLimit.trim() === "",
};

/** The summary: each policy's words in order, the first capitalised, and whether any is not the
 *  kind's default ("customised"). */
export function policySentence(policies: readonly PolicyWords[], state: FormState, defaults: FormValues): { parts: { key: string; text: string; isDefault: boolean }[]; customised: boolean } {
  const parts = policies.flatMap((policy) => {
    const words = policy.words(state);
    return words === null ? [] : [{ key: policy.key, text: words, isDefault: policy.isDefault(state, defaults) }];
  });
  const first = parts[0];
  if (first !== undefined) first.text = first.text.charAt(0).toUpperCase() + first.text.slice(1);
  return { parts, customised: parts.some((part) => !part.isDefault) };
}
