import { CHANNEL } from "pomade-kit/protocol";
import { HostError, type Transport } from "pomade-kit/sdk";
import { describe, expect, it } from "vitest";

import { revealVerdict, transportCaller } from "./platformCalls";

/** A transport whose host answers each call with `answer(method, params)`; it records what was sent. */
function fakeTransport(answer: (method: string, params: unknown) => { ok: true; value: unknown } | { ok: false; code: string }): { transport: Transport; sent: unknown[] } {
  const listeners = new Set<(data: unknown) => void>();
  const sent: unknown[] = [];
  const transport: Transport = {
    send(message) {
      sent.push(message);
      const call = message as unknown as { id: string; method: string; params: unknown };
      const reply = answer(call.method, call.params);
      // Another client's result first: the caller ignores ids that are not its own.
      for (const listener of [...listeners]) listener({ channel: CHANNEL, type: "result", id: "1", ok: true, value: "not mine" });
      const result = reply.ok ? { channel: CHANNEL, type: "result", id: call.id, ok: true, value: reply.value } : { channel: CHANNEL, type: "result", id: call.id, ok: false, error: { code: reply.code, message: "no" } };
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(result);
      });
    },
    listen(onMessage) {
      listeners.add(onMessage);
      return () => listeners.delete(onMessage);
    },
  };
  return { transport, sent };
}

describe("calls the kit's client has no method for yet", () => {
  it("a call goes as a plain `call` message under its own id; its result resolves it", async () => {
    const { transport, sent } = fakeTransport(() => ({ ok: true, value: {} }));
    await expect(transportCaller(transport).call("git.reveal", { path: "/ws/notes", projectId: "notes" })).resolves.toEqual({});
    expect(sent).toEqual([{ channel: CHANNEL, type: "call", id: "next-1", method: "git.reveal", params: { path: "/ws/notes", projectId: "notes" } }]);
  });

  it("an error result rejects with its HostError code", async () => {
    const { transport } = fakeTransport(() => ({ ok: false, code: "unknown-method" }));
    const err: unknown = await transportCaller(transport).call("git.reveal", { path: "" }).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe("unknown-method");
  });

  it("the probe's answer: refused params or a missing repo mean the call is there; unknown-method or no capability, not; anything else, not known yet", () => {
    expect(revealVerdict({ ok: false, code: "invalid-params" })).toBe(true);
    expect(revealVerdict({ ok: false, code: "not-found" })).toBe(true);
    expect(revealVerdict({ ok: true })).toBe(true);
    expect(revealVerdict({ ok: false, code: "unknown-method" })).toBe(false);
    expect(revealVerdict({ ok: false, code: "capability-denied" })).toBe(false);
    expect(revealVerdict({ ok: false, code: "not-ready" })).toBeNull();
    expect(revealVerdict({ ok: false, code: "app-not-responding" })).toBeNull();
    expect(revealVerdict({ ok: false, code: null })).toBeNull();
  });
});
