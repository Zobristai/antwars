/** Current-format four-colony saves keep the same event history as uninterrupted recording. */
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { rerunRecord } from "../../src/accounts/postMortemChild.ts";
import { scanRecord } from "../../src/accounts/postMortemRecord.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { decodeInput } from "../../src/records/inputs.ts";
import { matchRecord } from "../../src/replays/history.ts";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { eliminationsAt, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { ManualClock } from "./helpers.ts";

const QUADRANTS: MapDefinition = {
  id: "handover-quadrants", name: "Handover Quadrants", water: [],
  quadrant: { referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
    startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }] },
};
const CODE = "a".repeat(40);

async function recorded(delaySeconds: number, handovers: readonly number[]) {
  const live = newMatchConfig(rulesConfig("redesign"));
  const config = { ...live, matchTicks: 40, terrain: { ...live.terrain!, maps: [QUADRANTS] } };
  let state = createMatch(404, config);
  expect(state.colonies).toHaveLength(4);
  const clock = new ManualClock(), inputs = new Map<string, Uint8Array>(), published = new Map<string, Uint8Array>();
  const handoff = createRecordHandoff({ codeVersion: CODE, store: { create: async object => { inputs.set(object.name, object.body); } } });
  const hubs: LiveHub[] = [], released: boolean[] = [];
  const activity = new Map<string, number>();
  const houseIdle = { idleTicks: 1000, activityTick: (id: string) => activity.get(id) };
  const identity = (id: string) => ({ displayName: `Player ${id.slice(-1)}` });
  const serve = () => {
    const hub = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds }, captureMatchLogs: true,
      replayStore: { create: async object => { published.set(object.name, object.body); } }, recordHandoff: handoff });
    hubs.push(hub); return hub;
  };
  let hub = serve(), seq = 1;
  hub.startMatch(seq, state, undefined, identity, houseIdle);
  try {
    while (state.result === null) {
      if (handovers.includes(state.tick)) {
        const save = await hub.saveMatch(seq);
        released.push((save.meta.stream as { released: boolean }).released);
        // The save crosses servers as JSON metadata and independent part bytes.
        const carried = { meta: JSON.parse(JSON.stringify(save.meta)) as typeof save.meta,
          parts: new Map([...save.parts].map(([name, bytes]) => [name, bytes.slice()])) };
        hub.close(); hub = serve(); seq++;
        await hub.resumeMatch(seq, state, carried, identity, houseIdle);
      }
      const tick = state.tick;
      const calls: SimInput[] = tick === 0
        ? [0, 1, 2, 3].map(colony => ({ type: "join", agentId: `agent-${colony}`, modelLabel: `model-${colony}` }))
        : tick === 1 || tick === 4 ? [{ type: "set_brood", agentId: "agent-2", brood: "soldiers" }] : [];
      const stop = tick === 8;
      const out = step(state, calls, undefined, undefined, undefined, stop, true);
      calls.forEach((call, i) => { if (out.results[i]?.ok) activity.set(call.agentId, tick); });
      hub.appendLog(seq, tickLine(tick, calls, stop, true, eliminationsAt(out.state, tick)));
      clock.advance(100); hub.pushTick(seq, out); state = out.state;
    }
    clock.advance((delaySeconds + 2) * 1000);
    await vi.waitFor(() => expect([inputs.size, published.size]).toEqual([1, 1]));
    const input = decodeInput([...inputs.values()][0]!);
    const messages = unpackMessages(gunzipSync(input.binary)).map(decodeMessage);
    const record = { ...matchRecord({ id: input.id, binary: input.binary, logLines: input.logLines, endedAt: input.endedAt, rerun: true }), codeVersion: CODE };
    expect(record.status).toBe("complete");
    const scanned = await scanRecord(Readable.from([Buffer.from(JSON.stringify(record))]), undefined, "rerun");
    return { answer: rerunRecord(scanned.reduced), messages, released };
  } finally { hubs.forEach(hub => hub.close()); }
}

it("resumes from the newest held kill totals rather than the delayed full board", async () => {
  const live = newMatchConfig(rulesConfig("redesign"));
  let state = createMatch(404, { ...live, terrain: { ...live.terrain!, maps: [QUADRANTS] } });
  const clock = new ManualClock(), messages: StreamMessage[] = [];
  const first = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 60 } });
  const next = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 60 },
    encode: message => { messages.push(structuredClone(message)); return encodeMessage(message); } });
  try {
    first.startMatch(1, state);
    // Deliberate recorder fixture: a new total is held behind the initial zero-total board.
    state.colonies[2]!.kills = 7;
    let out = step(state, []); first.pushTick(1, out); state = out.state;
    const save = await first.saveMatch(1);
    expect((save.meta.stream as { released: boolean }).released).toBe(false);
    await next.resumeMatch(2, state, save);
    out = step(state, [], undefined, undefined, undefined, true);
    next.pushTick(2, out);
    clock.advance(62_000);
    expect(messages.some(message => message.events.some(event => event.kind === "kills" && event.totals[2] === 7))).toBe(true);
    const final = messages.filter(message => message.tick === out.state.tick && message.full === null);
    expect(final.length).toBeGreaterThan(0);
    expect(final.flatMap(message => message.events.filter(event => event.kind === "kills"))).toEqual([]);
  } finally { first.close(); next.close(); }
});

it.each([0, 60])("keeps a saved/resumed current-format record reproducible with %s seconds of playback delay", async delaySeconds => {
  const control = await recorded(delaySeconds, []);
  expect(control.answer).toMatchObject({ kind: "done", undecided: [] });
  const resumed = await recorded(delaySeconds, [3, 6]);
  expect(resumed.released).toEqual([delaySeconds === 0, delaySeconds === 0]);
  expect(resumed.answer).toMatchObject({ kind: "done", undecided: [] });
  expect(resumed.answer).toEqual(control.answer);
  expect(resumed.messages[0]!.full!.kills).toEqual([0, 0, 0, 0]);
  expect(resumed.messages.flatMap(message => message.events.filter(event => event.kind === "kills"))).toEqual([]);
  expect(resumed.messages.map(message => message.events)).toEqual(control.messages.map(message => message.events));
});
