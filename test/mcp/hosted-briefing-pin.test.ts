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
const HOSTED_AT_5DF81D04: Record<string, string> = {
  "join house=false undrawn=true nest=false": "9f82b0787446dd2dcb6d0a5287389c91436b326026d542662aeaa57b11ed0b23",
  "join house=false undrawn=true nest=true": "1d171ca6af4bf448a723ff746a13f177f7564b1ba47ad46ad309b95e92208e78",
  "rules house=false undrawn=true": "e97dd228b2bf80799a6c21e2dd9043d531ebb514248520eadaf53bca1acf0a90",
  "join house=false undrawn=false nest=false": "da9f206723a7a93d93a9c13ad078ae6b48f1fdd19069978114adf8813cc4e6d7",
  "join house=false undrawn=false nest=true": "63e582a095a06c3feb075d80dc2d0ca87883fb4af879c39aed4897f4b3155f37",
  "rules house=false undrawn=false": "39929998b3bb4473e60e51cdb0c885aec85ac813f4942008d6264cd95e0477a5",
  "join house=true undrawn=true nest=false": "7858aac5b8c97dff39385ddecda29bf8b20d1543b517322230fec44e8bd213ab",
  "join house=true undrawn=true nest=true": "eaa963c92bff17943e2e7301c6b84757acef2cc421580cb320097d155982d0cc",
  "rules house=true undrawn=true": "bceba8c615ab9696ec4b351bb529acf5580bf1c0d42d9d099537c82d05475bb2",
  "join house=true undrawn=false nest=false": "60575dff108c249386cb2be56d2034571c4ffb38809a4010c58d06c657552542",
  "join house=true undrawn=false nest=true": "9534c6f963914bfe470106a439e3861345a0512b302dbaea73e5087507f6a0b3",
  "rules house=true undrawn=false": "ab1c80b6cdeb85297ef96c46f5e53d4a86153c03a676bb1b13d849d5005ed6cf",
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
  "join redesign players=2": "0e465c7e5738c8b5177ca6edcdb85e4c9293ae47bc159981989830a2b0afcd92",
  "rules redesign players=2": "a24ab53434de626a544bb0b95c52b24d91701daed07831494eea4b1a6b90f0c5",
  "join redesign players=4": "97daeddc6b7934c99d72d1fb359cdf28f800b9acb1fa4fa548eb676df70a268c",
  "rules redesign players=4": "2031b16282f7ac7640c5dde86ed8c963434ca174eb981bd5e84ed05bb4f48ef5",
};

// Pins before the vocabulary change, with queen-first scoring. Reverse vocabulary only
// to verify these unchanged pins; the separate scoring reversal pins the other parent.
const HOSTED_QUEEN_FIRST: Record<string, string> = {
  "join house=false undrawn=true nest=false": "93a42cd317eb53912235c5644252cdfc7c518759022742a7422b07a4796a67f0",
  "join house=false undrawn=true nest=true": "532544fde5003092548c71600e5def02fb5a86d1a7fb704b9b9fd9500fe78d08",
  "rules house=false undrawn=true": "ccda2a9d62fae25fd523756dbf778fd7fcac1644638cdd97bfc86df88aeba846",
  "join house=false undrawn=false nest=false": "c84f5ba632410aad504801ed9376a52efde2454dcff6abe8a7186818e5f029a9",
  "join house=false undrawn=false nest=true": "11948a4503d7ca7f29a896e88ec667f8c80d7ac69e2cb7175af349c7124509d1",
  "rules house=false undrawn=false": "16a3cba9b9624db1243428fe4ff6b4e10b7320622986a83430e07e120bc9a530",
  "join house=true undrawn=true nest=false": "8dd27013832ffa4894bbaa9901a5243c3d60c1bae08992cc1224ca2af5d933e1",
  "join house=true undrawn=true nest=true": "8b563141778d572bd8ff9b0e24f423c25685c6824fef1b27119d7dd84f9c17a0",
  "rules house=true undrawn=true": "f80f50bd126ecc1319767899cfe931093f558da40106cbddc40650487d48484d",
  "join house=true undrawn=false nest=false": "32f33cbac08a8b1b5be0dc6a4e6bfe85c3f1c02757531d12fe3b73c4e5baac2a",
  "join house=true undrawn=false nest=true": "81089c597077fd2020e55cc71223fd1f76f6b75bc3546c18aa7ee9b04fb7330e",
  "rules house=true undrawn=false": "b0d3c36a99cb91d16aaf6edba8fd7b127273bdb443110faa38dec4d0dc13b8a3"
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
  "join redesign players=2": "6086e46e98758365296c4bfa6ce0b96be95ba5b3271edb3e5117defc7e2c8ffb",
  "rules redesign players=2": "1d84cc03948ef16eb57a5d41894a0e31702022cb8de9816d44af2cf8ea0e207b",
  "join redesign players=4": "eb8188e888305a4bb8ff680a54f3e1a8fec29eff9297eb6bf471511a253b250b",
  "rules redesign players=4": "890938d04d2112269466b06680f964d7013fd7ce3a1261d416292cc103045fed"
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
  "rules house=false undrawn=true": "dcf8a46e0a26be11089bc983cfa30c2534426d6654735c7005a5c8b7015c162f",
  "rules house=false undrawn=false": "977953274b1810d923c481f706ff828f2f81f81733ee9cb27257543f39d8e9a7",
  "rules house=true undrawn=true": "8106221918efbb08d33977ff88fef9e83f3cb66fc1da1f99c50dec96c506ac33",
  "rules house=true undrawn=false": "975fff8c35db1fc55888638568bce529e7ae9e6afcdb11586e842d7e41ba497a",
  "rules v4 players=2": "d74106ae57974263cf40fff2fd2e99c52c1c1e7a8d61be0c074032dc0bc14eae",
  "rules v4 players=4": "d57a9e79c59accfa216e17c90e02272ac024a32ffb1d7a02a43d93091364648e",
  "rules count-marks players=2": "74e50fc4f49e3bd3f30fec1484e01e319270592227a5301feb366a38df8166ee",
  "rules count-marks players=4": "d493637afc5ca34792863292f9575984a4995eb660e2e4e005f5d830b940e16c",
  "rules redesign players=2": "f0ff759c90ef098cfd3d9e40d906b04c1261e20944b673de47d3be81e9b62072",
  "rules redesign players=4": "0875127d8852028970f3541c014ed6da4ab13ed024abce7554a3c92a293a5f1e"
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
  expect(sha(beforeVocabulary(current, compact)), `pre-change output: ${key}`).toBe(BEFORE_VOCABULARY_RULES[key]);
}

