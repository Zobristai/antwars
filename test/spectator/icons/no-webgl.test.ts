// Execute the real no-board entry's icon initialization without a Pixi renderer.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";

describe("no-WebGL watch HUD icon initialization", () => {
  it.each(["?watch=1", "?watch=1&direction=1"])("mounts and loads the masks for %s before data or a renderer", async search => {
    const source = readFileSync("web/src/main.ts", "utf8");
    const start = source.indexOf("async function startWithoutBoard(");
    const end = source.indexOf("\nasync function start()", start);
    const entry = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
    const doc = {}, clock = {}, rejectReady = vi.fn();
    const mount = vi.fn(), load = vi.fn(async () => {});
    const openSource = vi.fn(async () => null);
    // Returning no source bounds this test to startup. No Application, WebGL, renderer or fixture is supplied.
    const run = new Function("document", "location", "mountIconDom", "loadIcons", "createClock", "openSource", "rejectReady",
      `${entry}\nreturn startWithoutBoard(null);`);
    await run(doc, { search }, mount, load, () => clock, openSource, rejectReady);
    expect(mount).toHaveBeenCalledExactlyOnceWith(doc);
    expect(load).toHaveBeenCalledExactlyOnceWith();
    expect(openSource).toHaveBeenCalledWith(new URLSearchParams(search), clock, doc, rejectReady);
    expect(mount.mock.invocationCallOrder[0]).toBeLessThan(openSource.mock.invocationCallOrder[0]!);
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(openSource.mock.invocationCallOrder[0]!);
  });
});
