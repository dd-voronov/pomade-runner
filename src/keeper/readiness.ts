// A service's readiness checks that need the network (docs/ARCHITECTURE.md "Services"): `ready: { port }`
// is up once the port on this Mac accepts a connection, `ready: { url }` once the URL answers at all
// — any HTTP status, a redirect included: the server is up, whatever it says.

import { createConnection } from "node:net";

import type { Readiness } from "../jobs/model";

/** A check that needs the network: a port or a URL. */
export type NetworkReadiness = Exclude<Readiness, { kind: "alive" }>;

/** How long one probe waits for an answer. */
const PROBE_TIMEOUT_MS = 1_000;

function portAccepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function urlAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** Whether the check passes now. A port is tried on IPv4 and IPv6 loopback: a server may listen on either. */
export async function probeReadiness(ready: NetworkReadiness): Promise<boolean> {
  if (ready.kind === "url") return urlAnswers(ready.url);
  const answers = await Promise.all([portAccepts("127.0.0.1", ready.port), portAccepts("::1", ready.port)]);
  return answers.includes(true);
}
