// Host API calls Pomade serves that Runner's `pomade-kit` client has no method for yet
// (`src/integrations/pomade-next.ts`): sent as plain `call` messages over the frame's own transport,
// the one `connect` was given, under ids of their own (`next-<n>`) that the kit's client ignores.
// When the pin reaches the kit that brings them, this goes and the callers use `host.git.reveal`.
//
// `git.reveal` is feature-detected: once per UI session — on the first card that could offer it —
// a probe call with an empty `path`, which a Pomade that serves the call refuses as `invalid-params`
// (or `not-found`) before it does anything, and an older one as `unknown-method`. Nothing moves in
// Pomade either way. The verdict is kept for the session; an answer that says neither (not ready,
// no answer in time) is not kept, so the next card asks again.

import { createContext, useContext, useEffect, useState } from "react";
import { CHANNEL, parseHostMessage, type AppToHostMessage, type ErrorCode, type JsonValue } from "pomade-kit/protocol";
import { HostError, type Transport } from "pomade-kit/sdk";

import { GIT_REVEAL_METHOD, type GitRevealParams } from "../integrations/pomade-next";

/** How long a call waits for Pomade's answer. */
const CALL_TIMEOUT_MS = 5000;

/** Calls a Host API method by name; rejects with `HostError` as the kit's client does. */
export interface PlatformCaller {
  call(method: string, params: JsonValue): Promise<unknown>;
}

/** A caller over `transport` — the transport the kit's client was connected with. */
export function transportCaller(transport: Transport): PlatformCaller {
  let next = 1;
  return {
    call(method, params) {
      const id = `next-${next++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unlisten();
          reject(new HostError("app-not-responding", `Pomade did not answer ${method}`));
        }, CALL_TIMEOUT_MS);
        const unlisten = transport.listen((data) => {
          const msg = parseHostMessage(data);
          if (msg?.type !== "result" || msg.id !== id) return;
          clearTimeout(timer);
          unlisten();
          if (msg.ok) resolve(msg.value);
          else reject(new HostError(msg.error.code, msg.error.message));
        });
        // The kit's message type names only the methods its map has; these are not in it yet.
        transport.send({ channel: CHANNEL, type: "call", id, method, params } as unknown as AppToHostMessage);
      });
    },
  };
}

/** The frame's caller; `null` outside Pomade. */
export const PlatformCalls = createContext<PlatformCaller | null>(null);

/** What a probe's answer says of the call: Pomade has it, has not, or cannot tell yet. */
export function revealVerdict(answer: { ok: true } | { ok: false; code: ErrorCode | null }): boolean | null {
  if (answer.ok) return true;
  if (answer.code === "invalid-params" || answer.code === "not-found") return true;
  if (answer.code === "unknown-method" || answer.code === "capability-denied") return false;
  return null;
}

const probes = new WeakMap<PlatformCaller, Promise<boolean | null>>();

function probe(caller: PlatformCaller): Promise<boolean | null> {
  const known = probes.get(caller);
  if (known !== undefined) return known;
  const asked = caller.call(GIT_REVEAL_METHOD, { path: "" }).then(
    () => revealVerdict({ ok: true }),
    (err: unknown) => revealVerdict({ ok: false, code: err instanceof HostError ? err.code : null }),
  );
  probes.set(caller, asked);
  void asked.then((verdict) => {
    if (verdict === null) probes.delete(caller);
  });
  return asked;
}

/** `git.reveal` when this Pomade serves it, else `null` — while the probe is out too. `ask` false
 *  sends no probe (a card with no failed repo). */
export function useGitReveal(ask: boolean): ((params: GitRevealParams) => Promise<void>) | null {
  const caller = useContext(PlatformCalls);
  const [served, setServed] = useState(false);
  useEffect(() => {
    if (caller === null || !ask) return;
    let live = true;
    void probe(caller).then((verdict) => {
      if (live) setServed(verdict === true);
    });
    return () => {
      live = false;
    };
  }, [caller, ask]);
  if (caller === null || !served) return null;
  return async (params) => {
    await caller.call(GIT_REVEAL_METHOD, { ...params });
  };
}
