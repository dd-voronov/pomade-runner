// Runner's client of the Agents app (`pomade-agents`) through Pomade's broker: the roster (agents,
// their modes), the projects connected to an agent, a launch's command line, a session found by
// folder and start time, and a session's last message. The contract is the Agents app's published
// API — `../pomade-agents/docs/CONTRACTS.md` "Roster" and "Reads for Runner"; `roster.list` and its
// `RosterAgent` are `pomade-kit/protocol`'s, the other shapes are defined here, each answer checked
// before it is trusted. Runner keeps no table of providers: what to run, the session id and what to
// type to end the agent all come from the launch spec. Pure but for the call it is given: shared by
// the scheduler (the launch, the session lookup) and the UI (the form's pickers, the result card).

import { checkRosterList, providerModes, ROSTER_APP_ID, ROSTER_METHOD, type JsonValue, type RosterAgent, type RosterMode } from "pomade-kit/protocol";
import { HostError } from "pomade-kit/sdk";

/** The Agents app's id: whose API this is. */
export const AGENTS_APP_ID = ROSTER_APP_ID;

export const LAUNCH_SPEC_METHOD = "roster.launchSpec";
export const PROJECTS_FOR_METHOD = "roster.projectsFor";
export const LAST_MESSAGE_METHOD = "sessions.lastMessage";
export const FIND_SESSIONS_METHOD = "sessions.find";

/** How long a call to the Agents app may take before it counts as not answering. */
export const AGENTS_CALL_TIMEOUT_MS = 5_000;

/** `roster.launchSpec`'s params: `mode` always; a new session's id (a UUID Runner makes); the prompt. */
export interface LaunchSpecParams {
  agent: string;
  mode: string;
  sessionId?: string;
  prompt?: string;
}

/** `roster.launchSpec`'s answer: what one launch runs. */
export interface LaunchSpec {
  /** The profile's command, as typed (it may be a shell alias). */
  command: string;
  args: string[];
  /** `command` and `args`, quoted: one POSIX-shell line, run as it is in an interactive shell. */
  line: string;
  /** The id the launched session will have; `null` when the provider cannot pre-assign one — then
   *  the session is found with `sessions.find`. */
  sessionId: string | null;
  /** What to type to end the agent ("/exit"). */
  exit: string;
}

/** `sessions.find`'s params: the start folder (absolute, symlinks resolved) and a window of start
 *  times (ISO 8601 with a zone, both ends included). */
export interface FindSessionsParams {
  cwd: string;
  startedFrom: string;
  startedTo: string;
  agent?: string;
}

/** A session `sessions.find` found. */
export interface FoundSession {
  id: string;
  provider: string;
  agent: string;
  cwd: string;
  startedAt: string;
  lastActiveAt: string;
}

/** An agent's last answer in a session: Markdown, at most 4000 characters. */
export interface LastMessage {
  text: string;
  /** When it was written (ISO 8601); `null` when the record has none. */
  at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string";

export function isLaunchSpec(value: unknown): value is LaunchSpec {
  if (!isRecord(value)) return false;
  const { command, args, line, sessionId, exit } = value;
  return isText(command) && Array.isArray(args) && args.every(isText) && isText(line) && line.trim() !== "" && !/[\r\n]/.test(line) && (sessionId === null || isText(sessionId)) && isText(exit) && exit !== "";
}

function isFoundSession(value: unknown): value is FoundSession {
  if (!isRecord(value)) return false;
  const { id, provider, agent, cwd, startedAt, lastActiveAt } = value;
  return isText(id) && id !== "" && isText(provider) && isText(agent) && isText(cwd) && isText(startedAt) && isText(lastActiveAt);
}

/** `sessions.find`'s answer, `{ sessions }`; `null` when it is not that. */
export function checkFoundSessions(value: unknown): FoundSession[] | null {
  return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isFoundSession) ? value.sessions : null;
}

/** `sessions.lastMessage`'s answer, `{ message }`; `undefined` when it is not that. */
export function checkLastMessage(value: unknown): LastMessage | null | undefined {
  if (!isRecord(value)) return undefined;
  const { message } = value;
  if (message === null) return null;
  return isRecord(message) && isText(message.text) && (message.at === null || isText(message.at)) ? { text: message.text, at: message.at } : undefined;
}

/** `roster.projectsFor`'s answer, `{ projects }`; `null` when it is not that. */
export function checkProjectsFor(value: unknown): string[] | null {
  return isRecord(value) && Array.isArray(value.projects) && value.projects.every(isText) ? value.projects : null;
}

