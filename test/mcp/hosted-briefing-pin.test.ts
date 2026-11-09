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
// start" in the Index clause, decision da631e67), which every briefing's idle line carries;
// without that clause every text hashes to its 5df81d04 digest, so nothing else changed.
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "743c4dcc81fdd6a5d9773a67f57bf31c550ddb3e1e0768648531df04495da583",
  "join house=false undrawn=true nest=true": "7827c8579cdb25dd8980ac63849455b812c9a4f30a1a2914f8882c4335abcfa2",
  "rules house=false undrawn=true": "1250dc102475c5aad3cbdb41888524a42e5beb3650c182a2b3ec4e4341558e59",
  "join house=false undrawn=false nest=false": "2cb82226813ed4ff6d07c399fd8ea3b4317eccc4a2068a7932aa5d66d99e0148",
  "join house=false undrawn=false nest=true": "77b4c5d4ea895b428d362302335ce95b7786f10a55d439e414ff05fd34a58864",
  "rules house=false undrawn=false": "479bc24479729dce6fe51b1962486876e87e3e5a17306f8394d24ed81e723d8c",
  "join house=true undrawn=true nest=false": "bc8a005afb78872af02ab62457e19aa2210f514d939d2c6e936401234dd9a193",
  "join house=true undrawn=true nest=true": "95f7b32a63b683fbe7cc06544ef9754d27926dd30f74c8a7606551e735d85d2c",
  "rules house=true undrawn=true": "6f197b7ce10dd0eab718a4b2fd1cdb59798cd01a612017226fe3a0b4ec06e5cb",
  "join house=true undrawn=false nest=false": "9e0249f36e0bcba588d6f65cee00da9347225747b2ca074c2bb589b3b532fb24",
  "join house=true undrawn=false nest=true": "4998ad069f6f951fe021ba6d86daa22332c1184739e83daccb642f698768df73",
  "rules house=true undrawn=false": "2bce5ba1004fc093c95c1331f7eb50d09891088a03d6b06fb64e83a6e5ec744b",
};

// The antwar-preview comparison service (held-match mode, ANTWAR_RULES and ANTWAR_PLAYERS set) is hosted
// too and keeps today's text. These digests were computed at main 5df81d04: the join briefing at the
// barrier, before the seed draws the map, and the rules text of the drawn seed 6006 match.
// Repinned for the same ranked never-joined idle clause; without it every text hashes to its 5df81d04 digest.
const PREVIEW_RULES = ["v4", "count-marks", "redesign"] as const;
const PREVIEW_AT_5DF81D04: Record<string, string> = {
  "join v4 players=2": "af70cc4edc3a41e091af318c203f655c5e1cae5ee5d53f498f79a6a736b085aa",
  "rules v4 players=2": "7417008686c1ce3e3e1e9ad6f3e58b4427ee2a35c860c46cb75ba2d4ca7141cf",
  "join v4 players=4": "98eb2b8394502342d7f593680d76807489d5ab6e584aef33572d952753c5c902",
  "rules v4 players=4": "0538b3defbd58067a581ead95b128c2fc542b97ee2a422c5dd1d8e8a58e200df",
  "join count-marks players=2": "e10b95d0531b0a7d98880f31ea3ead0aa9d95905de16aaf96d6d2983425417f4",
  "rules count-marks players=2": "ee2f0ef66e5d1af187463d2e6fb1b0e9246256e2e638e67c8417f9462d72eec7",
  "join count-marks players=4": "6692336e24520bdf7494d68ae2e3e00494d70c5fad3dacec50340da012785161",
  "rules count-marks players=4": "5b18a5341b66d4e5c4adc05454bc07aa5702f908265bbde56c16de6bb4b604bd",
  "join redesign players=2": "c7fc7d28a9141922d54c83f56a5db8d27be4eeffd8edd18d23c52e729cff7fe5",
  "rules redesign players=2": "8f2954209dd25fc99d99cb12982e678e8f660e98519430c02e3bb0bee9c3af1c",
  "join redesign players=4": "182751a7bd09bbd67beee246c1cb46d53352e2d53a1b49150c660b844b0a2517",
  "rules redesign players=4": "66d34ae61a6125d5a174bc70c0544033aa50b92d8df328860bb8289b851afe20",
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
