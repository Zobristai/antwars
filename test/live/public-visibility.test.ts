import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { memoryWatchStore } from "./watch-fixtures.ts";
import { playable } from "../playable.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(enabled: boolean) {
  const { store, docs } = memoryWatchStore();
  const identities = createIdentities(store);
  const owner = await identities.claimUsername("Meadow"), player = await identities.claimUsername("Player123");
  if (!owner.ok || !player.ok) throw new Error("fixture claim failed");
  const lobbies = createLobbies(store, identities), ratings = createRatings(store, identities), registry = createWatchRegistry(store);
  await ratings.houseBackfill;
  const made = await lobbies.createLobby(owner.value.key, "public", 1);
  const other = await lobbies.createLobby(player.value.key, "public", 1);
  if (!made.ok || !other.ok) throw new Error("fixture lobby failed");
  const id = made.value.lobby.id, shown = other.value.lobby.id;
  if (!(await lobbies.join(id, owner.value.key)).ok || !(await lobbies.join(shown, player.value.key)).ok) throw new Error("fixture seating failed");
  const policy = createPublicVisibility(store, registry, enabled ? [owner.value.identity.id] : []);
  const hub = new LiveHub({ publicVisibility: policy }); cleanup.push(() => hub.close());
  const state = createMatch(7, playable(rulesConfig("redesign")));
  hub.startMatch(1, state, { lobbyId: id, visibility: "public", rated: false });
  const routes = watchRoutes({ accounts: { identities, lobbies, ratings }, registry, hub, publicVisibility: policy });
  const server = createServer((req, res) => { void (req.url?.startsWith("/live") ? hub.handle(req, res) : routes(req, res)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  docs.set("instances/public-0", { runId: "run", mcpUrl: origin, spectatorUrl: origin });
  await registry.register({ lobbyId: id, visibility: "public", rated: false, startedAt: 1, slot: "public-0", runId: "run", origin });
  return { origin, id, shown, hub, docs };
}

it("removes configured seats from public lobby and waiting views", async () => {
  const f = await fixture(true);
  const catalog = await (await fetch(`${f.origin}/watch/catalog`)).json();
  expect(catalog.matches).toEqual([]);
  expect(catalog.lobbies.map((row: { id: string }) => row.id)).toEqual([f.shown]);
  const queue = await (await fetch(`${f.origin}/watch/queue`)).json();
  expect(JSON.stringify(queue)).not.toContain("Meadow");
  expect(JSON.stringify(queue)).toContain("Player123");
});

it("all public views of a hidden match refuse it, including direct and current streams", async () => {
  const f = await fixture(true);
  for (const path of [`/watch/live/${f.id}`, `/watch/status/${f.id}`, `/watch/recording/${f.id}`, "/live/1", "/live/current"]) {
    const response = await fetch(f.origin + path);
    expect(response.status, path).toBe(404);
    expect(await response.text()).not.toContain("Meadow");
  }
  expect(await (await fetch(`${f.origin}/live/status`)).json()).toEqual({ kind: "idle", match: null });
});

it("unset preserves public discovery and direct stream behavior", async () => {
  const f = await fixture(false);
  const catalog = await (await fetch(`${f.origin}/watch/catalog`)).json();
  expect(catalog.lobbies.map((row: { id: string }) => row.id)).toContain(f.id);
  const abort = new AbortController();
  const response = await fetch(`${f.origin}/live/1`, { signal: abort.signal });
  expect(response.status).toBe(200);
  abort.abort();
});

it("unavailable ownership never opens a stream", async () => {
  const f = await fixture(true);
  f.docs.delete(`lobbies/${f.id}`);
  const response = await fetch(`${f.origin}/live/1`);
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("");
});
