import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { createGcsHistorySource } from "../../src/replays/history-source.ts";
import { historyRoutes } from "../../src/replays/history-routes.ts";
import { createTestRecordings } from "../../src/replays/test-recordings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

// Synthetic end-to-end latency, not a production measurement. A common row costs 150 ms in series:
// 100 ms to open a record, 25 ms to read ownership, 25 ms to look up its lobby. Legacy rows cost extra.
it("builds the five-match listing with bounded reads, including cold and expired snapshots", async () => {
  const ids = Array.from({ length: 512 }, (_, i) => `2026-11-01T00-00-00-000Z-${i + 1}`).sort();
  const { store, docs } = memoryWatchStore();
  const owner = randomUUID(), excluded = randomUUID(), lobbyId = randomUUID();
  docs.set(`lobbies/${lobbyId}`, { seats: JSON.stringify([{ id: owner }]) });
  docs.set(`identities/${owner}`, { kind: "username" });
  const legacy = new Set(ids.filter((_, i) => i % 10 === 0));
  for (const id of ids) if (!legacy.has(id)) docs.set(`replayOwnership/${id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([owner]) });
  docs.set(`testRecordings/${ids[0]}`, { version: "1" });
  let bodyReads = 0, active = 0, peak = 0, dbReads = 0;
  const latency = async () => { ++dbReads; await sleep(25); };
  store.getMany = async paths => { await latency(); return new Map(paths.map(key => [key, docs.get(key) ?? null])); };
  const visibility = createPublicVisibility(store, { async replayLobby() { await latency(); return { state: "found", lobbyId }; } }, [excluded]);
  const objects = createServer(async (req, res) => {
    const id = /\/([^/]+)\.json/.exec(req.url!)![1];
    peak = Math.max(peak, ++active); ++bodyReads; await sleep(100); --active;
    res.end(JSON.stringify({ format: "antwar.match", version: 1, id, startedAt: "2026-11-01T00:00:00.000Z", endedAt: null,
      simulationEndedAt: null, result: { winner: 1, reason: "time_up", decidedBy: "territory" }, setup: { rated: true },
      seats: ["sample-amber-wing/leaf", "sample-blue-mound"].map((handle, seat) => ({ seat, colony: seat, handle, modelLabel: "Sample model" })),
      status: "complete", unavailable: [], events: [] }));
  });
  objects.listen(0, "127.0.0.1"); await once(objects, "listening");
  const local = `http://127.0.0.1:${(objects.address() as AddressInfo).port}`;
  const source = createGcsHistorySource("fixture", async input => String(input).includes("metadata.google.internal")
    ? Response.json({ access_token: "sample" }) : Response.json({ items: ids.map(id => ({ name: `${id}.json`, generation: "1" })) }),
    (url, options, cb) => get(local + url.pathname + url.search, options, cb));
  let now = 0;
  const handler = historyRoutes(source, async () => { await latency(); return null; }, { publicVisibility: visibility,
    testRecordings: createTestRecordings(store), usersNow: () => now, ratings: { async leaderboard() { await latency(); return { ok: true, value: { entries: [] } }; } } });
  const site = createServer((req, res) => { void handler(req, res, undefined as never); });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  try {
    for (const build of ["cold", "hit", "expired"]) {
      if (build === "expired") now += 60_001;
      bodyReads = dbReads = peak = 0;
      const start = performance.now();
      const visitors = await Promise.all(Array.from({ length: 3 }, async () => {
        const res = await fetch(`http://127.0.0.1:${(site.address() as AddressInfo).port}/matches/users`);
        expect(res.status).toBe(200);
        return (await res.json()).users;
      }));
      console.info(`Synthetic Users ${build}: ${Math.round(performance.now() - start)} ms; ${bodyReads} bodies, ${dbReads} database reads, peak ${peak} simultaneous bodies`);
      expect(bodyReads).toBe(build === "hit" ? 0 : 512);
      if (build !== "hit") { expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(20); }
      for (const rows of visitors) {
        expect(rows).toHaveLength(2);
        expect(rows[0].matches).toBe(511);
        expect(rows[0].recent.map((r: { id: string }) => r.id)).toEqual(ids.slice(-5).reverse());
      }
    }
  } finally {
    for (const server of [objects, site]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}, 35_000);
