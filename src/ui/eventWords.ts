// What a service event's card says (the prototype's `evCardHtml`, its `EVT` texts): the cause in a
// sentence, the cause beside the time in its head, and how the session it started ended. Pure.

import { LOOP_CRASHES } from "../keeper/model";
import { SERVICE_CAUSE_WORDS, type RunRecord, type ServiceEventKind } from "../scheduler/model";
import type { EventRecord } from "./runLook";
import { shortClock, whenWords } from "./serviceWords";

/** A chain's action, as "<name> restarts after Pull" says it. */
const CHAIN_VERBS: Record<ServiceEventKind, string> = { started: "starts", stopped: "stops", restarted: "restarts", "gave-up": "gives up" };

/** A chain's action, as "the restart failed" says it. */
const ACTION_NOUNS: Record<ServiceEventKind, string> = { started: "start", stopped: "stop", restarted: "restart", "gave-up": "give-up" };

/** The cause beside the time in the card's head: "by you", "first open of shop", "Mac startup";
 *  a chain's names its parent on the card itself. */
export function causeMeta(view: EventRecord): string {
  const { cause, detail } = view.event;
  if (cause === "you") return "by you";
  if (cause === "first-open") return detail === null ? "first open" : `first open of ${detail}`;
  return SERVICE_CAUSE_WORDS[cause];
}

/** What caused a service event, in a sentence or two. */
export function causeSentence(view: EventRecord): string {
  const { event, name } = view;
  const at = shortClock(view.dueAt);
  switch (event.cause) {
    case "crash":
      if (event.what === "gave-up") {
        return view.reason === null
          ? `It crashed ${LOOP_CRASHES} times within 1 minute, so Runner stopped restarting it.`
          : `It could not start: ${view.reason}. It failed ${LOOP_CRASHES} times within 1 minute, so Runner stopped trying.`;
      }
      return event.restarts > 1
        ? `It ended by itself ${event.restarts} times between ${at} and ${shortClock(view.endedAt)}; Runner restarted it each time.`
        : "It ended by itself; Runner restarted it.";
    case "login":
      return "You logged in to the Mac; Runner started its always-on services one by one.";
    case "runner-started":
      return `Runner started again within the same Mac login — after an update or a restart — and found ${name} not running, so it started it.`;
    case "first-open":
      return `You opened ${event.detail ?? "its project"} for the first time since Pomade started.`;
    case "pomade-started":
      return `Pomade started at ${at}; ${name} runs while Pomade runs.`;
    case "pomade-quit":
      return `Pomade quit at ${at}; ${name} runs only while Pomade runs.`;
    case "you":
      if (event.what === "started") return "You pressed Start.";
      if (event.what === "restarted") return "You pressed Restart: Runner stopped it and started it again with its job file as it is now.";
      return event.detail === "tab" ? "You stopped it in its terminal tab (Ctrl+C, or the tab’s Stop). It stays stopped until you press Start." : "You pressed Stop. It stays stopped until you press Start.";
    case "chain": {
      const parent = view.cause?.kind === "chain" ? view.cause : null;
      const what = parent === null ? `Another job finished at ${at}` : `${parent.name} ${parent.result === "done" ? "was done" : "failed"} at ${at}`;
      const follows = `${what}, and ${name} ${CHAIN_VERBS[event.what]} after it`;
      if (view.state === "skipped") return `${follows} — but ${view.reason ?? "there was nothing to do"}, so the chain did nothing.`;
      if (view.state === "failed") return `${follows} — the ${ACTION_NOUNS[event.what]} failed: ${view.reason ?? "the keeper refused it"}.`;
      return `${follows}.`;
    }
    case "keeper":
      return event.what === "restarted"
        ? "Runner’s keeper, which holds the services’ terminals, ended, and the session with it; Runner started it again."
        : "Runner’s keeper, which holds the services’ terminals, ended, and the session with it; it was not due to start again.";
    case "job-file":
      if (event.detail === "disabled") return "Its job file was turned off (enabled: false).";
      if (event.detail === "removed") return "Its job file was deleted.";
      if (event.detail === "moved") return "Its project moved, so Runner restarted it under its new id.";
      return "Its job file was made or turned on, so it started.";
  }
}

/** How the event `ender` ended a session: "it crashed", "stopped by you", "Pomade quit". */
export function endedByWords(ender: RunRecord): string {
  const event = ender.event;
  if (event === null) return "";
  if (event.what === "gave-up") return "it crashed; Runner gave up";
  if (event.cause === "crash") return "it crashed";
  if (event.cause === "keeper") return "the keeper ended";
  if (event.cause === "pomade-quit") return "Pomade quit";
  if (event.cause === "job-file") return event.detail === "disabled" ? "turned off in its file" : event.detail === "removed" ? "its file was deleted" : "its project moved";
  const by = event.cause === "chain" ? "a chain" : "you";
  return event.what === "restarted" ? `restarted by ${by}` : `stopped by ${by}`;
}

/** When a session ended, as the card says it: "11:20" today, "yesterday 19:05", "Mon 9:02". */
export function endedWhen(at: number, now: number): string {
  return whenWords(at, now).replace(/^today /, "");
}

/** When `ender` ended the session `session`: a crash window's first crash at its first restart,
 *  any other session at the event's time. */
export function endedAt(ender: RunRecord, session: number): number {
  const ended = ender.event?.ended ?? [];
  return ended[0] === session || ender.event?.restarts === 0 ? ender.dueAt : ender.endedAt;
}
