import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { briefing, joinBriefing, usesCompactAgentText, type BriefingContext } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { COMPARISON_SEED, comparisonOptions, startServer, type GameServer } from "../../src/server.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { drawColonyNames } from "../../src/sim/colonyNames.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { connect, tempDir, waitFor, type Agent } from "../server/helpers.js";
import { startHarness } from "./harness.js";

// The old hosted pins include the public queue instructions. Reverse only the Free-for-all copy
// on those surfaces; house and non-compact briefings must still match their pins byte for byte.
function historicalDigest(text: string): string {
  if (text.includes("Handle owner=username owner")) {
    const addition = 'Free-for-all: join_queue {key,mode:"quadrants"} waits for four different owners (four colonies, one seat each); separate Free-for-all rating when enabled. ';
    expect(text).toContain(addition + "Handle owner=username owner");
    expect(text).toContain("Two-colony natural results: Glicko");
    text = text.replace(addition, "").replace("Two-colony natural results: Glicko", "Natural results: Glicko");
  }
  return createHash("sha256").update(text).digest("hex");
}

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
// Redesign texts repinned for clearer flyer wording (a landed flyer's kill times, ATTACK/DEFEND flyers fighting on the
// ground until the mark moves, hovering flyers dealing no damage but to airborne enemy flyers, flyers giving sight, flyer
// in the count-mark caste list, the flyer clause in the cell legend), here and in the queen-first and pre-vocabulary
// tables below; with those changes undone every text hashes to its previous pin.
// Rules-text vocabulary repinned: only the documented movement/direct wording substitutions change.
// All join hashes remain unchanged; simulation rules and their version are unchanged.
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "0850c2b096ccd5e901596edb2e84330fcb0e03fb9fff8e392bf71df1cc19b880",
  "join house=false undrawn=true nest=true": "3077c95dae20a705885ce8e8dcda7f52824d4bdf5b16f4b584a225ea0e31e4c6",
  "rules house=false undrawn=true": "169466273543b7cef0313560c6e44996a03f5183f36368afcd337854054619b8",
  "join house=false undrawn=false nest=false": "b81daadd84ab3c0394e3cc6b4bb2e93a89b3750133e3cbea286502961b6497bf",
  "join house=false undrawn=false nest=true": "4b79a185db4c6a2eec1d170bb078c1fdce2e54007df521997e3aa5b78b351dbd",
  "rules house=false undrawn=false": "d9ac277fc942b7b05517b560cd5b32330be1636e2b8bcb91468a523151e30058",
  "join house=true undrawn=true nest=false": "46668b9fcca435da87e422eebd882aede9bc49896d656f54c40765284babc863",
  "join house=true undrawn=true nest=true": "3e0716abf4fff3d77602ca2550b13105bb3cd540c7bf3298d30797a2a5b75cdc",
  "rules house=true undrawn=true": "a7deed356fc8d4d6be1972e03d557e9a2a3432227370163179e5d83eec864096",
  "join house=true undrawn=false nest=false": "9c849809a618aceaf3c35797777883c3668894f5b0652775d8adcf36563fdf22",
  "join house=true undrawn=false nest=true": "cae3c74f398e1a055cd6f4f90c59ed4306665207907bcbb806bad26deafc7ee7",
  "rules house=true undrawn=false": "d0e358f7c7b02a8796b8f8f22886e1fabedfe6d5037cddc1bf5c58cf2ebecd3b",
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
// Redesign texts repinned for the clearer flyer wording as above; the v4 and count-marks digests are unchanged.
// Rules-text vocabulary repinned with the same substitutions; all join hashes remain unchanged.
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
  "join redesign players=2": "0442a91b53fd58ba6b33e01b038e5c6e4d4bd111e14d2eea926b3f29f8ca4ada",
  "rules redesign players=2": "0fa5421e242354ec4c93ab8f590ecb948e17aea54b3660cf47904949a556bf44",
  "join redesign players=4": "46990542f4600211b058735f18b1ac0b8ad582734e902969082fefc8083f063e",
  "rules redesign players=4": "9e868f662ec04f8f92dadd1f6646e5c4b43bab561b26ee94111fef5beb9cdb08",
};

