import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { briefing, joinBriefing, type BriefingContext } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { COMPARISON_SEED, comparisonOptions, startServer, type GameServer } from "../../src/server.js";
import { rulesConfig } from "../../src/sim/config.js";
import { drawColonyNames } from "../../src/sim/colonyNames.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { connect, tempDir, waitFor, type Agent } from "../server/helpers.js";
import { startHarness } from "./harness.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// The hosted briefing (lobby slot servers and the accounts-enabled entry server) is benchmark
// condition text. The baseline is main 5df81d04 (the game-mode naming change
// moved it from 037784f0). These digests were computed at main 5df81d04 from the
// public redesign config, before the drawn map (undrawn) and after the drawn map of seed 6006.
// Repinned for the idle rule's ranked never-joined clause (", or ranked seat not joined by the limit from match
// start" in the Index clause), which every briefing's idle line carries;
// without that clause every text hashes to its 5df81d04 digest, so nothing else changed.
// Repinned again when the clause covers every lobby match (", or a seat not joined by the limit from match start or an
// earlier end"); with the ranked wording every text hashes to its previous pin, so nothing else changed.
// Repinned for the lobby guidance's wait-stream pointer ("Or wait on the waitUrl your join returns (SSE; see join_queue).")
// and its dropped duplicate opening ("No join at the entry point: lobbies/ranked queue -> located slot only."); only the
// house=false texts carry that guidance, and the house=true digests are unchanged.
// Repinned for that pointer reading "Or wait for done on your waitUrl (SSE; see join_queue)."; the previous pointer
// restores the previous pins, so nothing else changed.
// Repinned for the lobby guidance's nest-pick line stating both window lengths ("Matched: nest-pick window 4 min in
// index matches, 2 min in other matches;"); only the house=false and preview texts carry that guidance, and the previous
// line ("Matched: 2 min to pick a nest;") restores the previous pins, so nothing else changed.
// Repinned for the join briefing's same-tick ending reading "(queens killed)" under queen HP, where overrun never
// happens; the previous "(double overrun/queens killed)" restores the previous pins. The rules digests are unchanged.
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "041d477331cf1542c9c2c324e7917802503c8802a9c4b7a54cdafa22171f4eec",
  "join house=false undrawn=true nest=true": "fb5a6cb9191bab5f817aa725646c6034e9a9d8d7941bdd892a6aeedcddcd7efc",
  "rules house=false undrawn=true": "22a99ee04de2f18bafd3d0f63862e6c6514fa85109d1478aa58f9d3fd095b85d",
  "join house=false undrawn=false nest=false": "8610e98444f71b495f0a8112f8e35d87459672fae4527e77360f10d9aba08861",
  "join house=false undrawn=false nest=true": "ecb3f81ee0650b2d17888cd3df91ca7adbd4bb98ad5e3c3540f17a00daaa7921",
  "rules house=false undrawn=false": "0e623889f1326ed042ac876881285cb249e0a4148599b7bd3d230c2aa781ccda",
  "join house=true undrawn=true nest=false": "17d024367b16cfd5125c5105103de6ee7d382ed1c407b4e31e18aa2c23ecce67",
  "join house=true undrawn=true nest=true": "bcfe50a2b0e5dd1da5b4d25676138a958cc876c81f524c33a245d4b1c9a6c6cc",
  "rules house=true undrawn=true": "351e906c3bf6a4faf2ca5d1d67878c8dfdcdcc7cb763adf7059d0cb66c0f3745",
  "join house=true undrawn=false nest=false": "e1ab9ff196b40d29aa79bb46d860d94374436310312fbdc08d85ad0133f57845",
  "join house=true undrawn=false nest=true": "52d03a98f0f52c96f2175d626842a50a21648daf96a09093de8a839bc10741a2",
  "rules house=true undrawn=false": "15c5b74b707424acdacedd7c1ace8f0afa030a737979b8f6bf29e9f1237e27c6",
};

