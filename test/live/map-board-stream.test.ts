import { describe, expect, it } from "vitest";
import { SUB_TILE, decodeMessage, encodeMessage, encodeReplayMessage } from "../../src/live/format.js";
import { SpectatorRecorder } from "../../src/live/model.js";
import { playScripted, recordLog } from "../../src/live/record.js";
import { packTerritory } from "../../src/mcp/territory.js";
import { MAX_BOARD_SIDE_TILES } from "../../src/sim/mapBoard.js";
import { createMatch } from "../../src/sim/map.js";
import { headerLine, replay, stateHash, type LogHeader } from "../../src/sim/log.js";
import { packMessages } from "../../src/live/snapshot.js";
import { Game } from "../../src/mcp/game.js";
import { matchRecord } from "../../src/replays/history.js";
import { BOARD_CASES, OWN_VALUES_WIDE, WIDE_BOARD, boardRotation } from "../sim/map-board-fixtures.js";

describe.each(BOARD_CASES)("$map.name at grid scale $scale: live stream and replay encoding", ({ map, scale }) => {
  const board = map.board!;
  const width = board.referenceWidth * scale, height = board.referenceHeight * scale;
  const base = boardRotation(scale, [map], { mapId: map.id });

  it("streams the map's board from a server-form log, in every message", () => {
    const seed = 7001;
    const { lines } = playScripted({ seed, config: base, agents: 2, ticks: 20 });
    const serverLines = [headerLine(seed, createMatch(seed, base).config), ...lines.slice(1)];
    const messages = recordLog(serverLines, 20).map(decodeMessage);
    const full = messages[0]!.full!;
    expect([full.setup.mapW, full.setup.mapH, full.setup.gridScale]).toEqual([width, height, scale]);
    expect(full.territory).toHaveLength(width * height);
    expect(full.setup.terrain!.mapId).toBe(map.id);
    expect(full.setup.terrain!.water).toEqual(map.water.map(r => [r.x * scale, r.y * scale, r.width * scale, r.height * scale]));
    for (const [qx, qy] of full.setup.queens) expect(qx < width * SUB_TILE && qy < height * SUB_TILE).toBe(true);
    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      for (let i = 0; i < message.ants.count; i++) {
        expect(message.ants.x[i]!).toBeLessThan(width * SUB_TILE);
        expect(message.ants.y[i]!).toBeLessThan(height * SUB_TILE);
      }
    }
  }, 30_000);

  it("keeps the board through replay re-encoding and reconnect snapshots", () => {
    const recorder = new SpectatorRecorder(createMatch(6006, base));
    const live = { ...recorder.initial(), full: recorder.initialFull() };
    const replayed = decodeMessage(encodeReplayMessage(live)).full!;
    const reencoded = decodeMessage(encodeMessage(live)).full!;
    for (const full of [replayed, reencoded]) {
      expect([full.setup.mapW, full.setup.mapH]).toEqual([width, height]);
      expect(full.territory).toHaveLength(width * height);
      expect(full.setup.terrain).toEqual(live.full.setup.terrain);
    }
  });
});

describe("format limits match MAX_BOARD_SIDE_TILES", () => {
  it("the stream carries a 256-tile side and refuses 257", () => {
    // Fixture Wide at grid scale 2 is the 256x92 board: the widest side a map's own board may have.
    const recorder = new SpectatorRecorder(createMatch(7001, boardRotation(2, [WIDE_BOARD], { mapId: WIDE_BOARD.id })));
    const live = { ...recorder.initial(), full: recorder.initialFull() };
    expect(decodeMessage(encodeMessage(live)).full!.setup.mapW).toBe(MAX_BOARD_SIDE_TILES);
    const wider = { ...live, full: { ...live.full, setup: { ...live.full.setup, mapW: MAX_BOARD_SIDE_TILES + 1 } } };
    expect(() => encodeMessage(wider)).toThrow(/up to 256 tiles a side/);
  });

  it("the agent territory bitset packs 256 a side and refuses 257", () => {
    expect(packTerritory(Array.from({ length: 2 }, () => ".".repeat(256)), 256, 2).width).toBe(256);
    expect(() => packTerritory([".".repeat(257)], 257, 1)).toThrow(/1\.\.256/);
  });
});

describe("a match on a map with its own board, ant cap and match length", () => {
  it("streams, logs, replays and records that map's values from the live game", () => {
    const config = boardRotation(2, [OWN_VALUES_WIDE], { mapId: OWN_VALUES_WIDE.id });
    const logs: string[] = [];
    const game = new Game({ simConfig: config, now: () => 0, onLogLine: line => logs.push(line),
      slot: { identityOf: async () => undefined, locate: async () => undefined } });
    game.startMatch(7001);
    for (let i = 0; i < 100 && game.match!.state.result === null; i++) game.tick();
    const final = game.match!.state;
    expect([final.tick, final.result !== null]).toEqual([40, true]);
    const header = (JSON.parse(logs[0]!) as LogHeader).config;
    expect([header.mapWidth, header.mapHeight, header.gridScale, header.colonyCap, header.matchTicks]).toEqual([256, 92, 2, 33, 40]);
    expect(stateHash(replay(logs, Infinity))).toBe(stateHash(final));
    const binary = packMessages(recordLog(logs));
    const messages = recordLog(logs).map(decodeMessage);
    const full = messages[0]!.full!;
    expect([full.setup.mapW, full.setup.mapH, full.setup.matchTicks, full.hatch!.cap]).toEqual([256, 92, 40, 33]);
    expect(full.setup.terrain!.mapId).toBe(OWN_VALUES_WIDE.id);
    expect(full.setup.terrain!.water).toEqual(OWN_VALUES_WIDE.water.map(r => [r.x * 2, r.y * 2, r.width * 2, r.height * 2]));
    for (const message of messages) for (let i = 0; i < message.ants.count; i++) {
      expect(message.ants.x[i]!).toBeLessThan(256 * SUB_TILE);
      expect(message.ants.y[i]!).toBeLessThan(92 * SUB_TILE);
    }
    const record = matchRecord({ id: "2026-10-27T00-00-00-000Z-499", binary, logLines: logs });
    expect(record.status).toBe("complete");
  }, 30_000);
});
