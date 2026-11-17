// The caller's side of the control protocol: one request, one answer, over a short connection.

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import { createLineDecoder, encodeLine } from "pomade-kit/protocol";

import {
  CONTROL_PROTOCOL,
  RESULT_GUARDS,
  parseControlResponse,
  type ControlErrorCode,
  type ControlMethod,
  type ControlMethods,
  type ControlParams,
  type ControlRequest,
} from "./protocol";

/** How long a scheduler has to answer. */
const DEFAULT_TIMEOUT_MS = 2000;

/** Connect errors that mean no scheduler is there: no socket file, a socket file nobody serves (a
 *  killed scheduler's), or a file that is not a socket. */
const NOTHING_LISTENS: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

export type ControlCallResult<T> =
  | { status: "ok"; value: T }
  /** Nothing listens on the socket. */
  | { status: "not-running" }
  /** Something listens, and the call did not get its answer: the scheduler refused it (`code` is
   *  its error), did not answer in time (`no-answer`), or answered something else (`invalid-response`). */
  | { status: "failed"; code: ControlErrorCode | "no-answer" | "invalid-response"; message: string };

export interface ControlCallOptions {
  timeoutMs?: number;
}

/** Call `method` with its params — `null` for a method that takes none. */
export function callScheduler<M extends ControlMethod>(
  socketPath: string,
  method: M,
  params: ControlParams[M],
  options: ControlCallOptions = {},
): Promise<ControlCallResult<ControlMethods[M]>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const request: ControlRequest = { protocol: CONTROL_PROTOCOL, id: randomUUID(), method, params };
    const socket = createConnection(socketPath);
    const decoder = createLineDecoder();
    let settled = false;
    const settle = (result: ControlCallResult<ControlMethods[M]>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };
    const noAnswer = (): void => settle({ status: "failed", code: "no-answer", message: `the scheduler did not answer within ${timeoutMs} ms` });
    const deadline = setTimeout(noAnswer, timeoutMs);

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(encodeLine(request)));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== undefined && NOTHING_LISTENS.has(err.code)) settle({ status: "not-running" });
      else settle({ status: "failed", code: "no-answer", message: err.message });
    });
    socket.once("close", noAnswer);
    socket.on("data", (chunk: string) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        settle({ status: "failed", code: "invalid-response", message: "the scheduler's answer is too long" });
        return;
      }
      for (const message of messages) {
        const response = parseControlResponse(message);
        if (response === null) {
          settle({ status: "failed", code: "invalid-response", message: "the scheduler's answer is not a control response" });
        } else if (!response.ok) {
          settle({ status: "failed", code: response.error.code, message: response.error.message });
        } else if (response.id !== request.id || !RESULT_GUARDS[method](response.value)) {
          settle({ status: "failed", code: "invalid-response", message: `the scheduler's answer to "${method}" has an unexpected shape` });
        } else {
          settle({ status: "ok", value: response.value });
        }
        return;
      }
    });
  });
}
