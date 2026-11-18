import { describe, expect, it } from "vitest";
import { mountDeck } from "../../../web/src/ui/deck/deck.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { scoreFrame } from "./score-band-frame.ts";

describe("Score Band colony comparison", () => {
  for (const count of [2, 4]) it(`shows ants alongside kills and territory for ${count} colonies`, () => {
    const deck = mountDeck(dom().doc), f = scoreFrame(count);
    f.ensure(count); f.count = count;
    for (let i = 0; i < count; i++) { f.colony[i] = i; f.caste[i] = i === 0 ? 0 : 1; f.alpha[i] = 1; }
    deck.update(f);
    const gauges = (deck.score as unknown as ElementPort).byClass("sb-gauge");
    expect(gauges.map(g => g.byClass("d1-ml")[0]!.textContent)).toEqual(["Kills", "Territory", "Ants"]);
    const ants = gauges[2]!;
    expect(ants.byClass("sb-figure").filter(n => !n.hidden).map(n => n.byClass("sb-value")[0]!.textContent)).toEqual(Array(count).fill("1"));
    expect(ants.byClass("sb-lead").every(n => n.hidden)).toBe(true);
    for (let c = 0; c < count; c++) {
      const economy = deck.economy[c] as unknown as ElementPort;
      expect(economy.byClass("sb-workers")[0]!.textContent).toBe(`Workers${c === 0 ? 1 : 0}`);
      expect(economy.byClass("sb-soldiers")[0]!.textContent).toBe(`Soldiers${c === 0 ? 0 : 1}`);
      expect(economy.byClass("sb-ants")[0]!.textContent).toBe("Ants1/512");
    }
  });
});
