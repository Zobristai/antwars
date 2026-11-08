// Readable observe view. The decoders here are ports of the server's reference
// decoders (the harness is installed alone and cannot import src/):
//   expandCells      src/sim/view.ts      (DenseCells, grammar CELL_ENCODING)
//   unpackTerritory  src/mcp/territory.ts (base64-bitset-lsb0)
//   unpackMarks      src/mcp/markTable.ts (columnar-v1)
// test/board.test.mjs checks each port against the server's encoder.

/** Port of expandCells: the one delta/run-length cell grammar. */
export function expandCells(table) {
  if (table.data === "") return [];
  const n = (value) => {
    if (!/^-?[0-9a-z]+$/.test(value)) throw new RangeError("Invalid base36 cell integer");
    const parsed = parseInt(value, 36);
    if (!Number.isSafeInteger(parsed)) throw new RangeError("Cell integer exceeds the safe integer range");
    return parsed;
  };
  if (!Number.isSafeInteger(table.foodRadix) || table.foodRadix < 1) throw new RangeError("Invalid food radix");
  const cells = [];
  let previousIndex = 0;
  for (const row of table.data.split(";")) {
    const [token, repeat] = row.split("*");
    const count = repeat === undefined ? 1 : n(repeat);
    if (count < 1 || cells.length + count > table.width * table.height || (repeat !== undefined && /[:,]/.test(token))) throw new RangeError("Invalid cell repeat count");
    const [header, body = ""] = token.split(":");
    const [packedTile, queen, queenHp] = header.split(",").map(n);
    const delta = Math.floor(packedTile / table.foodRadix), food = packedTile - delta * table.foodRadix;
    const ants = body === "" ? [] : body.split("/").map((record) => {
      const [antId, packed] = record.split(".").map(n);
      const hp = Math.floor(packed / 6), kind = packed % 6;
      return { antId, hp, colony: kind % 2, ...(kind < 2 ? {} : { caste: kind < 4 ? "worker" : "soldier" }) };
    });
    for (let i = 0; i < count; i++) {
      const index = previousIndex + delta;
      if (!Number.isSafeInteger(index) || index < 0 || index >= table.width * table.height) throw new RangeError("Cell index outside map");
      previousIndex = index;
      cells.push({ tileX: index % table.width, tileY: Math.floor(index / table.width), food, ants,
        ...(queen === undefined ? {} : { queen }), ...(queenHp === undefined ? {} : { queenHp }) });
    }
  }
  return cells;
}

/** Port of unpackTerritory: one '#'/'.' string per map row ('#' = own tile). */
export function unpackTerritory(territory) {
  const { encoding, width, height, data } = territory;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256) {
    throw new Error("Invalid territory dimensions: expected integers in 1..256");
  }
  const count = width * height;
  if (encoding !== "base64-bitset-lsb0" || typeof data !== "string" || data.length !== 4 * Math.ceil(Math.ceil(count / 8) / 3)) {
    throw new Error("Invalid territory encoding or length");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length !== Math.ceil(count / 8) || bytes.toString("base64") !== data ||
    (count % 8 !== 0 && (bytes.at(-1) >> (count % 8)) !== 0)) {
    throw new Error("Invalid territory data or padding");
  }
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const index = y * width + x;
    return (bytes[index >> 3] & (1 << (index & 7))) === 0 ? "." : "#";
  }).join(""));
}

/** Port of unpackMarks: object arrays pass through; columnar-v1 tables become objects. */
export function unpackMarks(marks) {
  if (Array.isArray(marks)) return marks.map((mark) => ({ ...mark }));
  if (marks?.encoding !== "columnar-v1" || new Set(marks.fields).size !== marks.fields.length ||
    marks.rows.some((row) => row.length !== marks.fields.length)) throw new Error("Invalid mark table");
  return marks.rows.map((row) => Object.fromEntries(marks.fields.flatMap((field, i) => row[i] === null ? [] : [[field, row[i]]])));
}

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
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, depth + 1)]));
  }
  return value;
}

/** Milli-HP as HP, exact (at most 3 decimals). */
const hp = (milli) => String(milli / 1000);
const CASTE = { worker: "w", soldier: "s" };

function antText(ant, own) {
  const letter = CASTE[ant.caste] ?? "a";
  return `${ant.antId}${ant.colony === own ? letter : letter.toUpperCase()}${hp(ant.hp)}`;
}

function tileText(cell, own) {
  let text = cell.food > 0 ? `f${cell.food}` : "";
  if (cell.queen !== undefined) text += `Q${cell.queen === own ? "own" : "enemy"}${cell.queenHp === undefined ? "" : hp(cell.queenHp)}`;
  if (cell.ants.length) text += `:${cell.ants.map((ant) => antText(ant, own)).join(",")}`;
  return text;
}

/** Cells by row, tiles by x; consecutive food-only tiles with equal food share one x-x2 run. */
export function cellLines(cells, own) {
  const rows = new Map();
  for (const cell of [...cells].sort((a, b) => a.tileY - b.tileY || a.tileX - b.tileX)) {
    const row = rows.get(cell.tileY) ?? [];
    const content = tileText(cell, own);
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

/** The readable text of any reply that carries a view. Nothing in cells, territory, squad, queens or marks is cut. */
export function renderView(data) {
  const { view, ...top } = data ?? {};
  const header = Object.fromEntries(Object.entries(top).filter(([k]) => !DROP_KEYS.has(k)));
  header.view = shrink(Object.fromEntries(Object.entries(view).filter(([k]) => !VIEW_SECTIONS.has(k))));
  const lines = [JSON.stringify(shrink(header))];
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
    if (decoded.length) lines.push(CELL_KEY, ...cellLines(decoded, own));
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
