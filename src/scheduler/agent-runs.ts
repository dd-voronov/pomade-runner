// An agent run's own rules (docs/DESIGN.md "Agent runs"), pure: what its session runs, how its end
// reads — a turn that ended without an answer included — and which session the lookup by folder and
// start time picks.
// The launch itself — the roster, the launch spec, the keeper session — is in `runs.ts`; following
// the agent's turns in `src/keeper/agent-turns.ts`.

import type { FoundSession } from "../integrations/agents";
import type { AgentRun } from "./model";
import type { SessionEnd } from "./git-runs";

/** How long the agent has to end once Runner typed its exit command; past it, Runner stops the
 *  session — the turn was done, so the run is done all the same. */
export const AGENT_EXIT_WAIT_MS = 15_000;

/** Why an agent run fails when even a fresh keeper fails the keychain check. */
export const KEYCHAIN_LOST = "cannot start — the keeper cannot reach the macOS keychain, so the agent would have no login";

/** How often the session of a run whose provider cannot pre-assign one is looked up while it runs. */
export const SESSION_LOOKUP_EVERY_MS = 5_000;

/** How far around the session's start the lookup reaches: the agent's own record of its start and
 *  the keeper's spawn are a moment apart. */
export const SESSION_LOOKUP_SLACK_MS = 10_000;

/** What an agent run's session runs: the launch spec's line in the user's shell, interactive — the
 *  agent's command may be an alias its rc file defines — and a login shell, for the user's `PATH`. */
export function agentArgv(shell: string, line: string): string[] {
  return [shell, "-l", "-i", "-c", line];
}

/** The window `sessions.find` searches for a session started at `startedAt` (ISO 8601). */
export function lookupWindow(startedAt: string, now: Date): { startedFrom: string; startedTo: string } {
  const start = Date.parse(startedAt);
  return { startedFrom: new Date(start - SESSION_LOOKUP_SLACK_MS).toISOString(), startedTo: new Date(Math.max(now.getTime(), start) + SESSION_LOOKUP_SLACK_MS).toISOString() };
}

/** The session a lookup found for a run started at `startedAt`: the one whose start is nearest it;
 *  `null` for none. Two sessions started together in one folder are told apart by that alone. */
export function pickSession(found: readonly FoundSession[], startedAt: string): FoundSession | null {
  const start = Date.parse(startedAt);
  let best: FoundSession | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const session of found) {
    const off = Math.abs(Date.parse(session.startedAt) - start);
    if (Number.isNaN(off) || off >= distance) continue;
    best = session;
    distance = off;
  }
  return best;
}

/** An agent run's end, from its session's end as a script's reads (`endOf`): once its turn was done
 *  and Runner typed the exit command, the agent's exit — or Runner's stop when it did not exit in
 *  time — is **done**; an end before that is **failed**, an exit with status 0 included. A stop by
 *  you, a time limit and a lost session read as for a script. */
export function agentEnd(end: SessionEnd, agent: AgentRun, exitReason: string | null): SessionEnd {
  if (end.state === "stopped-by-you" || end.limitHit !== null || exitReason === null || exitReason === "lost-in-keeper-crash") return end;
  if (agent.exitSentAt !== null) {
    if (exitReason === "exited" || exitReason === "stopped") return { ...end, state: "done", reason: null };
    return end;
  }
  if (exitReason === "exited") return { ...end, state: "failed", reason: "the agent exited before its turn was done" };
  return end;
}

/** Whether the agent answered in the session whose turn ended, as the Agents app's
 *  `sessions.lastMessage` says: a message (`answered`), none (`none` — an API error such as "Not
 *  logged in" ends a turn with none), or it could not be asked (`unknown`: the app not answering,
 *  Pomade gone, no session id). */
export type TurnAnswer = "answered" | "none" | "unknown";

/** Why an agent run whose turn ended without an answer failed. */
export const NO_ANSWER_REASON = "the agent's turn ended without an answer";

/** An agent run's end once its answer is known: a run `agentEnd` read as done whose agent never
 *  answered is **failed**, `NO_ANSWER_REASON`; an unknown answer leaves it as it was. */
export function answeredEnd(end: SessionEnd, answer: TurnAnswer): SessionEnd {
  if (end.state !== "done" || answer !== "none") return end;
  return { ...end, state: "failed", reason: NO_ANSWER_REASON };
}
