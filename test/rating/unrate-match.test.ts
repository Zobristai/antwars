import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { unrateMatch } from "../../scripts/unrate-match.ts";
import { createRatings, encodeRating } from "../../src/rating/ratings.ts";
import type { Fields, Store } from "../../src/store/firestore.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";

// Public pre-match board; fixture lobby keys and older results are synthetic.
const seats = [
  { handle: "gpt-6-1-sol", rating: 1730.1215668826403, rd: 99.38518451950826, wins: 17, losses: 13,
    form: "LWWLL", replays: ["2026-11-26T05-51-06-695Z-7127678893463", "2026-11-24T12-05-47-118Z-50297281609990", "2026-11-23T18-32-21-094Z-264686538496895", "2026-11-23T16-12-31-948Z-196840063753874", "2026-11-13T12-39-51-207Z-44146181134910"] },
  { handle: "gpt-6-2-astra-high-std", rating: 1792.5681518219478, rd: 118.766652028131, wins: 9, losses: 4,
    form: "WLWWW", replays: ["2026-11-28T05-40-59-833Z-50398100979275", "2026-11-27T14-09-02-924Z-173088077994558", "2026-11-26T15-22-17-887Z-133111585939279", "2026-11-26T05-51-06-695Z-7127678893463", "2026-11-25T21-29-36-668Z-19760227250438"] },
];
const target = "the-duel", path = `lobbies/${target}`, marker = `ratedMatches/${target}`;
async function fixture(outcome: "a" | "draw" = "a") {
  const { docs, store, commits, played, ids } = retentionWorld();
  const owner = played("antwars"), players = seats.map(s => played(s.handle, owner).id);
  const rowPaths = players.map(id => `ratings-house-1v1/${id}`);
  const lobby = (at: number, ids: string[], outcome: string): Fields => ({ state: "ended", mode: "house-1v1", rated: "true", outcome,
    seats: JSON.stringify(ids.map((id,colony) => ({id, colony}))), startsAt: String(at), createdAt: String(at-1) });
  for (const [i, s] of seats.entries()) {
    const count = s.wins + s.losses;
    const letters = s.form + 'W'.repeat(s.wins - s.form.split('W').length + 1) + 'L'.repeat(s.losses - s.form.split('L').length + 1);
    const form = [...letters].map((result,j) => {
      const key = `p${i}-${j}`, participants = [players[i], 'opponent'];
      docs.set(`lobbies/${key}`, lobby(900-j, participants, result === 'W' ? 'colony_0_won' : 'colony_1_won'));
      if (j < 5) docs.set(`watchMatches/${key}`, { replayId: s.replays[j] });
      if (j === 0) docs.set(`ratedMatches/${key}`, { changes: JSON.stringify(participants.map(identityId => ({ identityId, before: 1500, after: s.rating, rdBefore: 150, rdAfter: s.rd }))) });
      return `${result}:${key}`;
    }).slice(0,5).join(' ');
    docs.set(rowPaths[i], { displayName: `antwars/${s.handle}`, rating: encodeRating(s.rating), houseRating: encodeRating(s.rating), rd: encodeRating(s.rd),
      ratedAt: "900", ratedMatches: String(count), wins: String(s.wins), losses: String(s.losses), draws: "0", form });
  }
  const ratings = createRatings(store, ids);
  await ratings.houseBackfill;
  const board = async () => value(await ratings.leaderboard({ scope: "house", mode: "house-1v1" })).entries;
  const before = await board();
  docs.set(path, lobby(1000, players, outcome === 'draw' ? 'draw' : 'colony_0_won'));
  docs.set(`watchMatches/${target}`, { replayId: '2026-11-28T14-44-18-887Z-30818361372128' });
  await ratings.applyResult({ matchId: target, teams: [[players[0]], [players[1]]], mode: 'house-1v1', at: 1000, winner: outcome });
  commits.length = 0;
  return { docs, store, commits, players, rowPaths, before, board };
}

