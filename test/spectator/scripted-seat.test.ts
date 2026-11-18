import { describe, expect, it } from "vitest";
import type { StreamAgent, StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { SCRIPTED_BOT, isScriptedAgent, isScriptedSeat, shownAgent } from "../../web/src/scripted-seat.ts";
import { ratingResultRows } from "../../web/src/compose.ts";

const agent = (displayName: string | null, modelLabel: string, more: Partial<StreamAgent> = {}): StreamAgent => ({
  ...(displayName === null ? {} : { identity: { displayName, elo: 1500, rd: 350 } }), colony: 1, modelLabel,
  joinTick: 0, lastCallTick: -1, prevCallTick: -1, order: "hold", orderX: 0, orderY: 0, intent: "", ...more,
});

describe("scripted seats", () => {
  it("are seated players that recorded no model and are not house seats, whatever their name", () => {
    expect(isScriptedSeat("test-account", null)).toBe(true);
    expect(isScriptedSeat("test-account", "")).toBe(true);
    expect(isScriptedSeat("test-account #2", "")).toBe(true);
    expect(isScriptedSeat("test-account", "openai/gpt-6.1-terra")).toBe(false);
    // A house seat is never scripted, even with no recorded label (a retired house seat keeps its own name).
    expect(isScriptedSeat("antwars/claude-fable-5-1", null)).toBe(false);
    expect(isScriptedSeat("Antwars/gpt-6-luna #1", "")).toBe(false);
    // No seated player: an older recording's generated handle stays as it was.
    expect(isScriptedSeat(null, null)).toBe(false);
    expect(isScriptedSeat(undefined, "")).toBe(false);
  });

  it("have no line in a rated result's ratings, as received or as the board shows them; a model seat keeps its own", () => {
    const model = agent("kestrel-harness", "openai/gpt-6.1-terra", { colony: 0 });
    const result = { winner: 0 as const, reason: "queens_killed" as const, decidedBy: "queens_killed" as const, tick: 10, nextStartMs: null,
      ratingChanges: [{ agent: 0, before: 1500, after: 1510 }, { agent: 1, before: 1500, after: 1490 }] };
    for (const scripted of [agent("test-account", ""), shownAgent(agent("test-account", ""))]) {
      expect(isScriptedAgent(scripted)).toBe(true);
      const rows = ratingResultRows(true, [model, scripted], result);
      expect(rows.map(row => row.text)).toEqual(["Rating 1500 → 1510 (+10)"]);
      expect(JSON.stringify(rows)).not.toMatch(/test-account|1490/);
    }
    expect(isScriptedAgent(model)).toBe(false);
  });

  it("show on the board as Scripted bot with no rating, level or tier; every other agent is unchanged", () => {
    const scripted = agent("test-account", "", { thinkingLevel: "low", serviceTier: "fast" });
    const shown = shownAgent(scripted);
    expect(shown.identity).toEqual({ displayName: SCRIPTED_BOT });
    expect(shown).not.toHaveProperty("thinkingLevel");
    expect(shown).not.toHaveProperty("serviceTier");
    expect(scripted.identity?.displayName).toBe("test-account");
    for (const other of [agent("antwars/gemini-4-hydrogen-low", "antigravity/gemini-4-hydrogen", { thinkingLevel: "low" }),
      agent("kain", "openai/gpt-6.1-terra"), agent(null, ""), agent("antwars/claude-fable-5-1", "")]) {
      expect(shownAgent(other)).toBe(other);
    }
  });

  it("are named so on the board built from a snapshot and from a later join, the model seat as it was streamed", () => {
    const setup = { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] as [[number, number], [number, number]] };
    const ants = { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) };
    const model = agent("antwars/gemini-4-hydrogen-low", "antigravity/gemini-4-hydrogen", { colony: 0, thinkingLevel: "low" });
    const messages: StreamMessage[] = [
      { tick: 0, ants, full: { setup, territory: new Uint8Array(64), marks: [], agents: [model, agent("test-account", "")], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null }, events: [] },
      { tick: 1, ants, full: null, events: [{ kind: "join", agent: 2, colony: 1, modelLabel: "", identity: { displayName: "test-account #2", elo: 1500 } }] },
      { tick: 2, ants, full: null, events: [] },
    ];
    const playback = new Playback(), frame = new Frame();
    for (const message of messages) playback.push(message, message.tick * TICK_MS);
    expect(playback.sample(2 * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
    const agents = frame.board!.agents;
    expect(agents.map(a => a.identity)).toEqual([model.identity, { displayName: SCRIPTED_BOT }, { displayName: SCRIPTED_BOT }]);
    expect(agents[0]).toEqual(model);
  });
});
