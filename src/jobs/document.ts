// A job file's frontmatter, read with the line of every field — the validator names the line of
// each problem, nested ones included (`schedule.weekly.days[1]`). The block is found the way
// Pomade's editor and `files.readFolder` find it (`pomade-kit/frontmatter`'s split); its YAML is
// parsed with YAML 1.2's core schema, which reads values the way Pomade's frontmatter reader does
// for everything a job file holds: `7:00` and `2026-11-20` stay text, `yes` is text.

import { getBody, splitFrontmatter } from "pomade-kit/frontmatter";
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, type Document, type Node } from "yaml";

export type FieldPath = readonly (string | number)[];

/** `["schedule", "weekly", "days", 1]` → `schedule.weekly.days[1]`. */
export function fieldName(path: FieldPath): string {
  let name = "";
  for (const segment of path) name += typeof segment === "number" ? `[${segment}]` : name === "" ? segment : `.${segment}`;
  return name;
}

export type ReadDocumentResult =
  | { ok: true; doc: JobDocument }
  /** The file has no readable frontmatter: `line` is where, `problem` and `fix` say what to do. */
  | { ok: false; line: number; problem: string; fix: string };

/** The file's line of the frontmatter's first YAML line (the opening `---` is line 1). */
const FIRST_YAML_LINE = 2;

export class JobDocument {
  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
    /** The frontmatter as plain values. */
    readonly fields: Record<string, unknown>,
    /** Everything after the frontmatter block. */
    readonly body: string,
  ) {}

  private lineAt(offset: number): number {
    return this.lines.linePos(offset).line + FIRST_YAML_LINE - 1;
  }

  /**
   * The line of the field at `path`: a mapping entry's key line, a list item's own line. A path
   * that does not exist (a missing field) gives the line of its deepest existing parent; a missing
   * top-level field gives the line of `kind`, or the first line of the block.
   */
  line(path: FieldPath): number {
    let node: unknown = this.doc.contents;
    let line = this.topLine();
    for (const segment of path) {
      if (isMap(node) && typeof segment === "string") {
        const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === segment);
        if (!pair) return line;
        const at = (pair.key as Node).range?.[0];
        if (at !== undefined) line = this.lineAt(at);
        node = pair.value;
      } else if (isSeq(node) && typeof segment === "number") {
        const item: unknown = node.items[segment];
        if (item === undefined || isPair(item)) return line;
        const at = (item as Node).range?.[0];
        if (at !== undefined) line = this.lineAt(at);
        node = item;
      } else {
        return line;
      }
    }
    return line;
  }

  private topLine(): number {
    const root = this.doc.contents;
    if (isMap(root)) {
      const kind = root.items.find((item) => isScalar(item.key) && item.key.value === "kind");
      const at = (kind?.key as Node | undefined)?.range?.[0];
      if (at !== undefined) return this.lineAt(at);
    }
    return FIRST_YAML_LINE;
  }
}

const NO_BLOCK_FIX = "start the file with a line ---, the job's fields (kind: service …), and another line ---";

/** Read a job file's text. */
export function readJobDocument(text: string): ReadDocumentResult {
  const lf = text.replace(/\r\n/g, "\n");
  const { frontmatter } = splitFrontmatter(lf);
  if (frontmatter === "") {
    const firstLine = lf.slice(0, lf.indexOf("\n") < 0 ? lf.length : lf.indexOf("\n"));
    if (firstLine.trimEnd() === "---") {
      return { ok: false, line: 1, problem: "the frontmatter block that starts here is never closed", fix: "add a line --- after the last field" };
    }
    return { ok: false, line: 1, problem: "the file has no frontmatter block", fix: NO_BLOCK_FIX };
  }
  // `---\n<yaml>\n---\n`: the YAML ends at the first closing line.
  const yaml = frontmatter.slice(4, frontmatter.indexOf("\n---\n", 4));
  const lines = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter: lines, prettyErrors: true, schema: "core", uniqueKeys: true });
  const [error] = doc.errors;
  if (error) {
    const line = (error.linePos?.[0].line ?? 1) + FIRST_YAML_LINE - 1;
    const reason = (error.message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, "");
    const problem = reason === "Map keys must be unique" ? "this field appears twice" : `the frontmatter is not valid YAML: ${reason}`;
    const fix = reason === "Map keys must be unique" ? "keep one of the two lines" : "fix the YAML on this line — each field is `name: value`, nested fields indented with spaces";
    return { ok: false, line, problem, fix };
  }
  const contents = doc.contents;
  if (!isMap(contents)) {
    return { ok: false, line: FIRST_YAML_LINE, problem: "the frontmatter holds no fields", fix: "write the job's fields as `name: value` lines, starting with kind:" };
  }
  const fields = doc.toJS({ maxAliasCount: 50 }) as Record<string, unknown>;
  return { ok: true, doc: new JobDocument(doc, lines, fields, getBody(text)) };
}
