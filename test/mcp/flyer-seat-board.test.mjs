// What a seat prints of flyers: the real observe reply rendered by the seat harness's readable view
// (packages/antwars-seat, what `antwars-seat observe` and `board` print without --raw). The seat client is
// plain JavaScript, so it is tested from this .mjs file.
import { afterEach, describe, expect, it } from "vitest";
import { renderView } from "../../packages/antwars-seat/lib/board.mjs";
import { expandCells } from "../../src/sim/view.ts";
import { SEAT_MODES, placeFlyer, scoutAt, seatFlyers, seenLand } from "./flyer-seat.ts";

let seat;
afterEach(async () => { await seat?.h.close(); seat = undefined; });

const distance = (a, b) => Math.hypot(a.tileX - b.tileX, a.tileY - b.tileY);

/** The ant's entry in the printed cell rows: id, caste letter, HP and anything after, up to the next ant or tile. */
function printedAnt(text, antId) {
  return new RegExp(`[:,]${antId}([A-Za-z][^,\\s]*)`).exec(text.split("\n").filter(line => /^y\d+: /.test(line)).join("\n"))?.[1];
}

describe.each(SEAT_MODES)("the seat's readable view of flyers, $label seat", ({ mode }) => {
  it("prints a sighted enemy flyer as an enemy flyer in each state, and its own flyer as its own", async () => {
    let enemyFlyer = -1, ownFlyer = -1, enemyHome = { tileX: 0, tileY: 0 };
    seat = await seatFlyers(mode, state => {
      [enemyHome] = seenLand(state, 1, 1);
      enemyFlyer = placeFlyer(state, 1, enemyHome).id;
      ownFlyer = placeFlyer(state, 0, seenLand(state, 0, 1)[0]).id;
    });
    const s = seat, sight = s.state().config.sightTiles, hp = s.state().config.flyers.hp / 1000;
    const enemyLand = seenLand(s.state(), 1, 400);
    const hover = enemyLand.find(t => distance(t, enemyHome) >= sight / 2 && distance(t, enemyHome) <= sight - 2);
    const middle = { tileX: (hover.tileX + enemyHome.tileX) / 2, tileY: (hover.tileY + enemyHome.tileY) / 2 };
    const scout = enemyLand.toSorted((a, b) => distance(a, middle) - distance(b, middle))[0];
    /** One observe by colony 0 with a fresh scout in sight of the flight; what the reply carries and what the seat prints. */
    const sighting = async () => {
      scoutAt(s.state(), 0, scout);
      const reply = await s.agent.call("observe");
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.data.view.cellsMore, "one cell page").toBe(false);
      const shown = expandCells(reply.data.view.cells).flatMap(cell => cell.ants).find(ant => ant.antId === enemyFlyer);
      return { shown, text: renderView(reply.data) };
    };

    const printed = [];
    const first = await sighting();
    expect(printedAnt(first.text, ownFlyer)).toBe(`f${hp}(grounded)`);
    printed.push(first);
    const laid = await s.enemy.call("count_mark", { verb: "GATHER", count: 1, caste: "flyer", tileX: hover.tileX, tileY: hover.tileY });
    expect(laid.isError, laid.text).toBe(false);
    while (printed.filter(r => r.shown?.flyer === "hovering").length < 2) {
      expect(printed.length, "reading limit").toBeLessThan(200);
      printed.push(await sighting());
    }
    for (const r of printed) {
      expect(r.shown).toBeDefined();
      expect(printedAnt(r.text, enemyFlyer)).toBe(`F${hp}(${r.shown.flyer})`);
      expect(r.text).toContain("f=flyer");
    }
    expect(new Set(printed.map(r => r.shown.flyer))).toEqual(new Set(["grounded", "flying", "hovering"]));
  }, 120_000);
});
