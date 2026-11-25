// A run's output as Runner shows it: the colours and bold the program printed kept in the palette —
// the 16 basic colours, the 256-colour table and 24-bit ones mapped to the nearest — every other
// terminal code removed, a rewritten line as it ended; a line kept as text reads back the same.

import { describe, expect, it } from "vitest";

import { cutLine, lineText, nearestColour, outputLines, plainLine, plainLines, plainOutput, styledText, type OutputStyle } from "./terminal-text";

const plain: OutputStyle = { colour: null, bold: false, faint: false };
const style = (extra: Partial<OutputStyle>): OutputStyle => ({ ...plain, ...extra });

describe("outputLines", () => {
  it("keeps the text colour the program printed and the text after its reset plain", () => {
    expect(outputLines("\x1b[31mboom\x1b[0m\nfine\n")).toEqual([[{ text: "boom", style: style({ colour: "red" }) }], [{ text: "fine", style: plain }], []]);
  });

  it("maps the 16 basic colours to the palette: black the text colour, white and bright black dim", () => {
    const colours = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97].map((code) => outputLines(`\x1b[${code}mx`)[0]?.[0]?.style.colour);
    expect(colours).toEqual([null, "red", "green", "amber", "blue", "magenta", "cyan", "dim", "dim", "red", "green", "amber", "blue", "magenta", "cyan", "dim"]);
  });

  it("keeps bold and faint, and 22 ends both; 39 ends the colour only", () => {
    expect(outputLines("\x1b[1;33mwarn\x1b[22m soft\x1b[39m off \x1b[2mfaint\x1b[0m")).toEqual([
      [
        { text: "warn", style: style({ colour: "amber", bold: true }) },
        { text: " soft", style: style({ colour: "amber" }) },
        { text: " off ", style: plain },
        { text: "faint", style: style({ faint: true }) },
      ],
    ]);
  });

  it("maps 256-colour and 24-bit colours to the nearest palette colour, in both separator forms", () => {
    const colourOf = (code: string): string | null | undefined => outputLines(`\x1b[${code}mx`)[0]?.[0]?.style.colour;
    expect(colourOf("38;5;9")).toBe("red");
    expect(colourOf("38;5;196")).toBe("red");
    expect(colourOf("38;5;214")).toBe("amber");
    expect(colourOf("38;5;244")).toBe("dim");
    expect(colourOf("38;5;236")).toBeNull();
    expect(colourOf("38;2;80;200;120")).toBe("green");
    expect(colourOf("38:2::40:120:230")).toBe("blue");
    expect(colourOf("38:5:51")).toBe("cyan");
    expect(colourOf("1;38;2;200;60;200;4")).toBe("magenta");
  });

  it("shows a badge's background hue as its text colour, an inverse one too; a grey background is left out", () => {
    const first = (text: string): OutputStyle | undefined => outputLines(text)[0]?.[0]?.style;
    expect(first("\x1b[41;37;1m FAIL \x1b[0m")).toEqual(style({ colour: "red", bold: true }));
    expect(first("\x1b[7;31m FAIL \x1b[27m")).toEqual(style({ colour: "red" }));
    expect(first("\x1b[47;34mx")).toEqual(style({ colour: "blue" }));
    expect(first("\x1b[48;5;22mx")).toEqual(style({ colour: "green" }));
  });

  it("runs a style on across lines until the program changes it", () => {
    expect(outputLines("\x1b[32mone\ntwo\x1b[0m\nthree").map((line) => line.map((span) => span.style.colour))).toEqual([["green"], ["green"], [null]]);
  });

  it("removes cursor moves, titles, links and clearing; a line rewritten with \\r is the line it ended as, in its style", () => {
    const text = "\x1b]0;title\x07\x1b]8;;https://x.y\x1b\\link\x1b]8;;\x1b\\\r\n\x1b[2J\x1b[H\x1b[32m 10%\r\x1b[2K\x1b[1G100%\x1b[0m\r\n\x1b[?25ldone\ttab\x07";
    expect(plainLines(text)).toEqual(["link", "100%", "done\ttab"]);
    expect(outputLines(text)[1]).toEqual([{ text: "100%", style: style({ colour: "green" }) }]);
  });

  it("gives plain lines exactly for output with no colours", () => {
    expect(plainLines("a\r\nb 1\rb 2\r\n\r\n")).toEqual(["a", "b 2", "", ""]);
    expect(outputLines("a\nb").every((line) => line.every((span) => span.style === plain || (span.style.colour === null && !span.style.bold && !span.style.faint)))).toBe(true);
  });
});

describe("styledText", () => {
  it("keeps a line as SGR codes of its palette colours, each span reset, and reads back the same", () => {
    const [line = []] = outputLines("a \x1b[1;38;2;220;40;40mbad\x1b[22m red\x1b[0m end");
    const text = styledText(line);
    expect(text).toBe("a \x1b[1;31mbad\x1b[0m\x1b[31m red\x1b[0m end");
    expect(outputLines(text)).toEqual([line]);
    expect(plainLine(text)).toBe("a bad red end");
    expect(styledText([{ text: "plain", style: plain }])).toBe("plain");
  });
});

describe("cutLine", () => {
  it("cuts a line to its length in text, keeping the styles, the last character an ellipsis", () => {
    const [line = []] = outputLines("\x1b[31mabc\x1b[0mdefgh");
    expect(cutLine(line, 5)).toEqual([
      { text: "abc", style: style({ colour: "red" }) },
      { text: "d…", style: plain },
    ]);
    expect(cutLine(line, 8)).toBe(line);
    expect(lineText(cutLine(line, 3))).toBe("ab…");
  });
});

describe("nearestColour", () => {
  it("takes greys by lightness and the rest by hue", () => {
    expect([nearestColour(0, 0, 0), nearestColour(200, 200, 200), nearestColour(255, 140, 0), nearestColour(0, 200, 200), nearestColour(150, 50, 255)]).toEqual([null, "dim", "amber", "cyan", "magenta"]);
  });
});

describe("plainOutput", () => {
  it("makes plain lines output lines in no style", () => {
    expect(plainOutput(["a", ""])).toEqual([[{ text: "a", style: plain }], []]);
  });
});
