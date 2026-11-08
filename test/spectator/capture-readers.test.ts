// browser.ts's readers for boardArea() and frameTimes(): the client's own member where the build has it, else the
// 9c689f1 HUD's rule (ui/deck/hud.ts 230-235, ui/hud.ts 703-708) and the .aw-frametimes readout.
import type { BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCaptureReaders } from "../../web/capture/browser.ts";

type Box = { left: number; top: number; right: number; bottom: number };
const rect = (b: Box) => ({ ...b, width: b.right - b.left, height: b.bottom - b.top });

async function readers(api: object | undefined, elements: Record<string, Box | string>) {
  const win: Record<string, unknown> = { __antwar: api, innerWidth: 800, innerHeight: 600 };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { querySelector: (s: string) => {
    const e = elements[s];
    return e === undefined ? null : typeof e === "string" ? { textContent: e } : { getBoundingClientRect: () => rect(e) };
  } });
  await addCaptureReaders({ addInitScript: async (script: () => void) => script() } as unknown as BrowserContext);
  return win.__antwarCapture as Window["__antwarCapture"];
}

afterEach(() => vi.unstubAllGlobals());

describe("capture readers", () => {
  it("use the build's own members when it has them", async () => {
    const r = await readers({ boardArea: () => ({ x0: 1, y0: 2, x1: 3, y1: 4 }), frameTimes: () => "frame 4.0 ms" },
      { ".d1-window": { left: 0, top: 0, right: 9, bottom: 9 }, ".aw-frametimes": "old" });
    expect(r.boardArea()).toEqual({ x0: 1, y0: 2, x1: 3, y1: 4 });
    expect(r.frameTimes()).toBe("frame 4.0 ms");
  });

  it("read an older 3D build's deck window below its legend", async () => {
    const r = await readers({}, { ".d1-window": { left: 12, top: 100, right: 788, bottom: 500 }, ".d1-legend": { left: 0, top: 90, right: 800, bottom: 140 } });
    expect(r.boardArea()).toEqual({ x0: 12, y0: 140, x1: 788, y1: 500 });
  });

  it("read an older 2D or no-board build's window less its lane", async () => {
    const r = await readers({}, { ".d2-window": { left: 0, top: 60, right: 800, bottom: 560 }, ".d2-lane": { left: 0, top: 520, right: 800, bottom: 560 } });
    expect(r.boardArea()).toEqual({ x0: 0, y0: 60, x1: 800, y1: 520 });
  });

  it("fall back to the whole screen as the HUDs do", async () => {
    const collapsed = { left: 0, top: 0, right: 800, bottom: 0 };
    expect((await readers({}, { ".d1-window": collapsed, ".d1-legend": collapsed })).boardArea()).toEqual({ x0: 0, y0: 0, x1: 800, y1: 600 });
    expect((await readers({}, { ".d2-window": collapsed, ".d2-lane": collapsed })).boardArea()).toEqual({ x0: 0, y0: 0, x1: 800, y1: 600 });
    expect((await readers({}, {})).boardArea()).toEqual({ x0: 0, y0: 0, x1: 800, y1: 600 });
  });

  it("read an older build's frame-time readout", async () => {
    expect((await readers({}, { ".aw-frametimes": "frame 3.1 ms" })).frameTimes()).toBe("frame 3.1 ms");
    expect((await readers({}, {})).frameTimes()).toBeNull();
  });

  it("fail without window.__antwar rather than read the page", async () => {
    const r = await readers(undefined, { ".d2-window": { left: 0, top: 0, right: 9, bottom: 9 } });
    expect(() => r.boardArea()).toThrow(TypeError);
    expect(() => r.frameTimes()).toThrow(TypeError);
  });
});
