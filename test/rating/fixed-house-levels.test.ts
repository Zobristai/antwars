import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { CLAIM_WINDOW_MS, HANDLE_CREATION_LIMIT, type Identity } from "../../src/identity/identities.ts";
import { HOUSE_LABELS } from "../../src/rating/house.ts";
import { createRatings, ratingCollection, type LeaderboardEntry, type RankedMode } from "../../src/rating/ratings.ts";
import { startServer } from "../../src/server.ts";
import { loadLeaderboard } from "../../web/src/leaderboard.ts";
import { benchmarkLabel } from "../../web/src/leaderboard-page/view.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { connect, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

/**
 * Each antwars handle's confirmed fixed level and tier
 * and its display name and badges on the page.
 */
const CONFIRMED: Readonly<Record<string, readonly [level: string | null, tier: string | null, name: string, badges: readonly string[]]>> = {
  "claude-opus-5-5": ["high", null, "Claude Opus 5.5", ["high"]],
  "claude-opus-5-5-low": ["low", null, "Claude Opus 5.5", ["low"]],
  "claude-opus-5-5-medium": ["medium", null, "Claude Opus 5.5", ["medium"]],
  "claude-opus-5-5-xhigh": ["xhigh", null, "Claude Opus 5.5", ["xhigh"]],
  "claude-opus-5-5-max": ["max", null, "Claude Opus 5.5", ["max"]],
  "claude-fable-5-1": ["max", null, "Claude Fable 5.1", ["max"]],
  "claude-fable-5-2": ["max", null, "Claude Fable 5.2", ["max"]],
  "claude-sonnet-5-5": ["max", null, "Claude Sonnet 5.5", ["max"]],
  "glm-5-3": ["max", null, "GLM-5.3", ["max"]],
  "k3-1-pro": ["max", null, "K3.1 Pro", ["max"]],
  "muse-spark-1-3": ["max", null, "Muse Spark 1.3", ["max"]],
  "muse-wonder-1-0": ["max", null, "Muse Wonder 1.0", ["max"]],
  "muse-wonder-full-1-0": ["max", null, "Muse Wonder Full 1.0", ["max"]],
  "claude-haiku-5-5": ["max", null, "Claude Haiku 5.5", ["max"]],
  "deepseek-flash": ["max", null, "DeepSeek V4.1 Flash", ["max"]],
  "gpt-6-luna": ["max", "fast", "GPT-6 Luna", ["max", "Fast"]],
  "gpt-6-astra": ["max", "fast", "GPT-6 Astra", ["max", "Fast"]],
  "k3-1-pro-highspeed": ["high", null, "K3.1 Pro Highspeed", ["high"]],
  "grok-4-7": ["xhigh", null, "Grok 4.7", ["xhigh"]],
  "mimo-v2-6-flash": ["high", null, "MiMo V2.6 Flash", ["high"]],
  "mimo-v2-6-pro": ["high", null, "MiMo V2.6 Pro", ["high"]],
  "qwen3-8-max": ["xhigh", null, "Qwen3.8 Max", ["xhigh"]],
  "gpt-6-1-sol": ["max", "fast", "GPT-6.1 Sol", ["max", "Fast"]],
  "gpt-6-1-sol-high": ["high", "standard", "GPT-6.1 Sol", ["high"]],
  "gpt-6-1-sol-xhigh": ["xhigh", "standard", "GPT-6.1 Sol", ["xhigh"]],
  "gpt-6-1-sol-high-fast": ["high", "fast", "GPT-6.1 Sol", ["high", "Fast"]],
  "gpt-6-1-sol-xhigh-fast": ["xhigh", "fast", "GPT-6.1 Sol", ["xhigh", "Fast"]],
  // GPT-6.1 Terra at max, Fast and standard.
  "gpt-6-1-terra-max-fast": ["max", "fast", "GPT-6.1 Terra", ["max", "Fast"]],
  "gpt-6-1-terra-max": ["max", "standard", "GPT-6.1 Terra", ["max"]],
  // High at the standard tier, so no Fast badge.
  "gemini-3-8-flash": ["high", "standard", "Gemini 3.8 Flash", ["high"]],
  "gemini-4-argon": ["high", "standard", "Gemini 4 Argon", ["high"]],
  // Abliterated and Mistral models at the standard tier, so no Fast badge.
  "abliterated-model-large": ["max", "standard", "Abliterated GLM-5.2", ["max"]],
  "abliterated-model": ["high", "standard", "Abliterated Model", ["high"]],
  "mistral-large-4": ["high", "standard", "Mistral Large 4", ["high"]],
  "abliterated-large-v2": ["max", "standard", "Abliterated GLM-5.3", ["max"]],
  "abliterated-large-flash": ["max", "standard", "Abliterated DeepSeek V4.1 Flash", ["max"]],
  // No fixed value: the display name with no badges.
  "gemini-3-1-pro-preview": [null, null, "Gemini 3.1 Pro Preview", []],
  "grok-composer-2-5-fast": [null, null, "Grok Composer 2.5 Fast", []],
  "glm-5-3-highspeed": [null, null, "GLM-5.3 Highspeed", []],
  "mistral-large-latest": [null, null, "Mistral Large", []],
  // The recorded model key, a display name only.
  "gpt-6-1-terra": [null, null, "GPT-6.1 Terra", []],
};
/** What the page shows for a Benchmark row: its display name and badges. */
const shownLabel = (row: Parameters<typeof benchmarkLabel>[0]) => {
  const { name, badges } = benchmarkLabel(row);
  return [name, badges] as const;
};
const HANDLES = Object.keys(CONFIRMED);

