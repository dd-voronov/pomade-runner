import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { probeReadiness } from "./readiness";

describe("readiness checks", () => {
  const servers: Server[] = [];
  const connections = new Set<Socket>();

  async function listen(server: Server, host: string): Promise<number> {
    servers.push(server);
    server.on("connection", (socket: Socket) => connections.add(socket));
    server.listen(0, host);
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
  }

  /** A port nothing listens on. */
  async function freePort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  afterEach(async () => {
    for (const socket of connections) socket.destroy();
    connections.clear();
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  });

  it("a port is up once it accepts a connection, on IPv4 or IPv6 loopback", async () => {
    const closed = await freePort();
    expect(await probeReadiness({ kind: "port", port: closed })).toBe(false);
    expect(await probeReadiness({ kind: "port", port: await listen(createServer(), "127.0.0.1") })).toBe(true);
    expect(await probeReadiness({ kind: "port", port: await listen(createServer(), "::1") })).toBe(true);
  });

  it("a URL is up once it answers at all — an error status or a redirect included", async () => {
    const closed = await freePort();
    expect(await probeReadiness({ kind: "url", url: `http://127.0.0.1:${closed}/` })).toBe(false);
    const port = await listen(
      createHttpServer((request, response) => {
        response.writeHead(request.url === "/moved" ? 302 : 500, { location: "/elsewhere" });
        response.end("body");
      }),
      "127.0.0.1",
    );
    expect(await probeReadiness({ kind: "url", url: `http://127.0.0.1:${port}/` })).toBe(true);
    expect(await probeReadiness({ kind: "url", url: `http://127.0.0.1:${port}/moved` })).toBe(true);
  });

  it("a server that accepts and never answers is not up", async () => {
    const port = await listen(createServer(() => undefined), "127.0.0.1");
    expect(await probeReadiness({ kind: "url", url: `http://127.0.0.1:${port}/` })).toBe(false);
  });
});
