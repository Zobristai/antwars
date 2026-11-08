// The map in the deck's score: the stylesheet's and the mount's contracts
// for the Map row under Territory hold. The name itself is read by model.ts mapName (deck-model.test.ts); visual
// evidence comes from browser captures of the served build, never these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
const DECK = readFileSync(new URL("../../../web/src/ui/deck/deck.ts", import.meta.url), "utf8");

describe("the deck's map row", () => {
  it("sits under Territory hold, outside Win conditions, so it stays once the result takes their place", () => {
    expect(DECK).toContain("winGroup.append(h(doc, \"h3\", \"d1-kicker\", D1_COPY.winConditions), queensRow, holdRow);");
    expect(DECK).not.toMatch(/winGroup\.append\([^;]*mapRow/);
    expect(DECK).toMatch(/score\.append\(clockEl,[^;]*winGroup, mapRow\);/);
  });
  it("shows the stream's map name, and hides the row where the stream carries none", () => {
    expect(DECK).toContain("const map = mapName(frame);");
    expect(DECK).toContain("setText(mapNameEl, map ?? \"\");");
    expect(DECK).toContain("setHidden(mapRow, map === null);");
    expect(DECK).toContain("setHidden(mapRow, true);");
  });
  it("is styled as a row on the score's label axis, and the hidden rule still wins", () => {
    expect(CSS).toMatch(/\.d1-map \{[^}]*justify-content: center;/);
    expect(CSS).toMatch(/\.d1-map-name \{[^}]*text-overflow: ellipsis;/);
    expect(CSS).toContain(".d1 [hidden] { display: none !important; }");
  });
});
