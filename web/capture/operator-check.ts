/** Exact-checkout, local keyed-slot lifecycle capture. No deployment or production traffic. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Browser } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createIdentities } from "../../src/identity/identities.ts";
import { Game } from "../../src/mcp/game.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { UNRATED_DELAY_SECONDS } from "../../src/live/match-access.ts";
import type { ReplayObject } from "../../src/replays/store.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { startSpectatedServer } from "../../src/spectator.ts";
import { ManualClock } from "../../test/live/helpers.ts";
import { memoryWatchStore } from "../../test/live/watch-fixtures.ts";
import { launchBrowser, OUT_DIR } from "./browser.ts";

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Real account/lobby/slot domains and HTTP MCP; only storage and spectator time are local fixtures. */
export async function createSlotCaptureFixture() {
  const dir = await mkdtemp(join(tmpdir(), "antwar-slot-capture-"));
  const token = randomUUID(); // Run-owned fixture; never printed or put in a page.
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 300 });
  const keys: string[] = [];
  for (const name of ["CaptureAnn", "CaptureBob"]) {
    const issued = await identities.claimUsername(name);
    assert.ok(issued.ok);
    keys.push(issued.value.key);
  }
  const objects = new Map<string, ReplayObject>();
  const clock = new ManualClock();
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, operatorToken: token,
    simConfig: withGridScale({ ...rulesConfig("redesign"), matchTicks: 6000, startAnts: 30, colonyCap: 150 }), startPickWindowMs: 5,
    accounts: { identities, lobbies, ratings: createRatings(store, identities) }, watchRegistry: createWatchRegistry(store),
    slot: { slot: "public-0", publicUrl: "http://capture-slot.invalid", identities, lobbies, pollMs: 10 },
    spectatorClock: clock,
    replayStore: { create: async object => { objects.set(object.name, object); } },
    replaySource: { open: async id => { const object = objects.get(`${id}.bin`); return object ? { body: Readable.from([object.body]) } : null; } },
  }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const clients: Client[] = [];
  // The configured unrated delay is unchanged. Advance local simulation ticks
  // and spectator time for lifecycle checkpoints, never as latency/FPS evidence.
  const ticker = setInterval(() => clock.advance(10), 10);
  const control = async (action: "start" | "stop", credential: string = token) => {
    const response = await fetch(`${origin}/operator/${action}`, { method: "POST", headers: { authorization: `Bearer ${credential}` } });
    await response.body?.cancel();
    return response.status;
  };
  return {
    server, origin, objects, control,
    async admit() {
      const previous = server.game.match?.seq ?? 0;
      const created = await lobbies.createLobby(keys[0]!, "public", 1);
      assert.ok(created.ok);
      for (const key of keys) assert.ok((await lobbies.join(created.value.lobby.id, key)).ok);
      await until(() => server.game.nextStart !== null, "slot seating");
      for (const key of keys) {
        const client = new Client({ name: "slot-capture", version: "1.0.0" });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin)));
        const result = await client.callTool({ name: "join", arguments: { key } });
        assert.notEqual(result.isError, true, "keyed slot admission failed");
      }
      await until(() => (server.game.match?.seq ?? 0) > previous && (server.game.match?.state.tick ?? 0) >= 1, "slot match start");
      // The real hub requires BOTH simulation age and wall-clock age. Clock
      // travel alone cannot release a running snapshot. Drive only nonterminal
      // fixture ticks through the same game and hub, then let the server resume.
      assert.ok(server.game instanceof Game, "local fixture requires the real simulation driver");
      const game = server.game;
      const seq = game.match!.seq;
      const tickMs = 1000 / game.simConfig.ticksPerSecond;
      for (let tick = 0; tick < UNRATED_DELAY_SECONDS * game.simConfig.ticksPerSecond; tick++) {
        const out = game.tick();
        assert.ok(out, "capture fixture must keep producing simulation ticks");
        assert.equal(out.state.result, null, "capture fixture ended before its live checkpoint");
        server.hub.pushTick(seq, out);
        clock.advance(tickMs);
      }
      return created.value.lobby.id;
    },
    async finish(lobbyId: string) {
      const before = objects.size;
      assert.equal(await control("stop", "wrong"), 401);
      assert.equal(server.game.match!.result, null);
      assert.equal(await control("stop"), 200);
      assert.notEqual(server.game.match!.result, null);
      clock.advance(61_000);
      await until(() => objects.size === before + 1, "slot recording");
      await until(() => server.hub.watchStatus(lobbyId)?.playbackFinished === true, "slot delayed result");
      for (const client of clients.splice(0)) await client.close();
    },
    async close() {
      clearInterval(ticker);
      for (const client of clients.splice(0)) await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function main() {
  const output = join(OUT_DIR, "operator-check");
  await mkdir(output, { recursive: true });
  const fixture = await createSlotCaptureFixture();
  const results: { mode: string; starts: number; stops: number; navigations: number; recordings: number; manualDraws: number }[] = [];
  let browser: Browser | undefined;
  try {
    assert.equal(await fixture.control("start", "wrong"), 401);
    assert.equal(await fixture.control("start"), 409, "slots start only from lobbies");
    assert.equal(fixture.server.game.match, null);
    for (const mode of ["2d", "boardless", "3d"] as const) {
      browser = await launchBrowser({ webgl: mode !== "boardless" });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      let navigations = 0, manualDraws = 0;
      page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const manual3d = mode === "3d";
      for (let match = 0; match < 2; match++) {
        const lobbyId = await fixture.admit();
        const query = new URLSearchParams({ lobby: lobbyId, watch: "1", board: mode === "boardless" ? "2d" : mode,
          ...(manual3d ? { capture: "1", gpuTiming: "0" } : {}),
        });
        await page.goto(`${fixture.origin}/?${query}`);
        if (mode !== "boardless") {
          // Capture-mode 3D has no automatic frame loop: drive its first frame
          // before waiting for visible HUD content, not after that wait.
          await page.waitForFunction(manual => {
            try {
              if (manual) window.__antwar.frame(false);
              return window.__antwar.board()?.ended === false;
            } catch { return false; }
          }, manual3d);
        }
        // The 3D board shows the Instrument deck, its mode in the board frame's legend; 2D keeps today's HUD.
        const deck = mode === "3d";
        if (deck) await page.locator(".d1-legend", { hasText: /^LIVE\s· unrated match/ }).waitFor();
        else await page.locator(".d2-mode-label", { hasText: /^LIVE · unrated match$/ }).waitFor();
        await page.locator(deck ? ".d1-hud" : ".d2-hud").waitFor();
        if (mode !== "boardless") {
          const info = await page.evaluate(() => window.__antwar.ready);
          assert.equal(info.webgl2, true);
          if (manual3d) {
            assert.match(info.rendererName, /^babylon /, "3D must not silently become 2D");
            assert.equal(new URL(page.url()).searchParams.get("board"), "3d");
            await page.evaluate(() => window.__antwar.frame()); manualDraws++;
          }
        }
        const beforeStop = navigations;
        await page.screenshot({ path: join(output, `${mode}-${match}-live.png`) });
        await fixture.finish(lobbyId);
        if (manual3d) {
          await page.waitForFunction(() => {
            window.__antwar.frame(false);
            return window.__antwar.board()?.ended === true && document.querySelector<HTMLElement>(".d1-result")?.hidden === false;
          });
          await page.evaluate(() => window.__antwar.frame()); manualDraws++;
        }
        await page.locator(".d1-result").waitFor({ state: "visible" });
        const recording = await (await fetch(`${fixture.origin}/watch/recording/${lobbyId}`)).json() as { replayId: string | null };
        assert.ok(recording.replayId);
        const response = await fetch(`${fixture.origin}/replays/${recording.replayId}`);
        assert.equal(response.status, 200); await response.body?.cancel();
        assert.equal(navigations, beforeStop, `${mode} navigated during slot stop`);
        await page.screenshot({ path: join(output, `${mode}-${match}-stopped.png`) });
      }
      assert.deepEqual(errors, [], `${mode} page exceptions`);
      assert.equal(navigations, 2, `${mode} unexpected navigation beyond the two explicit lobby visits`);
      if (manual3d) assert.equal(manualDraws, 4, "3D must draw both live and stopped states twice");
      results.push({ mode, starts: 2, stops: 2, navigations, recordings: fixture.objects.size, manualDraws });
      await context.close(); await browser.close(); browser = undefined;
    }
    const report = { passed: true, node: process.version, threeDCheck: "keyed-slot lifecycle checkpoints with fixture simulation and spectator time, not FPS or delay evidence", results };
    await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser?.close(); await fixture.close(); }
}

if (import.meta.main) await main();
