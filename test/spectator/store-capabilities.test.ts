import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { storeFeatureEnabled } from "../../web/src/store-capabilities.ts";

function documentWith(lobbies?: string, matches?: string): Pick<Document, "querySelector"> {
  return { querySelector: vi.fn((selector: string) => {
    const value = selector === 'meta[name="antwar-lobbies"]' ? lobbies : matches;
    return value === undefined ? null : { getAttribute: () => value };
  }) } as unknown as Pick<Document, "querySelector">;
}
afterEach(() => vi.unstubAllGlobals());

describe("synchronous store capability metadata", () => {
  it.each([undefined, "false", "", "1", "TRUE", "unavailable"])("never enables unavailable controls for %s", value => {
    const doc = documentWith(value, value);
    expect(storeFeatureEnabled(doc, "lobbies")).toBe(false);
    expect(storeFeatureEnabled(doc, "public-matches")).toBe(false);
  });
  it("enables each configured service independently without fetching or scheduling late work", () => {
    const request = vi.fn(() => { throw new Error("No discovery request allowed"); });
    vi.stubGlobal("fetch", request);
    const doc = documentWith("true", "true");
    expect(storeFeatureEnabled(doc, "lobbies")).toBe(true);
    expect(storeFeatureEnabled(doc, "public-matches")).toBe(true);
    expect(storeFeatureEnabled(documentWith("true", "false"), "lobbies")).toBe(true);
    expect(storeFeatureEnabled(documentWith("true", "false"), "public-matches")).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it("mounts neither the public match directory nor the lobby and key controls", () => {
    const source = readFileSync(new URL("../../web/src/source.ts", import.meta.url), "utf8");
    expect(source).not.toContain("mountMatchDirectory");
    expect(existsSync(new URL("../../web/src/lobby-controls.ts", import.meta.url))).toBe(false);
    const entry = readFileSync(new URL("../../web/src/leaderboard-page/entry.ts", import.meta.url), "utf8");
    expect(entry).not.toContain("lobby-controls");
  });
});
