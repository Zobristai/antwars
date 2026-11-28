import { houseOwnedAmong } from "../src/identity/houseOwnership.js";
import {
  EMPTY_RECORD, MAX_PAGE_SIZE, NATURAL_OUTCOMES, encodeRating, isValidId, letterFor, lobbySeats,
  matchTime, recordFields, storedRecord, storedState, withResult, type LobbySeat, type RatingRecord,
} from "../src/rating/ratings.js";
import { firestoreFromEnv, type Fields, type Store, type Write } from "../src/store/firestore.js";

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const natural = (f: Fields) => f.state === "ended" && f.mode === "house-1v1" && Object.hasOwn(NATURAL_OUTCOMES, f.outcome);
function players(f: Fields): readonly LobbySeat[] {
  const seats = lobbySeats(f.seats);
  requireThat(seats?.length === 2 && seats[0].colony !== seats[1].colony && seats[0].id !== seats[1].id, "Invalid house duel seats");
  return seats;
}

// Discovery only, at one read time. Never use scan values to compute a write: each
// candidate is re-read under lock, and the rows' count, form and latest rating
// must account for the entire discovered history (including a racing release).
async function historyPaths(store: Store, ids: Set<string>) {
  const paths: string[] = [];
  let readTime: string | undefined, startAfter: { value: string; path: string } | undefined;
  for (;;) {
    const page = await store.query("lobbies", { orderBy: "createdAt", direction: "ASCENDING", limit: MAX_PAGE_SIZE, readTime, startAfter });
    readTime ??= page.readTime;
    for (const { path, fields } of page.rows) {
      if (fields.rated === "true" && natural(fields) && players(fields).some(seat => ids.has(seat.id))) paths.push(path);
    }
    if (page.rows.length < MAX_PAGE_SIZE) return paths;
    const last = page.rows.at(-1)!;
    startAfter = { value: last.fields.createdAt, path: last.path };
  }
}

function changesFor(marker: Fields | null | undefined, seats: readonly LobbySeat[]) {
  const changes = JSON.parse(marker?.changes ?? "null");
  requireThat(Array.isArray(changes) && changes.length === 2 && seats.every(({ id }) => changes.some(c => c?.identityId === id)), "Missing or mismatched rating changes");
  return seats.map(({ id }) => {
    const { before, after, rdBefore, rdAfter } = changes.find(c => c.identityId === id);
    requireThat([before, after, rdBefore, rdAfter].every(Number.isFinite) && rdBefore > 0 && rdAfter > 0, "Invalid rating change");
    return { before: Number(before), after: Number(after), rdBefore: Number(rdBefore), rdAfter: Number(rdAfter) };
  });
}
type Summary = { rating: number; rd: number; ratedMatches: number; wins: number; losses: number; draws: number; form: string };
function figures(rating: number, rd: number, record: RatingRecord): Summary {
  const { wins, losses, draws, form } = record;
  return { rating, rd, ratedMatches: wins + losses + draws, wins, losses, draws, form: form.map(e => e.result).join("") };
}

export async function unrateMatch(store: Store, id: string, apply = false) {
  requireThat(isValidId(id), "Invalid lobby id");
  const target = `lobbies/${id}`, marker = `ratedMatches/${id}`;
  const initial = await store.get(target);
  requireThat(initial && natural(initial), "Expected an ended, natural house duel");
  const ids = new Set(players(initial).map(s => s.id));
  const paths = await historyPaths(store, ids);
  return store.transaction(async read => {
    const docs = await read([...new Set([target, marker, ...paths, ...Array.from(ids, key => `ratings-house-1v1/${key}`)])]);
    const lobby = docs.get(target);
    requireThat(lobby && natural(lobby), "Lobby is not an ended, natural house duel");
    const seats = players(lobby);
    requireThat(seats.every(s => ids.has(s.id)) && (await houseOwnedAmong(read, [...ids])).size === 2, "House seats changed");
    // Post-apply preview: read the unchanged rows, but never 'apply' a second time.
    const unchanged = !apply && lobby.rated === "false" && !docs.get(marker);
    requireThat(unchanged || (lobby.rated === "true" && paths.includes(target)), "Lobby is not rated");
    const changes = unchanged ? null : changesFor(docs.get(marker), seats);
    const history = paths.map(path => {
      const f = docs.get(path);
      requireThat(f && natural(f) && f.rated === "true", "Rated history changed; preview again");
      const matchId = path.slice("lobbies/".length), at = matchTime(f);
      requireThat(isValidId(matchId) && at !== null && Number.isSafeInteger(at), "Invalid rated history");
      return { matchId, at, seats: players(f), winner: NATURAL_OUTCOMES[f.outcome] };
    }).sort((a, b) => a.at - b.at);
    const writes: Write[] = [];
    const rows = [];
    for (const [i, seat] of seats.entries()) {
      const path = `ratings-house-1v1/${seat.id}`, row = docs.get(path);
      requireThat(row && row.houseRating === row.rating && /^antwars\/[a-z0-9-]+$/.test(row.displayName), "Missing house rating row");
      const state = storedState(seat.id, row), stored = storedRecord(seat.id, row);
      const games = history.filter(h => h.seats.some(s => s.id === seat.id));
      const latest = games.at(-1);
      requireThat(latest && games.length === state.ratedMatches && latest.at === state.ratedAt && (unchanged || latest.matchId === id), "Not the latest rated result or incomplete history");
      requireThat(games.every((g, j) => !j || games[j-1].at !== g.at), "Ambiguous match order");
      let prior = EMPTY_RECORD, current = EMPTY_RECORD;
      for (const g of games) {
        prior = current;
        current = withResult(prior, letterFor(g.winner, g.seats.find(s => s.id === seat.id)!.colony), g.matchId);
      }
      requireThat(stored && Object.entries(recordFields(current)).every(([k,v]) => row[k] === v), "Record disagrees with rated history");
      const before = figures(state.rating, state.rd, current);
      let after = before;
      if (changes) {
        const c = changes[i], previous = games.at(-2);
        requireThat(previous && c.after === state.rating && c.rdAfter === state.rd, "Rating is not the recorded post-match state");
        const prevPath = `ratedMatches/${previous.matchId}`;
        const previousChanges = changesFor((await read([prevPath])).get(prevPath), previous.seats);
        const prev = previousChanges[previous.seats.findIndex(s => s.id === seat.id)];
        requireThat(prev.after === c.before && prev.rdAfter === c.rdBefore, "Prior change disagrees with restoration");
        after = figures(c.before, c.rdBefore, prior);
        const rating = encodeRating(after.rating);
        writes.push({ op: "update", path, fields: { rating, houseRating: rating, rd: encodeRating(after.rd),
          ratedAt: String(previous.at), ratedMatches: String(after.ratedMatches), ...recordFields(prior) } });
      }
      rows.push({ handle: row.displayName, before, after });
    }
    writes.push({ op: "delete", path: marker }, { op: "update", path: target, fields: { rated: "false" } });
    return { result: rows, writes: apply ? writes : [] };
  });
}

if (import.meta.main) {
  const [id, flag, ...extra] = process.argv.slice(2);
  try {
    requireThat(isValidId(id) && (flag === undefined || flag === "--apply") && !extra.length, "Invalid arguments");
    const store = firestoreFromEnv(process.env);
    requireThat(store, "No store selected");
    console.log(JSON.stringify(await unrateMatch(store, id, flag === "--apply")));
  } catch {
    console.error("No confirmed result. Check the lobby, rated history and store settings before proceeding.");
    process.exitCode = 1;
  }
}
