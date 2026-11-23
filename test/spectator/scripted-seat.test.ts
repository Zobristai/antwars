import { describe, expect, it } from "vitest";
import type { StreamAgent, StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { ratingResultRows } from "../../web/src/compose.ts";

const agent = (displayName: string | null, modelLabel: string, more: Partial<StreamAgent> = {}): StreamAgent => ({
  ...(displayName === null ? {} : { identity: { displayName, elo: 1500, rd: 350 } }), colony: 1, modelLabel,
  joinTick: 0, lastCallTick: -1, prevCallTick: -1, order: "hold", orderX: 0, orderY: 0, intent: "", ...more,
});

describe("a seat without a recorded model", () => {
  it("keeps its player and rating change in a rated result", () => {
    const model = agent("falcon", "openai/gpt-6.1-terra", { colony: 0 });
    const result = { winner: 0 as const, reason: "queens_killed" as const, decidedBy: "queens_killed" as const, tick: 10, nextStartMs: null,
      ratingChanges: [{ agent: 0, before: 1500, after: 1510 }, { agent: 1, before: 1500, after: 1490 }] };
    const rows = ratingResultRows(true, [model, agent("wren", "")], result);
    expect(rows.map(row => [row.name, row.text])).toEqual([["falcon", "Rating 1500 → 1510 (+10)"], ["wren", "Rating 1500 → 1490 (-10)"]]);
  });

  it("keeps the identity and rating on the replay board from a snapshot and a subsequent join", () => {
    const setup = { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] as [[number, number], [number, number]] };
    const ants = { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) };
    const model = agent("antwars/gemini-4-hydrogen-low", "antigravity/gemini-4-hydrogen", { colony: 0, thinkingLevel: "low" });
    const messages: StreamMessage[] = [
      { tick: 0, ants, full: { setup, territory: new Uint8Array(64), marks: [], agents: [model, agent("wren", "")], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null }, events: [] },
      { tick: 1, ants, full: null, events: [{ kind: "join", agent: 2, colony: 1, modelLabel: "", identity: { displayName: "wren #2", elo: 1500 } }] },
      { tick: 2, ants, full: null, events: [] },
    ];
    const playback = new Playback(), frame = new Frame();
    for (const message of messages) playback.push(message, message.tick * TICK_MS);
    expect(playback.sample(2 * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
    const agents = frame.board!.agents;
    expect(agents.map(a => a.identity)).toEqual([model.identity, { displayName: "wren", elo: 1500, rd: 350 }, { displayName: "wren #2", elo: 1500 }]);
    expect(agents[0]).toEqual(model);
  });
});
