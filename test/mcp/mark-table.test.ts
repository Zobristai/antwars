import { describe, expect, it } from "vitest";
import { packMarks, unpackMarks, type MarkTable } from "../../src/mcp/markTable.js";
import { startHarness } from "./harness.js";
import { prepareLargestView } from "./response-size-fixture.js";
import { rulesConfig } from "../../src/sim/config.js";
import { takeView } from "../../src/sim/view.js";
import { buildGrid } from "../../src/sim/map.js";
import { pagedView, publicCountCaste, MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS } from "../../src/mcp/replies.js";

describe("lossless pressure-only mark table", () => {
  it("pins an independently decoded mixed word/count table, including optional absence and zero", () => {
    const marks = [
      { markId: 1, words: ["HELP"], mine: false, ticksLeft: 0 },
      { markId: 2, words: [], mine: true, verb: "GATHER", count: 512, caste: "soldier", lost: 0, kills: 8841 },
    ];
    const snapshot = structuredClone(marks);
    const table = packMarks(marks);
    expect(table.fields).toEqual(["markId", "words", "mine", "ticksLeft", "verb", "count", "caste", "lost", "kills"]);
    expect(table.rows).toEqual([[1, ["HELP"], false, 0, null, null, null, null, null], [2, [], true, null, "GATHER", 512, "soldier", 0, 8841]]);
    const independentlyDecoded = table.rows.map(row => Object.fromEntries(row.flatMap((value, index) => value === null ? [] : [[table.fields[index], value]])));
    expect(independentlyDecoded).toEqual(marks);
    expect(unpackMarks(table)).toEqual(marks);
    expect(marks).toEqual(snapshot);
    expect(unpackMarks(marks)).toEqual(marks);
  });

  it("retains empty inputs, duplicate row identities and every own-mark field", () => {
    expect(unpackMarks(packMarks([]))).toEqual([]);
    const own = { markId: 7, steering: 0, verb: "DEFEND", count: 20, claimed: 0, lost: 0, kills: 0 };
    expect(unpackMarks(packMarks([own, own]))).toEqual([own, own]);
  });

  it("bounds repeated-key overhead without relying on any particular counter values", () => {
    const marks = Array.from({ length: 72 }, (_, i) => ({ markId: i, words: [], tileX: i, tileY: i, ticksLeft: 1700 - i,
      mine: i < 18, verb: "GATHER", count: 512, claimed: 512, caste: "soldier", lost: 8841 - i, kills: 8841 - i }));
    const table = packMarks(marks);
    expect(unpackMarks(table)).toEqual(marks);
    expect(JSON.stringify(marks).length - JSON.stringify(table).length).toBeGreaterThan(6000);
  });

  it("refuses null inputs and ambiguous decoder columns", () => {
    expect(() => packMarks([{ lost: null }])).toThrow();
    expect(() => unpackMarks({ encoding: "columnar-v1", fields: ["lost", "lost"], rows: [[1, 2]] })).toThrow();
    expect(() => unpackMarks({ encoding: "columnar-v1", fields: ["lost"], rows: [[]] })).toThrow();
  });
});

it("compacts only when needed for the first history event, preserving the exact internal view", async () => {
  const h = await startHarness({ simConfig: rulesConfig("redesign") });
  try {
    const agent = await h.connect();
    const joined = await agent.call("join");
    prepareLargestView(h, true);
    await agent.call("observe"); // Retain the fixture's sighted events in Game history.
    const state = h.game.match!.state;
    const own = state.agents.find(agent => agent.id === joined.data.agentId)!;
    const view = takeView(state, buildGrid(state), own);
    const snapshot = structuredClone(view);
    const end = h.game.eventHistory(own.id).length;
    expect(end).toBeGreaterThan(0);
    // Without the territory map: on the 128x96 board the map alone pushes this full uncompacted page
    // just past the 20,000-character limit, which would compact before any event is added.
    const empty = pagedView(h.game, state.config, view, false, {}, end);
    const raw = empty.structuredContent as { view: { marks: object[] } };
    expect(Array.isArray(raw.view.marks)).toBe(true);
    const textChars = JSON.stringify(empty.structuredContent).length + 10;
    const compact = pagedView(h.game, state.config, view, false, {}, 0, { textChars, bytes: MAX_OBSERVE_REPLY_BYTES });
    const result = compact.structuredContent as { view: { marks: MarkTable; myMarks: MarkTable; eventCursor: number; events: unknown[] } };
    expect(result.view.marks.encoding).toBe("columnar-v1");
    expect(unpackMarks(result.view.marks)).toEqual(view.marks.map(publicCountCaste));
    expect(unpackMarks(result.view.myMarks)).toEqual(view.myMarks.map(publicCountCaste));
    expect(result.view.events.length).toBeGreaterThan(0);
    expect(result.view.eventCursor).toBeGreaterThan(0);
    expect(JSON.stringify(compact.structuredContent).length).toBeLessThanOrEqual(textChars);
    expect(view).toEqual(snapshot);
  } finally { await h.close(); }
});
