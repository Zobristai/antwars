import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import type { AccountStores } from "../../src/accounts/service.js";
import type { WatchRegistry } from "../../src/live/watch-registry.js";
import { startSpectatedServer, type SpectatedServer, type SpectatedServerOptions } from "../../src/spectator.js";
import { tempDir } from "./helpers.js";

let server: SpectatedServer | undefined;
let dir: string;
afterEach(async () => { await server?.close(); server = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });
async function start(extra: Partial<SpectatedServerOptions> = {}) {
  dir = tempDir();
  server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, match: "held", expectedPlayers: 2, ...extra });
  return `http://127.0.0.1:${server.port}`;
}

// Reading capabilities must not call a store, even one whose operations fail.
const unavailable = vi.fn(() => { throw new Error("Store temporarily unavailable"); });
const accounts = new Proxy({} as AccountStores, { get: unavailable });
const registry = new Proxy({} as WatchRegistry, { get: unavailable });

function assertMetadata(html: string, lobbies: boolean, publicMatches: boolean) {
  const metadata = `<meta name="antwar-lobbies" content="${lobbies}"><meta name="antwar-public-matches" content="${publicMatches}">`;
  expect(html).toContain(`<head>${metadata}`);
  expect(html.indexOf(metadata)).toBeLessThan(html.indexOf("<script"));
}

describe("spectator service capabilities known before scripts", () => {
  it("disables controls without a store, keeps live viewing and serves no bundled recording", async () => {
    const origin = await start();
    const response = await fetch(`${origin}/?lobby=direct-link&key=not-reflected`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    assertMetadata(html, false, false);
    expect(html).not.toContain("not-reflected");
    expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(html));
    expect((await fetch(`${origin}/live/status`)).status).toBe(200);
    // The bundled legacy recording and its route are deleted.
    expect((await fetch(`${origin}/replays/agents.bin`)).status).toBe(404);
    expect(server!.game.match).toBeNull();
  });

  it.each([
    [true, false],
    [true, true],
    [false, true],
  ])("describes configured services, not their health: accounts=%s registry=%s", async (hasAccounts, hasRegistry) => {
    unavailable.mockClear();
    const origin = await start({ ...(hasAccounts ? { accounts } : {}), ...(hasRegistry ? { watchRegistry: registry } : {}) });
    const lobbies = hasAccounts, publicMatches = hasAccounts && hasRegistry;
    for (const path of ["/", "/index.html?board=3d"]) {
      const response = await fetch(`${origin}${path}`);
      assertMetadata(await response.text(), lobbies, publicMatches);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("preserves HEAD length/cache semantics and refuses unsupported methods", async () => {
    const origin = await start();
    const get = await fetch(`${origin}/`), head = await fetch(`${origin}/`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");
    expect((await fetch(`${origin}/`, { method: "POST" })).status).toBe(405);
  });
});
