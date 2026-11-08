import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { briefing, FOOD_RADIX_TEXT, joinBriefing, colonyVisibilityText } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG, sessionExpiryText } from "../../src/mcp/config.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const config = { ...playable(rulesConfig("redesign")), commandFloorTicks: 1, antSpeedTilesPerSecond: 0 };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("MCP text agrees with its replies", () => {
  it.each([false, true])("describes the actual queued/running join shape (running: %s)", async start => {
    h = await startHarness({ start, simConfig: config });
    const agent = await h.connect();
    const join = (await agent.client.listTools()).tools.find(tool => tool.name === "join")!;
    expect(join.description).toContain("Queued join returns agentId, reconnectToken, colony, briefing, matchStarts and message; no squad exists yet");
    expect(join.description).toContain("Running-match join returns agentId, reconnectToken, colony, squad, briefing and view");
    expect(join.description).toContain("Once the match starts, observe shows your squad");
    const joined = await agent.call("join", { colony: COLONY_NAMES[1] });
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.data.colony).toBe(COLONY_NAMES[1]);
    expect(joined.data).toHaveProperty("agentId");
    expect(joined.data).toHaveProperty("reconnectToken");
    expect(joined.data.briefing).toContain(`MCP session closes after ${DEFAULT_MCP_CONFIG.sessionIdleMs / 60_000} minutes without requests; rejoin as described below.`);
    if (start) {
      expect(joined.data.squad).toEqual(joined.data.view.squad);
      expect(joined.data).not.toHaveProperty("matchStarts");
    } else {
      expect(Object.keys(joined.data).sort()).toEqual(["agentId", "briefing", "colony", "matchStarts", "message", "reconnectToken"]);
      expect(joined.data.message).toContain(sessionExpiryText(DEFAULT_MCP_CONFIG));
      const back = await (await h.connect()).call("join", { reconnectToken: joined.data.reconnectToken });
      expect(back.data.colony).toBe(joined.data.colony);
      h.game.startMatch(1);
      const observed = await agent.call("observe");
      expect(observed.data.view.colonyName).toBe(joined.data.colony);
      expect(observed.data.view.squad.length).toBeGreaterThan(0);
    }
  });

  it.each([false, true])("expires after five request-free minutes and recovers the same seat (running: %s)", async start => {
    h = await startHarness({ start, simConfig: config });
    const agent = await h.connect();
    const joined = await agent.call("join");
    const sessionId = agent.transport.sessionId!;
    expect(DEFAULT_MCP_CONFIG.sessionIdleMs).toBe(300_000);
    h.clock.now = 300_000;
    await h.handler.sweep();
    expect(h.handler.hasSession(sessionId)).toBe(true);
    h.clock.now += 1;
    await h.handler.sweep();
    expect(h.handler.hasSession(sessionId)).toBe(false);
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fetch(h.url, { method,
        headers: { "mcp-session-id": sessionId, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}) });
      expect(response.status).toBe(404);
      const error = await response.json() as { error: { message: string } };
      expect(error.error.message).toBe(`Unknown session. ${sessionExpiryText(DEFAULT_MCP_CONFIG)}`);
      expect(error.error.message).toContain("5 minutes with no requests");
    }
    const restored = await (await h.connect()).call("join", { reconnectToken: joined.data.reconnectToken });
    expect(restored.isError, restored.text).toBe(false);
    expect(restored.data.agentId).toBe(joined.data.agentId);
    expect(restored.data.colony).toBe(joined.data.colony);
  });

  it("uses configured expiry and teaches current living-colony visibility and colony placement", async () => {
    h = await startHarness({ simConfig: { ...config, sightTiles: 4 }, mcpConfig: { ...DEFAULT_MCP_CONFIG, sessionIdleMs: 120_000 } });
    const agent = await h.connect();
    const tools = (await agent.client.listTools()).tools;
    const joined = await agent.call("join");
    const full = (await agent.call("rules")).data.rules as string;
    for (const text of [full, joined.data.briefing]) {
      expect(text).toContain("MCP session closes after 2 minutes without requests; rejoin as described below.");
      expect(text).toContain("any living ant of your colony currently sees (4 tiles around each colony ant)");
      expect(text).toContain("within 4 tiles of any living ant of your colony");
      expect(text).not.toContain("target within colony sight");
      expect(text).not.toContain("only what your own squad sees");
      expect(text).not.toContain("filtered to your seat's sight");
      expect(text).toContain(FOOD_RADIX_TEXT);
      expect(text).toContain("status: [idleSecondsLeft:");
    }
    expect(tools.find(tool => tool.name === "observe")!.description).toContain(FOOD_RADIX_TEXT);
    expect(tools.find(tool => tool.name === "observe")!.description).toContain(colonyVisibilityText({ ...config, sightTiles: 4 }));
    expect(tools.find(tool => tool.name === "count_mark")!.description).toContain("within 4 tiles of any living ant of your colony");
  });

  it("teaches the JSON words array and both optional tile axes in rules, worked examples and refusals", async () => {
    const { wordMarksDisabled: _retired, ...legacy } = config;
    h = await startHarness({ simConfig: legacy });
    const agent = await h.connect();
    const joined = await agent.call("join");
    const full = (await agent.call("rules")).data.rules as string;
    for (const text of [full, joined.data.briefing]) {
      expect(text).toContain("JSON array of 1 to 3 word strings");
      expect(text).toContain('["ENEMY","QUEEN"]');
    }
    expect(full.slice(full.indexOf("Worked example:"))).toContain('"mark":{"words":["ENEMY","QUEEN"]}');
    const tools = (await agent.client.listTools()).tools;
    expect(tools.find(tool => tool.name === "mark")!.inputSchema.properties!.words).toMatchObject({ type: "array", items: { type: "string" } });
    for (const [name, args] of [
      ["mark", { words: "ENEMY QUEEN" }],
      ["order", { kind: "hold", mark: { words: "ENEMY QUEEN" } }],
    ] as const) {
      const refused = await agent.call(name, args);
      expect(refused.data.error.code).toBe("bad_arguments");
      expect(refused.data.error.message).toContain('array of word strings, for example ["ENEMY","QUEEN"]');
    }
    const badMark = await agent.call("order", { kind: "hold", mark: ["HELP"] });
    expect(badMark.data.error.message).toContain("object with words and optional tileX and tileY");
    expect(badMark.data.error.message).toContain('{"words":["ENEMY","QUEEN"]}');
    const accepted = await agent.call("order", { kind: "hold", mark: { words: ["ENEMY", "QUEEN"] } });
    expect(accepted.isError, accepted.text).toBe(false);
  });

  it("separates each mark's answered ants from pre-command colony-wide claim availability", async () => {
    const state = emptyMatch(0, config);
    for (let i = 0; i < 30; i++) addAnt(state, 0, 8, 24);
    h = await startHarness({ simConfig: config, state });
    const agent = await h.connect();
    await agent.call("join", { colony: COLONY_NAMES[0] });
    const first = await agent.call("count_mark", { verb: "GATHER", count: 5, tileX: 8, tileY: 24 });
    const second = await agent.call("count_mark", { verb: "DEFEND", count: 3, tileX: 9, tileY: 24 });
    expect(first.isError, first.text).toBe(false);
    expect(second.isError, second.text).toBe(false);
    expect(first.data.mark.claimed).toBe(5);
    expect(second.data.mark.claimed).toBe(3);
    expect(first.data.countMark).toMatchObject({ claimed: 5, claimedAnts: 0, freeAntsNow: 24 });
    expect(second.data.countMark).toMatchObject({ claimed: 3, claimedAnts: 5, freeAntsNow: 19 });
    for (const reply of [first, second]) {
      expect(reply.data.countMark).not.toHaveProperty("claimCap");
      expect(reply.data.countMark).not.toHaveProperty("claimableAnts");
    }
    const description = (await agent.client.listTools()).tools.find(tool => tool.name === "count_mark")!.description!;
    for (const text of [description, (await agent.call("rules")).data.rules as string]) {
      // Rules 26 states both own-mark counts in one sentence; rules 25 keeps two.
      expect(text).toContain("mark.claimed and countMark.claimed count this mark's own answered ants");
      expect(text).toContain("countMark.claimedAnts is the colony-wide total");
      expect(text).toContain("freeAntsNow");
      expect(text).not.toMatch(/claimCap|claimableAnts/);
      expect(text).toContain("before this command");
    }
    const marksBefore = structuredClone(h.game.match!.state.marks);
    const commandBefore = h.game.match!.state.agents[0]!.lastCommandTick;
    const unseen = await agent.call("count_mark", { verb: "ATTACK", count: 1, tileX: 63, tileY: 0 });
    expect(unseen.data.error.code).toBe("count_mark_not_visible");
    expect(unseen.data.error.message).not.toContain("sight");
    // Sight is stated as the circle the sim checks.
    expect(unseen.data.error.howToFix).toContain(`inside a circle of radius ${config.sightTiles} tiles around any living ant of your colony`);
    expect(h.game.match!.state.marks).toEqual(marksBefore);
    expect(h.game.match!.state.agents[0]!.lastCommandTick).toBe(commandBefore);
  });
});

