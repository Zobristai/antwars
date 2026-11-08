import { expect, it } from "vitest";
import { DECIDED_BY, decodeMessage, encodeMessage, encodePublicMessage, GRID_SCALE_STREAM_VERSION, streamQueens, WIN_REASONS, type StreamQueen } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { MAPS, PUBLIC_CONFIG, QUEEN_HP_RULES, TERRAIN_RULES, rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { hpText } from "../../web/src/overlays.ts";
import { queensRoute } from "../../web/rules.ts";
import { howToWinLine } from "../../web/src/story.ts";
import { playable } from "../playable.ts";
import { boardCountMarks, boardLocalAnts, boardQueenFounding, boardQueenHp } from "../../web/src/variant.ts";

const REDESIGN = { ...rulesConfig("redesign"), players: 2 as const };

/** The opening full message, as the hub sends it to a new spectator. */
function opening(r: SpectatorRecorder) {
  return { ...r.initial(), full: r.initialFull() };
}

it("keeps every existing win-reason and decided-by index, appending queens killed", () => {
  expect(WIN_REASONS.slice(0, 3)).toEqual(["overrun", "time_up", "double_overrun"]);
  expect(DECIDED_BY.slice(0, 5)).toEqual(["overrun", "territory", "ants_alive", "food_delivered", "draw"]);
  expect(WIN_REASONS.indexOf("queens_killed")).toBe(3);
  expect(DECIDED_BY.indexOf("queens_killed")).toBe(5);
});

// Every stream setup carries grid scale 2, so a snapshot encodes at the grid-scale stream version or later;
// the redaction of comparison setup is what these keep.
it("a public full snapshot without terrain carries no rules, seed, players or HP", () => {
  const bytes = encodeMessage(opening(new SpectatorRecorder(createMatch(6006, playable({ ...PUBLIC_CONFIG, terrain: undefined })))));
  expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
  const decoded = decodeMessage(bytes).full!;
  expect(decoded.setup).not.toHaveProperty("rules");
  expect(decoded.setup).not.toHaveProperty("seed");
  expect(decoded.setup).not.toHaveProperty("players");
  expect(streamQueens(decoded).every((q) => !("hp" in q))).toBe(true);
});

it.each(MAPS)("$name public terrain snapshots retain map metadata without comparison rules, seed, players or HP", map => {
  const config = { ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, mapId: map.id }, players: 4 as const };
  const message = opening(new SpectatorRecorder(createMatch(6006, playable(config))));
  const bytes = encodeMessage(message), decoded = decodeMessage(bytes).full!;
  expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
  expect(decoded.setup.terrain).toEqual(message.full.setup.terrain);
  for (const full of [message.full, decoded]) {
    expect(full.setup).not.toHaveProperty("rules");
    expect(full.setup).not.toHaveProperty("seed");
    expect(full.setup).not.toHaveProperty("players");
    expect(streamQueens(full).every((q) => !("hp" in q))).toBe(true);
  }
});

it("a comparison run's live header carries its rules, seed and player count, and queens their HP", () => {
  const m = opening(new SpectatorRecorder(createMatch(6006, playable({ ...REDESIGN, terrain: undefined, commandIdleTicks: undefined }))));
  const bytes = encodeMessage(m);
  expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
  const full = decodeMessage(bytes).full!;
  expect(full.setup).toMatchObject({ rules: "redesign", seed: 6006, players: 2 });
  expect(full.queens!.map((q) => q.hp)).toEqual([40_000, 40_000]);
  const v4 = decodeMessage(encodeMessage(opening(new SpectatorRecorder(createMatch(6006, playable({ ...rulesConfig("v4"), players: 4 })))))).full!;
  expect(v4.setup).toMatchObject({ rules: "v4", seed: 6006, players: 4 });
  expect(v4.queens!.every((q) => !("hp" in q))).toBe(true);
});

it("streams each queen HP change and the queens-killed result, and playback keeps them on the board", () => {
  const queen: StreamQueen = { id: 0, colony: 0, x: 8.5 * 256, y: 24.5 * 256, foundedTick: 0, lostTick: null, overrun: 0, hp: 40_000 };
  const hpEvent = { kind: "queenHp" as const, colony: 0 as const, queenId: 0, hp: 37_500 };
  const end = { kind: "end" as const, result: { winner: 1 as const, reason: "queens_killed" as const, decidedBy: "queens_killed" as const, tick: 4000, nextStartMs: null } };
  const r = new SpectatorRecorder(createMatch(6006, playable(REDESIGN)));
  const first = opening(r);
  const delta = { tick: 1, ants: first.ants, full: null, events: [hpEvent, { kind: "queenLost" as const, queen: { ...queen, hp: 0, lostTick: 1 } }, end] };
  const decoded = decodeMessage(encodeMessage(delta));
  expect(decoded.events).toEqual(delta.events);
  const p = new Playback(), f = new Frame();
  p.push(first, 0);
  p.push({ tick: 1, ants: first.ants, full: null, events: [hpEvent] }, 100);
  p.sample(400, f);
  expect(f.board!.queens!.find((q) => q.colony === 0 && q.id === 0)!.hp).toBe(37_500);
});

