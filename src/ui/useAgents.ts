// The Agents app (`pomade-agents`) as Runner's frames read it, through Pomade's broker
// (`src/integrations/agents.ts`): the roster for the job form's Agent and Mode, the projects
// connected to an agent for its Folder, and a session's last message for an agent run's result card.
// Each is asked when it is needed; an Agents app that is not there or not answering is a state of its
// own, which the form and the card say in words.

import { useEffect, useState } from "react";
import type { RosterAgent } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { AgentsError, agentsOf, type LastMessage } from "../integrations/agents";

export type AgentsState<T> =
  | { status: "loading" }
  /** The Agents app is not installed, not running or not answering. */
  | { status: "absent"; message: string }
  | { status: "failed"; message: string }
  | { status: "ready"; value: T };

function useAsk<T>(host: HostClient, key: string | null, ask: (api: ReturnType<typeof agentsOf>) => Promise<T>): AgentsState<T> {
  const [state, setState] = useState<{ key: string | null; state: AgentsState<T> }>({ key, state: { status: "loading" } });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    ask(agentsOf(host)).then(
      (value) => {
        if (live) setState({ key, state: { status: "ready", value } });
      },
      (err: unknown) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ key, state: err instanceof AgentsError && err.code === "absent" ? { status: "absent", message } : { status: "failed", message } });
      },
    );
    return () => {
      live = false;
    };
    // `ask` follows from `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, key]);
  return state.key === key ? state.state : { status: "loading" };
}

/** The agents Runner may run, in roster order. */
export function useRoster(host: HostClient): AgentsState<RosterAgent[]> {
  return useAsk(host, "roster", (api) => api.roster());
}

/** The stable ids of the projects connected to `agent`; loading while no agent is chosen. */
export function useProjectsFor(host: HostClient, agent: string | null): AgentsState<string[]> {
  return useAsk(host, agent, (api) => api.projectsFor(agent ?? ""));
}

/** A session's last message; `null` while the agent has not answered. Loading without a session. */
export function useLastMessage(host: HostClient, session: string | null): AgentsState<LastMessage | null> {
  return useAsk(host, session, (api) => api.lastMessage(session ?? ""));
}
