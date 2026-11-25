// A turn is done when the kit's scanner, reading the provider's own title, sees the agent go from
// working to idle with no background work — once; a prompt it waits at is no finished turn but a
// wait for the person, told when it comes and when it goes; a fresh snapshot's screen without a
// prompt ends a wait. A turn that ends with background work going is told, and done once that work
// ended; after the exit command, the agent's moment of work is the command's, and its
// background-work question is told — idle after it, the turn's end is waited for afresh. Idle is
// the agent's empty prompt: a question form is a wait told with its highlighted option, a screen no
// rule names is a wait once the agent has worked. An agent that works on after the exit command, or
// waits at a prompt, did not take it: its turn is followed afresh.

import { readFileSync } from "node:fs";

import { AgentStateScanner, type AgentState } from "pomade-kit/scanners";
import { afterEach, describe, expect, it, vi } from "vitest";

import { turnTracker, WORKS_AGAIN_MS, type TurnHandlers } from "./agent-turns";

const title = (text: string): string => `\x1b]0;${text}\x07`;

/** Claude Code's permission dialog as it draws it: the question, the options, the footer last. */
const DIALOG = ["", " Bash command", "   git mv drafts/*.md published/", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for git mv", "   3. No, tell Claude what to do differently", "", " Esc to cancel"].join("\r\n");

function recorder(): { handlers: TurnHandlers; done: () => number; worked: () => number; waits: (string | null)[]; highlighted: (string | null)[]; told: string[] } {
  let done = 0;
  let worked = 0;
  const waits: (string | null)[] = [];
  const highlighted: (string | null)[] = [];
  /** Everything told, in order. */
  const told: string[] = [];
  return {
    handlers: {
      onWorking: () => {
        worked++;
        told.push("working");
      },
      onTurnDone: () => {
        done++;
        told.push("done");
      },
      onWaiting: (prompt, option) => {
        waits.push(prompt);
        highlighted.push(option);
        told.push(`wait:${prompt ?? "none"}`);
      },
      onBackground: (going) => told.push(going ? "background" : "back to work"),
      onBackgroundQuestion: () => told.push("question"),
      onWorksAgain: (by) => told.push(by === "working" ? "works again" : "not taken"),
    },
    done: () => done,
    worked: () => worked,
    waits,
    highlighted,
    told,
  };
}

const WORKING: AgentState = { kind: "working" };
const IDLE: AgentState = { kind: "idle", background: false };
const IDLE_BACKGROUND: AgentState = { kind: "idle", background: true };
const QUESTION: AgentState = { kind: "waiting", prompt: "background", lines: ["Background work is running"] };

/** Claude Code's screen at a turn's end, 80 × 12: the composer between its rules, the footer last —
 *  counting a background shell, or not. */
const row = (n: number, text: string): string => `\x1b[${n};1H\x1b[2K${text}`;
const COMPOSER = row(9, "─".repeat(80)) + row(10, "❯ ") + row(11, "─".repeat(80));
const SHELL = "  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage";
const PLAIN = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
const turnEnd = (footer: string): string => `\x1b[2J${row(1, "⏺ Timer's running.")}${COMPOSER}${row(12, footer)}`;
/** Its "Background work is running" dialog, as it answers /exit while that work goes. */
const BACKGROUND_DIALOG = `\x1b[2J${row(2, "▔".repeat(80))}${row(3, " Background work is running")}${row(4, " The following will stop when you exit:")}${row(6, " shell · Wait 3 minutes")}${row(8, " ❯ 1. Exit and stop tasks")}${row(9, "   2. Stay")}${row(11, " Enter to confirm · Esc to cancel")}`;

/** Claude Code's question form (its AskUserQuestion tool), as claude 2.1.332 draws it: the header,
 *  the question, the options, the footer last. */
const QUESTION_FORM = [
  "─".repeat(80),
  " ☐ Permission",
  "",
  'May I append the line "asked" to notes.md?',
  "",
  "❯ 1. Yes, append (Recommended)",
  "  2. No, cancel",
  "  3. Type something.",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\r\n");
/** A dialog no rule names (Claude's plan approval), its own footer last. */
const UNNAMED = `\x1b[2J${row(3, " Ready to code?")}${row(5, " ❯ 1. Yes, auto-accept edits")}${row(6, "   2. No, keep planning")}${row(8, " ctrl-g to edit in Vim")}`;

/** Claude Code's Bypass Permissions consent screen, from a real run's output log: drawn before any
 *  title, "❯ No, exit" highlighted. */
const CONSENT = readFileSync(new URL("../../e2e/fixtures/claude-bypass-consent.txt", import.meta.url), "utf8");

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("an agent's turn", () => {
  it("is done once, when the agent goes from working to idle", async () => {
    const seen = recorder();
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 24, idleAfterMs: 10 }, turnTracker(seen.handlers).onState);
    scanner.push(COMPOSER + title("✳ Claude Code"));
    await pause(30);
    await scanner.settled();
    expect(seen.done()).toBe(0);
    scanner.push(`${title("◐ Thinking")}● working`);
    await scanner.settled();
    scanner.push(title("✳ Claude Code"));
    await pause(30);
    await scanner.settled();
    expect(seen.done()).toBe(1);
    scanner.push(title("◓ Again"));
    scanner.push(title("✳ Claude Code"));
    await pause(30);
    await scanner.settled();
    expect(seen.done()).toBe(1);
    expect(seen.waits).toEqual([]);
    scanner.dispose();
  });

  it("waits at a permission dialog on screen, under the idle title, and is not done; answered, it works and then is done", async () => {
    const seen = recorder();
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 24, idleAfterMs: 10 }, turnTracker(seen.handlers).onState);
    scanner.push(`${title("◐ Working")}● Moving 14 notes\r\n`);
    await scanner.settled();
    scanner.push(`${DIALOG}${title("✳ Claude Code")}`);
    await pause(30);
    await scanner.settled();
    expect(seen.waits).toEqual(["permission"]);
    expect(seen.done()).toBe(0);
    scanner.push(`\r\n\r\n● Allowed\r\n${title("◑ Working")}`);
    await scanner.settled();
    expect(seen.waits).toEqual(["permission", null]);
    scanner.push(`\x1b[2J● Done.${COMPOSER}${title("✳ Claude Code")}`);
    await pause(30);
    await scanner.settled();
    expect(seen.done()).toBe(1);
    scanner.dispose();
  });

  it("tells a wait once, ends it on working or idle, and never counts it as idle", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState({ kind: "working" });
    track.onState({ kind: "waiting", prompt: "permission", lines: [] });
    track.onState({ kind: "waiting", prompt: "permission", lines: [] });
    track.onState({ kind: "unknown" });
    expect(seen.waits).toEqual(["permission"]);
    expect(seen.done()).toBe(0);
    track.onState({ kind: "waiting", prompt: "trust", lines: [] });
    track.onState({ kind: "idle", background: false });
    expect(seen.waits).toEqual(["permission", "trust", null]);
    expect(seen.done()).toBe(1);
  });

  it("tells the agent working once, and never for an unknown or idle screen", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState({ kind: "unknown" });
    track.onState({ kind: "idle", background: false });
    expect(seen.worked()).toBe(0);
    track.onState({ kind: "working" });
    track.onState({ kind: "waiting", prompt: "permission", lines: [] });
    track.onState({ kind: "working" });
    expect(seen.worked()).toBe(1);
  });

  it("tells a fresh following's first screen without a prompt even with no wait known — a wait the run kept from before ends — and only once", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onScreen({ kind: "unknown" });
    expect(seen.waits).toEqual([null]);
    track.onScreen({ kind: "unknown" });
    track.onState({ kind: "working" });
    expect(seen.waits).toEqual([null]);
  });

  it("ends a wait when a fresh snapshot's screen shows no prompt, and keeps it when it shows one", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState({ kind: "waiting", prompt: "permission", lines: [] });
    track.onScreen({ kind: "waiting", prompt: "permission", lines: [] });
    expect(seen.waits).toEqual(["permission"]);
    track.onScreen({ kind: "unknown" });
    expect(seen.waits).toEqual(["permission", null]);
    track.onScreen({ kind: "unknown" });
    expect(seen.waits).toEqual(["permission", null]);
  });

  it("reads the prompt from a snapshot's screen alone — no window title — as a scheduler restarted mid-wait sees it", async () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 24, idleAfterMs: 10 }, track.onState);
    scanner.push(`● Moving 14 notes\r\n${DIALOG}`);
    await scanner.settled();
    track.onScreen(scanner.state);
    expect(seen.waits).toEqual(["permission"]);
    scanner.dispose();
  });

  it("is not done when the turn ends with background work going; the agent's further turn, once the work ended, is", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState(WORKING);
    track.onState(IDLE_BACKGROUND);
    expect(seen.told).toEqual(["working", "background"]);
    // The work ends: the agent takes a further turn by itself, which ends without background work.
    track.onState(WORKING);
    track.onState(IDLE);
    expect(seen.told).toEqual(["working", "background", "back to work", "done"]);
  });

  it("is done when the background work ends while the agent stays idle", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState(WORKING);
    track.onState(IDLE_BACKGROUND);
    track.onState(IDLE);
    expect(seen.told).toEqual(["working", "background", "done"]);
  });

  it("reads the working moment the exit command causes as the command's, not as a new turn", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState(WORKING);
    track.onState(IDLE);
    track.onState(WORKING);
    track.onState({ kind: "unknown" });
    expect(seen.told).toEqual(["working", "done"]);
  });

  it("tells the background-work question that answers the exit command — never as a wait for the person — and idle after it, waits for the turn's end afresh", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState(WORKING);
    track.onState(IDLE);
    track.onState(WORKING);
    track.onState(QUESTION);
    expect(seen.told).toEqual(["working", "done", "question"]);
    expect(seen.waits).toEqual([]);
    // Declined, the agent stays with its work: back to waiting for the turn's end.
    track.onState(IDLE_BACKGROUND);
    expect(seen.told).toEqual(["working", "done", "question", "background"]);
    track.onState(WORKING);
    track.onState(IDLE);
    expect(seen.told).toEqual(["working", "done", "question", "background", "back to work", "done"]);
  });

  it("idle without counted background work after the question waits for the agent's next turn: no second exit at once", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState(WORKING);
    track.onState(IDLE);
    track.onState(QUESTION);
    track.onState(IDLE);
    expect(seen.told).toEqual(["working", "done", "question", "background"]);
    track.onState(WORKING);
    track.onState(IDLE);
    expect(seen.told).toEqual(["working", "done", "question", "background", "back to work", "done"]);
  });

  it("leaves a background-work question it did not cause alone — the person asked to exit — and a fresh snapshot showing it ends a wait", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState(WORKING);
    track.onState(IDLE_BACKGROUND);
    track.onState(WORKING);
    track.onState(QUESTION);
    track.onState(IDLE_BACKGROUND);
    expect(seen.told).toEqual(["working", "background", "back to work", "background"]);
    const fresh = recorder();
    const again = turnTracker(fresh.handlers);
    again.onState({ kind: "waiting", prompt: "permission", lines: [] });
    again.onScreen(QUESTION);
    expect(fresh.waits).toEqual(["permission", null]);
  });

  it("reads claude's screens: the footer's background shell holds the turn open; Runner's /exit answered by the dialog, Esc, the further turn after the work", async () => {
    const seen = recorder();
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 12, idleAfterMs: 10 }, turnTracker(seen.handlers).onState);
    const step = async (data: string): Promise<void> => {
      scanner.push(data);
      await pause(30);
      await scanner.settled();
    };
    await step(title("◐ Working"));
    await step(turnEnd(SHELL) + title("✳ Claude Code"));
    expect(seen.told).toEqual(["working", "background"]);
    // The shell ends: the footer drops its count and claude takes a further turn by itself.
    await step(row(12, PLAIN) + title("◓ Working"));
    await step(turnEnd(PLAIN) + title("✳ Claude Code"));
    expect(seen.told).toEqual(["working", "background", "back to work", "done"]);
    // Runner's /exit: a moment of work, then the dialog under the idle title.
    await step(title("◑ Working"));
    await step(BACKGROUND_DIALOG + title("✳ Claude Code"));
    expect(seen.told).toEqual(["working", "background", "back to work", "done", "question"]);
    // Esc: the dialog goes, the footer counts the shell again.
    await step(turnEnd(SHELL));
    expect(seen.told).toEqual(["working", "background", "back to work", "done", "question", "background"]);
    expect(seen.waits).toEqual([]);
    scanner.dispose();
  });

  it("waits at claude's question form under the idle title, told with its highlighted option, and is not done; answered, it works and then is done", async () => {
    const seen = recorder();
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 24, idleAfterMs: 10 }, turnTracker(seen.handlers).onState);
    scanner.push(`${title("◐ Working")}● Asking`);
    await scanner.settled();
    scanner.push(`${title("✳ Claude Code")}\x1b[2J${QUESTION_FORM}`);
    await pause(30);
    await scanner.settled();
    expect(seen.told).toEqual(["working", "wait:question"]);
    expect(seen.highlighted).toEqual(["Yes, append (Recommended)"]);
    scanner.push(`\x1b[2J● Appended${title("◑ Working")}`);
    await scanner.settled();
    scanner.push(`${COMPOSER}${title("✳ Claude Code")}`);
    await pause(30);
    await scanner.settled();
    expect(seen.told).toEqual(["working", "wait:question", "wait:none", "done"]);
    scanner.dispose();
  });

  it("tells every question of a question form, each with its highlighted option", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState(WORKING);
    track.onState({ kind: "waiting", prompt: "question", lines: ["☐ Format"], highlighted: "Markdown" });
    track.onState({ kind: "waiting", prompt: "question", lines: ["☐ File"], highlighted: "notes.md" });
    expect(seen.waits).toEqual(["question", "question"]);
    expect(seen.highlighted).toEqual(["Markdown", "notes.md"]);
    track.onState(WORKING);
    expect(seen.waits).toEqual(["question", "question", null]);
  });

  it("waits at a screen the scanner does not name once the agent worked — never done there; before it worked, no wait", async () => {
    const seen = recorder();
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 24, idleAfterMs: 10 }, turnTracker(seen.handlers).onState);
    scanner.push(`${UNNAMED}${title("✳ Claude Code")}`);
    await pause(30);
    await scanner.settled();
    expect(seen.told).toEqual([]);
    scanner.push(title("◐ Working"));
    await scanner.settled();
    scanner.push(`${UNNAMED}${title("✳ Claude Code")}`);
    await pause(30);
    await scanner.settled();
    expect(seen.told).toEqual(["working", "wait:unknown"]);
    expect(seen.done()).toBe(0);
    // Answered: the agent works, then ends its turn at its empty prompt.
    scanner.push(`\x1b[2J${title("◑ Working")}`);
    await scanner.settled();
    scanner.push(`${COMPOSER}${title("✳ Claude Code")}`);
    await pause(30);
    await scanner.settled();
    expect(seen.told).toEqual(["working", "wait:unknown", "wait:none", "done"]);
    scanner.dispose();
  });

  it("waits at claude's Bypass Permissions consent before the agent set any title or worked; accepted, its start screen ends the wait", async () => {
    const seen = recorder();
    const scanner = new AgentStateScanner({ agent: "claude", cols: 100, rows: 30, idleAfterMs: 10 }, turnTracker(seen.handlers).onState);
    scanner.push(CONSENT);
    await pause(30);
    await scanner.settled();
    expect(seen.told).toEqual(["wait:consent"]);
    expect(seen.highlighted).toEqual([null]);
    // "Yes, I accept": claude's start screen, its empty prompt under the idle title.
    scanner.push(`\x1b[2J${COMPOSER}${title("✳ Claude Code")}`);
    await pause(30);
    await scanner.settled();
    expect(seen.told).toEqual(["wait:consent", "wait:none"]);
    expect(seen.done()).toBe(0);
    scanner.dispose();
  });

  describe("after the exit command", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("an agent that works on WORKS_AGAIN_MS did not take it: told, and its next turn's end is done again", () => {
      vi.useFakeTimers();
      const seen = recorder();
      const track = turnTracker(seen.handlers);
      track.onState(WORKING);
      track.onState(IDLE);
      track.onState(WORKING);
      vi.advanceTimersByTime(WORKS_AGAIN_MS - 1);
      expect(seen.told).toEqual(["working", "done"]);
      vi.advanceTimersByTime(1);
      expect(seen.told).toEqual(["working", "done", "works again"]);
      track.onState(IDLE);
      expect(seen.told).toEqual(["working", "done", "works again", "done"]);
    });

    it("the command's own moment of work is not working again: the agent's exit (its title cleared) ends it", () => {
      vi.useFakeTimers();
      const seen = recorder();
      const track = turnTracker(seen.handlers);
      track.onState(WORKING);
      track.onState(IDLE);
      track.onState(WORKING);
      vi.advanceTimersByTime(300);
      track.onState({ kind: "unknown" });
      vi.advanceTimersByTime(WORKS_AGAIN_MS * 2);
      expect(seen.told).toEqual(["working", "done"]);
    });

    it("a prompt for the person after it: the agent did not take it, and waits", () => {
      const seen = recorder();
      const track = turnTracker(seen.handlers);
      track.onState(WORKING);
      track.onState(IDLE);
      track.onState(WORKING);
      track.onState({ kind: "waiting", prompt: "question", lines: [], highlighted: "Yes" });
      expect(seen.told).toEqual(["working", "done", "not taken", "wait:question"]);
    });

    it("a screen the scanner does not name after it is the command's: no wait, the exit wait ends it", () => {
      const seen = recorder();
      const track = turnTracker(seen.handlers);
      track.onState(WORKING);
      track.onState(IDLE);
      track.onState({ kind: "waiting", prompt: "unknown", lines: ["Bye."] });
      expect(seen.told).toEqual(["working", "done"]);
    });
  });
});
