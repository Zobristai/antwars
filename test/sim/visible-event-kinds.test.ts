import { describe, expect, it } from "vitest";
import type { SimEvent, VisibleEvent } from "../../src/sim/types.js";
import { VISIBLE_EVENT_KINDS, isVisibleEvent, type VisibleEventKinds } from "../../src/sim/view.js";

/** Every SimEvent kind, checked exhaustive by the compiler, with whether
 * recordSightings queues it into an agent's events today. */
const SIGHTED_BY_KIND = {
  hatch: true,
  fight: true,
  death: true,
  mark_laid: true,
  queen_founded: true,
  queen_lost: true,
  // Deliberately not sighted: it is pushed straight onto the placing agent's pendingEvents.
  count_mark_accepted: false,
  overrun_progress: false,
  queen_hp: false,
  match_end: false,
  agent_join: false,
  agent_call: false,
  order: false,
  squad_filled: false,
  squad_released: false,
} as const satisfies Record<SimEvent["type"], boolean>;

/* Compile-time tie. Vitest does not type-check: `npx tsc --noEmit`
 * (tsconfig includes test/) verifies these. The record must classify exactly
 * VisibleEvent's kinds; a kind added to VisibleEvent without an entry here is
 * a missing property, which is what the expected error below simulates. */
const _classified: VisibleEventKinds<VisibleEvent["type"]> = VISIBLE_EVENT_KINDS;
// @ts-expect-error queen_hp stands in for a kind added to VisibleEvent but not classified in VISIBLE_EVENT_KINDS.
const _unclassified: VisibleEventKinds<VisibleEvent["type"] | "queen_hp"> = VISIBLE_EVENT_KINDS;

describe("agent-visible event kinds", () => {
  it.each(Object.entries(SIGHTED_BY_KIND))("isVisibleEvent(%s) is %s", (type, sighted) => {
    // isVisibleEvent reads only the kind.
    expect(isVisibleEvent({ type, tick: 0 } as unknown as SimEvent)).toBe(sighted);
  });

  it("classifies exactly the VisibleEvent kinds, sighted ones matching isVisibleEvent", () => {
    expect(Object.keys(VISIBLE_EVENT_KINDS).sort()).toEqual(
      ["count_mark_accepted", "death", "fight", "hatch", "mark_laid", "queen_founded", "queen_lost"]);
    for (const [type, kind] of Object.entries(VISIBLE_EVENT_KINDS)) {
      expect(kind.sighted).toBe(SIGHTED_BY_KIND[type as keyof typeof SIGHTED_BY_KIND]);
    }
  });
});
