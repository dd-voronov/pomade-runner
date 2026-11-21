// The settings file on disk and the switch's file, on temp folders: read, followed, written one
// field at a time, and what a broken or missing file means.

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordsFolderOf, switchRecordPath } from "../locations";
import type { SettingsReport } from "./settings";
import { DEFAULT_SETTINGS, SETTINGS_PATH } from "./settings";
import { readSettingsText, settingsFile } from "./settings-file";
import { fileSwitchStore } from "./switch";

describe("the settings file", () => {
  let dir: string;
  let workspace: string | null;
  let lines: string[];
  let changes: SettingsReport[];

  const file = (): string => join(dir, SETTINGS_PATH);
  const open = () => settingsFile({ workspace: () => workspace, log: (line) => lines.push(line), onChange: (report) => changes.push(report) });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prs-"));
    workspace = dir;
    lines = [];
    changes = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is every default without a file or a workspace, and follows the file as it changes", async () => {
    const settings = open();
    expect(settings.report()).toEqual({ path: SETTINGS_PATH, exists: false, settings: DEFAULT_SETTINGS, errors: [] });
    await settings.refresh();
    expect(changes).toEqual([]);
    await mkdir(join(dir, "Apps/pomade-runner"), { recursive: true });
    await writeFile(file(), "max-low-priority-runs: 3\nwarm-up: soon\n");
    await settings.refresh();
    expect(settings.report()).toMatchObject({ exists: true, settings: { ...DEFAULT_SETTINGS, maxLowPriorityRuns: 3 }, errors: [{ line: 2, field: "warm-up" }] });
    expect(changes).toHaveLength(1);
    expect(lines).toEqual([
      "settings: Apps/pomade-runner/settings.yaml — max low-priority runs 3, warm-up 2 min, long-run warning 180 min, history 30 days",
      'settings: Apps/pomade-runner/settings.yaml:2: warm-up — "soon" is not a duration. Fix: write minutes or hours from 0m to 1h, e.g. warm-up: 2m.',
    ]);
    await settings.refresh();
    expect(changes).toHaveLength(1);
    workspace = null;
    await settings.refresh();
    expect(settings.report().exists).toBe(false);
    expect(await readSettingsText(join(dir, "nowhere"))).toBeNull();
  });

  it("writes one field, field-only, creating the file and its folder when missing", async () => {
    const settings = open();
    expect(await settings.write("warm-up", 5)).toMatchObject({ ok: true, settings: { exists: true, settings: { ...DEFAULT_SETTINGS, warmUpMinutes: 5 } } });
    expect(await readFile(file(), "utf8")).toBe("warm-up: 5m\n");
    await writeFile(file(), "# mine\nwarm-up: 5m # after login\nhistory-days: 30\n");
    expect(await settings.write("history-days", 14)).toMatchObject({ ok: true, settings: { settings: { historyDays: 14 } } });
    expect(await readFile(file(), "utf8")).toBe("# mine\nwarm-up: 5m # after login\nhistory-days: 14\n");
    expect(await settings.write("warm-up", null)).toMatchObject({ ok: true, settings: { settings: { warmUpMinutes: 2 } } });
    expect(await readFile(file(), "utf8")).toBe("# mine\nhistory-days: 14\n");
    expect(lines).toContain("settings: history-days set to 14");
  });

  it("writes through a link to its target", async () => {
    await mkdir(join(dir, "Apps/pomade-runner"), { recursive: true });
    await writeFile(join(dir, "real.yaml"), "history-days: 30\n");
    await symlink(join(dir, "real.yaml"), file());
    expect((await open().write("history-days", 9)).ok).toBe(true);
    expect(await readFile(join(dir, "real.yaml"), "utf8")).toBe("history-days: 9\n");
  });

  it("refuses a value out of range, a file it cannot read, and no workspace", async () => {
    const settings = open();
    expect(await settings.write("max-low-priority-runs", 0)).toEqual({ ok: false, reason: "max-low-priority-runs: 0 runs is out of range — write a whole number from 1 to 16, e.g. max-low-priority-runs: 2" });
    await mkdir(join(dir, "Apps/pomade-runner"), { recursive: true });
    await writeFile(file(), "warm-up: [2m\n");
    expect(await settings.write("warm-up", 3)).toMatchObject({ ok: false, reason: expect.stringMatching(/^Apps\/pomade-runner\/settings\.yaml line \d+: the file is not valid YAML: .*; fix it first$/) as string });
    expect(await readFile(file(), "utf8")).toBe("warm-up: [2m\n");
    workspace = null;
    expect(await settings.write("warm-up", 3)).toEqual({ ok: false, reason: "no workspace is known" });
  });
});

describe("the switch's file", () => {
  let dir: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prw-"));
    lines = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the position in the records folder; a missing or broken file is Running", async () => {
    const store = fileSwitchStore(recordsFolderOf(dir), (line) => lines.push(line));
    expect(await store.load()).toEqual({ position: "running", since: null });
    store.save({ position: "pause-low", since: 5 });
    await store.flush();
    expect(await fileSwitchStore(recordsFolderOf(dir), () => undefined).load()).toEqual({ position: "pause-low", since: 5 });
    await writeFile(switchRecordPath(recordsFolderOf(dir)), '{ "position": "nap" }');
    expect(await store.load()).toEqual({ position: "running", since: null });
    expect(lines).toEqual([`switch: ${switchRecordPath(recordsFolderOf(dir))} is not a switch position; Running`]);
    await writeFile(switchRecordPath(recordsFolderOf(dir)), "{ not json");
    expect(await store.load()).toEqual({ position: "running", since: null });
  });
});
