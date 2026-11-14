// A nest-pick start saved by a build before the no-bot-moves rule and reopened by a build with it: its match
// has not started, so it starts as every new match does, under the rule (localAnts.everyColony), and records
// that config in its log header. A save from a build with the rule reopens unchanged. Matches already started
// and restored from a save keep their saved config; that path does not reopen a start window.
import { describe, expect, it } from "vitest";
import { decodeGameSave, encodeGameSave, type StartGameSave } from "../../src/handover/matchSave.js";
import { Game } from "../../src/mcp/game.js";
import type { SimConfig } from "../../src/sim/config.js";
import { parseLog, stateHash } from "../../src/sim/log.js";
import { WIDE_SEATS, widePlainConfig } from "./helpers.js";

const WINDOW_MS = 120_000;

function slotGame(clock: { now: number }, log: string[] = []): Game {
  return new Game({ simConfig: widePlainConfig(), startPickWindowMs: WINDOW_MS, now: () => clock.now, onLogLine: (line) => log.push(line),
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
}

/** The config as a build before the rule saved it: the same, without localAnts.everyColony. */
function beforeTheRule(config: SimConfig): SimConfig {
  const { everyColony: _flag, ...local } = config.localAnts!;
  return { ...config, localAnts: local };
}

/** Reopen a save on a fresh game, close its window and start the match; the started game and its log. */
function resumeAndStart(save: StartGameSave, now: number) {
  const clock = { now }, log: string[] = [];
  const game = slotGame(clock, log);
  game.resumeMatch(save);
  clock.now = game.openStart!.closesAt;
  game.finishLobbyStart();
  return { game, log };
}

describe("a nest-pick start handed over across the no-bot-moves rule", () => {
  it("reopened from a save made before the rule, starts and records its match under the rule", async () => {
    const clock = { now: 1_000 }, log: string[] = [];
    const original = slotGame(clock, log);
    original.seatLobby("lobby-wide", WIDE_SEATS, "2v2");
    original.beginLobbyStart(31);
    clock.now += 10_000;
    for (const seat of WIDE_SEATS.slice(0, 3)) expect((await original.joinSeated(seat.identityId, "test-model"))!.outcome.kind).toBe("queued");
    const save = decodeGameSave(encodeGameSave(original.saveMatch())) as StartGameSave;
    expect(save.start.config.localAnts?.everyColony).toBe(true);
    const old: StartGameSave = { ...structuredClone(save), start: { ...structuredClone(save.start), config: beforeTheRule(save.start.config) } };
    expect(old.start.config.localAnts?.everyColony).toBeUndefined();

    const fromOld = resumeAndStart(old, clock.now + 25_000);
    const fromNew = resumeAndStart(save, clock.now + 25_000);
    clock.now = original.openStart!.closesAt;
    original.finishLobbyStart();

    for (const started of [fromOld, fromNew]) {
      const header = parseLog(started.log).header;
      expect(header.config.localAnts?.everyColony).toBe(true);
      expect(started.game.match!.state.config.localAnts?.everyColony).toBe(true);
      // The same match the saving server would have started, from the same board and seats.
      expect(stateHash(started.game.match!.state)).toBe(stateHash(original.match!.state));
      expect(started.log[0]).toBe(log[0]);
    }
    // The save itself is left as it was read.
    expect(old.start.config.localAnts?.everyColony).toBeUndefined();
  }, 60_000);
});