// The antwar-preview comparison service (held-match mode, ANTWAR_RULES and ANTWAR_PLAYERS set) is hosted
// too and keeps today's text. These digests were computed at main 5df81d04: the join briefing at the
// barrier, before the seed draws the map, and the rules text of the drawn seed 6006 match.
// Repinned for the same ranked never-joined idle clause; without it every text hashes to its 5df81d04 digest.
// Repinned again for that clause covering every lobby match, as above.
// Repinned for the same lobby-guidance wait-stream change as above; the v4 digests are unchanged.
// Repinned again for the same "wait for done" pointer as above; the v4 digests are unchanged.
// Repinned for the same nest-pick line stating both window lengths as above; the v4 digests are unchanged.
// Repinned for the same queen-HP "(queens killed)" wording as above; only the redesign join digests change.
const PREVIEW_RULES = ["v4", "count-marks", "redesign"] as const;
const PREVIEW_AT_5DF81D04: Record<string, string> = {
  "join v4 players=2": "5c5f62959d1ef08efa3ba6e40a31aede6b967a96ed66b893108ec82d2130d14a",
  "rules v4 players=2": "d74106ae57974263cf40fff2fd2e99c52c1c1e7a8d61be0c074032dc0bc14eae",
  "join v4 players=4": "a5b8a4de730c6992b8a27b29f705e6440724292b1cbe22209c7ddcf873029702",
  "rules v4 players=4": "d57a9e79c59accfa216e17c90e02272ac024a32ffb1d7a02a43d93091364648e",
  "join count-marks players=2": "5d47e87bfdbf7a6f53b2c70b07070163ff06c2f3458ce07b87c25637b101bfa4",
  "rules count-marks players=2": "74e50fc4f49e3bd3f30fec1484e01e319270592227a5301feb366a38df8166ee",
  "join count-marks players=4": "6ee40f2fed373eb907d39d6e9e28c12908372e05f586092d9fa331a82bca7aa1",
  "rules count-marks players=4": "d493637afc5ca34792863292f9575984a4995eb660e2e4e005f5d830b940e16c",
  "join redesign players=2": "d8689b092f1b1c0a720ea0b52521e5e435d0e26236d9ba77c965ce596fb36605",
  "rules redesign players=2": "53210f12f6031c23f5a7e74fedd4b512b7097fd715c164916e2fe6628865cc3f",
  "join redesign players=4": "aef59f5de77da55482b86a3faa2586b457cf0b87330ea876005ed37f2e3cec90",
  "rules redesign players=4": "7cc47e6550d905d85cadc6310c6387990eacd492e2138ae3281566539ec1d9d6",
};

const UNDRAWN = newMatchConfig(rulesConfig("redesign"));
const DRAWN = createMatch(6006, UNDRAWN).config;

function hostedTexts(extra: Partial<BriefingContext> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const house of [false, true]) for (const undrawn of [true, false]) {
    const config = undrawn ? UNDRAWN : DRAWN;
    const context = { house, undrawn, ...extra };
    for (const nest of [false, true]) out[`join house=${house} undrawn=${undrawn} nest=${nest}`] = joinBriefing(config, DEFAULT_MCP_CONFIG, nest, context);
    out[`rules house=${house} undrawn=${undrawn}`] = briefing(config, DEFAULT_MCP_CONFIG, context);
  }
  return out;
}

const ACCOUNT_TOOLS = ["list_lobbies", "create_lobby", "join_lobby", "start_lobby", "read_lobby", "locate_match", "join_queue", "queue_status", "leave_queue", "rating", "leaderboard", "create_handle", "rotate_key"];