it("the recorder turns sim queen_hp events into stream events", () => {
  const s = createMatch(6006, playable(REDESIGN));
  const r = new SpectatorRecorder(s);
  const out = step(s);
  out.state.colonies[0].queens![0]!.hp = 39_900;
  const m = r.record({ ...out, events: [{ type: "queen_hp", tick: 0, colony: 0, queenId: 0, hp: 39_900, tileX: 8, tileY: 24 }] });
  expect(m.events).toContainEqual({ kind: "queenHp", colony: 0, queenId: 0, hp: 39_900 });
});

it.each([QUEEN_HP_RULES.hp, 0])("preserves all redesign variant lookups after public redaction with queen HP %s", (hp) => {
  const message = opening(new SpectatorRecorder(createMatch(6006, playable(REDESIGN))));
  message.full.queens = message.full.queens!.map((queen) => ({ ...queen, hp }));
  const named = decodeMessage(encodeMessage(message)).full!;
  const redacted = decodeMessage(encodePublicMessage(message)).full!;
  expect(redacted.setup).not.toHaveProperty("rules");
  for (const lookup of [boardLocalAnts, boardCountMarks, boardQueenFounding]) {
    expect(lookup(named)).toBeDefined();
    expect(lookup(redacted)).toEqual(lookup(named));
  }
});

it.each([undefined, "v4", "count-marks", "redesign"])("preserves explicit comparison and historical variant lookups for %s", (rules) => {
  const config = rulesConfig(rules);
  const full = decodeMessage(encodeMessage(opening(new SpectatorRecorder(createMatch(6006, playable(config)))))).full!;
  expect(boardLocalAnts(full)).toEqual(config.localAnts);
  expect(boardCountMarks(full)).toEqual(config.countMarks);
  expect(boardQueenFounding(full)).toEqual(config.queenFounding);
});

it("does not substitute redesign for absent HP, absent queens or an unknown comparison name", () => {
  for (const queens of [undefined, [], [{ hp: undefined }]]) {
    const board = { setup: {}, queens };
    expect(boardLocalAnts(board)).toBeUndefined();
    expect(boardCountMarks(board)).toBeUndefined();
    expect(boardQueenFounding(board)).toEqual(PUBLIC_CONFIG.queenFounding);
  }
  const unknown = { setup: { rules: "unknown" }, queens: [{ hp: QUEEN_HP_RULES.hp }] };
  expect(boardLocalAnts(unknown)).toBeUndefined();
  expect(boardCountMarks(unknown)).toBeUndefined();
  expect(boardQueenFounding(unknown)).toBeUndefined();
});

it("selects HP rules and wording from streamed HP, including zero, never the comparison rules name", () => {
  const q: StreamQueen = { id: 1, colony: 0, x: 0, y: 0, foundedTick: 0, lostTick: null, overrun: 0, hp: 27_150 };
  expect(hpText(q.hp!)).toBe("28 HP");
  for (const rules of [undefined, "redesign", "v4", "count-marks", "unknown"]) {
    for (const hp of [27_150, 0]) {
      const board = { setup: { rules }, queens: [{ ...q, hp }] };
      expect(boardQueenHp(board)).toBe(QUEEN_HP_RULES);
      expect(howToWinLine(queensRoute(boardQueenHp(board), undefined))).toContain("all queens killed");
    }
    const board = { setup: { rules }, queens: [{ ...q, hp: undefined }] };
    expect(boardQueenHp(board)).toBeUndefined();
    expect(queensRoute(boardQueenHp(board), undefined)).toBe("the enemy queen overrun");
  }
  expect(boardQueenHp({})).toBeUndefined();
  expect(boardQueenHp({ queens: [] })).toBeUndefined();
});

it.each(["time_up", "double_overrun", "queens_killed"] as const)("round-trips a kills-decided %s result without shifting existing indices", reason => {
  // Appends "idle" (version 23 only); existing indices do not move.
  expect(DECIDED_BY).toEqual(["overrun", "territory", "ants_alive", "food_delivered", "draw", "queens_killed", "kills", "idle"]);
  const result = { winner: 1 as const, reason, decidedBy: "kills" as const, tick: 10, nextStartMs: null };
  const first = opening(new SpectatorRecorder(createMatch(6006, playable(REDESIGN))));
  first.full.result = result;
  expect(decodeMessage(encodeMessage(first)).full!.result).toEqual(result);
  const delta = { tick: 11, ants: first.ants, full: null, events: [{ kind: "end" as const, result }] };
  expect(decodeMessage(encodeMessage(delta)).events).toEqual(delta.events);
  const playback = new Playback(), frame = new Frame();
  playback.push(first, 0); playback.push(delta, 100); playback.sample(1000, frame);
  expect(frame.board!.result).toMatchObject({ reason, decidedBy: "kills", winner: 1 });
});
