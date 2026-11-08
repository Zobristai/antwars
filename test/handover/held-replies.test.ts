/// <reference types="node" />
/**
 * A seat's calls before its match begins are held by the game until the match's first tick hands them to
 * its recording. A handover save taken before that tick carries them, and the resuming game hands them on first.
 */
import { afterEach, expect, it } from "vitest";
import { decodeGameSave, encodeGameSave } from "../../src/handover/matchSave.js";
import { Game } from "../../src/mcp/game.js";
import { playable } from "../playable.js";
import { startHarness, TEST_CONFIG, TEST_MCP_CONFIG, type Harness } from "../mcp/harness.js";
import { WIDE_SEATS, widePlainConfig } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

it("carries a seat's held pre-start calls through a save before the first tick, handing them on first after resume", async () => {
  h = await startHarness({ start: false });
  const a = await h.connect();
  await a.call("join", {});
  const queued = await a.call("observe", {});
  h.game.startMatch(1);
  const save = decodeGameSave(encodeGameSave(h.game.saveMatch()));
  // The join briefing's text line comes first, then the entries.
  expect(save.replies?.map(held => JSON.parse(held.line)).map(line => line.type === "text" ? line.kind : line.tool)).toEqual(["briefing", "join", "observe"]);
  expect(h.replies).toEqual([]);

  const handedOn: { seq: number; line: string }[] = [];
  const resumed = new Game({ simConfig: playable(TEST_CONFIG), mcpConfig: TEST_MCP_CONFIG, now: () => 0, onReply: (seq, line) => handedOn.push({ seq, line }) });
  resumed.resumeMatch(save);
  resumed.tick();
  resumed.tick();
  expect(handedOn.map(({ seq }) => seq)).toEqual([1, 1, 1]);
  expect(handedOn.map(({ line }) => JSON.parse(line))).toMatchObject([{ type: "text", kind: "briefing" }, { tool: "join", tick: null },
    { tool: "observe", tick: null, reply: queued.data }]);
});

it("keeps a seat's pre-match stubs, closing stub included, within the fixed bound through repeated handovers of its start", async () => {
  const WINDOW_MS = 120_000, bound = Math.floor(2 * WINDOW_MS / 1000);
  const clock = { now: 1_000 };
  const handedOn: string[] = [];
  const slotGame = () => new Game({ simConfig: widePlainConfig(), startPickWindowMs: WINDOW_MS, now: () => clock.now,
    onReply: (_seq, line) => handedOn.push(line), slot: { identityOf: async () => undefined, locate: async () => undefined } });
  let game = slotGame();
  game.seatLobby("lobby-wide", WIDE_SEATS, "2v2");
  game.beginLobbyStart(31);
  const agentId = (await game.joinSeated(WIDE_SEATS[0]!.identityId, "test-model"))!.agentId!;
  // Five handovers of the open start, each after 100 s of 4 rate-limited calls a second: every call is a stub.
  let calls = 0, at = 0;
  const stubsIn = (lines: readonly string[]) => lines.map(line => JSON.parse(line)).filter(line => line.type === "stub" && line.agentId === agentId);
  for (let handover = 0; handover < 5; handover += 1) {
    for (let i = 0; i < 400; i += 1) {
      at += 250;
      game.recordReply(agentId, { tool: "order", receivedAt: at, answeredAt: at, code: "call_rate", alwaysStub: true }, () => { throw new Error("a stub has no entry"); });
      calls += 1;
    }
    const save = decodeGameSave(encodeGameSave(game.saveMatch()));
    expect(save.phase).toBe("start");
    // Saved: the held stubs and one closing stub, within the bound however many handovers came before.
    const saved = stubsIn(save.replies!.map(held => held.line));
    expect(saved.length).toBeLessThanOrEqual(bound);
    expect(save.replies!.filter(held => held.closing === true)).toHaveLength(1);
    expect(saved.reduce((n, stub) => n + 1 + (stub.omitted ?? 0), 0)).toBe(calls);
    game = slotGame();
    game.resumeMatch(save);
  }
  expect(handedOn).toEqual([]);
  clock.now = game.openStart!.closesAt;
  game.finishLobbyStart();
  game.tick();
  // Handed on at the first tick: at most the bound, the closing stub its last, and every call counted exactly once.
  const stubs = stubsIn(handedOn);
  expect(stubs).toHaveLength(bound);
  expect(stubs.at(-1)).toMatchObject({ answeredAt: at, tick: null });
  expect(stubs.reduce((n, stub) => n + 1 + (stub.omitted ?? 0), 0)).toBe(calls);
}, 60_000);
