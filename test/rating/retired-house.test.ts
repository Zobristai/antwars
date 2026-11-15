import { describe, expect, it } from "vitest";
import { HOUSE_LABELS, RETIRED_HOUSE_HANDLES, isRetiredHouse } from "../../src/rating/houseLabels.ts";

describe("retired house handles", () => {
  it("lists claude-fable-5-1, and every retired handle keeps its House table row", () => {
    expect([...RETIRED_HOUSE_HANDLES]).toEqual(["claude-fable-5-1"]);
    for (const handle of RETIRED_HOUSE_HANDLES) expect(Object.hasOwn(HOUSE_LABELS, handle), handle).toBe(true);
  });

  it("reads a bare handle or an antwars/ name, case-insensitively, and nothing else", () => {
    for (const name of ["claude-fable-5-1", "antwars/claude-fable-5-1", "ANTWARS/Claude-Fable-5-1", "Claude-Fable-5-1"]) {
      expect(isRetiredHouse(name), name).toBe(true);
    }
    for (const name of ["claude-fable-5-2", "antwars/claude-fable-5-2", "kite/claude-fable-5-1", "antwars/claude-fable-5-1-max", "antwars", ""]) {
      expect(isRetiredHouse(name), name).toBe(false);
    }
  });

  it("marks no other House table handle retired", () => {
    const retired = Object.keys(HOUSE_LABELS).filter(handle => isRetiredHouse(`antwars/${handle}`));
    expect(retired).toEqual(["claude-fable-5-1"]);
  });
});
