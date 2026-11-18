import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { correctedHistorySource } from "../../src/replays/correctedRecordings.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createPublicVisibility, publiclyVisible } from "../../src/identity/publicVisibility.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import type { HistorySummary } from "../../src/replays/history-source.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

const hidden = "2026-10-20T10-00-00-000Z-1", shown = "2026-10-20T11-00-00-000Z-1";
const owner = "00000000-0000-4000-8000-000000000001";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
// Rated, so the list's match-type rule (publiclyListedMatch) admits every row and only the hide list decides.
const row = (id: string): HistorySummary => ({ id, startedAt: "2026-10-20T10:00:00Z", endedAt: null,
  simulationEndedAt: null, winner: null, reason: null, decidedBy: null, seats: [], status: "complete", unavailable: [], rated: true });

async function fixture(enabled: boolean, failing = false) {
  const { store, docs } = memoryWatchStore();
  docs.set("lobbies/hidden", { seats: JSON.stringify([{ id: owner }]) });
  const policy = createPublicVisibility(store, { replayLobby: async id => {
    if (failing) throw new Error("private source detail");
    return id === hidden ? { state: "found", lobbyId: "hidden" } : { state: "none" };
  } }, enabled ? [owner] : []);
  const opens: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "public-visibility-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const server: SpectatedServer = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir,
    publicVisibility: policy,
    historySource: {
      list: async token => ({ matches: [row(token ? shown : hidden)], nextPageToken: token ? null : "next" }),
      open: async id => { opens.push(`record:${id}`); return Readable.from([`{"format":"antwar.match","version":1,"id":${JSON.stringify(id)},"source":"match-log","status":"complete","events":[]}`]); },
    },
    replaySource: { open: async id => { opens.push(`replay:${id}`); return { body: Readable.from(["recorded bytes"]) }; } },
  });
  cleanup.push(() => server.close());
  return { origin: `http://127.0.0.1:${server.port}`, opens };
}

