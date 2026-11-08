import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { briefing, joinBriefing, type BriefingContext } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { COMPARISON_SEED, comparisonOptions, startServer, type GameServer } from "../../src/server.js";
import { rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { connect, tempDir, waitFor, type Agent } from "../server/helpers.js";
import { startHarness } from "./harness.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// The hosted briefing (lobby slot servers and the accounts-enabled entry server) is benchmark
// condition text. The baseline is main 5df81d04 (the game-mode naming change
// moved it from 037784f0). These digests were computed at main 5df81d04 from the
// public redesign config, before the drawn map (undrawn) and after the drawn map of seed 6006.
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "a73bed09dc974000757e5190e8a530daabfaa4f4a515553e486ef6ee95e7646c",
  "join house=false undrawn=true nest=true": "78e84dc21139985ab4e1ce66dc31309ce1c2fd9b6aa3cdf69187e7718c516477",
  "rules house=false undrawn=true": "f7cd1a923f457f695e031f552b8b918316afdb30b4f95ec30dceccb075670a1d",
  "join house=false undrawn=false nest=false": "e9f688f19c8339840c6bbc6829cc72354f3c5d1471bf7e2d0c2de41b867b40ff",
  "join house=false undrawn=false nest=true": "68f0962e27e969afd67d0c0194d1c19c10631a057f6c098b0b0702e4dc3c9c92",
  "rules house=false undrawn=false": "8e465123d6b6931e60a266b23ea1de2f44860ff4cd07ae11322954d9d7ec0c33",
  "join house=true undrawn=true nest=false": "a0cea5ce0ddddc0692d9e2fd5460f46f7cbd486bae42bed1ec87e45136d8b903",
  "join house=true undrawn=true nest=true": "3671ed8532eaac26c3feec48050365d4398d03ec8abe1298994ddfce4d773d1f",
  "rules house=true undrawn=true": "16acb8c1c19234cf1776563a18bf01420b1a575c07c7894d35bd179cdcb9ea5d",
  "join house=true undrawn=false nest=false": "809b6a3ea7dab59a0f72d051b4168a1a86387233970a29100b50b371c27a5c6f",
  "join house=true undrawn=false nest=true": "332058a22ce922377df19f2fdf9718bd0594d9403a9a3646c4b8a51270023069",
  "rules house=true undrawn=false": "cf83e3740c62025ed6d2a81006dbfc74e9afa5d95a5ce0402b2e3fa95d729fad",
};

// The antwar-preview comparison service (held-match mode, ANTWAR_RULES and ANTWAR_PLAYERS set) is hosted
// too and keeps today's text. These digests were computed at main 5df81d04: the join briefing at the
// barrier, before the seed draws the map, and the rules text of the drawn seed 6006 match.
const PREVIEW_RULES = ["v4", "count-marks", "redesign"] as const;
const PREVIEW_AT_5DF81D04: Record<string, string> = {
  "join v4 players=2": "4cb5c2d7e10d77b25293e812f51bcf1e8c89bd3602a58e5550aba8109ea28d32",
  "rules v4 players=2": "cf87720b9e462a73f6e49bed55019c5a4882b5dc80ac4af1d63152cbabceb8cc",
  "join v4 players=4": "dfaedd2e579dd9d7eaa3a8843ce51dbc98ea03fe6d60317b22270536c5f26590",
  "rules v4 players=4": "536fa723664b9221adc9dbc92d694a6e6f10ad5a350571a2d0ba4f3c0b088467",
  "join count-marks players=2": "ad6c717089ff3bd98c37744867f4bc94e0da0bbd84a35cfa3f25fbbe73a147a2",
  "rules count-marks players=2": "5a1ea729b554fadddd9996266d4e17a0606d60490c0246814a934eb953fc59cc",
  "join count-marks players=4": "7d54e84b4c05c22d9afa1e901325bec5a214e518aa0b2abda718c190986f021a",
  "rules count-marks players=4": "bd12b82e83607dc269cb7cbbfa3d82095fba3184fbbed0f8429bca5d47ebc4cc",
  "join redesign players=2": "81a0f36ee94d3dca93b754ec54b19b34fc424eeb2a5e07d8ff84c34fa2c9a742",
  "rules redesign players=2": "7e59399b776ad79880ccf3baddf965bc4a9ff4dd077ffe3c73afc7d90bc0c3dc",
  "join redesign players=4": "4e9e33146cc1089adc0bca475e95f86bfc33acc04aa8130531aef22f8a9a8160",
  "rules redesign players=4": "a07826d55faf68a7383d1e1c35cf8862ec00fc3b4abe97e3980d56830d45cbcd",
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

  it("a lobby slot server serves the hosted text", async () => {
    const h = await startHarness({ start: false, simConfig: rulesConfig("redesign"), slot: {
      identityOf: async key => key === "pin-key" ? "pin-seat" : undefined,
      locate: async () => undefined,
    } });
    try {
      h.game.seatLobby("pin-lobby", [
        { identityId: "pin-seat", displayName: "Pin", colony: 0 },
        { identityId: "other-seat", displayName: "Other", colony: 1 },
      ]);
      h.game.startMatch(41);
      const agent = await h.connect();
      const joined = await agent.call("join", { key: "pin-key" });
      expect(joined.isError, joined.text).toBe(false);
      const rules = await agent.call("rules");
      const config = h.game.match!.state.config;
      expect(joined.data.briefing).toBe(joinBriefing(config, h.game.mcpConfig, false, { house: false, undrawn: false }));
      expect(rules.data.rules).toBe(briefing(config, h.game.mcpConfig, { house: false, undrawn: false }));
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
