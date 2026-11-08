import { describe, expect, it, vi } from "vitest";
import { assertSpectatorPlacement, measureSpectatorPlacement, placementIntersection, type PlacementSnapshot } from "../../web/capture/spectator-placement.ts";

function clear(): PlacementSnapshot {
  return {
    viewport: { width: 800, height: 600 },
    board: { name: "board", rect: { x: 0, y: 100, width: 500, height: 400 } },
    statusLine: { name: "status", rect: { x: 510, y: 100, width: 280, height: 30 } },
    controls: [{ name: "Bring your agent", rect: { x: 600, y: 0, width: 150, height: 44 } }],
  };
}

describe("ordinary spectator placement geometry", () => {
  it("rejects descendants hidden by a closed details ancestor before trusting their rectangles", async () => {
    class ClosedDetails {
      open = false;
      children: Element[] = [];
      parentElement = null;
    }
    const hidden = { parentElement: new ClosedDetails() };
    vi.stubGlobal("HTMLDetailsElement", ClosedDetails);
    vi.stubGlobal("document", { querySelectorAll: () => [hidden] });
    const page = {
      evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => callback(arg),
    } as unknown as Parameters<typeof measureSpectatorPlacement>[0];
    try {
      await expect(measureSpectatorPlacement(page)).rejects.toThrow("Expected one visible .d2-status, .d1-legend, found 0");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("allows edge contact but rejects any positive intersection without rounding", () => {
    const a = { x: 0, y: 0, width: 44, height: 44 };
    expect(placementIntersection(a, { ...a, x: 44 })).toBeNull();
    expect(placementIntersection(a, { ...a, x: 43.999 })?.area).toBeGreaterThan(0);
    expect(placementIntersection(a, a)).toEqual({ width: 44, height: 44, area: 1936 });
  });
  it("accepts visible controls placed clear of protected regions", () => {
    expect(() => assertSpectatorPlacement(clear())).not.toThrow();
  });
  it("rejects the status line on the board", () => {
    const sample = clear(); sample.statusLine.rect = { x: 20, y: 150, width: 100, height: 44 };
    expect(() => assertSpectatorPlacement(sample)).toThrow("intersects board");
  });


  it("refuses offscreen or zero-sized targets rather than treating them as clear", () => {
    const sample = clear(); sample.statusLine.rect.x = 801;
    expect(() => assertSpectatorPlacement(sample)).toThrow("outside the viewport");
    sample.statusLine.rect.width = 0;
    expect(() => assertSpectatorPlacement(sample)).toThrow("Invalid placement rectangle");
  });

  it("protects other 44px controls from the status line", () => {
    const sample = clear();
    sample.controls.push({ name: "another control", rect: { ...sample.statusLine.rect } });
    expect(() => assertSpectatorPlacement(sample)).toThrow("intersects another control");
  });

  it("refuses non-finite inputs", () => {
    const sample = clear(); sample.statusLine.rect.x = NaN;
    expect(() => assertSpectatorPlacement(sample)).toThrow("Invalid placement rectangle");
  });
});
