// The settings file on disk, for the scheduler: read on every tick — so an edit by hand, by an agent
// or by the form applies within a second, with Pomade open or closed — and written one field at a
// time for the form.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { formatJobError } from "../jobs/format";
import { replaceFile } from "../jobs/folder";
import type { Log } from "./log";
import { checkSettings, settingsValueProblem, setSettingsField, SETTINGS_PATH, type SettingsField, type SettingsReport, type SettingsValue, type SettingsWriteResult } from "./settings";

/** The settings file's text in a workspace; `null` when it does not exist. */
export async function readSettingsText(workspace: string): Promise<string | null> {
  try {
    return await readFile(join(workspace, SETTINGS_PATH), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw err;
  }
}

export interface SettingsFile {
  /** The settings as last read: every default before the first read, and without a workspace. */
  report(): SettingsReport;
  /** Read the file again; `onChange` when what it says changed. */
  refresh(): Promise<void>;
  /** Write one field, field-only: the rest of the file stays byte for byte. */
  write(field: SettingsField, value: SettingsValue): Promise<SettingsWriteResult>;
}

export function settingsFile(options: { workspace(): string | null; log: Log; onChange(report: SettingsReport): void }): SettingsFile {
  let report = checkSettings(null);
  let shown = JSON.stringify(report);
  let reading: Promise<void> | null = null;

  async function read(): Promise<void> {
    const workspace = options.workspace();
    let text: string | null = null;
    if (workspace !== null) {
      try {
        text = await readSettingsText(workspace);
      } catch (err) {
        options.log(`settings: cannot read ${SETTINGS_PATH}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const next = checkSettings(text);
    const json = JSON.stringify(next);
    if (json === shown) return;
    report = next;
    shown = json;
    const { settings } = next;
    options.log(
      `settings: ${next.exists ? SETTINGS_PATH : "defaults"} — max low-priority runs ${settings.maxLowPriorityRuns}, warm-up ${settings.warmUpMinutes} min, long-run warning ${settings.longRunWarningMinutes} min, history ${settings.historyDays} days`,
    );
    for (const error of next.errors) options.log(`settings: ${formatJobError(error)}`);
    options.onChange(next);
  }

  function refresh(): Promise<void> {
    reading ??= read().finally(() => {
      reading = null;
    });
    return reading;
  }

  return {
    report: () => report,
    refresh,
    async write(field, value) {
      const workspace = options.workspace();
      if (workspace === null) return { ok: false, reason: "no workspace is known" };
      const problem = settingsValueProblem(field, value);
      if (problem !== null) return { ok: false, reason: problem };
      try {
        const text = (await readSettingsText(workspace)) ?? "";
        const result = setSettingsField(text, field, value);
        if (!result.ok) return { ok: false, reason: `${SETTINGS_PATH} ${result.message}; fix it first` };
        if (result.changed) await replaceFile(join(workspace, SETTINGS_PATH), result.text);
      } catch (err) {
        return { ok: false, reason: `cannot write ${SETTINGS_PATH}: ${err instanceof Error ? err.message : String(err)}` };
      }
      options.log(`settings: ${field} set to ${value === null ? "its default" : String(value)}`);
      // A read under way may have started before the write: read once more after it.
      if (reading !== null) await reading;
      await refresh();
      return { ok: true, settings: report };
    },
  };
}