/** Every confirmed handle under the antwars username, plus a public username with a look-alike handle. */
async function world() {
  // One username creates at most HANDLE_CREATION_LIMIT handles per window, so the house set is created in
  // batches a window apart, starting far enough back that the clock ends at now.
  const windows = Math.ceil(HANDLES.length / HANDLE_CREATION_LIMIT) - 1;
  const w = retentionWorld(Date.now() - windows * CLAIM_WINDOW_MS);
  const house = value(await w.ids.claimUsername("antwars"));
  const ids = new Map<string, Identity>();
  for (const [i, handle] of HANDLES.entries()) {
    if (i > 0 && i % HANDLE_CREATION_LIMIT === 0) w.advance(CLAIM_WINDOW_MS);
    ids.set(handle, value(await w.ids.createHandle(house.key, handle)).identity);
  }
  const kay = value(await w.ids.claimUsername("kite"));
  const lookalike = value(await w.ids.createHandle(kay.key, "gpt-6-1-sol")).identity;
  const ratings = createRatings(w.store, w.ids);
  await ratings.houseBackfill;
  const lobbies = createLobbies(w.store, w.ids, { now: w.now, countdownMs: 0 });
  return { ...w, identity: (handle: string) => ids.get(handle)!, id: (handle: string) => ids.get(handle)!.id, lookalike, ratings, lobbies };
}
type World = Awaited<ReturnType<typeof world>>;

async function entries(w: World, mode: RankedMode, scope?: "house"): Promise<readonly LeaderboardEntry[]> {
  return value(await w.ratings.leaderboard({ mode, scope, limit: 100 })).entries;
}
const byHandle = (rows: readonly LeaderboardEntry[]) =>
  new Map(rows.filter(row => row.benchmark).map(row => [row.displayName.slice("antwars/".length), row]));

/** Rates every handle once in `mode`, in pairs, with each seat reporting `level` and `tier`. */
async function rateAll(w: World, mode: RankedMode, tag: string, level: string | null | undefined, tier: string | null | undefined) {
  const list = [...HANDLES];
  for (let i = 0; i < list.length; i += 2) {
    const a = w.id(list[i]!), b = w.id(list[(i + 1) % list.length]!);
    await w.ratings.applyResult({ matchId: `${tag}-${i}`, teams: [[a], [b]], winner: "a", mode,
      ...(level === undefined ? {} : { thinkingLevels: { [a]: level, [b]: level } }),
      ...(tier === undefined ? {} : { serviceTiers: { [a]: tier, [b]: tier } }) });
  }
}

function expectConfirmed(rows: readonly LeaderboardEntry[]) {
  const found = byHandle(rows);
  expect([...found.keys()].sort()).toEqual([...HANDLES].sort());
  for (const [handle, [level, tier, name, badges]] of Object.entries(CONFIRMED)) {
    const row = found.get(handle)!;
    expect([handle, row.thinkingLevel, row.serviceTier, ...shownLabel(row)]).toEqual([handle, level, tier, name, badges]);
  }
}

