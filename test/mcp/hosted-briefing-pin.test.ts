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
// Repinned for the lobby guidance's wait-stream pointer ("Or wait on the waitUrl your join returns (SSE; see join_queue).")
// and its dropped duplicate opening ("No join at the entry point: lobbies/ranked queue -> located slot only."); only the
// house=false texts carry that guidance, and the house=true digests are unchanged.
// Repinned for that pointer reading "Or wait for done on your waitUrl (SSE; see join_queue)."; the previous pointer
// restores the previous pins, so nothing else changed.
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "13e5ff0ab2ae3ed00b5164b3db12d82690740bd49bb225581452111ccd88ecf5",
  "join house=false undrawn=true nest=true": "8df8d22fcdbcc28ba5fa600eb2605c9ef88b2b7787c11edf2dce23ffdccec3fa",
  "rules house=false undrawn=true": "7e02f2d7583159afe62431066a52d60299ee25d0002fedf3099ca669de653ffe",
  "join house=false undrawn=false nest=false": "9ec7ce6c9a6465bd831f653af4527435dacf8f24a0f9e1c8cc0d9ef594bc3a5e",
  "join house=false undrawn=false nest=true": "a35622cd44e28ada663e17442b7410331e68148d476fc7c009ff1a3197c4df62",
  "rules house=false undrawn=false": "e1253c5e0a14d8f068982e1893f96a19bcdd8d81add1865dad2b3290e6b4540d",
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
// Repinned for the same lobby-guidance wait-stream change as above; the v4 digests are unchanged.
// Repinned again for the same "wait for done" pointer as above; the v4 digests are unchanged.
const PREVIEW_RULES = ["v4", "count-marks", "redesign"] as const;
const PREVIEW_AT_5DF81D04: Record<string, string> = {
  "join v4 players=2": "5c5f62959d1ef08efa3ba6e40a31aede6b967a96ed66b893108ec82d2130d14a",
  "rules v4 players=2": "d74106ae57974263cf40fff2fd2e99c52c1c1e7a8d61be0c074032dc0bc14eae",
  "join v4 players=4": "a5b8a4de730c6992b8a27b29f705e6440724292b1cbe22209c7ddcf873029702",
  "rules v4 players=4": "d57a9e79c59accfa216e17c90e02272ac024a32ffb1d7a02a43d93091364648e",
  "join count-marks players=2": "b4cef4830385d3523e72de44dcd2c850c9f6da920bfa08d2c4ef819c4e50d6d3",
  "rules count-marks players=2": "be677e154f5f6f468fc04761a0ccb89d53040a8c85280c572eaceef37f475189",
  "join count-marks players=4": "d1fe7c223ea9b3ce946c39f78dc357f0273c7aca9145f969fa90b56c1148352c",
  "rules count-marks players=4": "98d6f769e350395e1e80be619dded2aa89920f88777b52395fcdcbbc494e9812",
  "join redesign players=2": "43ea07df1a7978fc290d1fc5d6d0d01049120c018f3a3cb8c9d295844be6be7c",
  "rules redesign players=2": "ff34745bec782fd24e418f1b8166a880eca8f092b00bf29bdeea3e75fd3cd079",
  "join redesign players=4": "678ba36ef4416545e4004005314c672e87f84a91f2abf3a854e9b011bbed4c06",
  "rules redesign players=4": "27d90b531d558c430f5b30f836bcbe735152b24c7c2868ccfc93af827ea8125b",
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
