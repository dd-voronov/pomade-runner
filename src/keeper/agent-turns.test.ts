// A turn is done when the kit's scanner, reading the provider's own title, sees the agent go from
// working to idle — once; a prompt it waits at is no finished turn but a wait for the person, told
// when it comes and when it goes; a fresh snapshot's screen without a prompt ends a wait.

import { AgentStateScanner } from "pomade-kit/scanners";
import { describe, expect, it } from "vitest";

import { turnTracker, type TurnHandlers } from "./agent-turns";

const title = (text: string): string => `\x1b]0;${text}\x07`;

/** Claude Code's permission dialog as it draws it: the question, the options, the footer last. */
const DIALOG = ["", " Bash command", "   git mv 00-Inbox/*.md 01-Raw/Notes/", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for git mv", "   3. No, tell Claude what to do differently", "", " Esc to cancel"].join("\r\n");

function recorder(): { handlers: TurnHandlers; done: () => number; waits: (string | null)[] } {
  let done = 0;
  const waits: (string | null)[] = [];
  return { handlers: { onTurnDone: () => done++, onWaiting: (prompt) => waits.push(prompt) }, done: () => done, waits };
}

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
    track.onState({ kind: "waiting", prompt: "permission" });
    track.onState({ kind: "waiting", prompt: "permission" });
    track.onState({ kind: "unknown" });
    expect(seen.waits).toEqual(["permission"]);
    expect(seen.done()).toBe(0);
    track.onState({ kind: "waiting", prompt: "trust" });
    track.onState({ kind: "idle" });
    expect(seen.waits).toEqual(["permission", "trust", null]);
    expect(seen.done()).toBe(1);
  });

  it("ends a wait when a fresh snapshot's screen shows no prompt, and keeps it when it shows one", () => {
    const seen = recorder();
    const track = turnTracker(seen.handlers);
    track.onState({ kind: "waiting", prompt: "permission" });
    track.onScreen({ kind: "waiting", prompt: "permission" });
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
});
