import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { briefing, joinBriefing, usesCompactAgentText, type BriefingContext } from "../../src/mcp/briefing.js";
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
// Repinned for the no-bot-moves rule: the rules texts' "Active (not idle) colony seat: house bot off; none: on." reads
// "No house bot plans any colony, seated or not."; the previous sentence restores the previous pins, and the join
// digests are unchanged.
// Redesign texts repinned for rules 28 (Kain's unit figures, one hatch rate with the starting queen's first hatches, the queen's
// per-tick strike); built from the frozen rules-27 redesign config (test/rules27.ts) every text hashes to its previous pin.
// Redesign texts repinned for flyers in the served rules (the Flyers line, flyers among the set_brood choices, caste flyer in the
// count-mark caste, reply and PATROL sentences); with those sentences removed every text hashes to its previous pin.
// Redesign texts repinned for two more Flyers sentences (airborne flyers take no part in territory; observe cells mark each
// flyer in sight with its grounded, flying or hovering state); with those two sentences removed every text hashes to its previous pin.
// Rules-text vocabulary repinned: only the documented movement/direct wording substitutions change.
// All join hashes remain unchanged; simulation rules and their version are unchanged.
// Redesign texts repinned for clearer flyer wording (a landed flyer's kill times, ATTACK/DEFEND flyers fighting on the
// ground until the mark moves, hovering harming only airborne enemy flyers, flyers giving sight, flyer in the count-mark
// caste list, the flyer clause in the cell legend); with those changes undone every text hashes to its previous pin,
// including the pre-vocabulary digests below.
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "6ff8e25281f719c0e67db90de49969170bf11d6ac2e0e84115249052bf064254",
  "join house=false undrawn=true nest=true": "2c149d7665a2b414bb3c4a606183e9c84344a618260c5920ffdf990783392d7d",
  "rules house=false undrawn=true": "9f9856b88b3b2ad48af6633deef6658af665b855c53ed568d9bc54a26d3be70f",
  "join house=false undrawn=false nest=false": "f53fd6c88d327fce8e6e73c917eee8e68237e764769b385ea1ef7ab46afc2ca1",
  "join house=false undrawn=false nest=true": "13d2b5b1c6501f0e3ef7957c96290dd910383df3ceab70eb9bafab354aeea1d7",
  "rules house=false undrawn=false": "b23d26f3569627b3d5e2fa5c1ffd2ce4418e1201adbe17f67fc8a8601730192b",
  "join house=true undrawn=true nest=false": "fb011936464e775d004e689d2feb4c4eb0aec8a463f947b821bf5b142ca8cc93",
  "join house=true undrawn=true nest=true": "b57f5cbe860ffc885b7844f85e7bb543329be8db4bff928defe22fd97b1b6c44",
  "rules house=true undrawn=true": "19fd617bb5b5f21abfddf0420da290e531557613afa2019cadf71def299882ef",
  "join house=true undrawn=false nest=false": "ddd682c1a7a7e2b4d3d149ad08e4ccbf1c7de7eb7794d5344416da814bd8bb29",
  "join house=true undrawn=false nest=true": "1b844276c30934deae77d4b81acd5a96675d672081fbbc2aa800ce12dc10e890",
  "rules house=true undrawn=false": "25b9a5d63c4a6a9e17aa3ab25c5816847d67b81b052a6f27d928116ca59ba176",
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
// Repinned for the same no-bot-moves sentence as above; only the redesign rules digests change. A comparison server
// no longer starts on v4 or count-marks, so only redesign is served; the v4 and count-marks texts stay pinned.
// Redesign texts repinned for rules 28 as above; built from the frozen rules-27 redesign config each hashes to its previous pin.
// Redesign texts repinned for flyers as above; the v4 and count-marks digests are unchanged.
// Redesign texts repinned for the two more Flyers sentences as above; the v4 and count-marks digests are unchanged.
// Rules-text vocabulary repinned with the same substitutions; all join hashes remain unchanged.
// Redesign texts repinned for the clearer flyer wording as above; the v4 and count-marks digests are unchanged.
const PREVIEW_RULES = ["v4", "count-marks", "redesign"] as const;
const PREVIEW_AT_5DF81D04: Record<string, string> = {
  "join v4 players=2": "5c5f62959d1ef08efa3ba6e40a31aede6b967a96ed66b893108ec82d2130d14a",
  "rules v4 players=2": "0f98b5355c34b4fe2f6edf6f7f911da8962bc8218158bec87f58bfee08edfd9e",
  "join v4 players=4": "a5b8a4de730c6992b8a27b29f705e6440724292b1cbe22209c7ddcf873029702",
  "rules v4 players=4": "db85e98eba7ed382237549ffea255110bd131e1d7f3ad9403a61dd44b20b7302",
  "join count-marks players=2": "5d47e87bfdbf7a6f53b2c70b07070163ff06c2f3458ce07b87c25637b101bfa4",
  "rules count-marks players=2": "bdd416b4fd809974c6683bdb7bc1e0d1925263290f24f2f60706552e05d96dc3",
  "join count-marks players=4": "6ee40f2fed373eb907d39d6e9e28c12908372e05f586092d9fa331a82bca7aa1",
  "rules count-marks players=4": "eaef2a1c4d940f836457df1ed980132d04106d781be1fa0000ed8a4bd90e456f",
  "join redesign players=2": "1d0db00854fdec53ddc5478a4371a2086e6761a76d86d0cc9048392972c0b4a4",
  "rules redesign players=2": "a17db69ed5db7ca32be499ab520151c1f9752b88fb5e821b73eeb35ccd2b1b41",
  "join redesign players=4": "26aae39f57f7ef834c522f30c4ce64ef4afeb87fccbacca165e25745327635d7",
  "rules redesign players=4": "b61d1821fd216bab1e9f756411353bc43fe1126bdfd8191422202ecec03c43d8",
};

