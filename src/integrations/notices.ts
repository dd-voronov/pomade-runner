// Runner's notices and badge (`pomade:E-032`), from the scheduler. A notice goes to Pomade over the
// scheduler's connection while there is one, and into Pomade's closed-Pomade queue otherwise —
// Pomade shows the queued ones on its next launch. The badge on Runner's strip icon counts Needs
// you; Pomade keeps a badge only while it runs, so the scheduler sets it again on every connection
// and when Pomade is ready.

import { postNotice, queueNotice } from "pomade-kit/node";
import type { NoticeParams } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID, STRIP_ICON } from "../app";

/** Post a notice: over `host` when given, else — or when that fails — into the queue of the Pomade
 *  whose user data is `userData`. Where it went. */
export type PostNotice = (notice: NoticeParams, host: HostClient | null) => Promise<"pomade" | "queue">;

export function noticePoster(userData: string, log: (message: string) => void): PostNotice {
  return async (notice, host) => {
    if (host !== null) {
      try {
        await postNotice(notice, { source: APP_ID, host });
        return "pomade";
      } catch (err) {
        log(`notice "${notice.title}": Pomade did not take it (${err instanceof Error ? err.message : String(err)}); queueing it`);
      }
    }
    await queueNotice(notice, { source: APP_ID, userData });
    return "queue";
  };
}

/** Set the badge on Runner's strip icon: the Needs-you count, red; 0 clears it. */
export async function setBadge(host: HostClient, count: number): Promise<void> {
  await host.strip.setBadge({ icon: STRIP_ICON, count, urgent: count > 0 });
}
