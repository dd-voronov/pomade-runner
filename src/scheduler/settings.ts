// Runner's workspace settings (docs/ARCHITECTURE.md "Settings"): one plain YAML file,
// `<workspace>/Apps/pomade-runner/settings.yaml`, synced with the workspace like the job files. A
// missing file, or a field left out, means its default. The file is checked the way job files are —
// every problem names its field, its line and the fix — and a field with a problem counts as its
// default until it is fixed. The form writes one field at a time and leaves every other byte, comments
// included. Pure: the scheduler, the `pomade-runner` command and the UI share it.

import { getKeyLines, setField, type FieldWriteResult } from "pomade-kit/frontmatter";

import { readYamlDocument } from "../jobs/document";
import type { JobError } from "../jobs/model";
import { closest } from "../jobs/parse";

/** The settings file, workspace-relative. */
export const SETTINGS_PATH = "Apps/pomade-runner/settings.yaml";

export interface Settings {
  /** At most this many low-priority runs go at once; the rest wait queued. */
  maxLowPriorityRuns: number;
  /** After login or wake, caught-up runs wait this long once the services are up. */
  warmUpMinutes: number;
  /** A run going this long becomes a "still expected?" Needs-you item. */
  longRunWarningMinutes: number;
  /** Run history and output logs are kept this many days. */
  historyDays: number;
  /** Where Runner keeps its agent skill: a folder inside the workspace, workspace-relative. */
  skillsFolder: string;
}

export const DEFAULT_SKILLS_FOLDER = "Knowledge/_skills/apps/";

export const DEFAULT_SETTINGS: Settings = { maxLowPriorityRuns: 2, warmUpMinutes: 2, longRunWarningMinutes: 180, historyDays: 30, skillsFolder: DEFAULT_SKILLS_FOLDER };

/** The settings that hold a number. */
type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

/** How a number field is written: a whole number of something, or a duration (`2m`, `3h`, `1h30m`). */
interface NumberSpec {
  key: NumberKey;
  kind: "count" | "duration";
  min: number;
  max: number;
  /** A count's unit in words. */
  unit: string;
  example: string;
}

/** How a path field is written: a folder inside the workspace, relative to its root. */
interface PathSpec {
  key: "skillsFolder";
  kind: "path";
  example: string;
}

type FieldSpec = NumberSpec | PathSpec;

/** The fields of the file, in the order the form shows them. Durations' bounds are minutes. */
export const SETTINGS_FIELDS = {
  "max-low-priority-runs": { key: "maxLowPriorityRuns", kind: "count", min: 1, max: 16, unit: "runs", example: "2" },
  "warm-up": { key: "warmUpMinutes", kind: "duration", min: 0, max: 60, unit: "", example: "2m" },
  "long-run-warning": { key: "longRunWarningMinutes", kind: "duration", min: 1, max: 24 * 60, unit: "", example: "3h" },
  "history-days": { key: "historyDays", kind: "count", min: 1, max: 365, unit: "days", example: "30" },
  "skills-folder": { key: "skillsFolder", kind: "path", example: DEFAULT_SKILLS_FOLDER },
} as const satisfies Record<string, FieldSpec>;

export type SettingsField = keyof typeof SETTINGS_FIELDS;
/** The fields that hold a number: the form's steppers. */
export type NumberSettingsField = { [K in SettingsField]: (typeof SETTINGS_FIELDS)[K]["kind"] extends "path" ? never : K }[SettingsField];
const FIELD_NAMES = Object.keys(SETTINGS_FIELDS) as SettingsField[];

export function isSettingsField(value: string): value is SettingsField {
  return Object.hasOwn(SETTINGS_FIELDS, value);
}

/** The settings as the scheduler holds them, for the UI and the command. */
export interface SettingsReport {
  /** The file, workspace-relative. */
  path: string;
  /** Whether the file exists; without it every setting is its default. */
  exists: boolean;
  /** What applies: each field's value, or its default when it is left out or has a problem. */
  settings: Settings;
  /** Every problem of the file. */
  errors: JobError[];
}

/** The answer to writing a setting: the settings after, or why it was refused. */
export type SettingsWriteResult = { ok: true; settings: SettingsReport } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shape check a caller runs on a settings report before trusting it. */
export function isSettingsReport(value: unknown): value is SettingsReport {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.exists !== "boolean" || !Array.isArray(value.errors) || !isRecord(value.settings)) return false;
  const { settings } = value;
  return (
    Object.values(SETTINGS_FIELDS).every((spec: FieldSpec) => typeof settings[spec.key] === (spec.kind === "path" ? "string" : "number")) &&
    value.errors.every((error: unknown) => isRecord(error) && typeof error.path === "string" && typeof error.line === "number" && typeof error.field === "string" && typeof error.problem === "string" && typeof error.fix === "string")
  );
}

export function isSettingsWriteResult(value: unknown): value is SettingsWriteResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.reason === "string";
  return value.ok === true && isSettingsReport(value.settings);
}

/** A duration in minutes — `0m`, `2m`, `3h`, `1h30m` — or `null` when it is not one. */
export function parseMinutes(text: string): number | null {
  const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/.exec(text.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/** Minutes as the file writes them: `2m`, `3h`, `1h30m`. */
export function minutesText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

const show = (value: unknown): string => (value === null || value === undefined ? "empty" : JSON.stringify(value));

/** A folder inside the workspace as the file writes it: relative, never leaving the root. `null`
 *  when `text` is not one. */
export function workspaceFolder(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.includes("\\")) return null;
  let depth = 0;
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    depth += part === ".." ? -1 : 1;
    if (depth < 0) return null;
  }
  return trimmed;
}

