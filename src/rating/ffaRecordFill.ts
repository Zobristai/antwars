import { z } from "zod";
import type { Store, Write } from "../store/firestore.js";
import { FFA_COLLECTION } from "./ffa.js";
import { ffaRating } from "./ffaReads.js";
import { addPlace, emptyPlaces, ffaId, ffaPlace, placeFields, readPlaces, type PlaceRecord } from "./ffaRecord.js";

const changesSchema = z.array(z.object({ identityId: ffaId, place: ffaPlace })).length(4);

// Firestore returns UTC with 0, 3, 6 or 9 fractional digits. Preserve sub-ms ordering.
function orderKey(time?: string | null): string {
  const parts = time?.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/);
  if (!parts || !Number.isFinite(Date.parse(time!))) throw new Error("missing or invalid marker creation time");
  return parts[1]! + (parts[2] ?? "").padEnd(9, "0");
}

/** Bounded one-off, never called by the server. Rebuild whole records, not increments. */
export async function fillFfaRecords(store: Store, apply = false) {
  const markers = await store.query("ffaMatches", { orderBy: "changes", direction: "ASCENDING", limit: 101 });
  // Allow matches rated since the original eleven, but never silently truncate a scan.
  if (markers.rows.length < 11 || markers.rows.length > 100) throw new Error("expected 11 to 100 rated Free-for-all matches");
  const rows = await store.query(FFA_COLLECTION, { orderBy: "ratedMatches", direction: "ASCENDING", limit: 401, readTime: markers.readTime });
  if (rows.rows.length > 400) throw new Error("too many rating rows for the one-off fill");
  const times = await store.createTimes?.(markers.rows.map(m => m.path));
  const history = markers.rows.map(({ path, fields }) => {
    const changes = changesSchema.parse(JSON.parse(fields.changes!));
    if (new Set(changes.map(c => c.identityId)).size !== 4 || new Set(changes.map(c => c.place)).size !== 4) throw new Error(`invalid finish in ${path}`);
    return { key: orderKey(times?.get(path)), matchId: ffaId.parse(path.slice("ffaMatches/".length)), changes };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const records = new Map<string, PlaceRecord>(), latest = new Map<string, string>();
  for (const { key, matchId, changes } of history) for (const { identityId, place } of changes) {
    if (latest.get(identityId) === key) throw new Error(`ambiguous rating order for ${identityId}`);
    latest.set(identityId, key);
    const record = records.get(identityId) ?? emptyPlaces();
    addPlace(record, place, matchId);
    records.set(identityId, record);
  }
  const paths = rows.rows.map(r => r.path);
  if ([...records.keys()].some(id => !paths.includes(`${FFA_COLLECTION}/${id}`))) throw new Error("rated match has no rating row");
  return store.transaction(async read => {
    // Reconcile against *current* rows under transaction, not the count at scan time.
    const current = await read(paths), writes: Write[] = [];
    for (const path of paths) {
      const fields = current.get(path);
      if (!fields) throw new Error(`missing row: ${path}`);
      const record = records.get(path.slice(FFA_COLLECTION.length + 1)) ?? emptyPlaces();
      const { ratedMatches } = ffaRating(fields);
      if (record.places.reduce((n, v) => n + v, 0) !== ratedMatches) throw new Error(`rated count mismatch: ${path}`);
      const old = readPlaces(fields, ratedMatches);
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(record)) throw new Error(`existing place record disagrees: ${path}`);
      } else writes.push({ op: "update", path, fields: placeFields(record) });
    }
    return { result: { matches: history.length, finishes: history.length * 4, rowsToFill: writes.length, records: Object.fromEntries(records) }, writes: apply ? writes : [] };
  });
}
