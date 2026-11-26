// Pomade opened for agent runs (docs/ARCHITECTURE.md "Agent runs"): an agent run's launch spec comes from
// the Agents app through Pomade's broker, so one due while Pomade is not up for it waits while
// Runner opens Pomade — `pomade-kit/node`'s `launchPomade()`, which runs the launch Pomade recorded
// in `host.json` and waits for its socket to answer — and then waits, within a bound, until
// Runner's own connection is back, Pomade is ready (`pomade.ready`) and the Agents app answers its
// roster. One launch at a time: every agent run that comes due meanwhile waits for the same one.

import type { LaunchResult } from "pomade-kit/node";

import type { AgentsApi } from "./agents";

/** How long Runner waits, once Pomade's socket answered, for its connection, Pomade's ready and the
 *  Agents app's roster: Pomade loads its apps after it answers. */
export const POMADE_UP_WAIT_MS = 60_000;

/** How often it looks while it waits. */
export const POMADE_UP_POLL_MS = 250;

/** Pomade for agent runs, as the run lifecycle sees it. */
export interface PomadeForRuns {
  /** Whether an agent run can start now: Runner is connected to Pomade, Pomade is ready, and no
   *  launch of it is under way. */
  up(): boolean;
  /** Open Pomade, or join the opening under way; resolves `null` once it is up for agent runs,
   *  else why it is not — words that follow "cannot start — ". */
  open(): Promise<string | null>;
}

export interface PomadeOpenOptions {
  /** Start Pomade the way it recorded, and wait for its socket to answer (`launchPomade`). */
  launch(): Promise<LaunchResult>;
  /** Whether Runner's own connection to Pomade is up. */
  connected(): boolean;
  /** The Agents app through Runner's connection once Pomade is ready; `null` before. */
  agents(): AgentsApi | null;
  /** Connect at once, rather than at the connection's next retry. */
  reconnect(): void;
  log(message: string): void;
  /** Default `POMADE_UP_WAIT_MS`. */
  upWaitMs?: number;
  /** Default `POMADE_UP_POLL_MS`. */
  pollMs?: number;
  /** A monotonic clock (ms); default `performance.now()` — Pomade's own time, whatever the
   *  scheduler's clock says. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Opens Pomade for agent runs. */
export function pomadeOpener(options: PomadeOpenOptions): PomadeForRuns {
  const upWaitMs = options.upWaitMs ?? POMADE_UP_WAIT_MS;
  const pollMs = options.pollMs ?? POMADE_UP_POLL_MS;
  const now = options.now ?? ((): number => performance.now());
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  let opening: Promise<string | null> | null = null;

  /** Wait until Runner is connected, Pomade ready and the Agents app answers; why not, at the bound. */
  async function untilUp(opened: string): Promise<string | null> {
    const deadline = now() + upWaitMs;
    const after = `after ${Math.round(upWaitMs / 1000)} s`;
    for (;;) {
      let why: string;
      const api = options.agents();
      if (api !== null) {
        try {
          await api.roster();
          return null;
        } catch (err) {
          why = `${opened}, but ${after} ${errorText(err)}`;
        }
      } else {
        why = options.connected() ? `${opened}, but ${after} it has not finished starting` : `${opened}, but ${after} Runner cannot connect to it`;
      }
      if (now() >= deadline) return why;
      await sleep(pollMs);
    }
  }

  async function openNow(): Promise<string | null> {
    if (options.connected()) return untilUp("Pomade is running");
    options.log("Pomade: opening it for an agent run");
    const launched = await options.launch();
    if (launched.status === "failed") return `Pomade could not be opened: ${launched.reason}`;
    if (launched.status === "rejected") return `Pomade refused Runner (${launched.reason})`;
    // Runner's own connection serves its API; this one only told that Pomade answers.
    launched.host.close();
    options.log(launched.launched ? `Pomade: opened${launched.pid === undefined ? "" : ` (pid ${launched.pid})`}; waiting until it is ready` : "Pomade: it was running; waiting until it is ready");
    if (!options.connected()) options.reconnect();
    return untilUp(launched.launched ? "Pomade opened" : "Pomade is running");
  }

  return {
    up: () => opening === null && options.agents() !== null,
    open() {
      opening ??= openNow()
        .catch((err: unknown) => `Pomade could not be opened: ${errorText(err)}`)
        .finally(() => {
          opening = null;
        });
      return opening;
    },
  };
}
