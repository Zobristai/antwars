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
// Repinned for the idle rule's ranked never-joined clause (", or ranked seat not joined by the limit from match
// start" in the Index clause), which every briefing's idle line carries;
// without that clause every text hashes to its 5df81d04 digest, so nothing else changed.
// Repinned again when the clause covers every lobby match (", or a seat not joined by the limit from match start or an
// earlier end"); with the ranked wording every text hashes to its previous pin, so nothing else changed.
// Repinned for the lobby leave sentence in the non-house lobby guidance ("leave_lobby {key,lobbyId}: leave before
// start, no rating change or charge; the last leaver closes it. "); without it every house=false text hashes to its
// previous pin, and the house=true texts, which carry no lobby guidance, are unchanged.
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "972460439e046611cc39a2f3163034b9e8138a2c8dea88c37256e560acc783fe",
  "join house=false undrawn=true nest=true": "c95bc371b833c71d8ff666ad1c23b536e4a589b8953f3fe8435f6b3032fcf5f8",
  "rules house=false undrawn=true": "2c85f9cd4627343b26f2ea450bde9a174e6b1c26f37f7ab991cfa792b8ed96e3",
  "join house=false undrawn=false nest=false": "32b3bea4246eb164ac36da75a3d435fb10830ece8b75961c8fec513816813c65",
  "join house=false undrawn=false nest=true": "49e4de2ff813b01510ce338f958033db4f66605ac6d723d39a4ecbc09a0ec6de",
  "rules house=false undrawn=false": "b3e013f080a4ebeb339046df87e7cf1ecbf722d6f1803c301fd8ac689d6c13cd",
  "join house=true undrawn=true nest=false": "8238fa2e15595c076df9bf91b910ab2c4a9b7aa69422c4e7b897daf781d7a9a0",
  "join house=true undrawn=true nest=true": "db81dc9ac07a9e9123304f7b1646e03795157801f25465722c3e0aff9c4a1349",
  "rules house=true undrawn=true": "351e906c3bf6a4faf2ca5d1d67878c8dfdcdcc7cb763adf7059d0cb66c0f3745",
  "join house=true undrawn=false nest=false": "ed07560b81c278bb3f573d06927cb1a0e49646d1f73692e2c3c2d26b17731cd7",
  "join house=true undrawn=false nest=true": "99c46321328cc0899325524a38ac872b11373281843ca7bf7aa6bf43726c2fc1",
  "rules house=true undrawn=false": "15c5b74b707424acdacedd7c1ace8f0afa030a737979b8f6bf29e9f1237e27c6",
};

// The antwar-preview comparison service (held-match mode, ANTWAR_RULES and ANTWAR_PLAYERS set) is hosted
// too and keeps today's text. These digests were computed at main 5df81d04: the join briefing at the
// barrier, before the seed draws the map, and the rules text of the drawn seed 6006 match.
// Repinned for the same ranked never-joined idle clause; without it every text hashes to its 5df81d04 digest.
// Repinned again for that clause covering every lobby match, as above.
// Repinned for the lobby leave sentence, as above, in the count-marks and redesign texts that carry the lobby guidance;
// without it each hashes to its previous pin, and the v4 texts are unchanged.
const PREVIEW_RULES = ["v4", "count-marks", "redesign"] as const;
const PREVIEW_AT_5DF81D04: Record<string, string> = {
  "join v4 players=2": "5c5f62959d1ef08efa3ba6e40a31aede6b967a96ed66b893108ec82d2130d14a",
  "rules v4 players=2": "d74106ae57974263cf40fff2fd2e99c52c1c1e7a8d61be0c074032dc0bc14eae",
  "join v4 players=4": "a5b8a4de730c6992b8a27b29f705e6440724292b1cbe22209c7ddcf873029702",
  "rules v4 players=4": "d57a9e79c59accfa216e17c90e02272ac024a32ffb1d7a02a43d93091364648e",
  "join count-marks players=2": "3682600f589eef1ab47b0715ea1700b4acda7b8ebdf9c46be44b1535b8d52abd",
  "rules count-marks players=2": "4926858e7123a556f240cff073e53663fc8457ee7ef2ea7b17c79276265e64d2",
  "join count-marks players=4": "99407834e3522b30c0ba1450f8d405741a515cd8ac06ef23484f719e0d10f224",
  "rules count-marks players=4": "6f368f5fbdef5bec5e6adffd513b9fa7fcb7563f99f354c27fce7ac668fd9887",
  "join redesign players=2": "c3955ec707f0a0ca877f044ce5832b9b541a73eb32c8e9635377b398b5a9acf4",
  "rules redesign players=2": "2a9dfb16cf945bd0dd8cf93456eeebd4aebc5130a55ee08d86161435e23f300f",
  "join redesign players=4": "4853cd96415fee9912124c553f36ba49e1f899911070f2b59bc0d0ad1674cefb",
  "rules redesign players=4": "85f18afae106bb2bd21ec0228feb6a03f5b091ad8012e42a10687548e3a178c8",
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

const ACCOUNT_TOOLS = ["list_lobbies", "create_lobby", "join_lobby", "start_lobby", "read_lobby", "locate_match", "join_queue", "queue_status", "leave_queue", "leave_lobby", "rating", "leaderboard", "create_handle", "rotate_key"];

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
