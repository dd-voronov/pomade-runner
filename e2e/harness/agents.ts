// A stand-in for the Agents app (`pomade-agents`) in the fake host: the calls Runner's frames make,
// with the published contract's shapes (`../pomade-agents/docs/CONTRACTS.md` "Roster", "Reads for
// Runner") — the prototype's roster (`AGENTS`: claude, claude-editor, claude-coder, claude-pm with
// Normal only, codex with a third mode), the projects connected to each, and a session's last
// message from `window.agentMessages` (a session it lacks is `not-found`). `?agents=none` leaves
// it out, so the frames find the Agents app absent; `?agents=silent` keeps it from answering.

import type { RosterAgent } from "pomade-kit/protocol";
import type { FakeApi } from "pomade-kit/fake-host";
import { HostError } from "pomade-kit/sdk";

const normal = { id: "normal", name: "Normal", args: [] };
const full = { id: "full-autonomy", name: "Full autonomy", args: ["--dangerously-skip-permissions"] };

export const HARNESS_ROSTER: RosterAgent[] = [
  { id: "claude", name: "claude", command: "claude", provider: "claude", modes: [normal, full] },
  { id: "claude-editor", name: "claude-editor", command: "claude-editor", provider: "claude", modes: [normal, full] },
  { id: "claude-coder", name: "claude-coder", command: "claude-coder", provider: "claude", modes: [normal, full] },
  { id: "claude-pm", name: "claude-pm", command: "claude-pm", provider: "claude", modes: [normal] },
  { id: "codex", name: "codex", command: "codex", provider: "codex", modes: [normal, { ...full, args: ["--dangerously-bypass-approvals-and-sandbox"] }, { id: "read-only", name: "Read-only", args: ["--sandbox", "read-only"] }] },
];

/** The prototype's projects connected to each agent. */
const CONNECTED: Record<string, string[]> = {
  claude: ["pomade", "blog", "shop"],
  "claude-editor": ["notes"],
  "claude-coder": ["pomade", "pomade-kit", "pomade-runner"],
  "claude-pm": ["pomade"],
  codex: ["pomade-kit"],
};

export function agentsStandIn(mode: string | null): Record<string, FakeApi> {
  if (mode === "none") return {};
  if (mode === "silent") return { "pomade-agents": "not-responding" };
  window.agentMessages = {};
  const agentOf = (id: unknown): RosterAgent => {
    const agent = HARNESS_ROSTER.find((candidate) => candidate.id === id);
    if (agent === undefined) throw new HostError("not-found", `no agent ${JSON.stringify(id)}`);
    return agent;
  };
  const param = (params: unknown, key: string): unknown => (typeof params === "object" && params !== null ? (params as Record<string, unknown>)[key] : undefined);
  return {
    "pomade-agents": {
      "roster.list": () => ({ agents: JSON.parse(JSON.stringify(HARNESS_ROSTER)) as never }),
      "roster.projectsFor": (params) => ({ projects: CONNECTED[agentOf(param(params, "agent")).id] ?? [] }),
      "sessions.lastMessage": (params) => {
        const id = param(params, "id");
        const message = typeof id === "string" ? window.agentMessages[id] : undefined;
        if (message === undefined) throw new HostError("not-found", `no session ${JSON.stringify(id)}`);
        return { message: message === null ? null : { text: message, at: "2026-11-18T07:04:12Z" } };
      },
    },
  };
}
