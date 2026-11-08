/// <reference types="node" />
// Characterization of the deployment-mode interlocks and the route precedence of startServer,
// pinned before the mode wiring is split.
// Covered elsewhere and not repeated here: the slot startup-probe and superseded gates
// (test/slots/live-owner.test.ts, test/slots/handover-save.test.ts), the slot operator's start
// refusal (test/slots/slot-server.test.ts), the comparison join barrier and slotOptions'
// refusal of comparison settings (test/server/rules-switch.test.ts), and the entry point's
// tools and routes (test/server/entry-point.test.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identities } from "../../src/identity/identities.js";
import type { Lobbies } from "../../src/lobby/lobbies.js";
import { isEntryPoint, startServer, type GameServer, type ServerOptions, type SlotWiring } from "../../src/server.js";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG, waitFor } from "./helpers.js";

let server: GameServer | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = null;
});

/** Never reached: the interlock refuses before a slot's lobbies or identities are read. */
const unusedSlot: SlotWiring = { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies: {} as Lobbies, identities: {} as Identities };

async function start(options: Omit<ServerOptions, "port" | "host" | "dataDir">): Promise<GameServer> {
  server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: playable(shortConfig(600)), mcpConfig: TEST_MCP_CONFIG, ...options });
  return server;
}

async function get(path: string, init?: RequestInit): Promise<{ status: number; body: string; allow: string | null }> {
  const res = await fetch(`http://127.0.0.1:${server!.port}${path}`, init);
  return { status: res.status, body: await res.text(), allow: res.headers.get("allow") };
}

/** A catch-all mount that names itself, so a test can tell which requests reached it. */
function mountCatchAll(s: GameServer): void {
  s.mount("/", (_req, res) => { res.writeHead(200).end("mount:/"); });
}

