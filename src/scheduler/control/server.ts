// The scheduler's side of the control protocol: binds the socket, answers each request line. The
// socket also makes the scheduler single: a second scheduler finds the first one answering and
// leaves it in charge.

import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { createLineDecoder, encodeLine, socketPathProblem } from "pomade-kit/protocol";

import { callScheduler } from "./client";
import {
  CONTROL_PROTOCOL,
  PARAMS_PARSERS,
  PARAMS_SHAPES,
  isControlMethod,
  parseControlRequest,
  type ControlMethod,
  type ControlMethods,
  type ControlParams,
  type ControlResponse,
} from "./protocol";

export type ControlHandlers = { [M in ControlMethod]: (params: ControlParams[M]) => ControlMethods[M] | Promise<ControlMethods[M]> };

/** Thrown by a handler that cannot do what was asked: answered as `refused` with its message. */
export class ControlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRefused";
  }
}

async function call<M extends ControlMethod>(handlers: ControlHandlers, method: M, params: unknown): Promise<{ ok: true; value: unknown } | { ok: false; code: "invalid-params" | "refused"; message: string }> {
  const parsed = PARAMS_PARSERS[method](params);
  if (parsed === undefined) return { ok: false, code: "invalid-params", message: `"${method}" takes params: ${PARAMS_SHAPES[method]}` };
  try {
    return { ok: true, value: await handlers[method](parsed) };
  } catch (err) {
    if (err instanceof ControlRefused) return { ok: false, code: "refused", message: err.message };
    throw err;
  }
}

export type ServeResult =
  | { status: "listening"; close(): Promise<void> }
  /** Another scheduler answers on the socket. */
  | { status: "already-running" }
  | { status: "failed"; reason: string };

/** The response to one received message. */
export async function answerControl(data: unknown, handlers: ControlHandlers): Promise<ControlResponse> {
  const request = parseControlRequest(data);
  if (request === null) {
    return {
      protocol: CONTROL_PROTOCOL,
      id: "",
      ok: false,
      error: { code: "invalid-request", message: "a request is { protocol, id, method }" },
    };
  }
  const { id, method } = request;
  if (request.protocol !== CONTROL_PROTOCOL) {
    return {
      protocol: CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: "protocol-mismatch",
        message: `the scheduler speaks control protocol ${CONTROL_PROTOCOL}, the caller ${request.protocol}`,
      },
    };
  }
  if (!isControlMethod(method)) {
    return { protocol: CONTROL_PROTOCOL, id, ok: false, error: { code: "unknown-method", message: `no method "${method}"` } };
  }
  const result = await call(handlers, method, request.params);
  return result.ok
    ? { protocol: CONTROL_PROTOCOL, id, ok: true, value: result.value }
    : { protocol: CONTROL_PROTOCOL, id, ok: false, error: { code: result.code, message: result.message } };
}

function listen(server: Server, socketPath: string): Promise<"listening" | "in-use"> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") resolve("in-use");
      else reject(err);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve("listening");
    });
  });
}

export async function serveControl(socketPath: string, handlers: ControlHandlers): Promise<ServeResult> {
  const problem = socketPathProblem(socketPath);
  if (problem !== null) return { status: "failed", reason: problem };

  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    const decoder = createLineDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const message of messages) {
        answerControl(message, handlers).then(
          (response) => {
            if (!socket.destroyed) socket.write(encodeLine(response));
          },
          () => socket.destroy(),
        );
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => open.delete(socket));
  });

  try {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    if ((await listen(server, socketPath)) === "in-use") {
      const probe = await callScheduler(socketPath, "status", null);
      if (probe.status !== "not-running") return { status: "already-running" };
      // The file is what a scheduler that was killed left behind.
      await rm(socketPath, { force: true });
      if ((await listen(server, socketPath)) === "in-use") return { status: "already-running" };
    }
    await chmod(socketPath, 0o600);
  } catch (err) {
    server.close();
    return { status: "failed", reason: `cannot serve ${socketPath}: ${(err as Error).message}` };
  }

  return {
    status: "listening",
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of open) socket.destroy();
      });
    },
  };
}
