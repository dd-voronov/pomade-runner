// The scheduler's side of the control protocol: binds the socket, answers each request line. The
// socket also makes the scheduler single: a second scheduler finds the first one answering and
// leaves it in charge.

import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { createLineDecoder, encodeLine, socketPathProblem } from "pomade-kit/protocol";

import { callScheduler } from "./client";
import { CONTROL_PROTOCOL, isControlMethod, parseControlRequest, type ControlMethods, type ControlResponse } from "./protocol";

export type ControlHandlers = { [M in keyof ControlMethods]: () => ControlMethods[M] };

export type ServeResult =
  | { status: "listening"; close(): Promise<void> }
  /** Another scheduler answers on the socket. */
  | { status: "already-running" }
  | { status: "failed"; reason: string };

/** The response to one received message. */
export function answerControl(data: unknown, handlers: ControlHandlers): ControlResponse {
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
  return { protocol: CONTROL_PROTOCOL, id, ok: true, value: handlers[method]() };
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
      for (const message of messages) socket.write(encodeLine(answerControl(message, handlers)));
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => open.delete(socket));
  });

  try {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    if ((await listen(server, socketPath)) === "in-use") {
      const probe = await callScheduler(socketPath, "status");
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
