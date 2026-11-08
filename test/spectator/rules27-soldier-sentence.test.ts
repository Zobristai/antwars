import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { renderRules, ruleSections } from "../../web/rules.ts";
import { playable } from "../playable.ts";

/** The /rules page's "Autonomous ants" sentence for a config. */
function autonomousLine(config: SimConfig): string {
  const section = ruleSections(config).find((s) => s.title === "Autonomous ants");
  expect(section?.lines).toHaveLength(1);
  return section!.lines[0]!;
}

const OPENING = "Free ants follow these defaults until a count mark claims them. While any active (not idle) agent of a colony is seated, its free ants act locally instead of following a house-bot plan.";
const CLOSING = "A colony with no active seat keeps the house bot. Agents still command their own squads.";

const FORBIDDEN = [/front/i, /queen defence/i, /split/i, /patch/i, /stays near its queen/i, /return/i, /home-side/i];

describe("/rules Autonomous ants soldier sentence", () => {
  const template: SimConfig = rulesConfig("redesign");
  const redesign = playable(template);
  const live = newMatchConfig(template);

  it("free soldiers hold within the defend radius of where they hatched or were released, apart from local fights", () => {
    // Grid scale 2 states the 3-tile reference radius in fine tiles, as the page's near-queen clause does.
    const scaled = autonomousLine(live);
    expect(scaled).toBe(`${OPENING} Every non-carrying free ant bites enemies within 2 tiles (incl. diagonals). Within 6 tiles of its queen it goes for enemies within that distance of her; otherwise a worker forages the nearest food its colony has seen and carries it home, and a soldier holds within 6 tiles of where it hatched or was released, apart from local fights. ${CLOSING}`);
    expect(autonomousLine(redesign)).toBe(scaled);
    for (const pattern of FORBIDDEN) expect(scaled).not.toMatch(pattern);
    // Without a front share the sentence is the same, never "stays near its queen".
    const noFront = autonomousLine(playable({ ...template, localAnts: { defendTiles: 3 } }));
    expect(noFront).toContain("and a soldier holds within 6 tiles of where it hatched or was released, apart from local fights.");
    expect(renderRules(live)).toContain("and a soldier holds within 6 tiles of where it hatched or was released, apart from local fights.");
  });
});