// Frozen pre-vocabulary-change digests, from main 6920c5473b0d19b027dc29b6dd90e0014daa3380.
// Reverse only the listed substitutions, require the original digest, then apply
// them forward and require exact output equality. This pins the entire old output,
// not merely the changed phrases, without requiring Git history at test time.
const BEFORE_VOCABULARY_RULES: Record<string, string> = {
  "rules house=false undrawn=true": "0afccad110bfc55d3562d9149b34b89e2eaf98d630edbc95ce2f02c8e4ef94f6",
  "rules house=false undrawn=false": "698be837d0f910b8642703f4088bd9dbcb745dcfa230333aa10db0cf4061aefc",
  "rules house=true undrawn=true": "a0b770eb5a227a5f6322e3b4e902462efc2ef9c1bf65fd896e4cf62a36fd15a4",
  "rules house=true undrawn=false": "cb3fcbb18ee28e21ef7198bfd2fef361bf6458fa05bd1d2fa75dac2d315215c0",
  "rules v4 players=2": "d74106ae57974263cf40fff2fd2e99c52c1c1e7a8d61be0c074032dc0bc14eae",
  "rules v4 players=4": "d57a9e79c59accfa216e17c90e02272ac024a32ffb1d7a02a43d93091364648e",
  "rules count-marks players=2": "74e50fc4f49e3bd3f30fec1484e01e319270592227a5301feb366a38df8166ee",
  "rules count-marks players=4": "d493637afc5ca34792863292f9575984a4995eb660e2e4e005f5d830b940e16c",
  "rules redesign players=2": "c212f5b1b8960134c0b96b3b2f33a7a869ecbaf7b4a4052e406b099cf26a0613",
  "rules redesign players=4": "defd02642007caa58719ebc011fd0f2756718d4e6832c036c1e34766cb921843"
};
const VOCABULARY_SUBSTITUTIONS: readonly (readonly [string, string])[] = [
  [
    "Count marks do not steer your squad.",
    "Count marks do not direct your squad."
  ],
  [
    "steering+push",
    "movement+push"
  ],
  [
    "each ant steers itself",
    "each ant moves independently"
  ],
  [
    "order steers your squad",
    "order directs your squad"
  ],
  [
    "order to steer your squad",
    "order to direct your squad"
  ],
  [
    "strongest colony steering mark",
    "strongest colony movement mark"
  ],
  [
    "strongest steering mark",
    "strongest movement mark"
  ],
  [
    "First steering word",
    "First movement word"
  ],
  [
    "first steering word",
    "first movement word"
  ],
  [
    "Word marks never steer free ants",
    "Word marks never direct free ants"
  ],
  [
    "Ordinary word marks do not steer free ants",
    "Ordinary word marks do not direct free ants"
  ]
];
function verifyVocabularyOnly(key: string, current: string, compact: boolean): void {
  const fieldBefore = compact
    ? "The steering field counts squad ants following word marks, not count-mark ants."
    : "The steering field counts squad ants following word marks, not ants answering a count mark.";
  const substitutions = [...VOCABULARY_SUBSTITUTIONS, [fieldBefore, "In each myMarks entry, the only field whose name starts with s counts squad ants following word marks; claimed counts ants answering a count mark."] as const];
  const original = substitutions.reduce((text, [before, after]) => text.replaceAll(after, before), current);
  expect(BEFORE_VOCABULARY_RULES[key], key).toBeDefined();
  expect(sha(original), `pre-change output: ${key}`).toBe(BEFORE_VOCABULARY_RULES[key]);
  const transformed = substitutions.reduce((text, [before, after]) => text.replaceAll(before, after), original);
  expect(transformed, `substitutions alone: ${key}`).toBe(current);
}

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

  it("reproduces every hosted rules checksum using only the vocabulary substitutions", () => {
    for (const [key, value] of Object.entries(hostedTexts())) {
      if (key.startsWith("rules ")) verifyVocabularyOnly(key, value, usesCompactAgentText(UNDRAWN));
    }
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
      const names = mode === null ? { colonyNames: drawColonyNames("pin-lobby") } : {};
      expect(joined.data.briefing).toBe(joinBriefing(config, h.game.mcpConfig, false, { house: false, undrawn: false, ...names }));
      if (mode !== null) expect(joined.data.briefing).toBe(joinBriefing(config, h.game.mcpConfig, false, { house: false, undrawn: false }));
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

  it("reproduces every preview rules checksum using only the vocabulary substitutions", () => {
    for (const rules of PREVIEW_RULES) for (const players of [2, 4] as const) {
      const mcp = { ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players };
      const config = createMatch(COMPARISON_SEED, { ...newMatchConfig(rulesConfig(rules)), players }).config;
      verifyVocabularyOnly(`rules ${rules} players=${players}`, briefing(config, mcp), usesCompactAgentText(config));
    }
  });

  for (const rules of ["redesign"] as const) for (const players of [2, 4] as const) {
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