// Pins before the vocabulary change, with queen-first scoring. Reverse vocabulary only
// to verify these unchanged pins; the separate scoring reversal pins the other parent.
const HOSTED_QUEEN_FIRST: Record<string, string> = {
  "join house=false undrawn=true nest=false": "45eee5de834c437348ed48f08fb200bb1b6f5466d7089b79a6e88bcf0e974a0b",
  "join house=false undrawn=true nest=true": "edd9879841187c2350ee58deea1042bbea4cbce3580c330d20cb9cf91f2d231d",
  "rules house=false undrawn=true": "d85128a7d7928f8bebc7a5efcd494265caec44d12e7cfaef02a865956e159c4d",
  "join house=false undrawn=false nest=false": "60f9133fdf73e8c325e34771befb4832a90c8c6613c671f31d06b238389db799",
  "join house=false undrawn=false nest=true": "133aad74c197b112f6723291a4849a81b2d946042a47a86d10ad2ed40c073dd5",
  "rules house=false undrawn=false": "5bcedc0a84527192f87c1fb0d9e7ba51dc2049d4f5eaa8552219a1d38fc3349d",
  "join house=true undrawn=true nest=false": "60e4b1c1399c44b01f629b5c902ade83b77477286d633e64092846cfc903f2df",
  "join house=true undrawn=true nest=true": "94e24f77356863e0f4b294e2b31bf97222e979615688f59fdbee9a53ca5286fd",
  "rules house=true undrawn=true": "56a3a67a143c3f0fcbfdc6c183bba377ddd0047449363007d02ace86953fe5a3",
  "join house=true undrawn=false nest=false": "b3262adad9021efc1acef39c4b5b325fa8185f9601fbcbf421db19162ab32621",
  "join house=true undrawn=false nest=true": "fa65a791ee1ea9860a0eb7c12c37137d3121e2d951cb1cc75cdbc63b6d1802d4",
  "rules house=true undrawn=false": "dadad6e8175f1991c38e764f9962efe8277a49396d651d3cf713d30f9972320f"
};
const PREVIEW_QUEEN_FIRST: Record<string, string> = {
  "join v4 players=2": "5d0cab3eadc950631fb1633a4561bde966f7a2ce01bb157db13e404c7b869218",
  "rules v4 players=2": "f7ac59a2b57cf4f5ef5d5a70ce1dc17a1045e51530db25618a7dd9d0e2fa9e90",
  "join v4 players=4": "622e624f5355f8f0784511da622646ade58bb8d687a4ccf7613555d1f23b7fde",
  "rules v4 players=4": "d7bb7b66632bca5cb413a2ea8782e628b202b783f4eab4804da0ec8ef4ab93bf",
  "join count-marks players=2": "533b360643ba5ae31000beb12664abb8164b80d120ab54f13e8f4e66e965bebe",
  "rules count-marks players=2": "b656448095b7a62d4372aa0a14210b1ca29e13b917cbb42c82e2d9b82186f60f",
  "join count-marks players=4": "59650a0fe6e64698bdf3c55c765c11e9f0e735bbda1c8c8cbbeca725123676d1",
  "rules count-marks players=4": "0c61979d8141318cff72c701e752ee3026cd6f2e52d06cceddf7e2d30d8cac32",
  "join redesign players=2": "0e4ba51f2e128a6f153e718766e562696215847e0a90207b5524dcc18ce50c38",
  "rules redesign players=2": "5f42ec45e9b6cf4adb13477a16f0b45a9267706408875e1c37f7dd71f2291ba1",
  "join redesign players=4": "8a68801ad13c8591bbbb40c5a1d53a7491f27e531fc7bac1ad20f5f5f1c1d7c6",
  "rules redesign players=4": "4c844cde8d75511fc6cce406fad2ac73599a3c3db77d2a851d304224d5bb99f2"
};

// Undo only the explicitly asserted scoring text, proving every other byte stays pinned.
function previousScoring(text: string, config: SimConfig): string {
  const credit = ` Queen kills: the colony whose hit takes a queen to zero HP gets one; ${config.queenHp === undefined ? "uncredited overruns and elimination removals" : "elimination removals"} count for no one.`;
  expect(text.split(credit)).toHaveLength(2);
  if (text.includes("queen kills>")) {
    expect(text).toContain("queen kills>kills>territory>ants alive>food delivered>draw.");
    return text.replace(credit, "").replace("queen kills>kills>", "kills>");
  }
  expect(text).toContain("queen kills, kills, territory, ants alive, food delivered, draw.");
  return text.replace(credit, "").replace("queen kills, kills, territory, ants alive, food delivered, draw.", "kills, territory, ants alive, delivered food, else draw.");
}

