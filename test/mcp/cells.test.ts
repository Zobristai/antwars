import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { rulesConfig } from "../../src/sim/config.js";
import { denseCells, expandCells, type DenseCells, type ViewCell } from "../../src/sim/view.js";
import { startHarness } from "./harness.js";
import { playable } from "../playable.ts";

/** Independently implemented from the public legend, without the production decoder. */
function readLegendCells(table: DenseCells): ViewCell[] {
  let previous = 0;
  const cells: ViewCell[] = [];
  if (!table.data) return cells;
  for (const run of table.data.split(";")) {
    const [token, repetitions] = run.split("*") as [string, string?];
    for (let i = 0; i < (repetitions === undefined ? 1 : parseInt(repetitions, 36)); i++) {
      const [header, occupants] = token.split(":");
      const [position, queen, queenHp] = header!.split(",");
      const packed = parseInt(position!, 36), delta = Math.floor(packed / table.foodRadix);
      const food = packed - delta * table.foodRadix, index = previous + delta;
      previous = index;
      const ants = !occupants ? [] : occupants.split("/").map(record => {
        const [identity, health] = record.split(".");
        const value = parseInt(health!, 36), kind = value % 6;
        return { antId: parseInt(identity!, 36), hp: Math.floor(value / 6), colony: (kind % 2) as 0 | 1,
          ...(kind < 2 ? {} : { caste: kind < 4 ? "worker" as const : "soldier" as const }) };
      });
      cells.push({ tileX: index % table.width, tileY: Math.floor(index / table.width), food, ants,
        ...(queen === undefined ? {} : { queen: parseInt(queen, 36) as 0 | 1 }),
        ...(queenHp === undefined ? {} : { queenHp: parseInt(queenHp, 36) }) });
    }
  }
  return cells;
}

const raw: ViewCell[] = [
  ...[1, 2, 3].map(tileX => ({ tileX, tileY: 0, food: 3, ants: [] })),
  { tileX: 5, tileY: 0, food: 0, ants: [], queen: 0, queenHp: 40_000 },
  { tileX: 7, tileY: 7, food: 7, ants: [
    { antId: 16731, colony: 0, hp: 1 }, { antId: 16732, colony: 1, hp: 3999, caste: "worker" },
    { antId: 16733, colony: 0, hp: 7999, caste: "soldier" },
  ], queen: 1 },
  { tileX: 0, tileY: 1, food: 0, ants: [] }, // Preserve public helper input order, including a signed delta.
];

describe("one readable cell grammar", () => {
  it("roundtrips repeats, signed deltas and every optional field without mutation or a format switch", () => {
    const before = structuredClone(raw), table = denseCells(raw, 8, 8);
    expect(table.data).toContain("b*3");
    expect(readLegendCells(table)).toEqual(raw);
    expect(expandCells(table)).toEqual(raw);
    expect(raw).toEqual(before);
    expect(denseCells(raw, 8, 8)).toEqual(table);
    expect(readLegendCells(denseCells([], 8, 8))).toEqual([]);
    expect(denseCells([], 8, 8).encoding).toBe(table.encoding);
  });

  it("publishes the entire decoding and continuation contract in either briefing and the observe description alone", async () => {
    const config = playable(rulesConfig("redesign")), h = await startHarness({ simConfig: config });
    try {
      const agent = await h.connect();
      const text = (await agent.client.listTools()).tools.find(tool => tool.name === "observe")!.description!;
      for (const source of [briefing(config), joinBriefing(config), text]) {
        for (const instruction of ["cells.foodRadix", "base36 integers (signed)", "p[,queenColony[,queenHp]][:ants]", "previousIndex=0 (i) per page", "d=floor(p/foodRadix)", "food=p-d*foodRadix", "i+=d", "x=i%width", "y=floor(i/width)", "p*n repeats n times (n base36)", "updating i each time", "queenColony=colony0/1 (own=view.colony), not queenId", "antId.k separated by /", "hp=floor(k/6), kind=k%6", "0/1=no caste", "2/3=worker", "4/5=soldier", "even=colony0, odd=colony1", "HP and queenHp are milli-HP", "Absent queen/ants or empty data means none", "cellsCursor:view.cellsCursor", "cellsMore", "cellsTick", "event since is separate"]) {
          expect(source).toContain(instruction);
        }
        expect(source).not.toContain("DEFLATE");
      }
      expect(readLegendCells(denseCells(raw, 8, 8))).toEqual(raw);
    } finally { await h.close(); }
  });

  it("rejects unsafe packed integers and unbounded repeats", () => {
    const table = denseCells(raw, 8, 8);
    expect(() => expandCells({ ...table, data: "b*zzzzzzzz" })).toThrow(RangeError);
    expect(() => denseCells([{ tileX: 1, tileY: 0, food: Number.MAX_SAFE_INTEGER, ants: [] }], 8, 8)).toThrow(RangeError);
  });
});
