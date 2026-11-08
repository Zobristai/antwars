import { describe, expect, it } from "vitest";
import type { ObserveEvent } from "../../src/mcp/game.js";
import { currentEvent, publicEvent } from "../../src/mcp/replies.js";

/** Pins how observe replies redact agent-visible events at the MCP boundary. */
const hatch: ObserveEvent = { type: "hatch", tick: 1, tileX: 1, tileY: 1, antId: 7, colony: 0, caste: "soldier" };
const fight: ObserveEvent = { type: "fight", tick: 1, tileX: 1, tileY: 1, antId: 7, targetId: 8, colony: 0 };
const death: ObserveEvent = { type: "death", tick: 1, tileX: 1, tileY: 1, antId: 7, colony: 0 };
const founded: ObserveEvent = { type: "queen_founded", tick: 1, tileX: 1, tileY: 1, colony: 0, queenId: 3, foodCost: 5 };
const lost: ObserveEvent = { type: "queen_lost", tick: 1, tileX: 1, tileY: 1, colony: 0, queenId: 3 };
const replaced: ObserveEvent = { type: "squad_replaced", tick: 1, agentId: "a", colony: 0 };
const markAny: ObserveEvent = { type: "mark_laid", tick: 1, tileX: 1, tileY: 1, markId: 4, agentId: "a", colony: 0, words: [], verb: "PATROL", count: 3, caste: "any" };
const markSoldier: ObserveEvent = { ...markAny, caste: "soldier" };
const availability = { claimedAnts: 1, freeAntsNow: 2 };
const acceptedAny: ObserveEvent = { type: "count_mark_accepted", tick: 1, tileX: 1, tileY: 1, markId: 4, agentId: "a", colony: 0,
  verb: "PATROL", count: 3, caste: "any", availability, message: "2 free ants now" };
const acceptedWorker: ObserveEvent = { ...acceptedAny, caste: "worker" };

describe("observe event redaction", () => {
  it("passes kinds without caste restriction through unchanged in both modes", () => {
    for (const event of [hatch, fight, death, founded, lost, replaced]) {
      expect(publicEvent(event)).toBe(event);
      expect(currentEvent(event, 5)).toBe(event);
    }
  });

  it("drops a non-worker/soldier caste from mark_laid in both modes", () => {
    const { caste: _caste, ...withoutCaste } = markAny;
    expect(publicEvent(markAny)).toEqual(withoutCaste);
    expect(currentEvent(markAny, 5)).toEqual(withoutCaste);
    expect(publicEvent(markSoldier)).toEqual(markSoldier);
    expect(currentEvent(markSoldier, 5)).toEqual(markSoldier);
  });

  it("drops a non-worker/soldier caste from count_mark_accepted in history", () => {
    const { caste: _caste, ...withoutCaste } = acceptedAny;
    expect(publicEvent(acceptedAny)).toEqual(withoutCaste);
    expect(publicEvent(acceptedWorker)).toEqual(acceptedWorker);
  });

  it("compacts a current count_mark_accepted to a notice pointing at its history index", () => {
    const { caste: _caste, message: _message, availability: _availability, ...notice } = acceptedAny;
    expect(currentEvent(acceptedAny, 5)).toEqual({ ...notice, detailsSince: 5 });
    const { message: _m, availability: _a, ...workerNotice } = acceptedWorker;
    expect(currentEvent(acceptedWorker, 9)).toEqual({ ...workerNotice, detailsSince: 9 });
  });
});