describe("fixed level and tier per Antwars Model Index handle", () => {
  it("the code table holds exactly the confirmed names, levels and tiers", () => {
    expect(Object.fromEntries(Object.entries(HOUSE_LABELS))).toEqual(
      Object.fromEntries(Object.entries(CONFIRMED).map(([handle, [thinkingLevel, serviceTier, displayName]]) => [handle, { displayName, thinkingLevel, serviceTier }])));
  });

  it.each(["house-1v1", "house-2v2", "1v1"] as const)("%s: every handle shows its fixed level, tier and name in both rankings", async mode => {
    const w = await world();
    await rateAll(w, mode, "first", "low", "standard");
    expectConfirmed(await entries(w, mode));
    expectConfirmed(await entries(w, mode, "house"));
  });

  it("a seat reporting another level or tier, or none, never changes a handle's level, tier or name", async () => {
    const w = await world();
    for (const [tag, level, tier] of [["mismatch", "low", "fast"], ["other", "max", "standard"], ["null", null, null], ["absent", undefined, undefined]] as const) {
      await rateAll(w, "house-1v1", tag, level, tier);
      expectConfirmed(await entries(w, "house-1v1"));
    }
    // The seat's report is still recorded on the row (unchanged storage); it is only never shown for a Benchmark row.
    await rateAll(w, "house-1v1", "last", "low", "fast");
    expect(w.docs.get(`${ratingCollection("house-1v1")}/${w.id("claude-opus-5-5")}`)).toMatchObject({ thinkingLevel: "low", serviceTier: "fast" });
    const opus = byHandle(await entries(w, "house-1v1")).get("claude-opus-5-5")!;
    expect([opus.thinkingLevel, opus.serviceTier, ...shownLabel(opus)]).toEqual(["high", null, "Claude Opus 5.5", ["high"]]);
  });

  it("a natural Benchmark lobby completion shows the fixed values, not the seats' reports", async () => {
    const w = await world();
    const opus = w.id("claude-opus-5-5"), sol = w.id("gpt-6-1-sol");
    const lobby: Lobby = await w.store.transaction(async read => {
      const made = await w.lobbies.queuedMatchWrites(read, { mode: "house-1v1", colonies: [[w.identity("claude-opus-5-5")], [w.identity("gpt-6-1-sol")]] }, w.now());
      return { result: made.lobby, writes: made.writes };
    });
    await w.lobbies.registerInstance(lobby.slot!, { runId: "run", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" });
    value(await w.lobbies.beginMatch(lobby.id, lobby.slot!, "run"));
    value(await w.lobbies.endMatch(lobby.id, "run", "colony_0_won", { [opus]: "low", [sol]: "high" }, { [opus]: "fast", [sol]: "standard" }));
    const found = byHandle(await entries(w, "house-1v1", "house"));
    expect([found.get("claude-opus-5-5")!, found.get("gpt-6-1-sol")!].map(row => [row.ratedMatches, row.thinkingLevel, row.serviceTier, ...shownLabel(row)]))
      .toEqual([[1, "high", null, "Claude Opus 5.5", ["high"]], [1, "max", "fast", "GPT-6.1 Sol", ["max", "Fast"]]]);
  });

  it("a row the antwars username does not own keeps its latest self-reported level and tier, even with a listed handle name", async () => {
    const w = await world();
    const sol = w.id("gpt-6-1-sol");
    await w.ratings.applyResult({ matchId: "a", teams: [[w.lookalike.id], [sol]], winner: "a", thinkingLevels: { [w.lookalike.id]: "low", [sol]: "low" }, serviceTiers: { [w.lookalike.id]: "standard" } });
    const rows = await entries(w, "1v1");
    expect(rows.find(row => row.identityId === w.lookalike.id)).toMatchObject({ displayName: "kite/gpt-6-1-sol", benchmark: false, thinkingLevel: "low", serviceTier: "standard" });
    await w.ratings.applyResult({ matchId: "b", teams: [[w.lookalike.id], [sol]], winner: "b" });
    expect((await entries(w, "1v1")).find(row => row.identityId === w.lookalike.id)).toMatchObject({ thinkingLevel: null, serviceTier: null });
    expect((await entries(w, "1v1")).find(row => row.identityId === sol)).toMatchObject({ benchmark: true, thinkingLevel: "max", serviceTier: "fast" });
  });

  it("no two distinct Benchmark handles show the same name with the same badges", () => {
    const shown = HANDLES.map(handle => JSON.stringify(shownLabel({ displayName: `antwars/${handle}`, thinkingLevel: CONFIRMED[handle]![0], serviceTier: CONFIRMED[handle]![1] })));
    expect(new Set(shown).size).toBe(HANDLES.length);
  });

  it("serves the fixed values through the HTTP and MCP leaderboards and the browser reader", async () => {
    const w = await world(), dataDir = tempDir();
    await rateAll(w, "house-1v1", "api", "low", "fast");
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, mcpConfig: TEST_MCP_CONFIG,
      accounts: { identities: w.ids, lobbies: w.lobbies, ratings: w.ratings } });
    const client = await connect(server.port);
    try {
      const args = { mode: "house-1v1", scope: "house", limit: 100 };
      const response = await fetch(`http://127.0.0.1:${server.port}/api/leaderboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      const body = await response.json();
      expect(body).toEqual(value(await w.ratings.leaderboard({ mode: "house-1v1", scope: "house", limit: 100 })));
      expectConfirmed(body.entries);
      const mcp = await client.call("leaderboard", args);
      expect(mcp.isError).toBe(false); expect(mcp.data).toEqual(body);
      const page = await loadLeaderboard(undefined, undefined, (input, init) => fetch(`http://127.0.0.1:${server.port}${input}`, init), { mode: "house-1v1", scope: "house" });
      const shown = new Map(page.entries.map(row => [row.displayName.slice("antwars/".length), shownLabel(row)]));
      expect([...shown.keys()].sort()).toEqual([...HANDLES].sort());
      for (const [handle, [, , name, badges]] of Object.entries(CONFIRMED)) expect([handle, ...shown.get(handle)!]).toEqual([handle, name, badges]);
    } finally { await client.close(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
});
