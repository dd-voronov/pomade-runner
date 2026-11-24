// Where the command's output leaves the process: its stdout and stderr, each of which may be a
// pipe whose reader closes early (`pomade-runner sessions | head -1`). A write into a closed pipe
// fails with EPIPE as the stream's `error` event, which Node turns into a crash with a stack trace
// when nothing listens. A closed reader is no failure of the command: its output stops, and it
// ends with the status it would have had. Any other error of the stream is not this module's to hide: it is thrown
// again, as it would be with no listener.

import { EventEmitter } from "node:events";

/** A stream the command writes to. */
export interface OutputStream extends EventEmitter {
  write(text: string): boolean;
}

export interface Output {
  /** Write `text`; nothing once the reader of this stream has closed. */
  write(text: string): void;
  /** Whether the reader of this stream has closed. */
  closed(): boolean;
}

/** The writer of `stream`, which survives its reader closing. */
export function guardOutput(stream: OutputStream): Output {
  let closed = false;
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    closed = true;
  });
  return {
    write(text) {
      if (!closed) stream.write(text);
    },
    closed: () => closed,
  };
}
