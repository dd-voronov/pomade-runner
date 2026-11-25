/** A run's output as Runner shows it: the text a terminal got, with the colours and bold the program
 *  printed kept, in the app's palette, and every other terminal code — cursor moves, window titles,
 *  links, screen clearing — removed. A line rewritten with `\r` (a progress bar) is the line it
 *  ended as. */

/** The colours output is shown in: the palette's six hues, and dim for the greys and white a
 *  program prints. Black and dark greys show in the text colour (`null`). */
export const OUTPUT_COLOURS = ["red", "green", "amber", "blue", "magenta", "cyan", "dim"] as const;
export type OutputColour = (typeof OUTPUT_COLOURS)[number];

export interface OutputStyle {
  colour: OutputColour | null;
  bold: boolean;
  faint: boolean;
}

/** A run of text in one style. */
export interface OutputSpan {
  text: string;
  style: OutputStyle;
}

/** One line of output: its spans, in order. */
export type OutputLine = OutputSpan[];

const PLAIN: OutputStyle = { colour: null, bold: false, faint: false };

/** Terminal escape sequences: CSI (colours, cursor moves), OSC (titles, links), and the two-byte
 *  ones; and the line ends and control characters (all but tab). */
const CODES = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\r|\n|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** The 16 basic colours by number: black, red, green, yellow, blue, magenta, cyan, white, then
 *  their bright ones. */
const BASIC: readonly (OutputColour | null)[] = [null, "red", "green", "amber", "blue", "magenta", "cyan", "dim", "dim", "red", "green", "amber", "blue", "magenta", "cyan", "dim"];

/** The palette colour nearest a 24-bit colour: a grey (little saturation) is the text colour when
 *  dark and dim when light; any other goes by its hue. */
export function nearestColour(r: number, g: number, b: number): OutputColour | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 510;
  const chroma = max - min;
  if (chroma < 48) return lightness < 0.5 ? null : "dim";
  let hue: number;
  if (max === r) hue = (((g - b) / chroma) % 6) * 60;
  else if (max === g) hue = ((b - r) / chroma + 2) * 60;
  else hue = ((r - g) / chroma + 4) * 60;
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 330) return "red";
  if (hue < 70) return "amber";
  if (hue < 165) return "green";
  if (hue < 195) return "cyan";
  if (hue < 260) return "blue";
  return "magenta";
}

/** A colour of the 256-colour table: the 16 basic ones, the 6×6×6 cube, the grey ramp. */
function indexedColour(index: number): OutputColour | null {
  if (index < 16) return BASIC[index] ?? null;
  if (index < 232) {
    const level = (step: number): number => (step === 0 ? 0 : 55 + step * 40);
    const n = index - 16;
    return nearestColour(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6));
  }
  const grey = 8 + (index - 232) * 10;
  return nearestColour(grey, grey, grey);
}

/** The pen an SGR code sets: what the program asked for, before it is drawn in the palette. */
interface Pen {
  fg: OutputColour | null;
  bg: OutputColour | null;
  bold: boolean;
  faint: boolean;
  inverse: boolean;
}

const NEW_PEN: Pen = { fg: null, bg: null, bold: false, faint: false, inverse: false };

const isHue = (colour: OutputColour | null): boolean => colour !== null && colour !== "dim";

/** The style a pen draws in: a background in a hue — the program's badge, " FAIL " on red — shows
 *  as text in that hue, as an inverse one does; other backgrounds are left out. */
function styleOf(pen: Pen): OutputStyle {
  const back = pen.inverse ? pen.fg : pen.bg;
  const front = pen.inverse ? pen.bg : pen.fg;
  return { colour: isHue(back) ? back : front, bold: pen.bold, faint: pen.faint };
}

/** An extended colour's parameters after its 38 or 48: `5, n` from the 256-colour table, `2, r, g, b`
 *  24-bit; `undefined` for a form Runner does not know. */
function extendedColour(rest: readonly number[]): OutputColour | null | undefined {
  if (rest[0] === 5) return indexedColour(rest[1] ?? 0);
  if (rest[0] === 2) return nearestColour(rest[1] ?? 0, rest[2] ?? 0, rest[3] ?? 0);
  return undefined;
}

const number = (part: string): number => (part === "" ? 0 : Number(part));

