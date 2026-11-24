// Writing job files the way the form does: field-only changes on the file's text, so the fields
// nobody touched, comments and the body stay byte for byte (`pomade-kit/frontmatter`), and a new
// file in the right folder under a free slug. Pure: the caller reads and writes the file (through
// the Host API in the UI), and the file on disk stays the truth.

import { removeField, setBody, setComplexKeyLines, setField, setKeyLines, splitFrontmatter, type FieldWriteResult } from "pomade-kit/frontmatter";
import { parse } from "yaml";

import { JOBS_FOLDER } from "./model";
import { SLUG_RE } from "./parse";

/** A value the form writes: a scalar, a list of text and numbers (`days: [1, last]`), or a mapping of
 *  them (`ready: { port: 5173 }`); inside a mapping, `null` leaves the entry out. */
export type FieldInput = string | number | boolean | null | readonly (string | number)[] | { readonly [key: string]: FieldInput };

/** Field changes: a value sets the field, `undefined` removes it. */
export type FieldChanges = Readonly<Record<string, FieldInput | undefined>>;

/** The order a new job file's fields are written in. */
export const FIELD_ORDER = [
  "kind",
  "name",
  "description",
  "project",
  "folder",
  "enabled",
  "command",
  "agent",
  "mode",
  "git",
  "start",
  "start-project",
  "ready",
  "schedule",
  "hook",
  "after",
  "missed",
  "worth-until",
  "overlap",
  "low-priority",
  "time-limit",
  "notify",
] as const;

