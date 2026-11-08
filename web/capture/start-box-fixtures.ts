/** Real finalized-layout fixtures for the start-box captures, with explicitly accelerated offline founding.
 * node --import ./src/ts-resolve.mjs web/capture/start-box-fixtures.ts --out out/start-box-recordings
 * No server, MCP connection or agent join. Spatial configuration is the current Game default with its maps pinned to the
 * retired seven-map rotation (retiredSevenMapRotation()), which still holds the START_MAPS ids.
 * Only founding availability/food/one held tile are arranged for this short renderer scenario;
 * LobbyStart, pick validation/default assignment, foundQueen, step and the wire encoder are real.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Game } from "../../src/mcp/game.ts";
import { LobbyStart } from "../../src/mcp/lobbyStart.ts";
import { SUB, type SimConfig } from "../../src/sim/config.ts";
import { retiredSevenMapRotation } from "../../src/sim/mapShapes.ts";
import { foundQueen } from "../../src/sim/agents.ts";
import { isBlockedTile } from "../../src/sim/terrain.ts";
import { step } from "../../src/sim/step.ts";
import type { SimEvent } from "../../src/sim/types.ts";
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { inspectStartRecording, START_MAPS } from "./start-boxes.ts";

/** The current Game default, pinned to the retired seven-map rotation that still holds the START_MAPS ids. */
function pinnedGameConfig(): SimConfig {
  const config = new Game().simConfig;
  return { ...config, terrain: { ...config.terrain!, maps: retiredSevenMapRotation() } };
}

export function startBoxFixture(mapId: string, resolvedConfig: SimConfig = pinnedGameConfig()) {
  assert(resolvedConfig.terrain && resolvedConfig.queenFounding, "fixture requires the actual terrain and queen rules");
  const config: SimConfig = { ...resolvedConfig, terrain: { ...resolvedConfig.terrain, mapId },
    queenFounding: { ...resolvedConfig.queenFounding, firstFoundTick: 0 } };
  const seats = Array.from({ length: 4 }, (_, id) => ([
    { identityId: `left-${id}`, colony: 0 as const }, { identityId: `right-${id}`, colony: 1 as const },
  ])).flat();
  const lobby = new LobbyStart(7001, config, seats, 0);
  const picks: { identityId: string; tileX: number; tileY: number }[] = [];
  for (const identityId of ["left-0", "right-3"]) {
    const box = lobby.teamView(identityId)!.box;
    let picked = false;
    for (let y = box.y; y < box.y + box.height && !picked; y++) for (let x = box.x; x < box.x + box.width && !picked; x++) {
      if (lobby.pick(identityId, x, y, 1).ok) { picks.push({ identityId, tileX: x, tileY: y }); picked = true; }
    }
    assert(picked, `no legal explicit pick for ${identityId}`);
  }
  const state = lobby.finish(lobby.closesAt);
  assert.equal(state.agents.length, 0, "fixture must not join agents");
  const recorder = new SpectatorRecorder(state);
  const first = encodeMessage({ ...recorder.initial(), full: recorder.initialFull() });
  const spacing = state.config.queenFounding!.minDistanceTiles;
  let target: { x: number; y: number } | undefined;
  for (let y = 0; y < state.config.mapHeight && !target; y++) for (let x = 0; x < state.config.mapWidth && !target; x++) {
    if (isBlockedTile(state.terrain, x, y) || state.colonies.some(c => c.queens!.some(q =>
      (x - Math.floor(q.queenX / SUB)) ** 2 + (y - Math.floor(q.queenY / SUB)) ** 2 < spacing ** 2))) continue;
    target = { x, y };
  }
  assert(target, "no legal tile for the true founding scene");
  state.owner[target.y * state.config.mapWidth + target.x] = 0;
  state.colonies[0].foodStore = 10000;
  const events: SimEvent[] = [];
  assert.equal(foundQueen(state, 0, target.x, target.y, state.tick, events), null, "normal founding operation refused");
  const next = step(state);
  const delta = encodeMessage({ ...recorder.record({ ...next, events: [...events, ...next.events] }), full: null });
  const bytes = packMessages([first, delta]);
  const observed = inspectStartRecording(unpackMessages(bytes).map(decodeMessage), mapId);
  return { bytes, observed, provenance: {
    kind: "offline finalized lobby plus accelerated legal founding", seed: 7001, mapId,
    resolvedConfig, fixtureConfig: state.config, pickWindowMs: lobby.closesAt, picks,
    defaultedIdentities: seats.filter(s => !picks.some(p => p.identityId === s.identityId)).map(s => s.identityId),
    arrangedFounding: { firstFoundTick: 0, colony: 0, foodStore: 10000, ownedTile: target },
    joins: 0,
  } };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string", default: "out/start-box-recordings" } } });
  const out = resolve(values.out); mkdirSync(out, { recursive: true });
  const records = START_MAPS.map(mapId => {
    const fixture = startBoxFixture(mapId), filename = `${mapId}.bin`;
    writeFileSync(join(out, filename), fixture.bytes);
    return { filename, sha256: createHash("sha256").update(fixture.bytes).digest("hex"), ...fixture.provenance, observed: fixture.observed };
  });
  // No legacy recording: the older bundled file carries no grid scale and no longer decodes.
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    records }, null, 2));
  console.log(`Wrote ${records.length} finalized-layout recordings to ${out}`);
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