const UNDRAWN = newMatchConfig(rulesConfig("redesign"));
const DRAWN = createMatch(6006, UNDRAWN).config;

function hostedTexts(extra: Partial<BriefingContext> = {}, historical = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const house of [false, true]) for (const undrawn of [true, false]) {
    const current = undrawn ? UNDRAWN : DRAWN;
    const config = historical ? { ...current, queenKillsFirst: undefined } : current;
    const context = { house, undrawn, ...extra };
    for (const nest of [false, true]) out[`join house=${house} undrawn=${undrawn} nest=${nest}`] = joinBriefing(config, DEFAULT_MCP_CONFIG, nest, context);
    out[`rules house=${house} undrawn=${undrawn}`] = briefing(config, DEFAULT_MCP_CONFIG, context);
  }
  return out;
}

const ACCOUNT_TOOLS = ["list_lobbies", "create_lobby", "join_lobby", "start_lobby", "read_lobby", "locate_match", "join_queue", "queue_status", "leave_queue", "rating", "leaderboard", "create_handle", "rotate_key"];

describe("hosted briefing stays byte-identical to main 5df81d04", () => {
  it("every hosted join briefing and rules text matches its 5df81d04 digest", () => {
    const digests = Object.fromEntries(Object.entries(hostedTexts({}, true)).map(([name, text]) => [name, sha(text)]));
    expect(digests).toEqual(HOSTED_AT_5DF81D04);
    const current = hostedTexts();
    expect(Object.fromEntries(Object.entries(current).map(([name, text]) => [name, sha(beforeVocabulary(text, usesCompactAgentText(UNDRAWN)))]))).toEqual(HOSTED_QUEEN_FIRST);
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
      const config = { ...newMatchConfig(rulesConfig(rules)), players, queenKillsFirst: undefined };
      digests[`join ${rules} players=${players}`] = sha(joinBriefing(config, mcp, false, { house: false, undrawn: true }));
      digests[`rules ${rules} players=${players}`] = sha(briefing(createMatch(COMPARISON_SEED, config).config, mcp));
    }
    expect(digests).toEqual(PREVIEW_AT_5DF81D04);
    const current: Record<string, string> = {};
    for (const rules of PREVIEW_RULES) for (const players of [2, 4] as const) {
      const mcp = { ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players };
      const config = { ...newMatchConfig(rulesConfig(rules)), players };
      const texts = {
        join: joinBriefing(config, mcp, false, { house: false, undrawn: true }),
        rules: briefing(createMatch(COMPARISON_SEED, config).config, mcp),
      };
      for (const [kind, text] of Object.entries(texts)) {
        const key = `${kind} ${rules} players=${players}`;
        current[key] = sha(beforeVocabulary(text, usesCompactAgentText(config)));
        expect(sha(previousScoring(text, config)), key).toBe(PREVIEW_AT_5DF81D04[key]);
      }
    }
    expect(current).toEqual(PREVIEW_QUEEN_FIRST);
  });

  it("reproduces every preview rules checksum using only the vocabulary substitutions", () => {
    for (const rules of PREVIEW_RULES) for (const players of [2, 4] as const) {
      const mcp = { ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players };
      const config = createMatch(COMPARISON_SEED, { ...newMatchConfig(rulesConfig(rules)), players }).config;
      verifyVocabularyOnly(`rules ${rules} players=${players}`, briefing({ ...config, queenKillsFirst: undefined }, mcp), usesCompactAgentText(config));
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
        expect(sha(joined.data.briefing as string)).toBe(PREVIEW_QUEEN_FIRST[`join ${rules} players=${players}`]);
        const full = await agents[index]!.call("rules", {});
        expect(full.isError, full.text).toBe(false);
        const rulesText = full.data.rules as string;
        expect(rulesText).not.toMatch(/steer/i);
        expect(rulesText).toContain("queen kills");
        expect(sha(beforeVocabulary(rulesText, usesCompactAgentText(rulesConfig(rules))))).toBe(PREVIEW_QUEEN_FIRST[`rules ${rules} players=${players}`]);
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
