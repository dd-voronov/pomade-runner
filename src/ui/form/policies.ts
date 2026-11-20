// The job form's policies in words, pure: each policy's words in the one-sentence summary and
// whether it is the kind's default; the summary bolds the others. A policy the form edits reads the
// values; one it shows from the file only (a missed-run policy, a time limit) reads the file as last
// read, and is in the sentence only when the file sets it. Its row — the control — is in `kinds.tsx`.

import { MISSED_POLICIES, type MissedPolicy, type Notify, type OverlapPolicy } from "../../jobs/model";
import { KIND_DEFAULTS } from "../../jobs/parse";
import { fileValue, type FormState, type FormValues } from "./state";

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
const MISSED_LABELS: Record<MissedPolicy, string> = { "run-on-wake": "Run on wake", "wait-for-me": "Wait for me", skip: "Skip" };

/** The file's missed-run policy and its worth-until, as written; `null` when it sets neither. A
 *  value the format lacks shows as written. */
export interface FileMissed {
  policy: MissedPolicy | null;
  /** In the sentence: "if missed, wait for me", "if missed, run on wake until 12:00". */
  words: string;
  /** In its row: "Wait for me", "Run on wake, until 12:00". */
  label: string;
  isDefault: boolean;
}

const isUnset = (value: unknown): boolean => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

export function fileMissed(state: FormState): FileMissed | null {
  const missed = fileValue(state, "missed");
  const worth = fileValue(state, "worth-until");
  if (isUnset(missed) && isUnset(worth)) return null;
  const policy = isUnset(missed) ? KIND_DEFAULTS[state.values.kind].missed : (MISSED_POLICIES.find((one) => one === missed) ?? null);
  const until = typeof worth === "string" && worth.trim() !== "next-run" && !isUnset(worth) ? worth.trim() : null;
  const head = policy === null ? `if missed: ${String(missed)}` : MISSED_TEXT[policy];
  const label = policy === null ? String(missed) : MISSED_LABELS[policy];
  return {
    policy,
    words: until === null ? head : `${head} until ${until}`,
    label: until === null ? label : `${label}, until ${until}`,
    isDefault: policy === KIND_DEFAULTS[state.values.kind].missed && until === null,
  };
}

export const MISSED_FROM_FILE_WORDS: PolicyWords = {
  key: "missed",
  words: (state) => fileMissed(state)?.words ?? null,
  isDefault: (state) => fileMissed(state)?.isDefault ?? true,
};

/** The file's time limit as written; `null` when it sets none. */
export function fileLimit(state: FormState): string | null {
  const limit = fileValue(state, "time-limit");
  return isUnset(limit) ? null : String(limit).trim();
}

export const TIME_LIMIT_FROM_FILE_WORDS: PolicyWords = {
  key: "timeLimit",
  words: (state) => {
    const limit = fileLimit(state);
    return limit === null ? null : `stops after ${limit}`;
  },
  isDefault: (state) => fileLimit(state) === null,
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
