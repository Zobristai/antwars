// Asynchronous mask loading for the watch view's one icon set, and the exact fallback markup.
import { describe, expect, it, vi } from "vitest";
import { IconMasks } from "../../../web/src/icons/masks.ts";
import { glyphIconKey, iconKeys, iconSet } from "../../../web/src/icons/set.ts";
import { domIcon } from "../../../web/src/icons/dom.ts";

describe("icon masks", () => {
  it("keeps the 30 semantic keys, with the agent glyphs last in agent order", () => {
    expect(iconKeys).toHaveLength(30);
    expect(new Set(iconKeys).size).toBe(30);
    expect(Array.from({ length: 8 }, (_, i) => glyphIconKey(i))).toEqual(iconKeys.slice(-8));
  });
  it("loads the shipped set's fill then second mask for every key, once", async () => {
    const load = vi.fn(async (src: string) => src);
    const state = new IconMasks(iconSet, load);
    await Promise.all([state.start(), state.start()]);
    for (const key of iconKeys) {
      expect(state.isReady(key)).toBe(true);
      expect(state.get(key)).toEqual({ src: iconSet[key]!.src, texture: iconSet[key]!.src, second: { src: iconSet[key]!.second!.src, texture: iconSet[key]!.second!.src } });
    }
    expect(load).toHaveBeenCalledTimes(2 * iconKeys.length);
    await state.start(); expect(load).toHaveBeenCalledTimes(2 * iconKeys.length);
  });
  it("returns the vector's bytes unchanged", () => {
    const svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 1h2"/></svg>';
    expect(domIcon("close", svg)).toBe(svg);
  });
  it("loads nothing before it is started", () => {
    const load = vi.fn(async () => "texture");
    const state = new IconMasks({ crown: { src: "crown.png" } }, load);
    expect(state.get("crown")).toBeUndefined(); expect(state.isReady("crown")).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
  it("loads every semantic key, notifying only when the mask can replace its vector", async () => {
    const set = Object.fromEntries(iconKeys.map(key => [key, { src: `${key}.png` }]));
    const state = new IconMasks(set, async src => src);
    const changed = vi.fn(); const unsubscribe = state.subscribe(changed);
    await state.start();
    for (const key of iconKeys) expect(state.isReady(key)).toBe(true);
    for (const key of iconKeys) expect(state.get(key)).toEqual({ src: `${key}.png`, texture: `${key}.png` });
    expect(changed).toHaveBeenCalledTimes(iconKeys.length); expect(state.version).toBe(iconKeys.length); unsubscribe();
  });
  it("keeps the vector while pending and falls back on failure", async () => {
    let resolve!: (texture: string) => void;
    const load = vi.fn((src: string) => src === "broken.png" ? Promise.reject(new Error("missing")) : new Promise<string>(r => { resolve = r; }));
    const state = new IconMasks({ crown: { src: "pending.png" }, close: { src: "broken.png" } }, load);
    const pending = state.start();
    expect(state.get("crown")).toBeUndefined(); expect(state.get("close")).toBeUndefined();
    expect(state.isReady("crown")).toBe(false); expect(state.isReady("close")).toBe(false);
    resolve("crown texture"); await pending;
    expect(state.get("crown")).toEqual({ src: "pending.png", texture: "crown texture" }); expect(state.get("close")).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("exposes the second mask beside the first without delaying the ready fill", async () => {
    let finishSecond!: (value: string) => void;
    const load = vi.fn((src: string) => src === "shade.png"
      ? new Promise<string>(resolve => { finishSecond = resolve; }) : Promise.resolve(src));
    const state = new IconMasks({ crown: { src: "fill.png", second: { src: "shade.png" } } }, load);
    const pending = state.start();
    await Promise.resolve();
    expect(state.get("crown")).toEqual({ src: "fill.png", texture: "fill.png" });
    expect(state.isReady("crown")).toBe(false);
    finishSecond("shade texture"); await pending;
    expect(state.get("crown")).toEqual({ src: "fill.png", texture: "fill.png", second: { src: "shade.png", texture: "shade texture" } });
    expect(state.isReady("crown")).toBe(true);
    expect(load.mock.calls.map(([src]) => src)).toEqual(["fill.png", "shade.png"]);
  });
  it("keeps the ready first mask when its optional second mask fails", async () => {
    const state = new IconMasks({ crown: { src: "fill.png", second: { src: "missing.png" } } },
      async src => { if (src === "missing.png") throw new Error("missing"); return src; });
    await state.start();
    expect(state.get("crown")).toEqual({ src: "fill.png", texture: "fill.png" });
    expect(state.isReady("crown")).toBe(false);
  });
  it("never publishes an orphan second mask when the first fails", async () => {
    const load = vi.fn(async () => { throw new Error("missing fill"); });
    const state = new IconMasks({ crown: { src: "missing.png", second: { src: "shade.png" } } }, load);
    await state.start();
    expect(state.get("crown")).toBeUndefined(); expect(load).toHaveBeenCalledTimes(1);
  });
});