/** A pen after an SGR code's parameters (`1;31`, `38;5;196`, `38;2;255;0;0`, `38:2::255:0:0`). */
function applySgr(pen: Pen, params: string): Pen {
  const groups = params.split(";");
  let next = { ...pen };
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] ?? "";
    const code = number(group.split(":")[0] ?? "");
    if (code === 0) next = { ...NEW_PEN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.faint = true;
    else if (code === 22) next = { ...next, bold: false, faint: false };
    else if (code === 7) next.inverse = true;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30] ?? null;
    else if (code >= 90 && code <= 97) next.fg = BASIC[code - 90 + 8] ?? null;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40] ?? null;
    else if (code >= 100 && code <= 107) next.bg = BASIC[code - 100 + 8] ?? null;
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      let colour: OutputColour | null | undefined;
      if (group.includes(":")) {
        // The colon form keeps the colour in one parameter; its 24-bit one may name a colour space
        // first (`38:2::r:g:b`).
        const sub = group.split(":").slice(1).map(number);
        colour = extendedColour(sub[0] === 2 && sub.length >= 5 ? [2, ...sub.slice(-3)] : sub);
      } else {
        const rest = groups.slice(i + 1, i + 5).map(number);
        colour = extendedColour(rest);
        if (rest[0] === 5) i += 2;
        else if (rest[0] === 2) i += 4;
      }
      if (colour === undefined) break;
      if (code === 38) next.fg = colour;
      else next.bg = colour;
    }
  }
  return next;
}

const sameStyle = (a: OutputStyle, b: OutputStyle): boolean => a.colour === b.colour && a.bold === b.bold && a.faint === b.faint;

/** A terminal's output as lines of styled spans: the colours and bold kept, every other code
 *  removed, and a line rewritten with `\r` (a progress bar) as it ended up. A style the program
 *  set runs on across lines until it changes it, as in the terminal. */
export function outputLines(text: string): OutputLine[] {
  const lines: OutputLine[] = [];
  let line: OutputLine = [];
  let pen = NEW_PEN;
  let returned = false;
  const add = (part: string): void => {
    if (part === "") return;
    if (returned) {
      line = [];
      returned = false;
    }
    const style = styleOf(pen);
    const last = line.at(-1);
    if (last !== undefined && sameStyle(last.style, style)) last.text += part;
    else line.push({ text: part, style });
  };
  let from = 0;
  for (const match of text.matchAll(CODES)) {
    add(text.slice(from, match.index));
    from = match.index + match[0].length;
    const code = match[0];
    if (code === "\n") {
      lines.push(line);
      line = [];
      returned = false;
    } else if (code === "\r") returned = true;
    else if (match[2] === "m") pen = applySgr(pen, match[1] ?? "");
  }
  add(text.slice(from));
  lines.push(line);
  return lines;
}

/** A line's text, without its styles. */
export function lineText(line: OutputLine): string {
  return line.map((span) => span.text).join("");
}

/** A terminal's output as plain lines: every code gone, and a line rewritten with `\r` (a progress
 *  bar) as it ended up. */
export function plainLines(text: string): string[] {
  return outputLines(text).map(lineText);
}

/** The SGR code each palette colour is kept as. */
const SGR_OF: Record<OutputColour, string> = { red: "31", green: "32", amber: "33", blue: "34", magenta: "35", cyan: "36", dim: "90" };

/** One line of output with its colours kept, as text: each styled span in the SGR codes of its
 *  palette colour and bold, and reset after it — so the line reads the same on its own. */
export function styledText(line: OutputLine): string {
  return line
    .map(({ text, style }) => {
      const codes = [style.bold ? "1" : null, style.faint ? "2" : null, style.colour === null ? null : SGR_OF[style.colour]].filter((code) => code !== null);
      return codes.length === 0 ? text : `\x1b[${codes.join(";")}m${text}\x1b[0m`;
    })
    .join("");
}

/** A line cut to `max` characters of its text, the last one "…" when it was longer. */
export function cutLine(line: OutputLine, max: number): OutputLine {
  if (lineText(line).length <= max) return line;
  const cut: OutputLine = [];
  let room = max - 1;
  for (const span of line) {
    if (room <= 0) break;
    cut.push({ text: span.text.slice(0, room), style: span.style });
    room -= span.text.length;
  }
  const last = cut.at(-1);
  if (last === undefined) return [{ text: "…", style: PLAIN }];
  last.text += "…";
  return cut;
}

/** A line of a run record's last lines (kept with its colours) as plain text. */
export function plainLine(line: string): string {
  return plainLines(line).join("");
}

/** Plain lines as output lines, each one span in no style. */
export function plainOutput(lines: readonly string[]): OutputLine[] {
  return lines.map((text) => (text === "" ? [] : [{ text, style: PLAIN }]));
}