/** A call to the Agents app failed, in words fit for a run's reason or the form's note: it is not
 *  there or not answering (`absent`), it answered something the contract does not have, or it
 *  refused (`not-found`: no such agent or session; `invalid-params`: a mode it does not enable). */
export class AgentsError extends Error {
  constructor(
    readonly code: "absent" | "malformed" | "not-found" | "refused",
    message: string,
  ) {
    super(message);
  }
}

/** The broker call the client goes through: `host.apps.call` of a connected client. */
export type AgentsCall = (method: string, params: JsonValue, timeoutMs: number) => Promise<unknown>;

/** The Agents app, as Runner asks it. Each method rejects with an `AgentsError`. */
export interface AgentsApi {
  /** The agents Runner may run, in roster order, hidden ones left out. */
  roster(): Promise<RosterAgent[]>;
  /** The stable ids of the projects connected to the agent, in the Projects panel's order. */
  projectsFor(agent: string): Promise<string[]>;
  launchSpec(params: LaunchSpecParams): Promise<LaunchSpec>;
  findSessions(params: FindSessionsParams): Promise<FoundSession[]>;
  /** `null` while the agent has not answered. */
  lastMessage(session: string): Promise<LastMessage | null>;
}

const APP_WORDS = "the Agents app (pomade-agents)";

/** A broker error in words. */
function agentsError(err: unknown, what: string): AgentsError {
  if (err instanceof HostError) {
    if (err.code === "app-absent" || err.code === "unknown-method" || err.code === "capability-denied") return new AgentsError("absent", `${APP_WORDS} is not running`);
    if (err.code === "app-not-responding") return new AgentsError("absent", `${APP_WORDS} is not answering`);
    if (err.code === "not-found") return new AgentsError("not-found", err.message);
    return new AgentsError("refused", `${APP_WORDS} refused ${what}: ${err.message}`);
  }
  return new AgentsError("absent", `${APP_WORDS} could not be asked: ${err instanceof Error ? err.message : String(err)}`);
}

/** The Agents app through `call`. */
export function agentsApi(call: AgentsCall): AgentsApi {
  const ask = async <T>(method: string, params: JsonValue, what: string, check: (value: unknown) => T | null | undefined): Promise<T> => {
    let value: unknown;
    try {
      value = await call(method, params, AGENTS_CALL_TIMEOUT_MS);
    } catch (err) {
      throw agentsError(err, what);
    }
    const checked = check(value);
    if (checked === null || checked === undefined) throw new AgentsError("malformed", `${APP_WORDS} answered ${method} with something Runner cannot read`);
    return checked;
  };
  return {
    roster: () =>
      ask(ROSTER_METHOD, {}, "the roster", (value) => {
        const checked = checkRosterList(value);
        return checked.ok ? checked.agents : null;
      }),
    projectsFor: (agent) => ask(PROJECTS_FOR_METHOD, { agent }, `the projects of ${agent}`, checkProjectsFor),
    launchSpec: (params) => ask(LAUNCH_SPEC_METHOD, { ...params }, `a launch of ${params.agent}`, (value) => (isLaunchSpec(value) ? value : null)),
    findSessions: (params) => ask(FIND_SESSIONS_METHOD, { ...params }, "the session lookup", checkFoundSessions),
    async lastMessage(session) {
      const answer = await ask(LAST_MESSAGE_METHOD, { id: session }, "the last message", (value) => {
        const checked = checkLastMessage(value);
        return checked === undefined ? null : { message: checked };
      });
      return answer.message;
    },
  };
}

/** The Agents app through a connected host client. */
export function agentsOf(host: { apps: { call(app: string, method: string, params?: JsonValue, options?: { timeoutMs?: number }): Promise<unknown> } }): AgentsApi {
  return agentsApi((method, params, timeoutMs) => host.apps.call(AGENTS_APP_ID, method, params, { timeoutMs }));
}

/** An agent's modes: the roster's, else its provider's (Normal, Full autonomy). */
export function agentModes(agent: RosterAgent): RosterMode[] {
  return agent.modes ?? providerModes(agent.provider);
}

/** An agent's mode by its id; `undefined` when the agent has no such mode. */
export function agentMode(agent: RosterAgent, mode: string): RosterMode | undefined {
  return agentModes(agent).find((candidate) => candidate.id === mode);
}

/** The mode that skips every approval: the Full-autonomy warning's. */
export const FULL_AUTONOMY_MODE = "full-autonomy";

/** A mode's name in words when the roster is not at hand: "Normal", "Full autonomy", else its id. */
export function modeWords(mode: string): string {
  if (mode === "normal") return "Normal";
  if (mode === FULL_AUTONOMY_MODE) return "Full autonomy";
  return mode;
}
