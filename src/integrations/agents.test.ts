// The Agents app's client: each answer checked against the contract (`../pomade-agents/docs/
// CONTRACTS.md` "Roster", "Reads for Runner"), and each broker error in words.

import { HostError } from "pomade-kit/sdk";
import { describe, expect, it } from "vitest";

import { agentMode, agentModes, agentsApi, AgentsError, checkFoundSessions, checkLastMessage, checkProjectsFor, isLaunchSpec, modeWords } from "./agents";

const spec = { command: "claude", args: ["--session-id", "u1", "hi"], line: "claude --session-id u1 hi", sessionId: "u1", exit: "/exit" };

describe("the Agents app's client", () => {
  it("checks a launch spec", () => {
    expect(isLaunchSpec(spec)).toBe(true);
    expect(isLaunchSpec({ ...spec, sessionId: null })).toBe(true);
    for (const bad of [{ ...spec, line: "" }, { ...spec, line: "a\nb" }, { ...spec, exit: "" }, { ...spec, args: [1] }, { ...spec, sessionId: 3 }, null]) expect(isLaunchSpec(bad)).toBe(false);
  });

  it("checks the other answers", () => {
    const found = { id: "s", provider: "codex", agent: "codex", cwd: "/w", startedAt: "2026-11-18T11:00:00Z", lastActiveAt: "2026-11-18T11:00:00Z" };
    expect(checkFoundSessions({ sessions: [found] })).toEqual([found]);
    expect(checkFoundSessions({ sessions: [{ ...found, id: "" }] })).toBeNull();
    expect(checkLastMessage({ message: null })).toBeNull();
    expect(checkLastMessage({ message: { text: "**Done.**", at: null } })).toEqual({ text: "**Done.**", at: null });
    expect(checkLastMessage({ message: { text: 1 } })).toBeUndefined();
    expect(checkProjectsFor({ projects: ["p1"] })).toEqual(["p1"]);
    expect(checkProjectsFor({ projects: "p1" })).toBeNull();
  });

  it("asks through the broker, and says an absent, silent or refusing app in words", async () => {
    const asked: [string, unknown, number][] = [];
    const api = agentsApi((method, params, timeout) => {
      asked.push([method, params, timeout]);
      if (method === "roster.list") return Promise.resolve({ agents: [{ id: "claude", name: "Claude", command: "claude", provider: "claude" }] });
      if (method === "sessions.lastMessage") return Promise.resolve({ message: { text: "hi", at: "2026-11-18T11:00:00Z" } });
      if (method === "roster.launchSpec") return Promise.resolve(spec);
      return Promise.resolve({ wrong: true });
    });
    expect((await api.roster()).map((agent) => agent.id)).toEqual(["claude"]);
    expect(await api.lastMessage("s1")).toEqual({ text: "hi", at: "2026-11-18T11:00:00Z" });
    expect(await api.launchSpec({ agent: "claude", mode: "normal", sessionId: "u1", prompt: "hi" })).toEqual(spec);
    expect(asked[2]).toEqual(["roster.launchSpec", { agent: "claude", mode: "normal", sessionId: "u1", prompt: "hi" }, 5000]);
    await expect(api.projectsFor("claude")).rejects.toThrow("the Agents app (pomade-agents) answered roster.projectsFor with something Runner cannot read");
    const failing = (code: ConstructorParameters<typeof HostError>[0]) => agentsApi(() => Promise.reject(new HostError(code, "no agent \"x\"")));
    await expect(failing("app-absent").roster()).rejects.toThrow("the Agents app (pomade-agents) is not running");
    await expect(failing("app-not-responding").roster()).rejects.toThrow("the Agents app (pomade-agents) is not answering");
    await expect(failing("not-found").lastMessage("x")).rejects.toMatchObject({ code: "not-found" });
    await expect(failing("invalid-params").launchSpec({ agent: "x", mode: "y" })).rejects.toBeInstanceOf(AgentsError);
  });

  it("gives an agent its provider's modes when the roster names none, and modes their words", () => {
    const codex = { id: "codex", name: "Codex", command: "codex", provider: "codex" as const };
    expect(agentModes(codex).map((mode) => mode.id)).toEqual(["normal", "full-autonomy"]);
    expect(agentMode({ ...codex, modes: [{ id: "normal", name: "Normal", args: [] }] }, "full-autonomy")).toBeUndefined();
    expect([modeWords("normal"), modeWords("full-autonomy"), modeWords("read-only")]).toEqual(["Normal", "Full autonomy", "read-only"]);
  });
});