it.each(["a", "draw"] as const)("previews then removes only the latest %s result in one commit; the entire public board is restored", async outcome => {
  const { docs, store, commits, before, board, rowPaths } = await fixture(outcome);
  const snapshot = new Map(docs);
  const rows = await unrateMatch(store, target);
  expect(docs).toEqual(snapshot);
  for (const [i,s] of seats.entries()) {
    expect(rows[i].after).toEqual({ rating: s.rating, rd: s.rd, wins: s.wins, losses: s.losses, draws: 0, ratedMatches: s.wins+s.losses, form: s.replays.map((replayId, j) => ({ result: s.form[j], replayId })) });
    expect(before.find(r => r.displayName === `antwars/${s.handle}`)?.form.map(f => f.replayId)).toEqual(s.replays);
  }
  expect(await unrateMatch(store, target, true, rows)).toEqual(rows);
  expect(await board()).toEqual(before);
  expect(commits.map(ws => ws.map(w => w.path))).toEqual([[...rowPaths, marker, path]]);
  expect(docs.has(marker)).toBe(false);
  expect(docs.get(path)).toEqual({...snapshot.get(path), rated: 'false'});
  for (const p of rowPaths) expect(docs.get(p)?.ratedAt).toBe('900');
  expect(await unrateMatch(store, target)).toEqual(rows.map(r => ({...r, before: r.after})));
  await expect(unrateMatch(store, target, true)).rejects.toThrow();
  expect(commits).toHaveLength(1);
});

it.each([
  ['running', 'Expected an ended, natural house duel'],
  ['unrated', 'Lobby is not rated'],
  ['other mode', 'Expected an ended, natural house duel'],
  ['abandoned', 'Expected an ended, natural house duel'],
  ['marker', 'Missing or mismatched rating changes'],
  ['form', 'Record disagrees with rated history'],
  ['rating', 'Rating is not the recorded post-match state'],
  ['prior marker', 'Missing or mismatched rating changes'],
  ['missing history', 'Not the latest rated result or incomplete history'],
  ['sol later', 'Not the latest rated result or incomplete history'],
  ['astra later', 'Not the latest rated result or incomplete history'],
])("refuses %s without writes", async (reason, expectedError) => {
  const { store, docs, commits, rowPaths, players } = await fixture();
  const preview = await unrateMatch(store, target);
  const modify = (p: string, f: Fields) => docs.set(p, { ...docs.get(p), ...f });
  if (reason === 'running') modify(path, { state: 'playing' });
  if (reason === 'unrated') modify(path, { rated: 'false' });
  if (reason === 'other mode') modify(path, { mode: '1v1' });
  if (reason === 'abandoned') modify(path, { outcome: 'abandoned' });
  if (reason === 'marker') docs.delete(marker);
  if (reason === 'form') modify(rowPaths[1], { form: 'W:wrong' });
  if (reason === 'rating') modify(rowPaths[0], { rd: encodeRating(250) });
  if (reason === 'prior marker') docs.delete('ratedMatches/p1-0');
  if (reason === 'missing history') docs.delete('lobbies/p1-7');
  if (reason.endsWith('later')) {
    const i = reason === 'sol later' ? 0 : 1;
    docs.set('lobbies/later', {...docs.get(path)!, createdAt: '2000', startsAt: '2001', seats: JSON.stringify([{id: players[i], colony: 0}, {id:'other', colony:1}])});
  }
  await expect(unrateMatch(store, target, true, preview)).rejects.toThrow(expectedError);
  expect(commits).toHaveLength(0);
});

it('re-reads a changed row on transaction retry rather than applying the first plan', async () => {
  const { store, docs, commits, rowPaths } = await fixture();
  const preview = await unrateMatch(store, target);
  const racing: Store = { ...store, async transaction(step) {
    await store.transaction(async read => ({result: await step(read), writes: []}));
    docs.set(rowPaths[1], {...docs.get(rowPaths[1]), ratedMatches: '15'});
    return store.transaction(step);
  } };
  await expect(unrateMatch(racing, target, true, preview)).rejects.toThrow();
  expect(commits).toEqual([]);
});

it('rejects malformed arguments without emitting raw data', () => {
  const result = spawnSync(process.execPath, ['--import', './src/ts-resolve.mjs', 'scripts/unrate-match.ts', 'private/path', '--apply'], {encoding:'utf8'});
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/^No confirmed result\./);
  expect(result.stderr).not.toContain('private/path');
});

it('refuses a different public recording with the same result after preflight, before any commit', async () => {
  const { store, docs, commits } = await fixture();
  const preview = await unrateMatch(store, target);
  docs.set('watchMatches/p1-4', { replayId: seats[0].replays[2] });
  await expect(unrateMatch(store, target, true, preview)).rejects.toThrow('differ from preview');
  expect(commits).toHaveLength(0);
  docs.set('watchMatches/p1-4', { replayId: 'unknown-private-recording' });
  await expect(unrateMatch(store, target)).rejects.toThrow('known public recordings');
});