function isMappingInput(value: FieldInput): value is { readonly [key: string]: FieldInput } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A scalar inside a flow collection, plain when it reads back as itself there. */
function flowScalar(value: string | number | boolean | null): string {
  if (typeof value !== "string") return value === null ? "null" : String(value);
  if (value !== "" && value === value.trim() && !/[,[\]{}#"'\n]|: /.test(value)) {
    try {
      const read: unknown = parse(`[${value}]`);
      if (Array.isArray(read) && read.length === 1 && read[0] === value) return value;
    } catch {
      // Not plain: quoted below.
    }
  }
  return JSON.stringify(value);
}

/** A mapping's entries without the ones set to `null`. */
function entriesOf(value: { readonly [key: string]: FieldInput }): Array<[string, FieldInput]> {
  return Object.entries(value).filter(([, item]) => item !== null);
}

function flowValue(value: FieldInput): string {
  if (Array.isArray(value)) return `[${value.map((item: string | number) => flowScalar(item)).join(", ")}]`;
  if (isMappingInput(value)) {
    const entries = entriesOf(value).map(([key, item]) => `${key}: ${flowValue(item)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return flowScalar(value as string | number | boolean | null);
}

/** The fields always written one entry per line: a schedule, as `pomade-kit/schedule` formats it. */
const BLOCK_FIELDS: readonly string[] = ["schedule"];

/** A mapping field's lines: one flow line, or — when it holds mappings, or is a block field — one
 *  line per entry. */
function mappingLines(key: string, value: { readonly [key: string]: FieldInput }, indent = ""): string[] {
  const nested = Object.values(value).some((item) => isMappingInput(item) && Object.values(item).some(isMappingInput));
  const holdsMappings = Object.values(value).some(isMappingInput) || (indent === "" && BLOCK_FIELDS.includes(key) && entriesOf(value).length > 0);
  if (!holdsMappings || (!nested && Object.keys(value).length === 0)) return [`${indent}${key}: ${flowValue(value)}`];
  const lines = [`${indent}${key}:`];
  for (const [entry, item] of entriesOf(value)) {
    if (isMappingInput(item) && Object.values(item).some(isMappingInput)) lines.push(...mappingLines(entry, item, `${indent}  `));
    else lines.push(`${indent}  ${entry}: ${flowValue(item)}`);
  }
  return lines;
}

/** Raw index in `raw` of LF-normalized index `index` (each CRLF counts as one character). */
function rawIndex(raw: string, index: number): number {
  let r = 0;
  for (let n = 0; n < index; n++) r += raw.startsWith("\r\n", r) ? 2 : 1;
  return r;
}

/** The comment after a field written on one flow line (`ready: { port: 5173 } # vite`), with the
 *  space before it; `""` for none. It follows the `}` that closes the mapping — quoted text and
 *  nested braces skipped. */
function flowLineComment(frontmatter: string, key: string): string {
  const line = frontmatter.split("\n").find((candidate) => candidate.startsWith(`${key}:`));
  const open = line === undefined ? -1 : line.indexOf("{");
  if (line === undefined || open < 0 || line.slice(key.length + 1, open).trim() !== "") return "";
  let depth = 0;
  let quote: string | null = null;
  for (let at = open; at < line.length; at++) {
    const char = line[at];
    if (quote !== null) {
      if (char === "\\" && quote === '"') at++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      const tail = line.slice(at + 1);
      return /^\s+#/.test(tail) ? tail.trimEnd() : "";
    }
  }
  return "";
}

/** Set a mapping field: its lines are replaced (or appended), every other byte stays — and the
 *  comment of a field on one flow line, when it stays on one line. */
function setMappingField(text: string, key: string, value: { readonly [key: string]: FieldInput }): FieldWriteResult {
  const comment = flowLineComment(splitFrontmatter(text.replace(/\r\n/g, "\n")).frontmatter, key);
  // A plain `key:` line first — the kit appends a missing key, or a block to a file with none.
  const placed = setField(text, key, null);
  if (!placed.ok) return placed;
  const lf = placed.text.replace(/\r\n/g, "\n");
  const { frontmatter } = splitFrontmatter(lf);
  const end = rawIndex(placed.text, frontmatter.length);
  const crlf = placed.text.slice(0, end).includes("\r\n");
  const lines = mappingLines(key, value);
  if (lines.length === 1 && comment !== "") lines[0] = `${lines[0] ?? ""}${comment}`;
  const block = setComplexKeyLines(frontmatter, key, lines.join("\n"));
  const next = (crlf ? block.replace(/\n/g, "\r\n") : block) + placed.text.slice(end);
  return { ok: true, text: next, changed: next !== text };
}

/** A text of several lines as a literal block (`description: |-` over its lines, each indented — an
 *  empty one too, so the field's lines stay one span for the frontmatter writer), when that reads back
 *  as exactly the text; `null` when it does not (a text ending in a line break, one whose first line
 *  starts with a space), and the field is written double-quoted on one line instead. */
function literalLines(key: string, value: string): string | null {
  const lines = [`${key}: |-`, ...value.split("\n").map((line) => `  ${line}`)].join("\n");
  try {
    const read: unknown = parse(lines, { schema: "core" });
    return typeof read === "object" && read !== null && (read as Record<string, unknown>)[key] === value ? lines : null;
  } catch {
    return null;
  }
}

/** Apply field changes to a job file's text, in the order given. */
export function setJobFields(text: string, changes: FieldChanges): FieldWriteResult {
  let current = text;
  for (const [key, value] of Object.entries(changes)) {
    let result: FieldWriteResult;
    if (value === undefined) result = removeField(current, key);
    else if (isMappingInput(value)) result = setMappingField(current, key, value);
    else if (typeof value === "string" && /[\r\n]/.test(value)) {
      const lines = literalLines(key, value);
      result = lines === null ? setField(current, key, value) : setKeyLines(current, key, lines);
    }
    // A top-level list is a list of text in the frontmatter writer; numbers go in nested ones.
    else result = setField(current, key, Array.isArray(value) ? value.map(String) : (value as string | number | boolean | null));
    if (!result.ok) return result;
    current = result.text;
  }
  return { ok: true, text: current, changed: current !== text };
}

/** A new job file's text: the fields in `FIELD_ORDER` (others after them), then the body. */
export function newJobText(fields: Readonly<Record<string, FieldInput>>, body: string): string {
  const known: readonly string[] = FIELD_ORDER;
  const ordered: Record<string, FieldInput> = {};
  for (const key of FIELD_ORDER) if (fields[key] !== undefined) ordered[key] = fields[key];
  for (const [key, value] of Object.entries(fields)) if (!known.includes(key)) ordered[key] = value;
  const written = setJobFields("", ordered);
  if (!written.ok) throw new Error(`cannot write a job file: ${written.message}`);
  const withBody = setBody(written.text.replace(/\n\n$/, "\n"), body);
  return withBody.ok ? withBody.text : written.text;
}

/** The slug a job name gives its file: `Dev server` → `dev-server`. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return SLUG_RE.test(slug) ? slug : "job";
}

/** A job file's path, workspace-relative: `folder` is the project's sub-folder, `null` for a workspace job. */
export function jobFilePath(folder: string | null, slug: string): string {
  return `${JOBS_FOLDER}/${folder === null ? "" : `${folder}/`}${slug}.md`;
}

/** The paths a new job named `name` may take, best first: its slug, then `-2`, `-3`… */
export function* jobFileCandidates(folder: string | null, name: string): Generator<string> {
  const slug = slugify(name);
  yield jobFilePath(folder, slug);
  for (let n = 2; ; n++) yield jobFilePath(folder, `${slug}-${n}`);
}
