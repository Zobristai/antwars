import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { startServer } from "../../src/server.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });

async function fixture(enabled: boolean, transport: "HTTP" | "MCP") {
  const { docs, store } = memoryWatchStore(), identities = createIdentities(store);
  const hidden = await identities.claimUsername("Meadow"), publicPlayer = await identities.claimUsername("Willow");
  if (!hidden.ok || !publicPlayer.ok) throw new Error("fixture claim failed");
  const lobbies = createLobbies(store, identities);
  const hiddenLobby = await lobbies.createLobby(hidden.value.key, "public", 2);
  const shownLobby = await lobbies.createLobby(publicPlayer.value.key, "public", 2);
  if (!hiddenLobby.ok || !shownLobby.ok) throw new Error("fixture lobby failed");
  await lobbies.join(hiddenLobby.value.lobby.id, hidden.value.key);
  await lobbies.join(shownLobby.value.lobby.id, publicPlayer.value.key);
  const policy = createPublicVisibility(store, createWatchRegistry(store), enabled ? [hidden.value.identity.id] : []);
  const accounts = { identities, lobbies, ratings: createRatings(store, identities, policy), publicVisibility: policy };
  const dataDir = mkdtempSync(join(tmpdir(), "account-visibility-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, accounts });
  cleanup.push(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "public-visibility-test", version: "1" });
  if (transport === "MCP") {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    cleanup.push(() => client.close());
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (transport === "HTTP") {
      const response = await fetch(`${origin}/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      const text = await response.text();
      let body: unknown = text; try { body = JSON.parse(text); } catch { /* Error responses may have no JSON body. */ }
      return { ok: response.ok, body };
    }
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text ?? "{}";
    let body: unknown = text; try { body = JSON.parse(text); } catch { /* MCP errors may be plain text. */ }
    return { ok: result.isError !== true, body: result.structuredContent ?? body };
  };
  return { call, docs, hidden: hidden.value, shown: publicPlayer.value, hiddenLobby: hiddenLobby.value.lobby.id, shownLobby: shownLobby.value.lobby.id };
}

it.each(["HTTP", "MCP"] as const)("%s hides anonymous discovery but keeps authenticated participation", async transport => {
  const f = await fixture(true, transport);
  const listed = await f.call("list_lobbies");
  expect(listed.ok).toBe(true);
  expect(JSON.stringify(listed.body)).not.toContain("Meadow");
  expect(JSON.stringify(listed.body)).not.toContain(f.hidden.identity.id);
  expect(JSON.stringify(listed.body)).toContain("Willow");
  const rating = await f.call("rating", { displayName: "Meadow" });
  expect(rating.ok).toBe(false); expect(JSON.stringify(rating.body)).not.toContain(f.hidden.identity.id);
  expect((await f.call("rating", { displayName: "Willow" })).ok).toBe(true);
  const own = await f.call("read_lobby", { key: f.hidden.key, lobbyId: f.hiddenLobby });
  expect(own.ok).toBe(true); expect(JSON.stringify(own.body)).toContain("Meadow");
  expect((await f.call("read_lobby", { lobbyId: f.hiddenLobby })).ok).toBe(false);
  expect((await f.call("leave_lobby", { key: f.shown.key, lobbyId: f.shownLobby })).ok).toBe(true);
  expect((await f.call("join_lobby", { key: f.shown.key, lobbyId: f.hiddenLobby })).ok).toBe(true);
  expect((await f.call("read_lobby", { key: f.shown.key, lobbyId: f.hiddenLobby })).ok).toBe(true);
  expect((await f.call("create_lobby", { key: f.hidden.key, kind: "public", size: 1 })).ok).toBe(true);
  const withEmptyLobby = await f.call("list_lobbies");
  expect(JSON.stringify(withEmptyLobby.body)).not.toContain(f.hidden.identity.id);
});

it.each(["HTTP", "MCP"] as const)("%s retains off behavior and refuses unresolved visibility", async transport => {
  const off = await fixture(false, transport);
  expect(JSON.stringify((await off.call("list_lobbies")).body)).toContain("Meadow");
  expect((await off.call("rating", { displayName: "Meadow" })).ok).toBe(true);
  const on = await fixture(true, transport);
  on.docs.delete(`identities/${on.shown.identity.id}`);
  const refused = await on.call("list_lobbies");
  expect(refused.ok).toBe(false);
  expect(JSON.stringify(refused.body)).not.toContain("Meadow");
});