// Frozen pre-vocabulary-change digests, from main 6920c5473b0d19b027dc29b6dd90e0014daa3380.
// Reverse only the listed substitutions, require the original digest, then apply
// them forward and require exact output equality. This pins the entire old output,
// not merely the changed phrases, without requiring Git history at test time.
const BEFORE_VOCABULARY_RULES: Record<string, string> = {
  "rules house=false undrawn=true": "9f1b20d9073897bfb222239371f16995f52d5e33e96afd6557273feaeda1a81e",
  "rules house=false undrawn=false": "3daba12399e1c845b8a8bb8d859b5a2ff42a362dcb40e1494924972ca93fea1d",
  "rules house=true undrawn=true": "186d81d83a00261925d777cef08ce2ba07a142aeaf90a8b87f04105fe5e6d7c7",
  "rules house=true undrawn=false": "fdcfcfd45ac7e5e91898ba6c7c763738b7acba8336379b79fca3a86e8a9dc2df",
  "rules v4 players=2": "d74106ae57974263cf40fff2fd2e99c52c1c1e7a8d61be0c074032dc0bc14eae",
  "rules v4 players=4": "d57a9e79c59accfa216e17c90e02272ac024a32ffb1d7a02a43d93091364648e",
  "rules count-marks players=2": "74e50fc4f49e3bd3f30fec1484e01e319270592227a5301feb366a38df8166ee",
  "rules count-marks players=4": "d493637afc5ca34792863292f9575984a4995eb660e2e4e005f5d830b940e16c",
  "rules redesign players=2": "ec980c98d35dae1f898dfebb0642c58173ef447ade49bb376e94a2d91370d687",
  "rules redesign players=4": "c55d691400a2479e40acceadcfaed9f3729f805c77a3877fd172117733ba62fe"
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
function beforeVocabulary(current: string, compact: boolean): string {
  const fieldBefore = compact
    ? "The steering field counts squad ants following word marks, not count-mark ants."
    : "The steering field counts squad ants following word marks, not ants answering a count mark.";
  const substitutions = [...VOCABULARY_SUBSTITUTIONS, [fieldBefore, "In each myMarks entry, the only field whose name starts with s counts squad ants following word marks; claimed counts ants answering a count mark."] as const];
  const original = substitutions.reduce((text, [before, after]) => text.replaceAll(after, before), current);
  const transformed = substitutions.reduce((text, [before, after]) => text.replaceAll(before, after), original);
  expect(transformed, "vocabulary substitutions alone").toBe(current);
  return original;
}
function verifyVocabularyOnly(key: string, current: string, compact: boolean): void {
  expect(BEFORE_VOCABULARY_RULES[key], key).toBeDefined();
  expect(historicalDigest(beforeVocabulary(current, compact)), `pre-change output: ${key}`).toBe(BEFORE_VOCABULARY_RULES[key]);
}

// Keep the historical pins byte-for-byte. In live redesign rules only the renewal clause changed.
function beforeRenewal(text: string): string {
  const renewal = "one command restarts the 180 s lifetime";
  expect(text.split(renewal)).toHaveLength(2);
  return text.replace(renewal, "the mark keeps its original 180 s lifetime");
}

function historicalRules(config: SimConfig): SimConfig {
  return { ...config, queenKillsFirst: undefined, ...(config.countMarks && { countMarks: { ...config.countMarks, renewOnRelay: undefined } }) };
}

const UNDRAWN = newMatchConfig(rulesConfig("redesign"));
const DRAWN = createMatch(6006, UNDRAWN).config;

function hostedTexts(extra: Partial<BriefingContext> = {}, historical = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const house of [false, true]) for (const undrawn of [true, false]) {
    const current = undrawn ? UNDRAWN : DRAWN;
    const config = historical ? historicalRules(current) : current;
    const context = { house, undrawn, ...extra };
    for (const nest of [false, true]) out[`join house=${house} undrawn=${undrawn} nest=${nest}`] = joinBriefing(config, DEFAULT_MCP_CONFIG, nest, context);
    out[`rules house=${house} undrawn=${undrawn}`] = briefing(config, DEFAULT_MCP_CONFIG, context);
  }
  return out;
}