describe("mode selection", () => {
  it("is an entry point only with no slot, match or breakMs", () => {
    expect(isEntryPoint({})).toBe(true);
    expect(isEntryPoint({ match: "immediate" })).toBe(false);
    expect(isEntryPoint({ match: "held" })).toBe(false);
    expect(isEntryPoint({ breakMs: 1000 })).toBe(false);
    expect(isEntryPoint({ slot: unusedSlot })).toBe(false);
  });

  it.each([
    ["match immediate", { match: "immediate" }],
    ["match held", { match: "held" }],
    ["breakMs", { breakMs: 1000 }],
    ["expectedPlayers", { expectedPlayers: 2 }],
  ] as const)("refuses a slot server combined with %s before creating its data directory", async (_name, extra) => {
    const dataDir = join(tempDir(), "never-created");
    await expect(startServer({ port: 0, host: "127.0.0.1", dataDir, slot: unusedSlot, ...extra } as ServerOptions)).rejects.toThrow("a slot server starts matches only from lobbies");
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe("programmatic match controls per mode", () => {
  it("entry point: startMatch refuses as a non-host; stopMatch refuses", async () => {
    const s = await start({});
    expect(() => s.startMatch()).toThrow("The entry point does not host matches; use a lobby slot");
    expect(() => s.stopMatch()).toThrow("no on-demand match running");
  });

  it("scheduled harness: nothing is held, so startMatch refuses; stopMatch refuses", async () => {
    const s = await start({ breakMs: 60_000 });
    expect(s.game.nextStart).toMatchObject({ kind: "scheduled" });
    expect(() => s.startMatch()).toThrow("no held match to start");
    expect(() => s.stopMatch()).toThrow("no on-demand match running");
  });

  it("immediate harness: startMatch refuses while running and after the end; stopMatch refuses either way", async () => {
    const s = await start({ match: "immediate", simConfig: playable(shortConfig(5)) });
    expect(s.game.match?.result).toBeNull();
    expect(() => s.startMatch()).toThrow("a match is already running");
    expect(() => s.stopMatch()).toThrow("no on-demand match running");
    await waitFor(() => s.game.match!.result !== null);
    expect(() => s.startMatch()).toThrow("no held match to start");
    expect(() => s.stopMatch()).toThrow("no on-demand match running");
    expect(s.game.nextStart).toBeNull();
  });

  it("held harness: starts once on request; later starts refuse; stopMatch refuses", async () => {
    const s = await start({ match: "held", simConfig: playable(shortConfig(5)) });
    expect(s.game.nextStart).toEqual({ kind: "held" });
    s.startMatch();
    expect(() => s.startMatch()).toThrow("a match is already running");
    expect(() => s.stopMatch()).toThrow("no on-demand match running");
    await waitFor(() => s.game.match!.result !== null);
    expect(() => s.startMatch()).toThrow("no held match to start");
  });
});

describe("route precedence off a slot", () => {
  it.each([
    ["entry point", {}],
    ["held harness", { match: "held" }],
  ] as const)("%s: /wake answers GET 204 and anything else 405, ahead of a catch-all mount", async (_name, options) => {
    mountCatchAll(await start(options));
    expect(await get("/wake")).toMatchObject({ status: 204, body: "" });
    expect(await get("/wake", { method: "POST" })).toMatchObject({ status: 405, allow: "GET" });
  });

  it("entry point: /operator and /operator/* answer 404, even with an operator token", async () => {
    mountCatchAll(await start({ operatorToken: "token" }));
    for (const path of ["/operator", "/operator/start", "/operator/stop", "/operator/x"]) {
      expect(await get(path, { method: "POST", headers: { authorization: "Bearer token" } }), path).toMatchObject({ status: 404, body: "" });
    }
  });

  it("harness: the operator controls stay disabled even with an operator token (only a slot server reads it)", async () => {
    mountCatchAll(await start({ match: "held", operatorToken: "token" }));
    const auth = { method: "POST", headers: { authorization: "Bearer token" } };
    expect(await get("/operator/start", auth)).toMatchObject({ status: 503, body: JSON.stringify({ message: "Operator controls disabled" }) });
    expect(await get("/operator/stop", auth)).toMatchObject({ status: 503, body: JSON.stringify({ message: "Operator controls disabled" }) });
    expect(await get("/operator", auth)).toMatchObject({ status: 404, body: JSON.stringify({ message: "Not found" }) });
    expect(server!.game.match).toBeNull();
  });

  it.each([
    ["entry point", {}],
    ["held harness", { match: "held" }],
  ] as const)("%s: slot-only paths are not special and reach a catch-all mount", async (_name, options) => {
    mountCatchAll(await start(options));
    for (const path of ["/ready", "/keep-alive", "/lobbies/abc/match"]) {
      expect(await get(path), path).toMatchObject({ status: 200, body: "mount:/" });
    }
  });

  it("a catch-all mount never captures /mcp; every /mcp/<key> reaches the mounts", async () => {
    mountCatchAll(await start({ match: "held" }));
    expect((await get("/mcp")).body).not.toBe("mount:/");
    expect(await get("/mcp/seat-1")).toMatchObject({ status: 200, body: "mount:/" });
    expect(await get("/mcp/")).toMatchObject({ status: 200, body: "mount:/" });
  });

  it("the longest whole-segment mount prefix wins, whatever the mount order; nothing mounted is 404", async () => {
    const s = await start({ match: "held" });
    expect(await get("/a")).toMatchObject({ status: 404 });
    for (const prefix of ["/a", "/", "/a/b"]) s.mount(prefix, (_req, res) => { res.writeHead(200).end(`mount:${prefix}`); });
    expect((await get("/a/b/c")).body).toBe("mount:/a/b");
    expect((await get("/a/b")).body).toBe("mount:/a/b");
    expect((await get("/a/bc")).body).toBe("mount:/a");
    expect((await get("/a")).body).toBe("mount:/a");
    expect((await get("/ab")).body).toBe("mount:/");
  });

  it("a throwing mount answers 500 and logs the method and the mount's prefix as the route class, never the URL", async () => {
    const s = await start({ match: "held" });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    s.mount("/boom", () => { throw new Error("mount failed"); });
    expect((await get("/boom/secret-token?q=1")).status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^antwar 500 GET \/boom: Error: mount failed/);
    expect(errors[0]).not.toContain("secret-token");
  });
});