it("wires filtering and consumes hidden-only pages without exposing their continuations", async () => {
  const f = await fixture(true);
  const first = await fetch(`${f.origin}/matches`);
  const page = await first.json();
  expect(page.matches.map((r: HistorySummary) => r.id)).toEqual([shown]);
  expect(page.nextPageToken).toBeNull();
  for (const [path, method] of [[`/matches/${hidden}`, "GET"], [`/matches/${hidden}`, "HEAD"], [`/replays/${hidden}`, "GET"]]) {
    const response = await fetch(f.origin + path, { method });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  expect(f.opens).toEqual([]);
  for (const path of [`/matches/${shown}`, `/replays/${shown}`]) {
    const response = await fetch(f.origin + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await response.text();
  }
});

it("unset keeps list contents and ordinary immutable media caching", async () => {
  const f = await fixture(false);
  expect((await (await fetch(`${f.origin}/matches`)).json()).matches[0].id).toBe(hidden);
  for (const path of [`/matches/${hidden}`, `/replays/${hidden}`]) {
    const response = await fetch(f.origin + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    await response.text();
  }
});

it("failed membership sends sanitized 503 without opening media", async () => {
  const f = await fixture(true, true);
  for (const path of ["/matches", `/matches/${hidden}`, `/replays/${hidden}`]) {
    const response = await fetch(f.origin + path);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private source detail");
  }
  expect(f.opens).toEqual([]);
});


it("serves only ordinary recorded owners even when watch registration has not arrived", async () => {
  const { store, docs } = memoryWatchStore(), registry = createWatchRegistry(store);
  const ordinary = "00000000-0000-4000-8000-000000000002";
  for (const id of [owner, ordinary]) {
    docs.set(`identities/${id}`, { kind: "username" });
    docs.set(`lobbies/${id}`, { seats: JSON.stringify([{ id }]) });
  }
  const policy = createPublicVisibility(store, registry, [owner])!;
  const recorded = new Set<string>();
  const dataDir = mkdtempSync(join(tmpdir(), "public-visibility-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, publicVisibility: policy,
    historySource: { list: async () => ({ matches: [...recorded].map(row), nextPageToken: null }),
      open: async id => recorded.has(id) ? Readable.from(["{}"]) : null },
    replaySource: { open: async id => recorded.has(id) ? { body: Readable.from(["binary"]) } : null },
  });
  cleanup.push(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  expect((await (await fetch(`${origin}/matches`)).json()).matches).toEqual([]);
  for (const [id, lobbyId] of [[hidden, owner], [shown, ordinary]]) {
    // Publication is permitted only after the ownership transaction has succeeded.
    await registry.recordOwners(lobbyId!, id!); recorded.add(id!);
    expect(await registry.replayLobby(id!)).toEqual({ state: "none" });
  }
  expect((await (await fetch(`${origin}/matches`)).json()).matches.map((r: HistorySummary) => r.id)).toEqual([shown]);
  for (const prefix of ["/matches/", "/replays/"]) {
    const denied = await fetch(origin + prefix + hidden); expect(denied.status).toBe(404); await denied.text();
    const allowed = await fetch(origin + prefix + shown); expect(allowed.status).toBe(200); await allowed.text();
  }
});


it.each([{ hiddenIndices: [0, 1] }, { hiddenIndices: [1, 2, 3] }, { hiddenIndices: [0, 1, 2, 3, 4, 5] }])(
  "history continuations contain only returned public rows across $hiddenIndices", async ({ hiddenIndices }) => {
    const { store, docs } = memoryWatchStore(), registry = createWatchRegistry(store);
    const ids = Array.from({ length: 6 }, (_, index) => `2026-10-20T10-00-00-000Z-${9 - index}`);
    const other = "00000000-0000-4000-8000-000000000002";
    for (const [index, id] of ids.entries()) docs.set(`replayOwnership/${id}`, {
      version: "1", lobbyId: owner, ownerIds: JSON.stringify([hiddenIndices.includes(index) ? owner : other]),
    });
    const after = (id: string) => `after:${id}`;
    const source = correctedHistorySource({
      continuationAfter: after,
      list: async token => {
        const start = token === undefined ? 0 : ids.indexOf(token.slice("after:".length)) + 1;
        const page = ids.slice(start, start + 2);
        return { matches: page.map(row), nextPageToken: start + 2 < ids.length ? after(page.at(-1)!) : null };
      }, open: async () => null,
    }, store);
    const dataDir = mkdtempSync(join(tmpdir(), "public-cursors-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, historySource: source,
      publicVisibility: createPublicVisibility(store, registry, [owner]) });
    cleanup.push(() => server.close());
    const returned: string[] = []; let token: string | null = null, pages = 0;
    do {
      const response: Response = await fetch(`http://127.0.0.1:${server.port}/matches${token === null ? "" : `?pageToken=${encodeURIComponent(token)}`}`);
      expect(response.status).toBe(200);
      const page: { matches: HistorySummary[]; nextPageToken: string | null } = await response.json(); const pageIds = page.matches.map((r: HistorySummary) => r.id);
      returned.push(...pageIds); token = page.nextPageToken; pages++;
      for (const index of hiddenIndices) expect(JSON.stringify(page)).not.toContain(ids[index]);
      if (token !== null) expect(token).toBe(after(pageIds.at(-1)!));
      expect(pages).toBeLessThanOrEqual(6);
    } while (token !== null);
    expect(returned).toEqual(ids.filter((_, index) => !hiddenIndices.includes(index)));
    expect(new Set(returned).size).toBe(returned.length);
  });

it("refuses a raw history continuation when its source cannot construct one from a public row", async () => {
  const { store } = memoryWatchStore();
  const dataDir = mkdtempSync(join(tmpdir(), "public-cursors-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir,
    publicVisibility: createPublicVisibility(store, createWatchRegistry(store), [owner]),
    historySource: { list: async () => ({ matches: [row(shown)], nextPageToken: `private:${hidden}` }), open: async () => null },
  });
  cleanup.push(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.port}/matches`);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain(hidden);
});

it("starts no further visibility check once the read's signal aborts, and fails the read", async () => {
  const abort = new AbortController(), checked: number[] = [];
  const read = publiclyVisible([1, 2, 3, 4], async row => { checked.push(row); if (row === 2) abort.abort(); return true; }, abort.signal);
  await expect(read).rejects.toThrow();
  expect(checked).toEqual([1, 2]);
  // Without a signal every row is checked, in order.
  expect(await publiclyVisible([1, 2, 3], async row => row !== 2)).toEqual([1, 3]);
});