// Current-copy pins are separate from immutable historical gameplay/briefing pins.
it("pins the current configured briefing, join briefing and tool list", async () => {
  const current = playable(rulesConfig("redesign"));
  h = await startHarness({ simConfig: current });
  const agent = await h.connect();
  const tools = (await agent.client.listTools()).tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  // Changes account/key/lobby/rejoin guidance only; preceding economy and gameplay stay pinned.
  // The compact found_queen clause names enemyQueens; observe describes view.enemyQueens. Join briefings unchanged.
  // Preserve the independent omission-sentence assertion and repin only the intended account guidance.
  // Briefing, join briefing and tool-list pins repinned to the
  // grid-scale-2 (rules version 17) current copy; the omission-sentence and ant-cap controls stay independent of the hashes.
  const omissionSentence = " A pair that cannot fit is omitted on both sides.";
  expect(briefing(current).split(omissionSentence)).toHaveLength(2);
  // Rules-25 personal-space lines name the small-radius exceptions (settled guard, resting soldier).
  // The current config is rules 27, so the three current pins follow the rules-27 text:
  // worker defaults without home guard/dispatch/patrol/recall/retarget, soldier hold,
  // and count_mark SPAWN/REMOVE. The pre-rules-27 values stay pinned on the rules-26 rendering below.
  // The compact found_queen line names the territory bit instead of "#".
  // The copy adds the numeric ant cap exactly once; the hashes exclude it.
  const antCap = ` Ant cap ${current.colonyCap}/colony.`;
  for (const text of [briefing(current), joinBriefing(current)]) expect(text.split(antCap)).toHaveLength(2);
  // Repinned for main af5453ab's grid-scale-2 and ant-cap text plus the rules-27 text.
  // Ownership and set_brood text: rules-27 briefing, join briefing and tool list repinned for
  // queenBroodText (caste line, join briefing, found_queen and count_mark descriptions), the found_queen owner-only spawn
  // sentence and the seat notices without brood_vote_lost. The rules-26 pins below are unchanged.
  // Owner-only spawn-point text: repinned again on the merged tree for SPAWN on a live queen you
  // own plus "Only a queen's owner sets, moves or clears her spawn point." in both briefings and the count_mark description.
  // Repinned for "A newly founded queen breeds mixed until her owner calls set_brood for her." in queenBroodText;
  // with that sentence removed both briefings hash to the previous pins 48953990… and c8a92ffc…, so nothing else changed.
  // Rules-27 briefing repinned for the mark-reach sentence in the count-mark placement line; rules 26 below unchanged.
  // Previously 6bf0261f2ed8e3815bbd47f7ba89d98099c1949297ee4f27b43a9af8c2cf1435; removing the sentence restores it.
  // Rules-27 and rules-26 briefing and join briefing repinned for the lobby line "never keys or spectatorUrl.";
  // removing " or spectatorUrl" restores the previous pins 2bf0dfef…, fc970982…, d59d7935… and 2d24a2bb…, so nothing else changed.
  // Briefing and join briefing repinned for the 12-hour lobby and queue lifetimes and the notice-the-match sentence;
  // restoring "Open lobby TTL: 15 min." and "Unpaired TTL: 15 min, no game/rating change; rejoin." restores
  // the previous pins c794287a… and 354c193b…, so nothing else changed. Repinned again for the Benchmark clause's
  // "; unpaired TTL: 15 min." (house modes keep 15 minutes); without it both hash to ca5b9600… and fe75fc03….
  // Repinned for the notice-the-match sentence naming `join-lobby <lobbyId>` for a lobby beside `go` for the queue;
  // the previous sentence restores b17ae39a… and 1a85859e….
  // Repinned for `join-lobby <lobbyId>` naming a public lobby and the private-lobby sentence (join_lobby with
  // inviteToken, then read_lobby); the previous text restores 549339fc… and f1e6f9b1….
  // Repinned for the shortened wake text and the queue line without "; nothing renews it" (the
  // rules reply must fit 20000 characters); the previous LOBBY_GUIDANCE restores fc730908… and fcaf877d….
  // Briefing and join briefing repinned for the count_mark maximum: "at most 10,000" in the count_mark line;
  // the previous line restores 2f416b91… and 1e504690…, so nothing else changed.
  // Briefing and join briefing repinned for the game-mode names ("index match", "the ranked ladder's house-models
  // table"); the previous wording restores dda6128b… and ab3284cf…, so nothing else changed.
  expect(sha(briefing(current).replace(omissionSentence, "").replace(antCap, ""))).toBe("009f4855abfaaf22f2216c2ae009f3a753f0cd8743e89f28ff877322453a17e8");
  expect(joinBriefing(current).split(omissionSentence)).toHaveLength(2);
  expect(sha(joinBriefing(current).replace(omissionSentence, "").replace(antCap, ""))).toBe("7f248b95414f7305ebdc195e77823b1545b846c72ef93fe0368771dee8422ae0");
  // Join advertises optional self-reported thinkingLevel. Rules 26 adds LINE and toTileX/toTileY to count_mark.
  // Briefing, join briefing and observe repinned for the one idle rule only (idle-rule line, countdown wording, 180 s lines removed); the tool pin carries the harness idle limit (86400 s).
  // Rules-27 tool list repinned for the found_queen, count_mark and observe descriptions.
  // Repinned for the count_mark description's owner-only spawn text and its queenId field naming a queen you own.
  // The rules-27 order tool carries no brood field and its description names set_brood, queen ownership
  // and the owner-only spawn point; no other tool changes. Previously 6692b80789bbd635432d3dd50dd150b1b09bf8d7733a6105edf55ab7cdc6b7b4.
  // Repinned on the merged tree carrying both rules-27 changes.
  // Repinned on the merged tree, where the rules-27 tool list also adds set_brood;
  // the rules-26 tool pin below is unchanged. Previously c2fe4bc0f6329a1ab3b593aa7a56ec7ce55f9cf9511ff021f05f992013b19035.
  // Repinned for the rules-27 count_mark description's both-LINE-ends reach clause; rules 26 below unchanged.
  // Previously 1e17b2ae67f72b868117ae01ce28ee0ff91bddead8c174058fd15a11fa6fbbc3.
  // Repinned on the merged tree for "A newly founded queen breeds mixed until her owner calls set_brood for her." in
  // the found_queen, count_mark, order and set_brood descriptions; removed, the list hashes to the pin
  // 70a27c9efc7d1e187259db8c65b678b97aa55f1ef93563eef4fa0777979079ab.
  // Repinned for the rules-27 count_mark description's re-lay lifetime sentence.
  // Previously 2f6144e34e2cccc1fe6b6c88927590b245624ef39b38eacaee7af3c7b0f35c70; removing the sentence restores it.
  // Repinned for the count_mark maximum in the count_mark description and its count field;
  // the previous text restores b87386db…, so nothing else changed.
  // Repinned for "index match" in the observe description (two phrases); the previous wording restores
  // 9178696b…, so nothing else changed.
  expect(sha(JSON.stringify(tools))).toBe("04514aa7ab9f3169be1b9a7582dc1a4734df7ecfaf6c2314682a690bba4ba96b");
});
