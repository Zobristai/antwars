/// <reference types="node" />
import { connect as rawConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type GameServer } from "../../src/server.js";
import { connect, tempDir, TEST_MCP_CONFIG, type Agent } from "./helpers.js";

let server: GameServer | null = null;
const agents: Agent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
});

/** Send raw bytes on a fresh connection and return the response's status line. */
function rawRequest(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = rawConnect(port, "127.0.0.1", () => socket.write(bytes));
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error(`no response to ${JSON.stringify(bytes)}`)));
  });
}

describe("malformed requests never take the server down", () => {
  it("answers a malformed target, a malformed header and a throwing route with an error, then still serves /mcp and mounts", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "held", expectedPlayers: 2, mcpConfig: TEST_MCP_CONFIG });
    const s = server;
    s.mount("/ok", (_req, res) => void res.end("ok"));
    s.mount("/boom", () => {
      throw new Error("route failure");
    });

    expect(await rawRequest(s.port, "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
    expect(await rawRequest(s.port, "GET /ok HTTP/1.1\r\nBad Header\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
    expect(await rawRequest(s.port, "GET /boom HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).toMatch(/^HTTP\/1\.1 500/);

    const ok = await fetch(`http://127.0.0.1:${s.port}/ok`);
    expect(await ok.text()).toBe("ok");
    const agent = await connect(s.port);
    agents.push(agent);
    const joined = await agent.call("join", {});
    expect(joined.isError, joined.text).toBe(false);
  });
});
