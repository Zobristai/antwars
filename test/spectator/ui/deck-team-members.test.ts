// The team head's member icons: the source and stylesheet contracts behind one icon per member in place of
// the "N agent(s)" count, its tip on pointer and tap, and no new keyboard stop. The model's lines
// are covered in deck-model.test.ts; visual evidence comes from browser captures, never these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PANE = readFileSync(new URL("../../../web/src/ui/deck/pane.ts", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");

/** The source of the function `name` as an arrow constant, up to the next blank line. */
function body(name: string): string {
  const at = PANE.indexOf(`const ${name} = `);
  expect(at, name).toBeGreaterThanOrEqual(0);
  return PANE.slice(at, PANE.indexOf("\n\n", at));
}

describe("the team head's member icons", () => {
  it("drops the agent count from the head", () => {
    expect(PANE).not.toContain("d1-team-count");
    expect(CSS).not.toContain(".d1-team-count");
    expect(PANE).toContain('head.append(name, members, player)');
  });

  it("writes one labelled image per member, which the keyboard never stops on", () => {
    const write = body("writeMembers");
    expect(write).toContain('h(doc, "span", "d1-member")');
    expect(write).toContain('setAttribute("role", "img")');
    expect(write).toContain('setAttribute("aria-label", m.label)');
    expect(write).not.toMatch(/tabIndex|tabindex|"button"|focus/);
    expect(PANE).toContain("writeMembers(team, g?.members ?? [])");
  });

  it("shows the member's tip on a pointer over it and on a tap, and hides it as a pointer leaves", () => {
    const write = body("writeMembers");
    expect(write).toContain('for (const type of ["pointerenter", "click"]) icon.addEventListener(type, () => showTip(icon, m.lines))');
    expect(write).toContain('icon.addEventListener("pointerleave", leaveTip)');
    // A tap keeps the tip until the next tap elsewhere; the asterisk's tip is the default and unchanged.
    expect(PANE).toContain('if (p.pointerType === "touch") return;');
    expect(PANE).toContain("const showTip = (target: Element, lines: readonly string[] = [D1_COPY.selfReported]) =>");
  });

  it("keeps a member's tip through the roster's refresh: only an asterisk's explanation goes with its asterisk", () => {
    expect(PANE).toContain("if (!row.asterisk && tipFor === node.ast) hideTip();");
    expect(PANE).not.toContain("tipFor !== null) hideTip();");
  });

  it("styles the icons in the head and the tip's lines one to a line", () => {
    expect(CSS).toMatch(/\.d1-team-members \{[^}]*display: inline-flex;[^}]*flex-wrap: wrap;/);
    expect(CSS).toMatch(/\.d1-member \{[^}]*cursor: help;/);
    expect(CSS).toMatch(/\.d1-tip-line \{[^}]*display: block;/);
  });
});
