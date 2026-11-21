// Following an agent run's turns: the scheduler attaches to the run's keeper session as a viewer
// and replays its output into the kit's agent-state scanner (`pomade-kit/scanners`), which reads
// the provider's own screen and window title. A permission or trust prompt on screen is a wait for
// the person, told when it comes and when it goes — answered, the agent works again. When the turn
// completes — the agent was working and is idle, with no prompt pending — the run is told once; it
// then types the launch spec's exit command through the same attachment. The scanner is made
// afresh on every snapshot (an attach, a reconnect after a keeper update, a resync, a scheduler
// restart), so it reads the screen as the session shows it: a prompt on it is a wait, a screen
// without one ends a wait the run still had.

import { existsSync } from "node:fs";
import { userInfo } from "node:os";

import { followSession, type Follower } from "pomade-kit/node";
import { AgentStateScanner, type AgentKind, type AgentPrompt, type AgentState } from "pomade-kit/scanners";

import { APP_ID } from "../app";
import type { Log } from "../scheduler/log";

/** Between the exit command's text and its Enter: a CLI that reads text and Enter arriving in one
 *  chunk as a paste would not submit it. */
export const ENTER_AFTER_MS = 300;

/** The user's login shell, as the keeper finds it for a session's command: `SHELL`, else the
 *  account's, else zsh. An agent run's line runs in it. */
export function loginShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL;
  if (shell?.startsWith("/") === true && existsSync(shell)) return shell;
  try {
    const own = userInfo().shell;
    if (own !== null && existsSync(own)) return own;
  } catch {
    // No account entry: zsh, as the keeper does.
  }
  return "/bin/zsh";
}

/** What a followed agent run is told. */
export interface TurnHandlers {
  /** Its turn completed: once. */
  onTurnDone(): void;
  /** It waits at a prompt for the person (`prompt`), or no longer does (`null`); told on a change only. */
  onWaiting(prompt: AgentPrompt | null): void;
}

/** A turn's progress as the scanner reports it (`onState`), and the screen a fresh snapshot shows
 *  once read (`onScreen`): a prompt is a wait until the agent works or idles again, or a screen
 *  shows none; the turn is done once the agent went from working to idle — a prompt pending is
 *  never idle. */
export function turnTracker(handlers: TurnHandlers): { onState(state: AgentState): void; onScreen(state: AgentState): void } {
  let working = false;
  let done = false;
  let waiting: AgentPrompt | null = null;
  const wait = (prompt: AgentPrompt | null): void => {
    if (prompt === waiting) return;
    waiting = prompt;
    handlers.onWaiting(prompt);
  };
  return {
    onState(state) {
      if (state.kind === "waiting") return wait(state.prompt);
      if (state.kind === "unknown") return;
      wait(null);
      if (state.kind === "working") working = true;
      else if (working && !done) {
        done = true;
        handlers.onTurnDone();
      }
    },
    onScreen(state) {
      if (state.kind !== "waiting") wait(null);
    },
  };
}

export interface AgentTurns {
  /** Follow a running agent run's session and tell it its waits and its turn's end. A session
   *  followed already is left as it is. */
  watch(session: string, provider: AgentKind, handlers: TurnHandlers): void;
  /** Type `text` and then Enter into a followed session. */
  type(session: string, text: string): void;
  /** Stop following a session (it ended, or its run is recorded). */
  unwatch(session: string): void;
  /** Sessions followed now. */
  watched(): string[];
  close(): void;
}

export function createAgentTurns(options: { socketPath: string; log: Log }): AgentTurns {
  const { log } = options;
  /** Each followed session: its attachment, and the scanner reading its screen since the last snapshot. */
  const followed = new Map<string, { follower: Follower; screen: { scanner: AgentStateScanner | null } }>();

  const unwatch = (session: string): void => {
    const entry = followed.get(session);
    if (entry === undefined) return;
    followed.delete(session);
    entry.screen.scanner?.dispose();
    entry.follower.close();
  };

  return {
    watch(session, provider, handlers) {
      if (followed.has(session)) return;
      const track = turnTracker({
        onTurnDone() {
          log(`session ${session}: the agent's turn is done`);
          handlers.onTurnDone();
        },
        onWaiting(prompt) {
          log(prompt === null ? `session ${session}: no prompt waits any more` : `session ${session}: the agent waits at a ${prompt} prompt`);
          handlers.onWaiting(prompt);
        },
      });
      const screen: { scanner: AgentStateScanner | null } = { scanner: null };
      const follower = followSession(
        { socketPath: options.socketPath, app: APP_ID, session },
        {
          onSnapshot(data, info) {
            screen.scanner?.dispose();
            const scanner = new AgentStateScanner({ agent: provider, cols: info.cols, rows: info.rows }, track.onState);
            screen.scanner = scanner;
            scanner.push(data);
            // The snapshot redraws the screen but carries no window title: what it shows once read
            // is whether a prompt waits.
            void scanner.settled().then(() => {
              if (screen.scanner === scanner) track.onScreen(scanner.state);
            });
          },
          onDelta: (data) => screen.scanner?.push(data),
          onOutput: (data) => screen.scanner?.push(data),
          onResized: (cols, rows) => screen.scanner?.resize(cols, rows),
          onExit() {
            screen.scanner?.dispose();
            screen.scanner = null;
          },
        },
      );
      followed.set(session, { follower, screen });
    },
    type(session, text) {
      const entry = followed.get(session);
      if (entry === undefined) return;
      entry.follower.input(text);
      setTimeout(() => entry.follower.input("\r"), ENTER_AFTER_MS);
    },
    unwatch,
    watched: () => [...followed.keys()],
    close() {
      for (const session of [...followed.keys()]) unwatch(session);
    },
  };
}
