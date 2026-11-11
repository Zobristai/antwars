// The team section's agent rows and the history-only panel, where the whole section is history with each
// move shown against its agent: the source and stylesheet contracts behind a small row per
// agent under the colony name, no agent table or column header, a full-width history with its arrival rows, the
// asterisk beside each model, and no new keyboard control. The rows' contents are covered in
// deck-model.test.ts; visual evidence comes from browser captures.
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
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at + selector.length + 2, CSS.indexOf("}", at));
}

describe("the team section's agent rows", () => {
  it("drops the agent table and its column header", () => {
    for (const gone of ["d1-roster", "d1-thead", "d1-th-", "Agent · Model", '"Latest"', '"Time"', "d1-latest", "d1-order"]) expect(PANE).not.toContain(gone);
    for (const gone of [".d1-roster", ".d1-thead", ".d1-th-", ".d1-row ", ".d1-latest", ".d1-order", ".d1-time "]) expect(CSS).not.toContain(gone);
  });

  it("places the agents under the colony name, before the economy, and the history below them", () => {
    expect(PANE).toContain('const rows = h(doc, "ol", "d1-agents");');
    expect(PANE).toContain("section.append(head, rows, hooks.economy[colony], line);");
    expect(PANE).toContain("setHidden(team.rows, n === 0);");
  });

  it("writes a row's badge, then its line in the Matches order: name, model, badges, asterisk, rating and result, and nothing of its order or calls", () => {
    const make = body("makeRow");
    expect(make).toContain("button.append(badge, who);");
    expect(make).toContain("who.append(titleBox, modelBox, tags, ast, elo, result);");
    // The rating is the figure alone: no "Rating" word on the row.
    expect(body("writeRow")).toContain('setText(node.elo, row.elo ?? "");');
    expect(PANE).not.toMatch(/setText\([^)]*`[^`]*Rating/);
    expect(CSS).not.toContain(".d1-quiet");
  });

  it("shows the rating as a cyan badge right after the level and Fast badges, none without a rating", () => {
    // Directly after the tags in the name line (after the name when the tags are hidden), never a far-right column.
    const make = body("makeRow");
    expect(make).toContain('const elo = h(doc, "span", "d1-tag d1-elo"), result = h(doc, "span", "d1-tag d1-outcome");');
    expect(make.indexOf("tags, ast, elo,")).toBeGreaterThan(make.indexOf("who.append(titleBox,"));
    expect(rule(".d1-agent")).toMatch(/grid-template-columns: 16px minmax\(0, 1fr\);/);
    // The same badge form as the level and Fast badges (it carries .d1-tag), in the site's cyan (the Matches page
    // Refresh button's cyan), not the tags' ink.
    const elo = rule(".d1-elo");
    expect(elo).toMatch(/color: var\(--aw-c1\);/);
    expect(elo).toMatch(/border-color: color-mix\(in srgb, var\(--aw-c1\) 45%, transparent\);/);
    expect(elo).not.toMatch(/var\(--aw-ink|#7ddc9a|font-size|padding|border-radius|font-weight/);
    expect(CSS.indexOf(".d1-elo {")).toBeGreaterThan(CSS.indexOf(".d1-tag {"));
    expect(CSS).not.toMatch(/\.d1-elo \{ font-size|, \.d1-elo \{/);
    // No rating, no badge; the row's accessible label is unchanged.
    const write = body("writeRow");
    expect(write).toContain("setHidden(node.elo, row.elo === null);");
    expect(write).toContain('setAttr(node.button, "aria-label", row.label);');
    expect(make).toContain('for (const child of button.children) child.setAttribute("aria-hidden", "true");');
  });

  it("keeps the row's existing behaviour: pointing or focus lights its squad and order tile, choosing opens its card", () => {
    const make = body("makeRow");
    expect(make).toContain('listen(button, "pointerenter", point);');
    expect(make).toContain('listen(button, "focus", () => { point();');
    expect(make).toContain('listen(button, "click", () => { focusCard = true; actions.select(null); actions.selectAgent(index); });');
  });

  it("puts the asterisk beside each self-reported model, the same explanation on a pointer or a tap, and no keyboard stop", () => {
    const make = body("makeRow");
    expect(make).toContain('const ast = h(doc, "span", "d1-ast-mark", "*");');
    expect(make).toContain('listen(ast, "pointerenter", () => showTip(ast));');
    expect(make).toContain('listen(ast, "click", e => { e.stopPropagation(); showTip(ast); });');
    expect(make).not.toMatch(/tabIndex|tabindex|"button", "d1-ast/);
    expect(body("writeRow")).toContain("setHidden(node.ast, !row.asterisk);");
    // The tip's default lines are the asterisk's explanation, unchanged.
    expect(PANE).toContain("const showTip = (target: Element, lines: readonly string[] = [D1_COPY.selfReported]) =>");
  });

  it("adds no keyboard-only control: the two Escape handlers are the only key listeners", () => {
    expect(PANE.match(/"keydown"/g)).toHaveLength(2);
  });

  it("keeps the agents in view while a card is open: only the history gives way", () => {
    expect(CSS).toContain(".d1-team.is-picked > .d1-timeline { display: none; }");
    expect(CSS).not.toMatch(/is-picked > :is\(/);
  });
});

describe("the history-only panel", () => {
  it("writes each history row against its acting agent, its status at the right", () => {
    const write = body("writeHistoryRow");
    expect(write).toContain("if (row.member) setMarkup(who, row.member.badge);");
    expect(write).toContain('parts.push(h(doc, "span", "d1-log-refused", D1_COPY.refused));');
    expect(rule(".d1-tl-entry.d1-log")).toMatch(/minmax\(0, 1fr\) auto/);
    expect(rule(".d1-log-refused")).toMatch(/justify-self: end/);
  });

  it("gives an arrival row no time, its lead before the order and its newest mark after it, its badge in line with every row's", () => {
    const write = body("writeHistoryRow");
    expect(write).toContain('if (row.arrival) what.append(h(doc, "span", "d1-log-lead", D1_COPY.onArrival));');
    expect(CSS).not.toMatch(/is-arrival \{[^}]*grid-template-columns/);
    expect(write).toContain("if (row.mark) {");
    expect(PANE).toContain("${row.arrival}|${row.mark?.verb ?? \"\"}|${row.mark?.text ?? \"\"}|");
  });

  it("holds the arrival across frames and gives each history its seed, written again only when the seed changes", () => {
    expect(PANE).toContain("arrived = arrivalOf(arrived, frame);");
    expect(PANE).toContain("const seed = arrivalRows(arrived, view.mode);");
    expect(PANE).toContain("seed !== lastSeed");
    expect(PANE).toContain("writeHistory(colony, gameHistory(frame, colony, seed))");
  });

  it("writes the model's own level and tier badges after it, never its provider/model key", () => {
    // The model line is the display name plus the level and tier badges.
    const make = body("makeRow");
    expect(make).toContain('const modelTags = h(doc, "span", "d1-tags");');
    expect(make).toContain("modelBox.append(model, modelTags);");
    expect(body("writeRow")).toContain('node.modelTags.replaceChildren(...row.modelBadges.map(text => h(doc, "span", "d1-tag", text)));');
    expect(PANE).toContain("cardTitle.append(cardName, cardModel, cardTags, cardAst, cardAstSr);");
  });
});
