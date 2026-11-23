import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIT_TARGETS, fitProblems, nameTapPoints, recordingPositionMs, type TextFit } from "../../../web/capture/match-label-fit.ts";

const deck = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
const ui = readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8");
const phone = deck.slice(deck.indexOf("@media (max-width: 34.9375em)"));
const fit: TextFit = { text: "Back to live", target: true, lines: 1, clipped: false, outside: false };

describe("match label fit", () => {
  it("checks both ends of the name, including text crossing the old half-plate boundary", () => {
    const points = nameTapPoints({ x: 184, y: 60, width: 180, height: 24 });
    expect(points).toEqual([{ edge: "left", x: 185, y: 72 }, { edge: "right", x: 363, y: 72 }]);
    expect(points[0]!.x).toBeLessThan(195);
    expect(() => nameTapPoints({ x: 0, y: 0, width: 0, height: 24 })).toThrow();
  });
  it("enables name and chevron hit targets only on the classic stacked phone plate", () => {
    const rule = '.d2-hud[data-layout="narrow"][data-plate="stacked"] .d2-plate:not(.is-quad) .d2-name { pointer-events: auto; cursor: pointer; }';
    const boundary = ui.indexOf("@media (max-width: 559px)");
    expect(ui.slice(0, boundary)).not.toContain(rule);
    expect(ui.slice(boundary)).toContain(rule);
  });
  it("seeks both complete recordings and mid-match excerpts by their own time origin", () => {
    expect(recordingPositionMs(1002, 0, 10)).toBe(100200);
    expect(recordingPositionMs(1002, 980, 10)).toBe(2200);
    expect(recordingPositionMs(4800, 4500, 20)).toBe(15000);
    expect(() => recordingPositionMs(1, 2, 10)).toThrow();
    expect(() => recordingPositionMs(2, 1, 0)).toThrow();
  });
  it("reports wrapped, clipped and off-screen targets rather than treating a screenshot as proof", () => {
    expect(fitProblems([fit])).toEqual([]);
    for (const bad of [{ lines: 2 }, { clipped: true }, { outside: true }]) {
      expect(fitProblems([{ ...fit, ...bad }])).toHaveLength(1);
    }
    expect(fitProblems([{ ...fit, target: false, lines: 2 }])).toEqual([]);
  });
  it("measures the labels in both renderers", () => {
    for (const target of [".d1-glabel", ".d1-back", ".d1-name", ".d1-cap-what", ".d1-cap-who", ".d2-name-text", ".d2-slabel", ".d2-back-text", ".d2-toast-what", ".d2-toast-who"]) expect(FIT_TARGETS).toContain(target);
  });
  // Structural guards, not visual proof: the companion browser diagnostic measures actual rendered text.
  it("does not force the territory heading into a wrapping 92px box", () => {
    const hold = deck.match(/\.d1-hold > \.d1-glabel \{([^}]+)\}/)?.[1];
    expect(hold).toBeDefined();
    expect(hold).not.toMatch(/max-width|white-space: normal/);
    expect(deck).toMatch(/\.d1-glabel \{[^}]+white-space: nowrap/);
  });
  it("keeps Back to live whole only in the phone override", () => {
    expect(phone).toContain(".d1-back { display: inline-block; white-space: nowrap; }");
    expect(deck.slice(0, deck.indexOf("@media (max-width: 34.9375em)"))).not.toContain(".d1-back { display: inline-block");
  });
  it("allocates a caption row only when an event exists, preserving the replay row", () => {
    expect(phone).toContain('.d1-frame:has(.d1-caption:not([data-kind="none"]))');
    expect(phone).toContain(':has(.d1-transport:not([hidden])) { --d1-lane: calc(var(--d1-tap) * 3 + 24px); }');
    expect(phone).toContain('.d1-caption:not([data-kind="none"]) { flex: 1 0 100%; }');
  });
  it("adds room for the two colony names only on narrow stacked phone plates, not four-colony plates", () => {
    const narrow = ui.slice(ui.indexOf("@media (max-width: 559px)"));
    expect(narrow).toContain('[data-layout="narrow"][data-plate="stacked"]:has(.d2-plate:not(.is-quad)) { --d2-plate-h: 282px; }');
    expect(narrow).toContain('grid-template-areas: "clock clock" "c0 c0" "c1 c1"; height: 72px;');
    expect(narrow).toContain("grid-template-rows: 72px repeat(4, 44px)");
  });
});
