/** Marks have no nullable fields. Null in this wire table means absent, not zero. */
type MarkValue = string | number | boolean | readonly string[];
export interface MarkTable {
  readonly encoding: "columnar-v1";
  readonly fields: readonly string[];
  readonly rows: readonly (readonly (MarkValue | null)[])[];
}

export const MARK_TABLE_TEXT = "When a full view needs compaction, marks/myMarks are {encoding:'columnar-v1',fields,rows} instead of object arrays. Rebuild each row as an object by pairing fields with values; null means an absent optional field, never zero. Every mark field and value is retained.";

/** Preserve field names once, every value and row order; no simulation mutation. */
export function packMarks(marks: readonly object[]): MarkTable {
  const fields = [...new Set(marks.flatMap(mark => Object.keys(mark)))];
  const rows = marks.map(mark => {
    const values = mark as Record<string, MarkValue | undefined>;
    return fields.map(field => {
      const value = values[field];
      if (value === null) throw new Error("A mark field cannot be null");
      return value ?? null;
    });
  });
  return { encoding: "columnar-v1", fields, rows };
}

/** Reference decoder accepts ordinary small replies and compact large replies. */
export function unpackMarks(marks: readonly object[] | MarkTable): Record<string, unknown>[] {
  if (Array.isArray(marks)) return marks.map(mark => ({ ...mark }));
  const table = marks as MarkTable;
  if (table.encoding !== "columnar-v1" || new Set(table.fields).size !== table.fields.length ||
    table.rows.some(row => row.length !== table.fields.length)) throw new Error("Invalid mark table");
  return table.rows.map(row => Object.fromEntries(table.fields.flatMap((field, i) => row[i] === null ? [] : [[field, row[i]]])));
}
