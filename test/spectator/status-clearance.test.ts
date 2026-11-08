import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modeCopy } from "../../web/src/replay.ts";

const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
const portrait = html.slice(html.indexOf("phones, portrait"), html.indexOf("phones, landscape"));

describe("status clearance in the shared spectator frame", () => {
  it("keeps the live and replay disclosures' full wording", () => {
    // The no-agent label: a label, no commentary.
    expect(modeCopy("live", 0, false, "/").detail).toBe("No agents · 60 s behind the match");
    expect(modeCopy("live", 2, false, "/", null, true).detail).toBe("300 s behind the match");
    expect(modeCopy("replay", 4, false, "/")).toMatchObject({
      // Deleted the bundled recording and its "older rules" label: a replay names no rules.
      label: "RECORDING · not live · 4 agents", link: { text: "Back to live", href: "/?watch=1" },
    });
  });

  it("keeps the touch-control floor on phones", () => {
    expect(portrait).toContain("--aw-tap: 44px;");
  });
});
