// A turn is done when the kit's scanner, reading the provider's own title, sees the agent go from
// working to idle with no background work — once; a prompt it waits at is no finished turn but a
// wait for the person, told when it comes and when it goes; a fresh snapshot's screen without a
// prompt ends a wait. A turn that ends with background work going is told, and done once that work
// ended; after the exit command, the agent's moment of work is the command's, and its
// background-work question is told — idle after it, the turn's end is waited for afresh.

import { AgentStateScanner, type AgentState } from "pomade-kit/scanners";
import { describe, expect, it } from "vitest";

import { turnTracker, type TurnHandlers } from "./agent-turns";

const title = (text: string): string => `\x1b]0;${text}\x07`;

/** Claude Code's permission dialog as it draws it: the question, the options, the footer last. */
const DIALOG = ["", " Bash command", "   git mv drafts/*.md published/", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for git mv", "   3. No, tell Claude what to do differently", "", " Esc to cancel"].join("\r\n");

function recorder(): { handlers: TurnHandlers; done: () => number; worked: () => number; waits: (string | null)[]; told: string[] } {
  let done = 0;
  let worked = 0;
  const waits: (string | null)[] = [];
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
      onWaiting: (prompt) => {
        waits.push(prompt);
        told.push(`wait:${prompt ?? "none"}`);
      },
      onBackground: (going) => told.push(going ? "background" : "back to work"),
      onBackgroundQuestion: () => told.push("question"),
    },
    done: () => done,
    worked: () => worked,
    waits,
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

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("an agent's turn", () => {
  it("is done once, when the agent goes from working to idle", async () => {
    const seen = recorder();
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 24, idleAfterMs: 10 }, turnTracker(seen.handlers).onState);
    scanner.push(title("✳ Claude Code"));
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
    scanner.push(`● Done.\r\n> ${title("✳ Claude Code")}`);
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
});
