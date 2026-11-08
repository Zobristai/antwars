import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { LiveHub } from "../../src/live/hub.ts";
import type { WatchRegistry } from "../../src/live/watch-registry.ts";
import type { Lobby } from "../../src/lobby/lobbies.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";

/** Every 503 the /watch routes answer logs its method, route class and cause; the reply itself is unchanged. */
const id = "00000000-0000-4000-8000-000000000001";
const lobby: Lobby = { id, kind: "public", size: 1, state: "playing", rated: false, slot: "public-0", creatorId: "a", createdAt: 0, expiresAt: 1000,
  colonies: [[{ id: "a", displayName: "alice" }], [{ id: "b", displayName: "bob" }]], startsAt: 0, outcome: null, mode: null } as unknown as Lobby;
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  vi.restoreAllMocks();
});

async function serve(registry: Partial<WatchRegistry>, request?: typeof fetch): Promise<string> {
  const accounts = { lobbies: {
    readLobby: async () => ({ ok: true, value: lobby }),
    listPublic: async () => [],
    isInviteCurrent: async () => false,
  } } as unknown as AccountStores;
  const hub = { watchStatus: () => undefined, hasLobby: () => false } as unknown as LiveHub;
  const routes = watchRoutes({ accounts, registry: registry as WatchRegistry, hub, origin: "http://gateway.test", request });
  const server = createServer((req, res) => { void routes(req, res); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The same clean reply the routes have always given a 503. */
async function expectUnchanged503(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("vary")).toBe("x-antwar-invite");
  expect(await response.text()).toBe("");
}

it("logs a failed store read inside a /watch route once, by method, route class and cause", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const origin = await serve({ publicMatches: async () => { throw new Error("watch store down"); } });
  await expectUnchanged503(await fetch(`${origin}/watch/catalog`));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]![0])).toMatch(/^antwar 503 GET \/watch\/catalog: Error: watch store down/);
});

const retained = { lobbyId: id, visibility: "public", rated: false, startedAt: 0, origin: "http://owner.test", slot: "public-0", runId: "run", playbackFinished: false };

it.each([
  ["an error status", () => new Response("owner failed", { status: 500 }), "upstream 500"],
  ["the wrong content type", () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), "upstream content-type text/html"],
])("logs a relayed /watch/status whose owner answers %s, without the lobby id", async (_name, upstream, cause) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const request = vi.fn<typeof fetch>(async () => upstream());
  const origin = await serve({ read: async () => retained } as unknown as Partial<WatchRegistry>, request);
  await expectUnchanged503(await fetch(`${origin}/watch/status/${id}`));
  expect(request).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]![0]).toBe(`antwar 503 GET /watch/status/:lobby: ${cause}`);
});

it("logs a relay whose fetch itself fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const request = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
  const origin = await serve({ read: async () => retained } as unknown as Partial<WatchRegistry>, request);
  await expectUnchanged503(await fetch(`${origin}/watch/live/${id}`));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]![0])).toMatch(/^antwar 503 GET \/watch\/live\/:lobby: TypeError: fetch failed/);
});

it("logs nothing for a 404", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const origin = await serve({ read: async () => retained } as unknown as Partial<WatchRegistry>, async () => new Response("", { status: 404 }));
  expect((await fetch(`${origin}/watch/status/${id}`)).status).toBe(404);
  expect(warn).not.toHaveBeenCalled();
});
