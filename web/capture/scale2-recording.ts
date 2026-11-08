/**
 * A short public recording of today's match, made in process at grid scale 2: spectator tests and capture
 * scripts that once read the deleted bundled web/public/replays/agents.bin play this instead. The first packet is a
 * full snapshot; the rest are one-tick deltas, encoded as stored recordings are.
 */
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";

export function scale2Packets(count: number, seed = 7001): Uint8Array[] {
  let state = createMatch(seed, withGridScale(DEFAULT_CONFIG));
  const recorder = new SpectatorRecorder(state);
  const packets = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  while (packets.length < count) {
    const out = step(state, []);
    state = out.state;
    packets.push(encodePublicMessage({ ...recorder.record(out), full: null }));
  }
  return packets;
}

/** One stored match a capture server holds: a bare ?replay or an idle stand-in finds it through history. */
export interface StoredRecording { readonly id: string; readonly bytes: Uint8Array; readonly lastTick: number }

export function storedRecording(packets: readonly Uint8Array[], id = "2026-10-21T13-58-00-000Z-1"): StoredRecording {
  return { id, bytes: packMessages([...packets]), lastTick: decodeMessage(packets.at(-1)!).tick };
}

/** What a server holding exactly this one stored match answers for its history, record and recording; null otherwise. */
export function storedHistory(path: string, stored: StoredRecording): { type: string; body: string | Uint8Array } | null {
  if (path === "/matches") return { type: "application/json", body: JSON.stringify({ matches: [{ id: stored.id }], nextPageToken: null }) };
  // Result ticks name the simulation step; the page plays to the completed tick after it.
  if (path === `/matches/${stored.id}`) return { type: "application/json", body: JSON.stringify({ format: "antwar.match", version: 1, id: stored.id, result: { tick: stored.lastTick - 1 } }) };
  if (path === `/replays/${stored.id}`) return { type: "application/octet-stream", body: stored.bytes };
  return null;
}
