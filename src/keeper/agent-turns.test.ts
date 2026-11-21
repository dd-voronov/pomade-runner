// A turn is done when the kit's scanner, reading the provider's own title, sees the agent go from
// working to idle — once; a prompt it waits at is no finished turn.

import { AgentStateScanner } from "pomade-kit/scanners";
import { describe, expect, it } from "vitest";

import { turnTracker } from "./agent-turns";

const title = (text: string): string => `\x1b]0;${text}\x07`;

describe("an agent's turn", () => {
  it("is done once, when the agent goes from working to idle", async () => {
    let done = 0;
    const scanner = new AgentStateScanner({ agent: "claude", cols: 80, rows: 24, idleAfterMs: 10 }, turnTracker(() => done++));
    scanner.push(title("✳ Claude Code"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await scanner.settled();
    expect(done).toBe(0);
    scanner.push(`${title("◐ Thinking")}● working`);
    await scanner.settled();
    scanner.push(title("✳ Claude Code"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await scanner.settled();
    expect(done).toBe(1);
    scanner.push(title("◓ Again"));
    scanner.push(title("✳ Claude Code"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await scanner.settled();
    expect(done).toBe(1);
    scanner.dispose();
  });

  it("is not done at a permission prompt", () => {
    let done = 0;
    const track = turnTracker(() => done++);
    track({ kind: "working" });
    track({ kind: "waiting", prompt: "permission" });
    track({ kind: "unknown" });
    expect(done).toBe(0);
    track({ kind: "idle" });
    expect(done).toBe(1);
  });
});
