import { describe, expect, it } from "vitest";

import { fileLimit, fileMissed, LOW_PRIORITY_WORDS, MISSED_FROM_FILE_WORDS, NOTIFY_WORDS, OVERLAP_WORDS, policySentence, TIME_LIMIT_FROM_FILE_WORDS } from "./policies";
import { blankValues, editForm, newForm, setValue, switchKind, type FormState } from "./state";

const SCRIPT = [MISSED_FROM_FILE_WORDS, OVERLAP_WORDS, LOW_PRIORITY_WORDS, TIME_LIMIT_FROM_FILE_WORDS, NOTIFY_WORDS];
const SERVICE = [LOW_PRIORITY_WORDS, NOTIFY_WORDS];

/** The summary as it reads, non-defaults in **bold**. */
function sentence(state: FormState, policies = SCRIPT): { text: string; customised: boolean } {
  const read = policySentence(policies, state, blankValues(state.values.kind));
  return { text: read.parts.map((part) => (part.isDefault ? part.text : `**${part.text}**`)).join(" · "), customised: read.customised };
}

const script = (fields: string): FormState => {
  const state = editForm("Apps/pomade-runner/jobs/tidy.md", `---\nkind: script\nname: Tidy\nfolder: .\ncommand: ./t.sh\nschedule:\n  daily: { at: 7:00 }\n${fields}---\n`);
  if (state === null) throw new Error("not editable");
  return state;
};

describe("the policies in one sentence", () => {
  it("a new script: what the form edits, at the defaults", () => {
    expect(sentence(switchKind(newForm("service"), "script"))).toEqual({ text: "Never overlaps itself · low priority · notifies on failure", customised: false });
    expect(sentence(newForm("service"), SERVICE)).toEqual({ text: "Normal priority · notifies on failure", customised: false });
  });

  it("the person's choices, in bold", () => {
    let state = setValue(switchKind(newForm("service"), "script"), "overlap", "queue");
    expect(sentence(state)).toEqual({ text: "**Queues behind itself** · low priority · notifies on failure", customised: true });
    state = setValue(setValue(setValue(state, "overlap", "parallel"), "lowPriority", false), "notify", "never");
    expect(sentence(state).text).toBe("**May overlap itself** · **normal priority** · **never notifies**");
  });

  it("a missed-run policy and a time limit the file sets: their values, read from the file", () => {
    expect(sentence(script("missed: wait-for-me\noverlap: queue\ntime-limit: 45m\nnotify: always\n"))).toEqual({
      text: "**If missed, wait for me** · **queues behind itself** · low priority · **stops after 45m** · **always notifies**",
      customised: true,
    });
    expect(sentence(script("missed: run-on-wake\nworth-until: 12:00\n")).text).toBe("**If missed, run on wake until 12:00** · never overlaps itself · low priority · notifies on failure");
    // The default written out is no change.
    expect(sentence(script("missed: run-on-wake\nworth-until: next-run\n"))).toEqual({ text: "If missed, run on wake · never overlaps itself · low priority · notifies on failure", customised: false });
    expect(sentence(script("time-limit:\n")).text).toBe("Never overlaps itself · low priority · notifies on failure");
  });

  it("the rows of the policies shown from the file", () => {
    expect(fileMissed(script("missed: wait-for-me\n"))).toMatchObject({ label: "Wait for me", isDefault: false });
    expect(fileMissed(script("worth-until: 12:00\n"))).toMatchObject({ label: "Run on wake, until 12:00", policy: "run-on-wake" });
    expect(fileMissed(script("missed: sometimes\n"))).toMatchObject({ label: "sometimes", words: "if missed: sometimes", policy: null });
    expect(fileMissed(script(""))).toBeNull();
    expect(fileLimit(script("time-limit: 1h30m\n"))).toBe("1h30m");
    expect(fileLimit(script(""))).toBeNull();
  });
});

describe("switching kind between Service and Script", () => {
  it("keeps what the person set and resets the defaults they left alone, both ways", () => {
    let state = setValue(setValue(newForm("service"), "name", "Ping"), "command", "./ping.sh");
    state = switchKind(state, "script");
    expect(state.values).toMatchObject({ kind: "script", name: "Ping", command: "./ping.sh", lowPriority: true, overlap: "skip", notify: "on-failure", trigger: "schedule" });
    state = setValue(setValue(state, "schedule", { ...state.values.schedule, shape: "weekly", days: ["sat"] }), "overlap", "queue");
    state = switchKind(state, "service");
    expect(state.values).toMatchObject({ kind: "service", lowPriority: false, overlap: "queue" });
    // Back to Script: the schedule and the overlap the person set are there again.
    state = switchKind(state, "script");
    expect(state.values).toMatchObject({ lowPriority: true, overlap: "queue", schedule: { shape: "weekly", days: ["sat"] } });
    // A low priority the person set stays across the switch.
    expect(switchKind(setValue(state, "lowPriority", false), "service").values.lowPriority).toBe(false);
  });
});