/** A field's value, or its problem and fix. */
function readField(name: SettingsField, value: unknown): { ok: true; value: number | string } | { ok: false; problem: string; fix: string } {
  const spec: FieldSpec = SETTINGS_FIELDS[name];
  if (spec.kind === "path") {
    const fix = `write a folder relative to the workspace root, e.g. ${name}: ${spec.example}`;
    if (typeof value !== "string") return { ok: false, problem: `${show(value)} is not a folder`, fix };
    const folder = workspaceFolder(value);
    if (folder === null) return { ok: false, problem: value.trim() === "" ? "the folder is empty" : `${value} is not inside the workspace`, fix };
    return { ok: true, value: folder };
  }
  if (spec.kind === "count") {
    const fix = `write a whole number from ${spec.min} to ${spec.max}, e.g. ${name}: ${spec.example}`;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return { ok: false, problem: `${show(value)} is not a whole number`, fix };
    if (value < spec.min || value > spec.max) return { ok: false, problem: `${value} ${spec.unit} is out of range`, fix };
    return { ok: true, value };
  }
  const bounds = `from ${minutesText(spec.min)} to ${minutesText(spec.max)}`;
  if (typeof value === "number") return { ok: false, problem: `${value} has no unit`, fix: `add one: ${name}: ${value}m (minutes) or ${value}h (hours)` };
  const minutes = typeof value === "string" ? parseMinutes(value) : null;
  if (minutes === null) return { ok: false, problem: `${show(value)} is not a duration`, fix: `write minutes or hours ${bounds}, e.g. ${name}: ${spec.example}` };
  if (minutes < spec.min || minutes > spec.max) return { ok: false, problem: `${minutesText(minutes)} is out of range`, fix: `write a duration ${bounds}, e.g. ${name}: ${spec.example}` };
  return { ok: true, value: minutes };
}

/** Check the settings file's text; `null` is a file that does not exist. */
export function checkSettings(text: string | null, path: string = SETTINGS_PATH): SettingsReport {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (text === null) return { path, exists: false, settings, errors: [] };
  const read = readYamlDocument(text);
  if (!read.ok) return { path, exists: true, settings, errors: [{ path, line: read.line, field: "", problem: read.problem, fix: read.fix }] };
  const { doc } = read;
  const errors: JobError[] = [];
  for (const [name, value] of Object.entries(doc.fields)) {
    const line = doc.line([name]);
    if (!isSettingsField(name)) {
      const guess = closest(name, FIELD_NAMES);
      errors.push({ path, line, field: name, problem: `${name} is not a setting`, fix: guess ? `rename it to ${guess}` : `remove it — the settings are ${FIELD_NAMES.join(", ")}` });
      continue;
    }
    // An empty field (`warm-up:`) means its default.
    if (value === null) continue;
    const field = readField(name, value);
    if (field.ok) Object.assign(settings, { [SETTINGS_FIELDS[name].key]: field.value });
    else errors.push({ path, line, field: name, problem: field.problem, fix: field.fix });
  }
  return { path, exists: true, settings, errors: errors.sort((a, b) => a.line - b.line) };
}

/** What the form writes for a field: its value as the file holds it — a count, a duration in
 *  minutes, a folder — or `null` to remove it, so the default applies. */
export type SettingsValue = number | string | null;

/** Why `value` cannot be written to `name`; `null` when it can. */
export function settingsValueProblem(name: SettingsField, value: SettingsValue): string | null {
  if (value === null) return null;
  const spec: FieldSpec = SETTINGS_FIELDS[name];
  if (spec.kind === "duration" && typeof value === "string") return `${name}: ${show(value)} is not a number of minutes — the form writes a duration as minutes, e.g. 120 for 2h`;
  const asFile = spec.kind === "duration" && typeof value === "number" ? (Number.isSafeInteger(value) && value >= 0 ? minutesText(value) : String(value)) : value;
  const field = readField(name, asFile);
  return field.ok ? null : `${name}: ${field.problem} — ${field.fix}`;
}

/** Write one field into the settings file's text (`""` for a file that does not exist yet), leaving
 *  every other byte as it is; `null` removes the field. A file that is not readable YAML is refused,
 *  never rewritten. */
export function setSettingsField(text: string, name: SettingsField, value: SettingsValue): FieldWriteResult {
  const crlf = text.includes("\r\n");
  const lf = text.replace(/\r\n/g, "\n");
  const read = readYamlDocument(lf);
  if (!read.ok) return { ok: false, reason: "unreadable-frontmatter", message: `line ${read.line}: ${read.problem}` };
  const yaml = lf === "" || lf.endsWith("\n") ? lf : `${lf}\n`;
  let next: string;
  if (value === null) {
    if (!Object.hasOwn(read.doc.fields, name)) return { ok: true, text, changed: false };
    next = yaml.replace(`${getKeyLines(`---\n${yaml}---\n`, name)}\n`, "");
  } else {
    // The YAML is written as a frontmatter block, the one shape the field writer edits in place.
    const spec: FieldSpec = SETTINGS_FIELDS[name];
    const written = spec.kind === "duration" && typeof value === "number" ? minutesText(value) : typeof value === "string" ? value.trim() : value;
    const result = setField(yaml.trim() === "" ? "" : `---\n${yaml}---\n`, name, written);
    if (!result.ok) return result;
    next = result.text.slice(4, result.text.indexOf("\n---\n", 3) + 1);
    if (yaml.trim() === "") next = yaml + next;
  }
  if (crlf) next = next.replace(/\n/g, "\r\n");
  return { ok: true, text: next, changed: next !== text };
}
