import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { guardOutput, type OutputStream } from "./output";

class FakeStream extends EventEmitter implements OutputStream {
  written: string[] = [];
  write(text: string): boolean {
    this.written.push(text);
    return true;
  }
}

const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`write ${code}`), { code });

describe("guardOutput", () => {
  it("writes the text to the stream while its reader reads", () => {
    const stream = new FakeStream();
    const output = guardOutput(stream);
    output.write("one\n");
    output.write("two\n");
    expect(stream.written).toEqual(["one\n", "two\n"]);
    expect(output.closed()).toBe(false);
  });

  it("survives the reader closing: EPIPE is no error, the output stops and says it closed", () => {
    const stream = new FakeStream();
    const output = guardOutput(stream);
    output.write("one\n");
    expect(() => stream.emit("error", failure("EPIPE"))).not.toThrow();
    output.write("two\n");
    expect(stream.written).toEqual(["one\n"]);
    expect(output.closed()).toBe(true);
  });

  it("does not hide any other error of the stream", () => {
    const stream = new FakeStream();
    const output = guardOutput(stream);
    expect(() => stream.emit("error", failure("ENOSPC"))).toThrow("write ENOSPC");
    expect(output.closed()).toBe(false);
  });
});
