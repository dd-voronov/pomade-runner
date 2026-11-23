import { describe, expect, it } from "vitest";

import { formatJobError } from "../jobs/format";
import { checkSettings, DEFAULT_SETTINGS, minutesText, parseMinutes, settingsValueProblem, setSettingsField, SETTINGS_PATH } from "./settings";

const problems = (text: string): string[] => checkSettings(text).errors.map((error) => formatJobError(error));

describe("settings file", () => {
  it("is every default when the file is missing, empty or comments only", () => {
    expect(checkSettings(null)).toEqual({ path: SETTINGS_PATH, exists: false, settings: DEFAULT_SETTINGS, errors: [] });
    for (const text of ["", "\n", "# Runner's settings\n"]) expect(checkSettings(text)).toEqual({ path: SETTINGS_PATH, exists: true, settings: DEFAULT_SETTINGS, errors: [] });
    expect(DEFAULT_SETTINGS).toEqual({ maxLowPriorityRuns: 2, warmUpMinutes: 2, longRunWarningMinutes: 180, historyDays: 30, skillsFolder: "Knowledge/_skills/apps/" });
  });

  it("reads every field; an empty one is its default", () => {
    const text = "max-low-priority-runs: 3\nwarm-up: 0m\nlong-run-warning: 1h30m # a comment\nhistory-days: 7\n";
    expect(checkSettings(text).settings).toEqual({ ...DEFAULT_SETTINGS, maxLowPriorityRuns: 3, warmUpMinutes: 0, longRunWarningMinutes: 90, historyDays: 7 });
    expect(checkSettings("warm-up:\nlong-run-warning: 1m\n").settings).toEqual({ ...DEFAULT_SETTINGS, longRunWarningMinutes: 1 });
    expect(checkSettings("max-low-priority-runs: 2\r\nwarm-up: 5m\r\n").settings).toEqual({ ...DEFAULT_SETTINGS, warmUpMinutes: 5 });
  });

  it("names the line, the field and the fix of every problem; a field with one counts as its default", () => {
    const text = "# settings\nmax-low-priority-runs: two\nwarm-up: 2\nlong-run-warning: 25h\nhistory-days: 0\nwarmup: 1m\nkeep: 30\n";
    expect(problems(text)).toEqual([
      'Apps/pomade-runner/settings.yaml:2: max-low-priority-runs — "two" is not a whole number. Fix: write a whole number from 1 to 16, e.g. max-low-priority-runs: 2.',
      "Apps/pomade-runner/settings.yaml:3: warm-up — 2 has no unit. Fix: add one: warm-up: 2m (minutes) or 2h (hours).",
      "Apps/pomade-runner/settings.yaml:4: long-run-warning — 25h is out of range. Fix: write a duration from 1m to 24h, e.g. long-run-warning: 3h.",
      "Apps/pomade-runner/settings.yaml:5: history-days — 0 days is out of range. Fix: write a whole number from 1 to 365, e.g. history-days: 30.",
      "Apps/pomade-runner/settings.yaml:6: warmup — warmup is not a setting. Fix: rename it to warm-up.",
      "Apps/pomade-runner/settings.yaml:7: keep — keep is not a setting. Fix: remove it — the settings are max-low-priority-runs, warm-up, long-run-warning, history-days, skills-folder.",
    ]);
    expect(checkSettings(text).settings).toEqual(DEFAULT_SETTINGS);
    expect(problems("max-low-priority-runs: 2.5\nwarm-up: soon\nlong-run-warning: 0m\n")).toEqual([
      "Apps/pomade-runner/settings.yaml:1: max-low-priority-runs — 2.5 is not a whole number. Fix: write a whole number from 1 to 16, e.g. max-low-priority-runs: 2.",
      'Apps/pomade-runner/settings.yaml:2: warm-up — "soon" is not a duration. Fix: write minutes or hours from 0m to 1h, e.g. warm-up: 2m.',
      "Apps/pomade-runner/settings.yaml:3: long-run-warning — 0m is out of range. Fix: write a duration from 1m to 24h, e.g. long-run-warning: 3h.",
    ]);
  });

  it("reads the skills folder: a folder inside the workspace, relative to its root", () => {
    for (const folder of ["Knowledge/_skills/apps/", "skills", "Apps/pomade-runner/skills-test/", "./a/b", "a/../b", "a/b/../../c"]) {
      expect(checkSettings(`skills-folder: ${folder}\n`)).toMatchObject({ settings: { skillsFolder: folder }, errors: [] });
    }
    expect(checkSettings('skills-folder: "  My skills/ "\n').settings.skillsFolder).toBe("My skills/");
    expect(checkSettings("skills-folder:\n").settings.skillsFolder).toBe("Knowledge/_skills/apps/");
    const fix = "Fix: write a folder relative to the workspace root, e.g. skills-folder: Knowledge/_skills/apps/.";
    expect(problems('skills-folder: /Users/me/skills\nwarm-up: 1m\n')).toEqual([`Apps/pomade-runner/settings.yaml:1: skills-folder — /Users/me/skills is not inside the workspace. ${fix}`]);
    expect(problems("skills-folder: ../skills\n")).toEqual([`Apps/pomade-runner/settings.yaml:1: skills-folder — ../skills is not inside the workspace. ${fix}`]);
    expect(problems("skills-folder: a/../../skills\n")).toEqual([`Apps/pomade-runner/settings.yaml:1: skills-folder — a/../../skills is not inside the workspace. ${fix}`]);
    expect(problems("skills-folder: ~/skills\n")).toEqual([`Apps/pomade-runner/settings.yaml:1: skills-folder — ~/skills is not inside the workspace. ${fix}`]);
    expect(problems('skills-folder: ""\n')).toEqual([`Apps/pomade-runner/settings.yaml:1: skills-folder — the folder is empty. ${fix}`]);
    expect(problems("skills-folder: 5\n")).toEqual([`Apps/pomade-runner/settings.yaml:1: skills-folder — 5 is not a folder. ${fix}`]);
    expect(problems("skills-folder: [a]\n")).toEqual([`Apps/pomade-runner/settings.yaml:1: skills-folder — ["a"] is not a folder. ${fix}`]);
    expect(checkSettings("skills-folder: ../skills\n").settings.skillsFolder).toBe("Knowledge/_skills/apps/");
    expect(problems("skill-folder: skills\n")).toEqual(["Apps/pomade-runner/settings.yaml:1: skill-folder — skill-folder is not a setting. Fix: rename it to skills-folder."]);
  });

  it("names what is wrong with a file that is not a mapping", () => {
    expect(problems("warm-up: 2m\nwarm-up: 3m\n")).toEqual(["Apps/pomade-runner/settings.yaml:2: this field appears twice. Fix: keep one of the two lines."]);
    expect(problems("- 2m\n")).toEqual(["Apps/pomade-runner/settings.yaml:1: the file is not a mapping of fields. Fix: write each field as a `name: value` line."]);
    expect(problems("warm-up: 2m\n---\nhistory-days: 3\n")).toEqual([
      "Apps/pomade-runner/settings.yaml:2: a --- line starts another YAML document. Fix: remove the --- line: the file is one mapping of `name: value` lines.",
    ]);
    expect(problems("warm-up: [2m\n")[0]).toMatch(/^Apps\/pomade-runner\/settings\.yaml:\d+: the file is not valid YAML: /);
    expect(checkSettings("warm-up: [2m\n").settings).toEqual(DEFAULT_SETTINGS);
  });

  it("reads and writes durations", () => {
    expect([parseMinutes("0m"), parseMinutes("45m"), parseMinutes("2h"), parseMinutes("1h30m"), parseMinutes("1h 5m"), parseMinutes("5"), parseMinutes("m"), parseMinutes("")]).toEqual([0, 45, 120, 90, 65, null, null, null]);
    expect([minutesText(0), minutesText(45), minutesText(120), minutesText(90)]).toEqual(["0m", "45m", "2h", "1h30m"]);
  });

  it("checks a value the form writes", () => {
    expect(settingsValueProblem("max-low-priority-runs", 4)).toBeNull();
    expect(settingsValueProblem("warm-up", 0)).toBeNull();
    expect(settingsValueProblem("history-days", null)).toBeNull();
    expect(settingsValueProblem("max-low-priority-runs", 17)).toBe("max-low-priority-runs: 17 runs is out of range — write a whole number from 1 to 16, e.g. max-low-priority-runs: 2");
    expect(settingsValueProblem("long-run-warning", 0)).toBe("long-run-warning: 0m is out of range — write a duration from 1m to 24h, e.g. long-run-warning: 3h");
    expect(settingsValueProblem("warm-up", 1.5)).toBe('warm-up: "1.5" is not a duration — write minutes or hours from 0m to 1h, e.g. warm-up: 2m');
    expect(settingsValueProblem("skills-folder", "Apps/pomade-runner/skills-test/")).toBeNull();
    expect(settingsValueProblem("skills-folder", null)).toBeNull();
    expect(settingsValueProblem("skills-folder", "../outside/")).toBe("skills-folder: ../outside/ is not inside the workspace — write a folder relative to the workspace root, e.g. skills-folder: Knowledge/_skills/apps/");
    expect(settingsValueProblem("skills-folder", 3)).toBe("skills-folder: 3 is not a folder — write a folder relative to the workspace root, e.g. skills-folder: Knowledge/_skills/apps/");
    expect(settingsValueProblem("warm-up", "2m")).toBe('warm-up: "2m" is not a number of minutes — the form writes a duration as minutes, e.g. 120 for 2h');
    expect(settingsValueProblem("history-days", "30")).toBe('history-days: "30" is not a whole number — write a whole number from 1 to 365, e.g. history-days: 30');
  });
});

