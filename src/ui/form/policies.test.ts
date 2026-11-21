import { describe, expect, it } from "vitest";

import { LOW_PRIORITY_WORDS, MISSED_WORDS, NOTIFY_WORDS, OVERLAP_WORDS, policySentence, TIME_LIMIT_WORDS } from "./policies";
import { blankValues, editForm, newForm, setValue, switchKind, type FormState } from "./state";

const SCRIPT = [MISSED_WORDS, OVERLAP_WORDS, LOW_PRIORITY_WORDS, TIME_LIMIT_WORDS, NOTIFY_WORDS];
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
    expect(sentence(switchKind(newForm("service"), "script"))).toEqual({ text: "If missed, run on wake · never overlaps itself · low priority · no time limit · notifies on failure", customised: false });
    expect(sentence(newForm("service"), SERVICE)).toEqual({ text: "Normal priority · notifies on failure", customised: false });
  });

  it("the person's choices, in bold", () => {
    let state = setValue(switchKind(newForm("service"), "script"), "overlap", "queue");
    expect(sentence(state)).toEqual({ text: "If missed, run on wake · **queues behind itself** · low priority · no time limit · notifies on failure", customised: true });
    state = setValue(setValue(setValue(state, "overlap", "parallel"), "lowPriority", false), "notify", "never");
    expect(sentence(state).text).toBe("If missed, run on wake · **may overlap itself** · **normal priority** · no time limit · **never notifies**");
  });

  it("a missed-run policy, until when it is worth it, and a time limit", () => {
    let state = switchKind(newForm("service"), "script");
    state = setValue(state, "missed", "wait-for-me");
    expect(sentence(state).text).toBe("**If missed, wait for me** · never overlaps itself · low priority · no time limit · notifies on failure");
    expect(sentence(setValue(state, "missed", "skip")).text).toContain("**If missed, skip**");
    // Until a time of day is a change from the default, until the next run is not.
    state = setValue(setValue(state, "missed", "run-on-wake"), "worth", "time");
    expect(sentence(state).text).toMatch(/^\*\*If missed, run on wake until 12:00\*\* ·/);
    expect(sentence(setValue(state, "worthAt", " 7:30 ")).text).toMatch(/^\*\*If missed, run on wake until 7:30\*\*/);
    expect(sentence(setValue(state, "worth", "next-run")).text).toMatch(/^If missed, run on wake ·/);
    state = setValue(setValue(state, "worth", "next-run"), "timeLimit", "45m");
    expect(sentence(state)).toMatchObject({ text: expect.stringContaining("**stops after 45m**") as unknown as string, customised: true });
    expect(sentence(setValue(state, "timeLimit", "  ")).text).toContain("no time limit");
  });

  it("what a file sets, read into the form's values, says the same words", () => {
    expect(sentence(script("missed: wait-for-me\noverlap: queue\ntime-limit: 45m\nnotify: always\n"))).toEqual({
      text: "**If missed, wait for me** · **queues behind itself** · low priority · **stops after 45m** · **always notifies**",
      customised: true,
    });
    expect(sentence(script("missed: run-on-wake\nworth-until: 12:00\n")).text).toBe("**If missed, run on wake until 12:00** · never overlaps itself · low priority · no time limit · notifies on failure");
    // The default written out is no change.
    expect(sentence(script("missed: run-on-wake\nworth-until: next-run\n"))).toEqual({ text: "If missed, run on wake · never overlaps itself · low priority · no time limit · notifies on failure", customised: false });
    expect(sentence(script("time-limit:\n")).text).toBe("If missed, run on wake · never overlaps itself · low priority · no time limit · notifies on failure");
  });

  it("a hook or a chain has no missed runs: the sentence leaves the policy out", () => {
    const hook = editForm("Apps/pomade-runner/jobs/mount.md", "---\nkind: script\nname: Mount\nfolder: .\ncommand: ./m.sh\nhook: { event: login }\n---\n");
    if (hook === null) throw new Error("not editable");
    expect(sentence(hook).text).toBe("Never overlaps itself · low priority · no time limit · notifies on failure");
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
