import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boardMode, fallbackUrl, runBoard } from "../../web/src/webgl2.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("footer control wiring", () => {
  it("removes only the 3D view toggle, not the opening pose, framing or zoom", () => {
    const source = read("web/src/board3d/main3d.ts");
    expect(source).not.toContain("aw-view-toggle");
    expect(source).not.toContain("overlays.addBoardControl(");
    expect(source).toContain('showView("tilted")');
    expect(source).toContain("wholeBoardRef = () => showView(viewName)");
    expect(source).toContain("zoomAt: (f)");
  });

  it("retains the default 3D and automatic 2D fallback without relying on a removed view control", async () => {
    const starts: string[] = [];
    expect(boardMode(new URLSearchParams())).toBe("3d");
    await runBoard("3d", {
      probe2: () => false,
      start3d: async () => { starts.push("3d"); },
      start2d: async () => { starts.push("2d"); },
      webglSupported: () => true,
      show: () => { throw new Error("No warning for automatic fallback"); },
      log: () => { throw new Error("No error for automatic fallback"); },
      reject: () => { throw new Error("Fallback must start"); },
      fallback2d: () => { throw new Error("No reload needed without WebGL2"); },
    });
    expect(starts).toEqual(["2d"]);
    const url = new URL(fallbackUrl("https://example.test/?replay=fixture&capture=1#frame"));
    expect(url.searchParams.get("board")).toBe("2d");
    expect(url.searchParams.get("replay")).toBe("fixture");
    expect(url.hash).toBe("#frame");
  });
});