describe("hosted briefing stays byte-identical to main 5df81d04", () => {
  it("every hosted join briefing and rules text matches its 5df81d04 digest", () => {
    const digests = Object.fromEntries(Object.entries(hostedTexts()).map(([name, text]) => [name, sha(text)]));
    expect(digests).toEqual(HOSTED_AT_5DF81D04);
  });

  it("an explicit local: false is the hosted text", () => {
    expect(hostedTexts({ local: false })).toEqual(hostedTexts());
  });

  // A rated lobby serves the hosted text byte for byte; an unrated one the same text naming the colonies it drew.
  for (const mode of ["1v1", null] as const) it(`a ${mode === null ? "unrated" : "rated"} lobby slot server serves the hosted text`, async () => {
    const h = await startHarness({ start: false, simConfig: rulesConfig("redesign"), slot: {
      identityOf: async key => key === "pin-key" ? "pin-seat" : undefined,
      locate: async () => undefined,
    } });
    try {
      h.game.seatLobby("pin-lobby", [
        { identityId: "pin-seat", displayName: "Pin", colony: 0 },
        { identityId: "other-seat", displayName: "Other", colony: 1 },
      ], mode);
      h.game.startMatch(41);
      const agent = await h.connect();
      const joined = await agent.call("join", { key: "pin-key" });
      expect(joined.isError, joined.text).toBe(false);
      const rules = await agent.call("rules");
      const config = h.game.match!.state.config;
      expect(joined.data.briefing).toBe(joinBriefing(config, h.game.mcpConfig, false, { house: false, undrawn: false }));
      const names = mode === null ? { colonyNames: drawColonyNames("pin-lobby") } : {};
      expect(rules.data.rules).toBe(briefing(config, h.game.mcpConfig, { house: false, undrawn: false, ...names }));
      if (mode !== null) expect(rules.data.rules).toBe(briefing(config, h.game.mcpConfig, { house: false, undrawn: false }));
      expect(joined.data.briefing).toContain("Accounts are required");
    } finally {
      await h.close();
    }
  });
});

describe("preview held-match briefing stays byte-identical to main 5df81d04", () => {
  let server: GameServer | null = null;
  const agents: Agent[] = [];
  const savedService = process.env.K_SERVICE;
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close();
    await server?.close();
    server = null;
    // Restore K_SERVICE so the Cloud Run marker cannot leak into later tests.
    if (savedService === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = savedService;
    vi.restoreAllMocks();
  });

  it("every preview join briefing and rules text matches its 5df81d04 digest", () => {
    const digests: Record<string, string> = {};
    for (const rules of PREVIEW_RULES) for (const players of [2, 4] as const) {
      const mcp = { ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players };
      const config = { ...newMatchConfig(rulesConfig(rules)), players };
      digests[`join ${rules} players=${players}`] = sha(joinBriefing(config, mcp, false, { house: false, undrawn: true }));
      digests[`rules ${rules} players=${players}`] = sha(briefing(createMatch(COMPARISON_SEED, config).config, mcp));
    }
    expect(digests).toEqual(PREVIEW_AT_5DF81D04);
  });

  for (const rules of PREVIEW_RULES) for (const players of [2, 4] as const) {
    it(`a comparison server on Cloud Run (K_SERVICE set) serves the hosted text: ${rules}, ${players} players`, async () => {
      process.env.K_SERVICE = "antwar-preview";
      // The comparison match copies its log to stdout; keep the test output readable.
      vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
      server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), ...comparisonOptions({ ANTWAR_RULES: rules, ANTWAR_PLAYERS: String(players) }, DEFAULT_MCP_CONFIG) });
      const joins = [];
      for (let i = 0; i < players; i++) {
        const agent = await connect(server.port);
        agents.push(agent);
        joins.push(await agent.call("join", {}));
      }
      await waitFor(() => (server!.game.match?.state.tick ?? 0) >= 1);
      for (const [index, joined] of joins.entries()) {
        expect(joined.isError, joined.text).toBe(false);
        expect(sha(joined.data.briefing as string)).toBe(PREVIEW_AT_5DF81D04[`join ${rules} players=${players}`]);
        const full = await agents[index]!.call("rules", {});
        expect(full.isError, full.text).toBe(false);
        expect(sha(full.data.rules as string)).toBe(PREVIEW_AT_5DF81D04[`rules ${rules} players=${players}`]);
      }
    }, 30_000);
  }
});

describe("local briefing", () => {
  it("omits account, key and lobby text and rejoins with reconnectToken", () => {
    for (const [name, text] of Object.entries(hostedTexts({ local: true }))) {
      expect(text, name).not.toContain("Accounts are required");
      expect(text, name).not.toMatch(/no join at the entry point/i);
      expect(text, name).not.toMatch(/ANTWARS_KEY|~\/\.antwars\/key|username/);
      for (const tool of ACCOUNT_TOOLS) expect(text, `${name}: ${tool}`).not.toMatch(new RegExp(`\\b${tool}\\b`));
      expect(text, name).toMatch(/join \{reconnectToken\}; token is an alias/);
    }
  });
});
