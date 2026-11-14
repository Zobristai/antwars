// Readable observe view. The cell, territory and mark decoders are generated from the
// server's reference decoders (the harness is installed alone and cannot import src/):
// see codec.generated.mjs, scripts/generate-seat-codec.ts and test/codec.test.mjs.
import { expandCells, unpackMarks, unpackTerritory } from "./codec.generated.mjs";

export { expandCells, unpackMarks, unpackTerritory };

const MAX_ARRAY = 12;
const DROP_KEYS = new Set(["briefing", "territory", "rules"]);
// Shown in full in their own sections; never pass through shrink().
const VIEW_SECTIONS = new Set(["cells", "cellsTick", "cellsMore", "cellsCursor", "territory", "squad", "queens", "marks", "myMarks"]);

function shrink(value, depth = 0) {
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((item) => shrink(item, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…${value.length - MAX_ARRAY} more`] : head;
  }
  if (value && typeof value === "object" && depth < 6) {
    // Map terrain (view.terrain, nestSelection.terrain) is kept whole: every water and rock rectangle.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "terrain" ? v : shrink(v, depth + 1)]));
  }
  return value;
}

/** Milli-HP as HP, exact (at most 3 decimals). */
const hp = (milli) => String(milli / 1000);
const CASTE = { worker: "w", soldier: "s" };

/** With more than two colonies, each enemy ant and enemy queen ends @<colony>; two colonies print as before. */
const colonyTag = (colony, own, byColony) => (byColony && colony !== own ? `@${colony}` : "");

function antText(ant, own, byColony) {
  const letter = CASTE[ant.caste] ?? "a";
  return `${ant.antId}${ant.colony === own ? letter : letter.toUpperCase()}${hp(ant.hp)}${colonyTag(ant.colony, own, byColony)}`;
}

function tileText(cell, own, byColony) {
  let text = cell.food > 0 ? `f${cell.food}` : "";
  if (cell.queen !== undefined) text += `Q${cell.queen === own ? "own" : "enemy"}${cell.queenHp === undefined ? "" : hp(cell.queenHp)}${colonyTag(cell.queen, own, byColony)}`;
  if (cell.ants.length) text += `:${cell.ants.map((ant) => antText(ant, own, byColony)).join(",")}`;
  return text;
}

/** Cells by row, tiles by x; consecutive food-only tiles with equal food share one x-x2 run. byColony labels enemies by colony. */
export function cellLines(cells, own, byColony = false) {
  const rows = new Map();
  for (const cell of [...cells].sort((a, b) => a.tileY - b.tileY || a.tileX - b.tileX)) {
    const row = rows.get(cell.tileY) ?? [];
    const content = tileText(cell, own, byColony);
    const last = row.at(-1);
    const foodOnly = cell.queen === undefined && cell.ants.length === 0;
    if (foodOnly && last?.foodOnly && last.content === content && last.to === cell.tileX - 1) last.to = cell.tileX;
    else row.push({ from: cell.tileX, to: cell.tileX, content, foodOnly });
    rows.set(cell.tileY, row);
  }
  return [...rows].map(([y, row]) => `y${y}: ${row.map((t) => `${t.from}${t.to === t.from ? "" : `-${t.to}`}${t.content}`).join(" ")}`);
}

/** Own territory rows as x ranges; rows with no own tile are omitted. */
export function territoryLines(rows) {
  const lines = [];
  rows.forEach((row, y) => {
    const ranges = [];
    for (const match of row.matchAll(/#+/g)) {
      const from = match.index, to = match.index + match[0].length - 1;
      ranges.push(from === to ? `${from}` : `${from}-${to}`);
    }
    if (ranges.length) lines.push(`y${y}: ${ranges.join(" ")}`);
  });
  return lines;
}

const CELL_KEY = "key: per row y<row>: tiles by x; x-x2 = run of equal food-only tiles; f<n> food; Q<own|enemy><hp> queen; :ants, comma-separated id+caste+hp, caste w=worker s=soldier a=none, lowercase own UPPERCASE enemy; hp in HP";
/** The key of a cell table with more than two colonies: enemy ants and queens also name their colony. */
const colonyCellKey = (colonies, own) => `${CELL_KEY}; @<n> ends each enemy ant and enemy queen: the colony it belongs to, 0-${colonies - 1} (yours is ${own})`;

/** The readable text of any reply that carries a view. Nothing in cells, territory, squad, queens or marks is cut. */
export function renderView(data) {
  const { view, ...top } = data ?? {};
  // Header fields and the view are each shrunk once, so every "…N more" counts the items actually hidden.
  const header = shrink(Object.fromEntries(Object.entries(top).filter(([k]) => !DROP_KEYS.has(k))));
  header.view = shrink(Object.fromEntries(Object.entries(view).filter(([k]) => !VIEW_SECTIONS.has(k))));
  const lines = [JSON.stringify(header)];
  const own = view.colony;
  if (Array.isArray(view.squad)) lines.push(`squad (${view.squad.length}):`, ...view.squad.map((a) => JSON.stringify(a)));
  if (Array.isArray(view.queens)) lines.push(`queens (${view.queens.length}):`, ...view.queens.map((q) => JSON.stringify(q)));
  const cells = view.cells;
  if (cells && typeof cells === "object" && typeof cells.data === "string") {
    const decoded = expandCells(cells);
    const tick = view.cellsTick === undefined ? "" : ` tick ${view.cellsTick}`;
    lines.push(view.cellsMore === true
      ? `cells${tick}: ${decoded.length} tiles shown; MORE CELLS FOLLOW, not shown: observe --cellsCursor ${view.cellsCursor}`
      : `cells${tick}: ${decoded.length} tiles (complete)`);
    const colonies = cells.colonies ?? 2, byColony = colonies > 2;
    if (decoded.length) lines.push(byColony ? colonyCellKey(colonies, own) : CELL_KEY, ...cellLines(decoded, own, byColony));
  } else if (cells !== undefined) lines.push(`cells: ${JSON.stringify(cells)}`);
  if (view.territory) {
    const rows = territoryLines(unpackTerritory(view.territory));
    lines.push(`territory own (${view.territory.width}x${view.territory.height}; x ranges per row, rows without own tiles omitted):${rows.length ? "" : " none"}`, ...rows);
  } else lines.push("territory: not in this reply (observe with map:true)");
  for (const name of ["marks", "myMarks"]) {
    if (view[name] === undefined) continue;
    const marks = unpackMarks(view[name]);
    lines.push(`${name} (${marks.length}):`, ...marks.map((m) => JSON.stringify(m)));
  }
  return lines.join("\n");
}