describe("writing one setting", () => {
  const write = (text: string, ...change: Parameters<typeof setSettingsField> extends [string, ...infer R] ? R : never): string => {
    const result = setSettingsField(text, ...change);
    if (!result.ok) throw new Error(result.message);
    return result.text;
  };

  it("creates the field in a new or empty file", () => {
    expect(write("", "warm-up", 5)).toBe("warm-up: 5m\n");
    expect(write("# Runner\n", "max-low-priority-runs", 3)).toBe("# Runner\nmax-low-priority-runs: 3\n");
    expect(write("\n", "history-days", 14)).toBe("\nhistory-days: 14\n");
  });

  it("changes only the field's own line; comments, order and other fields stay byte for byte", () => {
    const text = "# Runner's settings\nwarm-up: 2m   # after login\n\nmax-low-priority-runs: 2\nhistory-days: 30\n";
    expect(write(text, "max-low-priority-runs", 4)).toBe("# Runner's settings\nwarm-up: 2m   # after login\n\nmax-low-priority-runs: 4\nhistory-days: 30\n");
    expect(write(text, "long-run-warning", 90)).toBe(`${text}long-run-warning: 1h30m\n`);
    expect(write("warm-up: 2m", "history-days", 7)).toBe("warm-up: 2m\nhistory-days: 7\n");
    expect(write("warm-up: 2m\r\nhistory-days: 30\r\n", "history-days", 7)).toBe("warm-up: 2m\r\nhistory-days: 7\r\n");
  });

  it("removes a field for its default, comments kept", () => {
    expect(write("# keep me\nwarm-up: 5m\nhistory-days: 30\n", "warm-up", null)).toBe("# keep me\nhistory-days: 30\n");
    expect(write("# keep me\nwarm-up: 5m\n", "warm-up", null)).toBe("# keep me\n");
    expect(setSettingsField("history-days: 30\n", "warm-up", null)).toEqual({ ok: true, text: "history-days: 30\n", changed: false });
  });

  it("writes the skills folder as a path, trimmed", () => {
    expect(write("# mine\nwarm-up: 2m\n", "skills-folder", " Apps/pomade-runner/skills-test/ ")).toBe("# mine\nwarm-up: 2m\nskills-folder: Apps/pomade-runner/skills-test/\n");
    expect(write("skills-folder: a/\nwarm-up: 2m\n", "skills-folder", "My skills/")).toBe("skills-folder: My skills/\nwarm-up: 2m\n");
    expect(checkSettings(write("", "skills-folder", "My skills/")).settings.skillsFolder).toBe("My skills/");
    expect(write("skills-folder: a/\n", "skills-folder", null)).toBe("");
  });

  it("refuses a file it cannot read, rather than rewrite it", () => {
    expect(setSettingsField("warm-up: [2m\n", "warm-up", 3)).toMatchObject({ ok: false, reason: "unreadable-frontmatter" });
    expect(setSettingsField("a: 1\n---\n", "warm-up", 3)).toEqual({ ok: false, reason: "unreadable-frontmatter", message: "line 2: a --- line starts another YAML document" });
  });
});
