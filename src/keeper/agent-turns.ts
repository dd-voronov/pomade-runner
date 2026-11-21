// Following an agent run's turns: the scheduler attaches to the run's keeper session as a viewer
// and replays its output into the kit's agent-state scanner (`pomade-kit/scanners`), which reads
// the provider's own screen and window title. When the turn completes — the agent was working and
// is idle, with no prompt pending — the run is told once; it then types the launch spec's exit
// command through the same attachment. A permission or trust prompt is no finished turn: the run
// keeps going. The scanner is made afresh on every snapshot (an attach, a reconnect after a keeper
// update, a resync), so it reads the screen as the session shows it.

import { existsSync } from "node:fs";
import { userInfo } from "node:os";

import { followSession, type Follower } from "pomade-kit/node";
import { AgentStateScanner, type AgentKind, type AgentState } from "pomade-kit/scanners";

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

/** A turn's progress as the scanner reports it: done once it went from working to idle. Waiting at
 *  a prompt is neither. */
export function turnTracker(onDone: () => void): (state: AgentState) => void {
  let working = false;
  let done = false;
  return (state) => {
    if (state.kind === "working") working = true;
    else if (state.kind === "idle" && working && !done) {
      done = true;
      onDone();
    }
  };
}

export interface AgentTurns {
  /** Follow a running agent run's session; `onTurnDone` is called once, when its turn completes.
   *  A session followed already is left as it is. */
  watch(session: string, provider: AgentKind, onTurnDone: () => void): void;
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
    watch(session, provider, onTurnDone) {
      if (followed.has(session)) return;
      const track = turnTracker(() => {
        log(`session ${session}: the agent's turn is done`);
        onTurnDone();
      });
      const screen: { scanner: AgentStateScanner | null } = { scanner: null };
      const follower = followSession(
        { socketPath: options.socketPath, app: APP_ID, session },
        {
          onSnapshot(data, info) {
            screen.scanner?.dispose();
            screen.scanner = new AgentStateScanner({ agent: provider, cols: info.cols, rows: info.rows }, track);
            screen.scanner.push(data);
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
