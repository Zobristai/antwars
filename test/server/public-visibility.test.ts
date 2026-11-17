import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import type { HistorySummary } from "../../src/replays/history-source.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

const hidden = "2026-10-20T10-00-00-000Z-1", shown = "2026-10-20T11-00-00-000Z-1";
const owner = "00000000-0000-4000-8000-000000000001";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const row = (id: string): HistorySummary => ({ id, startedAt: "2026-10-20T10:00:00Z", endedAt: null,
  simulationEndedAt: null, winner: null, reason: null, decidedBy: null, seats: [], status: "complete", unavailable: [] });

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

it("wires filtering and all direct media guards, retaining empty-page continuations", async () => {
  const f = await fixture(true);
  const first = await fetch(`${f.origin}/matches`);
  expect(await first.json()).toEqual({ matches: [], nextPageToken: "next" });
  const next = await fetch(`${f.origin}/matches?pageToken=next`);
  expect((await next.json()).matches.map((r: HistorySummary) => r.id)).toEqual([shown]);
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
