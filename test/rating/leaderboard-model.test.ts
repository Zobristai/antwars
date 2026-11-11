/// <reference types="node" />
// A builder row's model from its latest rated match: served only on the web page's leaderboard read (POST /api/leaderboard),
// never by the agents' leaderboard tool, so no agent reads a likely opponent's model through it mid-match. Ratings are
// untouched. Real identity and rating services over in-memory storage; the agents' tool through a real MCP session.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountApi } from "../../src/accounts/httpApi.ts";
import { registerAccountTools } from "../../src/accounts/mcpTools.ts";
import { ACCOUNT_OPERATIONS, WEB_LEADERBOARD, type AccountStores } from "../../src/accounts/service.ts";
import { createRatings, RANKED_MODES } from "../../src/rating/ratings.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";

async function world() {
  const w = retentionWorld(Date.now());
  const house = value(await w.ids.claimUsername("antwars"));
  const terra = value(await w.ids.createHandle(house.key, "gpt-6-1-terra-max-fast")).identity;
  const kite = value(await w.ids.claimUsername("kite")).identity;
  const dove = value(await w.ids.claimUsername("dove")).identity;
  const ratings = createRatings(w.store, w.ids);
  await ratings.houseBackfill;
  return { ...w, terra, kite, dove, ratings, stores: { identities: w.ids, ratings } as unknown as AccountStores };
}
type World = Awaited<ReturnType<typeof world>>;
const models = async (w: World, mode: (typeof RANKED_MODES)[number] = "1v1") =>
  Object.fromEntries(value(await w.ratings.leaderboard({ mode, model: true })).entries.map(entry => [entry.displayName, entry.model]));

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise(done => server.close(done)); });

describe("the leaderboard's model", () => {
  it.each(RANKED_MODES)("%s: with the model option a builder row carries its latest rated match's label, replaced or cleared by the next; a house row never does", async mode => {
    const w = await world();
    await w.ratings.applyResult({ matchId: "one", mode, teams: [[w.kite.id], [w.terra.id]], winner: "a", modelLabels: { [w.kite.id]: "openai/gpt-6.1-terra", [w.terra.id]: "lab/house" } });
    await w.ratings.applyResult({ matchId: "two", mode, teams: [[w.dove.id], [w.kite.id]], winner: "draw", modelLabels: { [w.dove.id]: "lab/dove" } });
    expect(await models(w, mode)).toEqual({ kite: undefined, dove: "lab/dove", "antwars/gpt-6-1-terra-max-fast": undefined });
    await w.ratings.applyResult({ matchId: "three", mode, teams: [[w.kite.id], [w.dove.id]], winner: "a", modelLabels: { [w.kite.id]: "anthropic/claude-sonnet-5-5" } });
    expect(await models(w, mode)).toEqual({ kite: "anthropic/claude-sonnet-5-5", dove: undefined, "antwars/gpt-6-1-terra-max-fast": undefined });
  });

  it("without the option no entry has a model, and the option changes nothing else on any entry", async () => {
    const w = await world();
    await w.ratings.applyResult({ matchId: "one", teams: [[w.kite.id], [w.dove.id]], winner: "a", modelLabels: { [w.kite.id]: "openai/gpt-6.1-terra" } });
    const plain = value(await w.ratings.leaderboard()).entries;
    for (const entry of plain) expect(entry).not.toHaveProperty("model");
    const withModel = value(await w.ratings.leaderboard({ model: true })).entries;
    expect(withModel.map(({ model: _model, ...entry }) => entry)).toEqual(plain);
  });

  it("the web page's POST /api/leaderboard serves the model; the agents' leaderboard tool, over a real MCP session, does not", async () => {
    const w = await world();
    await w.ratings.applyResult({ matchId: "one", teams: [[w.kite.id], [w.terra.id]], winner: "a", modelLabels: { [w.kite.id]: "openai/gpt-6.1-terra" } });

    const api = createAccountApi(w.stores);
    const server = createServer((req, res) => void api(req, res));
    servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/leaderboard`, { method: "POST", body: "{}" });
    const web = (await res.json()) as { entries: { displayName: string; model?: string | null }[] };
    expect(web.entries.map(entry => [entry.displayName, entry.model])).toEqual([["kite", "openai/gpt-6.1-terra"], ["antwars/gpt-6-1-terra-max-fast", undefined]]);

    const mcp = new McpServer({ name: "leaderboard-model-test", version: "0.0.0" });
    registerAccountTools(mcp, w.stores);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const tool = (await client.listTools()).tools.find(entry => entry.name === "leaderboard")!;
      expect(tool.description).not.toMatch(/\bmodel\b/);
      const result = await client.callTool({ name: "leaderboard", arguments: {} });
      const text = (result.content as { text: string }[])[0]!.text;
      const agents = JSON.parse(text) as { entries: Record<string, unknown>[] };
      expect(agents.entries.map(entry => entry.displayName)).toEqual(["kite", "antwars/gpt-6-1-terra-max-fast"]);
      for (const entry of agents.entries) { expect(entry).not.toHaveProperty("model"); expect(entry).not.toHaveProperty("modelLabel"); }
      expect(text).not.toContain("gpt-6.1-terra");
      // Apart from the model, the two replies are the same.
      expect(web.entries.map(({ model: _model, ...entry }) => entry)).toEqual(agents.entries);
    } finally {
      await client.close();
    }
    // The agents' operation list holds the leaderboard without the model; only the /api map swaps in the web read.
    expect(ACCOUNT_OPERATIONS.find(op => op.name === "leaderboard")).not.toBe(WEB_LEADERBOARD);
    expect(WEB_LEADERBOARD.description).toBe(ACCOUNT_OPERATIONS.find(op => op.name === "leaderboard")!.description);
  });
});
