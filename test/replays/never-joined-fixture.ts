import { gzipSync } from "node:zlib";
import { encodePublicMessage, type StreamResult } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { ColonyId, SimInput } from "../../src/sim/types.ts";
import { matchRecord, type MatchRecord } from "../../src/replays/history.ts";
import { playable } from "../playable.ts";

export const REPLAY_ID = "2026-11-09T13-26-59-840Z-160375822867893";

/**
 * A rated ranked recording as the live hub stores it (cf. test/replays/history.test.ts fixture): rated setup, one seat
 * per colony in `joined`, and the delayed final result carrying rating changes. With joined [1], colony 0 never joins.
 */
export function ratedRecording(joined: readonly ColonyId[] = [1], options: { readonly names?: readonly string[]; readonly id?: string } = {}):
  { binary: Uint8Array; record: MatchRecord; recordBody: Uint8Array } {
  const config = { ...playable(rulesConfig("redesign")), matchTicks: 4, commandFloorTicks: 100, startAnts: 16 };
  let state = createMatch(6006, config);
  const names = options.names ?? ["omp-dolphin", "other-player"];
  const recorder = new SpectatorRecorder(state, { identity: agentId => ({ displayName: names[Number(agentId.replace("seat-private-", ""))]!, elo: 1500 }) });
  const full = recorder.initialFull();
  full.setup = { ...full.setup, rated: true };
  const messages = [encodePublicMessage({ ...recorder.initial(), full })];
  const lines = [headerLine(state.seed, config)];
  const rated = (result: StreamResult): StreamResult => ({ ...result,
    ratingChanges: joined.map((_, agent) => ({ agent, before: 1500, after: 1662.21 })) });
  while (state.result === null) {
    const inputs: SimInput[] = state.tick === 0
      ? joined.map((colony, index) => ({ type: "join", agentId: `seat-private-${index}`, modelLabel: `model-${index}`, colony }))
      : [];
    if (inputs.length) lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    const message = recorder.record(out);
    const events = message.events.map(event => event.kind === "end" ? { ...event, result: rated(event.result) } : event);
    messages.push(encodePublicMessage({ ...message, events, full: null }));
    state = out.state;
  }
  const binary = new Uint8Array(gzipSync(packMessages(messages)));
  const record = matchRecord({ id: options.id ?? REPLAY_ID, binary, logLines: lines, endedAt: Date.parse("2026-11-09T13:55:09.465Z") });
  return { binary, record, recordBody: new TextEncoder().encode(JSON.stringify(record) + "\n") };
}
