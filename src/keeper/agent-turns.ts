// Following an agent run's turns: the scheduler attaches to the run's keeper session as a viewer
// and replays its output into the kit's agent-state scanner (`pomade-kit/scanners`), which reads
// the provider's own screen and window title. A permission or trust prompt on screen is a wait for
// the person, told when it comes and when it goes — answered, the agent works again. The agent
// working is told too: an agent that never does waits for the person at a screen no scanner names
// (`runs.ts`). A turn that ends with background work going — a shell the agent left running — is
// not done: the run is told, and waits for the work; the agent goes on by itself once it ends. When
// the turn completes — the agent was working and is idle with no background work, no prompt
// pending — the run is told once; it then types the launch spec's exit command through the same
// attachment. The agent answering that command with its background-work question is told too: the
// run declines it, and once the agent is idle again the run waits for the turn's end afresh. The
// scanner is made afresh on every snapshot (an attach, a reconnect after a keeper update, a
// resync, a scheduler restart), so it reads the screen as the session shows it: a prompt on it is a
// wait, a screen without one ends a wait the run still had. The output arrives as text the keeper
// decoded as a stream (node-pty's, and the attach socket's, UTF-8 decoding), so a character split
// across two reads reaches the scanner whole.

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

/** A prompt that waits for the person: the scanner's prompts but the background-work question,
 *  which only ever answers Runner's own exit command. */
export type PersonPrompt = Exclude<AgentPrompt, "background">;

/** What a followed agent run is told. */
export interface TurnHandlers {
  /** The agent works: once per following — again after a snapshot made it afresh. */
  onWorking(): void;
  /** Its turn completed — idle with no background work: once, until it is waited for afresh. */
  onTurnDone(): void;
  /** It waits at a prompt for the person (`prompt`), or no longer does (`null`); told on a change only. */
  onWaiting(prompt: PersonPrompt | null): void;
  /** Its turn ended with background work going, or it stayed with that work after declining the
   *  exit (`true`); it works again (`false`). Told on a change only. */
  onBackground(going: boolean): void;
  /** It answered the exit command with its background-work question. */
  onBackgroundQuestion(): void;
}

/** Where a followed agent's turn is: not yet seen working (`before`), working (`turn`), idle with
 *  background work going (`background`), done with the exit command typed (`exit`), or answering
 *  that command with its background-work question (`asked`). */
type Phase = "before" | "turn" | "background" | "exit" | "asked";

/** A turn's progress as the scanner reports it (`onState`), and the screen a fresh snapshot shows
 *  once read (`onScreen`): a prompt is a wait until the agent works or idles again, or a screen
 *  shows none; the turn is done once the agent went from working to idle with no background work —
 *  at once, or once that work ended — and a prompt pending is never idle. After the exit command,
 *  the agent working is the command's moment of work, not a new turn; its background-work question
 *  is told, and the agent idle after it is back to waiting for the turn's end. The first snapshot's
 *  screen without a prompt is told even with no wait known: the run followed afresh may keep one
 *  from before — a prompt answered while the scheduler was down. */
export function turnTracker(handlers: TurnHandlers): { onState(state: AgentState): void; onScreen(state: AgentState): void } {
  let phase: Phase = "before";
  let sawWorking = false;
  let waiting: PersonPrompt | null = null;
  let screened = false;
  const wait = (prompt: PersonPrompt | null): void => {
    if (prompt === waiting) return;
    waiting = prompt;
    handlers.onWaiting(prompt);
  };
  return {
    onState(state) {
      if (state.kind === "unknown") return;
      if (state.kind === "waiting" && state.prompt !== "background") return wait(state.prompt);
      wait(null);
      if (state.kind === "waiting") {
        if (phase !== "exit") return;
        phase = "asked";
        return handlers.onBackgroundQuestion();
      }
      if (state.kind === "working") {
        if (!sawWorking) handlers.onWorking();
        sawWorking = true;
        if (phase === "exit" || phase === "asked") return;
        if (phase === "background") handlers.onBackground(false);
        phase = "turn";
        return;
      }
      if (phase === "asked") {
        phase = "background";
        return handlers.onBackground(true);
      }
      if (phase === "turn" && state.background) {
        phase = "background";
        return handlers.onBackground(true);
      }
      if ((phase === "turn" || phase === "background") && !state.background) {
        phase = "exit";
        handlers.onTurnDone();
      }
    },
    onScreen(state) {
      const first = !screened;
      screened = true;
      if (state.kind === "waiting" && state.prompt !== "background") return;
      if (first && waiting === null) handlers.onWaiting(null);
      else wait(null);
    },
  };
}

export interface AgentTurns {
  /** Follow a running agent run's session and tell it its waits and its turn's end. A session
   *  followed already is left as it is. */
  watch(session: string, provider: AgentKind, handlers: TurnHandlers): void;
  /** Type `text` and then Enter into a followed session. */
  type(session: string, text: string): void;
  /** Press a key — `data` as it is, no Enter — in a followed session. */
  press(session: string, data: string): void;
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
        onWorking() {
          log(`session ${session}: the agent works`);
          handlers.onWorking();
        },
        onTurnDone() {
          log(`session ${session}: the agent's turn is done`);
          handlers.onTurnDone();
        },
        onWaiting(prompt) {
          log(prompt === null ? `session ${session}: no prompt waits any more` : `session ${session}: the agent waits at a ${prompt} prompt`);
          handlers.onWaiting(prompt);
        },
        onBackground(going) {
          log(going ? `session ${session}: the agent is idle with background work going` : `session ${session}: the agent works again`);
          handlers.onBackground(going);
        },
        onBackgroundQuestion() {
          log(`session ${session}: the agent answers the exit command with its background-work question`);
          handlers.onBackgroundQuestion();
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
            // The snapshot redraws the screen, the window title last: what it shows once read is
            // whether a prompt waits.
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
    press(session, data) {
      followed.get(session)?.follower.input(data);
    },
    unwatch,
    watched: () => [...followed.keys()],
    close() {
      for (const session of [...followed.keys()]) unwatch(session);
    },
  };
}