const ACCOUNT_TOOLS = ["list_lobbies", "create_lobby", "join_lobby", "start_lobby", "read_lobby", "locate_match", "join_queue", "queue_status", "leave_queue", "rating", "leaderboard", "create_handle", "rotate_key"];

describe("hosted briefing stays byte-identical to main 5df81d04", () => {
  it("every hosted join briefing and rules text matches its 5df81d04 digest", () => {
    const digests = Object.fromEntries(Object.entries(hostedTexts({}, true)).map(([name, text]) => [name, historicalDigest(text)]));
    expect(digests).toEqual(HOSTED_AT_5DF81D04);
    const current = Object.fromEntries(Object.entries(hostedTexts()).map(([name, text]) => [name, name.startsWith("rules ") ? beforeRenewal(text) : text]));
    expect(Object.fromEntries(Object.entries(current).map(([name, text]) => [name, historicalDigest(beforeVocabulary(text, usesCompactAgentText(UNDRAWN)))]))).toEqual(HOSTED_QUEEN_FIRST);
    for (const [name, text] of Object.entries(current)) {
      expect(previousScoring(text, UNDRAWN), name).toBe(hostedTexts({}, true)[name]);
    }
  });

  it("reproduces every hosted rules checksum using only the vocabulary substitutions", () => {
    for (const [key, value] of Object.entries(hostedTexts({}, true))) {
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
      const config = historicalRules({ ...newMatchConfig(rulesConfig(rules)), players });
      digests[`join ${rules} players=${players}`] = historicalDigest(joinBriefing(config, mcp, false, { house: false, undrawn: true }));
      digests[`rules ${rules} players=${players}`] = historicalDigest(briefing(createMatch(COMPARISON_SEED, config).config, mcp));
    }
    expect(digests).toEqual(PREVIEW_AT_5DF81D04);
    const current: Record<string, string> = {};
    for (const rules of PREVIEW_RULES) for (const players of [2, 4] as const) {
      const mcp = { ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players };
      const config = { ...newMatchConfig(rulesConfig(rules)), players };
      const rulesText = briefing(createMatch(COMPARISON_SEED, config).config, mcp);
      const texts = {
        join: joinBriefing(config, mcp, false, { house: false, undrawn: true }),
        rules: rules === "redesign" ? beforeRenewal(rulesText) : rulesText,
      };
      for (const [kind, text] of Object.entries(texts)) {
        const key = `${kind} ${rules} players=${players}`;
        current[key] = historicalDigest(beforeVocabulary(text, usesCompactAgentText(config)));
        expect(historicalDigest(previousScoring(text, config)), key).toBe(PREVIEW_AT_5DF81D04[key]);
      }
    }
    expect(current).toEqual(PREVIEW_QUEEN_FIRST);
  });

  it("reproduces every preview rules checksum using only the vocabulary substitutions", () => {
    for (const rules of PREVIEW_RULES) for (const players of [2, 4] as const) {
      const mcp = { ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players };
      const config = createMatch(COMPARISON_SEED, { ...newMatchConfig(rulesConfig(rules)), players }).config;
      verifyVocabularyOnly(`rules ${rules} players=${players}`, briefing(historicalRules(config), mcp), usesCompactAgentText(config));
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
        expect(historicalDigest(joined.data.briefing as string)).toBe(PREVIEW_QUEEN_FIRST[`join ${rules} players=${players}`]);
        const full = await agents[index]!.call("rules", {});
        expect(full.isError, full.text).toBe(false);
        const rulesText = full.data.rules as string;
        expect(rulesText).not.toMatch(/steer/i);
        expect(rulesText).toContain("queen kills");
        expect(historicalDigest(beforeVocabulary(beforeRenewal(rulesText), usesCompactAgentText(rulesConfig(rules))))).toBe(PREVIEW_QUEEN_FIRST[`rules ${rules} players=${players}`]);
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
