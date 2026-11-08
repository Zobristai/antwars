import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { createRatings } from "../../src/rating/ratings.js";
import { startServer } from "../../src/server.js";
import { tempDir, TEST_MCP_CONFIG } from "../server/helpers.js";
import { retentionWorld } from "../identity/retentionStore.js";

for (const protocol of ["HTTP", "MCP"] as const) describe(`${protocol} released-account recovery`, () => {
  it("accepts an optional owner key without creating another account or transferring handles", async () => {
    const w = retentionWorld(), owner = w.played("original"), handle = w.played("worker", owner), start = w.now();
    const stores = { identities: w.ids, lobbies: createLobbies(w.store, w.ids), ratings: createRatings(w.store, w.ids) };
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), mcpConfig: TEST_MCP_CONFIG, accounts: stores });
    const client = new Client({ name: "retention-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      if (protocol === "MCP") {
        await client.connect(transport);
        const tools = (await client.listTools()).tools;
        expect(tools.find(tool => tool.name === "claim_username")?.inputSchema.properties).toHaveProperty("key");
      }
      const call = async (name: string, args: Record<string, unknown>) => {
        if (protocol === "MCP") {
          const result = await client.callTool({ name, arguments: args });
          return { ok: !result.isError, body: result.structuredContent as Record<string, unknown> };
        }
        const result = await fetch(`http://127.0.0.1:${server.port}/api/${name}`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
        return { ok: result.ok, body: await result.json() as Record<string, unknown> };
      };
      w.at(start + 90 * 86_400_000);
      const newOwner = await call("claim_username", { name: "original" });
      expect(newOwner.ok).toBe(true);
      expect((newOwner.body.identity as { id: string }).id).not.toBe(owner.id);
      expect(await call("claim_username", { name: "replacement", key: handle.key })).toMatchObject({ ok: false, body: { error: "not_owner_key" } });
      const recovered = await call("claim_username", { name: "replacement", key: owner.key });
      expect(recovered).toMatchObject({ ok: true, body: { identity: { id: owner.id, displayName: "replacement" }, key: owner.key } });
      expect((await w.ids.findByDisplayName("replacement/worker"))?.id).toBe(handle.id);
      expect(await w.ids.findByDisplayName("original/worker")).toBeUndefined();
      expect(await call("claim_username", { name: "another", key: owner.key })).toMatchObject({ ok: false, body: { error: "already_named" } });
      expect(await call("claim_username", { name: "another", key: "not-a-key" })).toMatchObject({ ok: false, body: { error: "invalid_key" } });
    } finally {
      info.mockRestore();
      if (protocol === "MCP") await transport.terminateSession().catch(() => {});
      await client.close(); await server.close();
    }
  });
});
