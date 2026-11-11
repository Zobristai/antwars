import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { decodeRating, encodeRating, ratingCollection, ratingWrites, RANKED_MODES, storedRecord, type RankedMode, type Winner } from "../../src/rating/ratings.ts";
import { CORRECTION_MARKER, NEVER_JOINED, planCorrections, PLAN_PATH, REFUSAL_CODES, SOL_MOVES, startCorrectionPlan, type Plan, type PlanState } from "../../src/rating/correctionPlan.ts";
import { DAY_MS } from "../../src/identity/retention.ts";
import { RELEASED_NAME } from "../../src/live/queue-catalog.ts";
import { firestoreWrites, verify } from "../../src/rating/unrateNeverJoined.ts";
import { createFirestore, CREATE_TIME_BATCH, FirestoreError, type Fields, type Store, type Write } from "../../src/store/firestore.ts";
import type { RecordingObjects } from "../../src/replays/abandonRecording.ts";
import type { LiveGame } from "../../src/server.ts";
import { ratedRecording } from "../replays/never-joined-fixture.ts";

// Runs inside `firebase emulators:exec --only firestore` (FIRESTORE_EMULATOR_HOST); the recording bucket is in memory.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
let counter = 0;
/** A recording's start, as the watch registry stores it (src/live/watch-registry.ts). */
const startedAt = (id: string) => String(Date.parse(`${id.slice(0, 13)}:${id.slice(14, 16)}:${id.slice(17, 19)}.${id.slice(20, 24)}`)).padStart(16, "0");
const commit = (store: Store, writes: readonly Write[]) => store.transaction(async () => ({ result: undefined, writes }));
const MODE: RankedMode = "house-1v1";
const T0 = Date.parse("2026-11-01T21:29:08.783Z");
const MIN = 60_000;
const SECOND_LOBBY = SOL_MOVES[1]!.lobbyId!;

// House-1v1 history around the moved matches, in the order rated: [colony 0, colony 1, winner, start in minutes from the
// first moved match]. The two at 1200 and 1000 share glm-5-3 and end in the opposite order to their starts.
const HISTORY: readonly [string, string, Winner, number][] = [
  ["gpt-6-1-sol-high", "glm-5-3", "a", -900], ["gpt-6-1-sol-high-fast", "grok-4-7", "b", -800], ["gpt-6-1-sol-xhigh", "glm-5-3", "b", -700],
  ["gpt-6-1-sol-xhigh-fast", "gpt-6-1-sol-high", "a", -600], ["grok-4-7", "gpt-6-1-sol-xhigh", "draw", -500],
  ["gpt-6-1-sol-high", "glm-5-3", "b", 0], ["gpt-6-1-sol-xhigh", "grok-4-7", "b", 6.1],
  ["gpt-6-1-sol-high-fast", "glm-5-3", "a", 300], ["gpt-6-1-sol-high", "grok-4-7", "a", 2000], ["gpt-6-1-sol-xhigh-fast", "gpt-6-1-sol-xhigh", "b", 2600],
  ["glm-5-3", "grok-4-7", "b", 1200], ["glm-5-3", "gpt-6-1-sol-high-fast", "a", 1000],
  // A draw between equal ratings, each player's only match: it leaves both ratings unchanged.
  ["kimi-k3", "qwen-4", "draw", 100],
  // Started before the first moved match and rated after every other; after the move it shares sol-high-fast with it.
  ["gpt-6-1-sol-high-fast", "deepseek-v4", "a", -5],
];
const MOVED: Readonly<Record<number, string>> = { 5: "gpt-6-1-sol-high", 6: "gpt-6-1-sol-xhigh" };

/** Glicko-1 written out from Glickman's paper, apart from src/rating/glicko.ts: each match its own rating period, RD
 * growing only over a positive gap since the player's previous rated match. */
function independentReplay(moved: boolean): Map<string, { r: number; rd: number }> {
  const q = Math.LN10 / 400, c2 = (350 ** 2 - 50 ** 2) / 365, g = (rd: number) => 1 / Math.sqrt(1 + 3 * q * q * rd * rd / Math.PI ** 2);
  const state = new Map<string, { r: number; rd: number; t: number | null }>();
  HISTORY.forEach(([a, b, winner, minutes], i) => {
    const names = [a, b].map(name => moved && MOVED[i] === name ? `${name}-fast` : name);
    const at = T0 + minutes * MIN;
    const p = names.map(name => {
      const s = state.get(name) ?? { r: 1500, rd: 350, t: null };
      return { ...s, rd: s.t === null || at <= s.t ? s.rd : Math.min(Math.sqrt(s.rd ** 2 + c2 * (at - s.t) / 86_400_000), 350) };
    });
    const scores = winner === "a" ? [1, 0] : winner === "b" ? [0, 1] : [0.5, 0.5];
    names.forEach((name, side) => {
      const me = p[side]!, them = p[1 - side]!, gj = g(them.rd);
      const e = 1 / (1 + 10 ** (-gj * (me.r - them.r) / 400));
      const precision = 1 / me.rd ** 2 + q * q * gj * gj * e * (1 - e);
      state.set(name, { r: me.r + (q / precision) * gj * (scores[side]! - e), rd: Math.sqrt(1 / precision), t: at });
    });
  });
  return new Map([...state].map(([name, { r, rd }]) => [`antwars/${name}`, { r, rd }]));
}

const readOnly = (objects: Map<string, Uint8Array>): RecordingObjects => ({
  async read(name) { const body = objects.get(name); return body ? { body, generation: "1", contentType: "application/json", ...(name.endsWith(".bin") ? { contentEncoding: "gzip" as const } : {}) } : null; },
  async generation(name) { return objects.has(name) ? "1" : null; },
  async replace() { throw new Error("the read-only pass must never replace a recording"); },
});

async function world() {
  const store = createFirestore({ projectId, namespace: `c${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
  const identities = createIdentities(store);
  const users: string[] = [];
  for (const name of ["absent-player", "joined-player"]) {
    const claimed = await identities.claimUsername(name);
    if (!claimed.ok) throw new Error(claimed.reason);
    users.push(claimed.value.identity.id);
  }
  const at = Date.parse("2026-11-09T13:26:59.840Z");
  const lobby = NEVER_JOINED.lobbyId;
  await commit(store, [
    { op: "create", path: `lobbies/${lobby}`, fields: { kind: "public", state: "ended", rated: "true", mode: "1v1", outcome: "colony_1_won", createdAt: String(at - MIN),
      startsAt: String(at), matchRunId: "run-1", seats: JSON.stringify([{ id: users[0], colony: 0 }, { id: users[1], colony: 1 }]) } },
    { op: "create", path: `watchMatches/${lobby}`, fields: { visibility: "public", rated: "true", mode: "1v1", startedAt: startedAt(NEVER_JOINED.replayId),
      playbackFinished: "true", origin: "https://example.test", slot: "public-1", runId: "run-1", replayId: NEVER_JOINED.replayId } },
  ]);
  await store.transaction(read => ratingWrites(read, { matchId: lobby, teams: [[users[0]!], [users[1]!]], winner: "b", mode: "1v1", at }));
  const recording = ratedRecording([1]);
  const objects = new Map([[`${NEVER_JOINED.replayId}.bin`, recording.binary], [`${NEVER_JOINED.replayId}.json`, recording.recordBody]]);

  const house = await identities.claimUsername("antwars");
  if (!house.ok) throw new Error(house.reason);
  const ids = new Map<string, string>();
  for (const name of new Set(HISTORY.flatMap(([a, b]) => [a, b]))) {
    const created = await identities.createHandle(house.value.key, name);
    if (!created.ok) throw new Error(created.reason);
    ids.set(`antwars/${name}`, created.value.identity.id);
  }
  const lobbies: string[] = [];
  for (const [i, [a, b, winner, minutes]] of HISTORY.entries()) {
    const id = i === 6 ? SECOND_LOBBY : randomUUID(), at = T0 + minutes * MIN;
    const seats = [a, b].map((name, colony) => ({ id: ids.get(`antwars/${name}`)!, displayName: `antwars/${name}`, colony }));
    const outcome = winner === "draw" ? "draw" : `colony_${winner === "a" ? 0 : 1}_won`;
    await commit(store, [{ op: "create", path: `lobbies/${id}`, fields: { kind: "public", state: "ended", rated: "true", mode: MODE, outcome,
      createdAt: String(at - MIN), startsAt: String(at), seats: JSON.stringify(seats) } }, ...(MOVED[i] ? [{ op: "create" as const, path: `watchMatches/${id}`,
      fields: { visibility: "public", rated: "true", mode: MODE, startedAt: startedAt(SOL_MOVES[i - 5]!.replayId),
      playbackFinished: "true", origin: "https://example.test", slot: "public-1", runId: "run", replayId: SOL_MOVES[i - 5]!.replayId,
      modelLabels: JSON.stringify({ [`antwars/${MOVED[i]}`]: "fast", [`antwars/${b}`]: "other" }) } }] : [])]);
    await store.transaction(read => ratingWrites(read, { matchId: id, teams: [[seats[0]!.id], [seats[1]!.id]], winner, mode: MODE, at }));
    lobbies.push(id);
  }
  const paths = [...users.flatMap(id => RANKED_MODES.map(mode => `${ratingCollection(mode)}/${id}`)), ...[...ids.values()].map(id => `${ratingCollection(MODE)}/${id}`),
    ...[lobby, ...lobbies].flatMap(id => [`lobbies/${id}`, `ratedMatches/${id}`, `watchMatches/${id}`]), `ratingCorrections/${lobby}`, CORRECTION_MARKER,
    ...[...users, house.value.identity.id, ...ids.values()].map(id => `identities/${id}`), "usernames/absent-player", "usernames/joined-player", "usernames/antwars"];
  const snapshot = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, await store.get(path)] as const)));
  return { store, recordings: readOnly(objects), users, ids, lobbies, snapshot };
}

function served(serve: ReturnType<typeof startCorrectionPlan>["serve"], url = PLAN_PATH, method = "GET") {
  const out = { status: 0, body: "" };
  const res = { writeHead(status: number) { out.status = status; return res; }, end(body?: Buffer) { out.body = body?.toString() ?? ""; } };
  void serve({ url, method } as IncomingMessage, res as unknown as ServerResponse, {} as LiveGame);
  return out;
}

describe.skipIf(!host)("one-off rating correction plan", { timeout: 60_000 }, () => {
  it("plans both corrections exactly, writes nothing, and the planned writes give the independently replayed ratings", async () => {
    const w = await world();
    for (const [handle, { r, rd }] of independentReplay(false)) {
      const row = (await w.store.get(`${ratingCollection(MODE)}/${w.ids.get(handle)}`))!;
      expect([decodeRating(row.rating!), decodeRating(row.rd!)]).toEqual([expect.closeTo(r, 9), expect.closeTo(rd, 9)]);
    }
    const before = await w.snapshot();
    const plan = await planCorrections(w.store, w.recordings) as Plan;
    expect(await w.snapshot()).toEqual(before);

    const unrate = firestoreWrites(await verify({ store: w.store, recordings: w.recordings }, NEVER_JOINED.lobbyId, NEVER_JOINED.replayId), new Date());
    const withoutTime = (writes: readonly Write[]) => writes.map(each => each.op === "create" ? { ...each, fields: { ...each.fields, at: "" } } : each);
    expect(withoutTime(plan.writes.slice(0, unrate.length))).toEqual(withoutTime(unrate));
    expect(plan.summary.digest).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(plan.summary);
    for (const id of [...w.users, ...w.ids.values(), NEVER_JOINED.lobbyId]) expect(text).not.toContain(id);
    const corrected: readonly string[] = [NEVER_JOINED.replayId, ...SOL_MOVES.map(move => move.replayId)];
    expect(plan.summary.matches.filter(m => corrected.includes(m.match)).map(m => [m.match, m.before.seats, m.after.status, m.after.seats])).toEqual([
      [NEVER_JOINED.replayId, ["absent-player", "joined-player"], "abandoned, unrated", ["absent-player", "joined-player"]],
      [SOL_MOVES[0]!.replayId, ["antwars/gpt-6-1-sol-high", "antwars/glm-5-3"], "rated", ["antwars/gpt-6-1-sol-high-fast", "antwars/glm-5-3"]],
      [SOL_MOVES[1]!.replayId, ["antwars/gpt-6-1-sol-xhigh", "antwars/grok-4-7"], "rated", ["antwars/gpt-6-1-sol-xhigh-fast", "antwars/grok-4-7"]],
    ]);

    // Every planned match and rating-row write has its public entry.
    const matchWrites = new Set(plan.writes.filter(each => /^(lobbies|watchMatches|ratedMatches)\//.test(each.path)).map(each => each.path.split("/")[1]));
    // Each is named by its recording, else (no recording published yet) by its public lobby id.
    const named = new Map([[NEVER_JOINED.lobbyId, NEVER_JOINED.replayId], [w.lobbies[5]!, SOL_MOVES[0]!.replayId], [w.lobbies[6]!, SOL_MOVES[1]!.replayId]]);
    expect(plan.summary.matches.map(each => each.match).sort()).toEqual([...matchWrites].map(id => named.get(id!) ?? id).sort());
    expect(plan.summary.matches.length).toBeGreaterThan(3);
    expect(plan.summary.ratings).toHaveLength(plan.writes.filter(each => each.path.startsWith("ratings")).length);
    expect(plan.summary.matches.filter(each => each.before.labels)).toHaveLength(2);

    await commit(w.store, plan.writes);
    // Neither never-joined player stays rated in any ranked mode.
    for (const id of w.users) for (const mode of RANKED_MODES) expect(await w.store.get(`${ratingCollection(mode)}/${id}`)).toBeNull();
    expect(await w.store.get(`lobbies/${NEVER_JOINED.lobbyId}`)).toMatchObject({ outcome: "abandoned", rated: "false" });
    for (const [handle, { r, rd }] of independentReplay(true)) {
      const row = (await w.store.get(`${ratingCollection(MODE)}/${w.ids.get(handle)}`))!;
      expect([decodeRating(row.rating!), decodeRating(row.rd!), row.houseRating]).toEqual([expect.closeTo(r, 9), expect.closeTo(rd, 9), row.rating]);
    }
    const record = async (name: string) => storedRecord(name, await w.store.get(`${ratingCollection(MODE)}/${w.ids.get(`antwars/${name}`)}`));
    expect(await record("gpt-6-1-sol-high")).toMatchObject({ wins: 2, losses: 1, draws: 0 });
    expect(await record("gpt-6-1-sol-high-fast")).toMatchObject({ wins: 2, losses: 3, draws: 0, form: expect.arrayContaining([{ result: "L", matchId: w.lobbies[5] }]) });
    expect(await record("gpt-6-1-sol-xhigh-fast")).toMatchObject({ wins: 1, losses: 2, draws: 0 });
    expect(JSON.parse((await w.store.get(`watchMatches/${w.lobbies[5]}`))!.modelLabels!)).toEqual({ "antwars/glm-5-3": "other", "antwars/gpt-6-1-sol-high-fast": "fast" });
  });

  it("with a released never-joined player: writes nothing, refused or planned, and serves no identity id", async () => {
    const w = await world();
    // 100 days without a match or key use releases the name (identity/retention.ts); findById would record that, a write.
    const old = String(Date.now() - 100 * DAY_MS);
    await commit(w.store, [{ op: "update", path: `identities/${w.users[0]}`, fields: { claimedAt: old, lastKeyUseAt: old, lastMatchAt: old, hasJoinedMatch: "true" } }]);

    // Every planning read goes through a store whose transactions refuse any write.
    const strict: Store = { ...w.store, transaction: step => w.store.transaction(async read => {
      const result = await step(read);
      if (result.writes.length > 0) throw new Error(`planning wrote ${result.writes.map(each => each.path).join(", ")}`);
      return result;
    }) };

    // Refused after the names are read: nothing written.
    const path = `ratedMatches/${w.lobbies[8]}`;
    const stored = (await w.store.get(path))!.changes!;
    const changes = JSON.parse(stored) as { rdAfter: number }[];
    changes[0]!.rdAfter += 1;
    await commit(w.store, [{ op: "update", path, fields: { changes: JSON.stringify(changes) } as Fields }]);
    const tampered = await w.snapshot();
    expect(tampered["usernames/absent-player"]).not.toBeNull();
    await expect(planCorrections(strict, w.recordings)).rejects.toThrow("stored history not reproduced");
    expect(await w.snapshot()).toEqual(tampered);

    // Planned: nothing written, and the served plan holds no identity id.
    await commit(w.store, [{ op: "update", path, fields: { changes: stored } }]);
    const before = await w.snapshot();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { serve } = startCorrectionPlan(strict, w.recordings);
    await vi.waitFor(() => expect(JSON.parse(served(serve).body).state).toBe("planned"));
    info.mockRestore();
    expect(await w.snapshot()).toEqual(before);
    const body = served(serve).body;
    for (const id of [...w.users, ...w.ids.values()]) expect(body).not.toContain(id);
    expect(body).not.toContain("account:");
    const plan = JSON.parse(body) as PlanState & { matches: Plan["summary"]["matches"] };
    expect(plan.matches.find(m => m.match === NEVER_JOINED.replayId)!.before.seats).toEqual([RELEASED_NAME, "joined-player"]);
  });

  it("reads the history again when a match ends during planning, instead of refusing", async () => {
    const w = await world();
    let ended = false;
    const racing: Store = { ...w.store, transaction: step => w.store.transaction(step), get: path => w.store.get(path), query: async (collection, options) => {
      const page = await w.store.query(collection, options);
      if (collection === "lobbies" && !ended && options.startAfter === undefined && page.rows.some(row => row.fields.mode === MODE)) {
        ended = true;
        // grok-4-7 vs glm-5-3 ends and is rated after the first lobby scan.
        const [a, b] = [w.ids.get("antwars/grok-4-7")!, w.ids.get("antwars/glm-5-3")!], id = randomUUID(), at = T0 + 3000 * MIN;
        await commit(w.store, [{ op: "create", path: `lobbies/${id}`, fields: { kind: "public", state: "ended", rated: "true", mode: MODE, outcome: "colony_0_won",
          createdAt: String(at - MIN), startsAt: String(at), seats: JSON.stringify([{ id: a, displayName: "antwars/grok-4-7", colony: 0 }, { id: b, displayName: "antwars/glm-5-3", colony: 1 }]) } }]);
        await w.store.transaction(read => ratingWrites(read, { matchId: id, teams: [[a], [b]], winner: "a", mode: MODE, at }));
      }
      return page;
    } };
    const plan = await planCorrections(racing, w.recordings) as Plan;
    expect(ended).toBe(true);
    expect(plan.summary.matches.length).toBeGreaterThan(3);
  });

  it("refuses, naming the handle and match, when the stored history is not reproduced; serves only the check's code", async () => {
    const w = await world();
    // gpt-6-1-sol-high's last match, so its rating chain still holds.
    const path = `ratedMatches/${w.lobbies[8]}`;
    const original = (await w.store.get(path))!.changes!;
    type Stored = { identityId: string; before: number; after: number; rdBefore: number; rdAfter: number };
    const tamper = async (edit: (changes: Stored[]) => void) => {
      const changes = JSON.parse(original) as Stored[];
      edit(changes);
      await commit(w.store, [{ op: "update", path, fields: { changes: JSON.stringify(changes) } as Fields }]);
    };
    // Each stored figure and the stored players are compared, not only the results.
    for (const [edit, reason] of [
      [(c: Stored[]) => { c[0]!.before += 1; }, `antwars/gpt-6-1-sol-high in lobby ${w.lobbies[8]}`],
      [(c: Stored[]) => { c[0]!.rdBefore += 1; }, `antwars/gpt-6-1-sol-high in lobby ${w.lobbies[8]}`],
      [(c: Stored[]) => { c.push({ ...c[1]!, identityId: w.users[0]! }); }, `the players of lobby ${w.lobbies[8]}`],
    ] as const) {
      await tamper(edit);
      await expect(planCorrections(w.store, w.recordings)).rejects.toThrow(`stored history not reproduced: ${reason}`);
    }
    await tamper(c => { c[0]!.rdAfter += 1; });
    await expect(planCorrections(w.store, w.recordings)).rejects.toThrow(`stored history not reproduced: antwars/gpt-6-1-sol-high in lobby ${w.lobbies[8]}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = startCorrectionPlan(w.store, w.recordings);
    await vi.waitFor(() => expect(JSON.parse(served(serve).body)).toEqual({ state: "refused", reason: "not-reproduced-change" }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("antwars/gpt-6-1-sol-high"));
    warn.mockRestore();
  });

  it("serves a refusal as a fixed code naming the check, never an id, a name or the logged detail", async () => {
    expect(REFUSAL_CODES.every(code => /^[a-z]+(-[a-z]+)*$/.test(code))).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusal = async (store: Store, recordings: RecordingObjects) => {
      const { serve } = startCorrectionPlan(store, recordings);
      await vi.waitFor(() => expect(JSON.parse(served(serve).body).state).toBe("refused"));
      return served(serve).body;
    };
    const w = await world();
    await commit(w.store, [{ op: "delete", path: `watchMatches/${NEVER_JOINED.lobbyId}` }]);
    const body = await refusal(w.store, w.recordings);
    expect(JSON.parse(body)).toEqual({ state: "refused", reason: "never-joined-watch-entry" });
    for (const id of [...w.users, ...w.ids.values(), NEVER_JOINED.lobbyId, NEVER_JOINED.replayId]) expect(body).not.toContain(id);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("watchMatches entry missing"));
    // A failed store read, and any other throw, each have their own code.
    const failing = (error: Error): Store => ({ ...w.store, get: async () => { throw error; } });
    expect(JSON.parse(await refusal(failing(new FirestoreError("get", 403, "PERMISSION_DENIED")), w.recordings))).toEqual({ state: "refused", reason: "store-error" });
    expect(JSON.parse(await refusal(failing(new Error(`lobby ${NEVER_JOINED.lobbyId}`)), w.recordings))).toEqual({ state: "refused", reason: "error" });
    warn.mockRestore();
  });

  it("codes a stored row that is not reproduced by the field that differs", async () => {
    const w = await world();
    // A moved-to handle with matches in the window, so its row is replayed and its record compared.
    const path = `${ratingCollection(MODE)}/${w.ids.get("antwars/gpt-6-1-sol-high-fast")}`;
    const row = (await w.store.get(path))!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [fields, reason] of [
      [{ rating: encodeRating(decodeRating(row.rating!) + 1) }, "not-reproduced-rating"],
      [{ rd: encodeRating(decodeRating(row.rd!) + 1) }, "not-reproduced-rd"],
      [{ ratedAt: String(Number(row.ratedAt) + 1) }, "not-reproduced-rated-at"],
      [{ wins: String(Number(row.wins) + 1), losses: String(Number(row.losses) - 1) }, "not-reproduced-record"],
    ] as const) {
      await commit(w.store, [{ op: "update", path, fields }]);
      const { serve } = startCorrectionPlan(w.store, w.recordings);
      await vi.waitFor(() => expect(JSON.parse(served(serve).body).state).toBe("refused"));
      expect(JSON.parse(served(serve).body)).toEqual({ state: "refused", reason });
      await commit(w.store, [{ op: "update", path, fields: row }]);
    }
    warn.mockRestore();
  });

  it("plans a match that is not shown publicly like any other, and serves no trace of it, only counts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // Every string (keys too) and every number a served body carries.
    const leaves = (value: unknown, strings = new Set<string>(), numbers = new Set<number>()) => {
      if (typeof value === "string") strings.add(value);
      else if (typeof value === "number") numbers.add(value);
      else if (value && typeof value === "object") for (const [key, each] of Object.entries(value)) { strings.add(key); leaves(each, strings, numbers); }
      return { strings, numbers };
    };
    // The moved match and the never-joined match, each with its recording, hidden by a private watch entry; a private
    // lobby kind alone does not hide a match whose watch entry, and so its recording, is public.
    for (const [path, fields, hidden] of [
      [`watchMatches/${SECOND_LOBBY}`, { visibility: "private" }, SOL_MOVES[1]!.replayId],
      [`watchMatches/${NEVER_JOINED.lobbyId}`, { visibility: "private" }, NEVER_JOINED.replayId],
      [`lobbies/${SECOND_LOBBY}`, { kind: "private" }, null],
    ] as const) {
      const w = await world();
      const shown = await planCorrections(w.store, w.recordings) as Plan;
      expect([shown.summary.withheldMatches, shown.summary.withheldRatings]).toEqual([0, 0]);
      await commit(w.store, [{ op: "update", path, fields }]);
      const plan = await planCorrections(w.store, w.recordings) as Plan;
      // The same writes, so the same digest and the same apply.
      expect(plan.summary.digest).toBe(shown.summary.digest);
      expect(plan.writes.map(write => write.path)).toEqual(shown.writes.map(write => write.path));
      const { serve } = startCorrectionPlan(w.store, w.recordings);
      await vi.waitFor(() => expect(JSON.parse(served(serve).body).state).toBe("planned"));
      const body = served(serve).body;
      if (hidden === null) {
        expect(plan.summary).toEqual(shown.summary);
        continue;
      }
      // What the public plan served about the hidden match: its handles, and every figure of its rating changes and of
      // its players' rating rows. None of it is served now.
      const entry = shown.summary.matches.find(m => m.match === hidden)!;
      const handles = new Set([...entry.before.seats, ...entry.after.seats]);
      const figures = [...entry.before.ratingChanges, ...entry.after.ratingChanges].flatMap(c => [c.before, c.after]);
      const rows = shown.summary.ratings.filter(r => handles.has(r.handle));
      expect(rows.length).toBeGreaterThan(0);
      figures.push(...rows.flatMap(r => [r.before, r.after]).flatMap(s => s ? [s.rating, s.rd] : []));
      // A figure the public plan also serves for a player of no hidden match (two first-match players share a start
      // and a result) says nothing about it.
      const elsewhere = leaves([...shown.summary.matches.filter(m => m !== entry).flatMap(m => [m.before, m.after]).flatMap(s => s.ratingChanges),
        ...shown.summary.ratings].filter(each => !handles.has(each.handle))).numbers;
      const { strings, numbers } = leaves(JSON.parse(body));
      for (const each of [hidden, SECOND_LOBBY, NEVER_JOINED.lobbyId, ...handles]) {
        expect(body).not.toContain(each);
        expect(strings.has(each)).toBe(false);
      }
      expect(figures.filter(figure => !elsewhere.has(figure)).length).toBeGreaterThan(0);
      for (const figure of figures) if (!elsewhere.has(figure)) expect(numbers.has(figure)).toBe(false);
      // Only whole entries of the public plan are served, the rest counted.
      for (const m of plan.summary.matches) expect(shown.summary.matches).toContainEqual(m);
      for (const r of plan.summary.ratings) expect(shown.summary.ratings).toContainEqual(r);
      expect(plan.summary.matches.length + plan.summary.withheldMatches).toBe(shown.summary.matches.length);
      expect(plan.summary.ratings.length + plan.summary.withheldRatings).toBe(shown.summary.ratings.length);
      expect(plan.summary.withheldRatings).toBeGreaterThanOrEqual(rows.length);
      // Its effect travels on, in rating order, to every player a traced one meets: no later match seating a traced
      // player, and no traced player's row, is served. The public plan lists its changed matches in that order.
      const traced = new Set(handles);
      const later = shown.summary.matches.slice(shown.summary.matches.indexOf(entry) + 1);
      for (const m of later) {
        const seats = [...m.before.seats, ...m.after.seats];
        if (seats.some(seat => traced.has(seat))) for (const seat of seats) traced.add(seat);
      }
      if (hidden === SOL_MOVES[1]!.replayId) expect(traced.size).toBeGreaterThan(handles.size);
      for (const r of plan.summary.ratings) expect(traced.has(r.handle)).toBe(false);
      for (const m of plan.summary.matches) if (later.includes(m)) expect([...m.before.seats, ...m.after.seats].some(seat => traced.has(seat))).toBe(false);
    }
    info.mockRestore();
  });

  it("orders by each change record's creation: a later rewrite of a record moves nothing; a shared commit time refuses", async () => {
    const w = await world();
    const plan = await planCorrections(w.store, w.recordings) as Plan;
    // A later write to the earliest match's record (as a marker or record fill would make) keeps its createTime.
    await commit(w.store, [{ op: "update", path: `ratedMatches/${w.lobbies[0]}`, fields: { filled: "true" } }]);
    // The same plan, digest included (an updateTime order would put that match last and change it).
    expect(((await planCorrections(w.store, w.recordings)) as Plan).summary).toEqual(plan.summary);

    const [a, b] = [w.lobbies[7]!, w.lobbies[8]!];
    const tied: Store = { ...w.store, createTimes: async paths => {
      const times = new Map(await w.store.createTimes!(paths));
      return times.set(`ratedMatches/${b}`, times.get(`ratedMatches/${a}`)!);
    } };
    await expect(planCorrections(tied, w.recordings)).rejects.toThrow(new RegExp(`lobbies (${a} and ${b}|${b} and ${a}) not established`));
  });

  it("reads commit times for more documents than one batch, and a document's stays put when it is rewritten", async () => {
    const store = createFirestore({ projectId, namespace: `c${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
    const paths = Array.from({ length: 2 * CREATE_TIME_BATCH + 50 }, (_, i) => `probes/${String(i).padStart(4, "0")}`);
    await commit(store, paths.map(path => ({ op: "create" as const, path, fields: { n: "0" } })));
    const times = await store.createTimes!([...paths, "probes/missing"]);
    expect(times.size).toBe(paths.length + 1);
    expect(times.get("probes/missing")).toBeNull();
    for (const path of paths) expect(times.get(path)).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    await commit(store, [{ op: "update", path: paths[0]!, fields: { n: "1" } }]);
    expect((await store.createTimes!([paths[0]!])).get(paths[0]!)).toBe(times.get(paths[0]!));
  });

  it("serves the plan at its one path, and plans nothing once the correction marker exists", async () => {
    const w = await world();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { serve } = startCorrectionPlan(w.store, w.recordings);
    await vi.waitFor(() => expect(JSON.parse(served(serve).body).state).toBe("planned"));
    const plan = await planCorrections(w.store, w.recordings) as Plan;
    expect(JSON.parse(served(serve).body)).toEqual(JSON.parse(JSON.stringify({ state: "planned", ...plan.summary })));
    expect(info.mock.calls.filter(([line]) => String(line).startsWith("antwar rating correction planned: "))).toHaveLength(plan.writes.length);
    info.mockRestore();
    expect(served(serve, `${PLAN_PATH}/x`).status).toBe(404);
    expect(served(serve, PLAN_PATH, "POST").status).toBe(405);

    await commit(w.store, [{ op: "create", path: CORRECTION_MARKER, fields: { planDigest: plan.summary.digest, appliedAt: new Date().toISOString() } }]);
    expect(await planCorrections(w.store, w.recordings)).toBe("applied");
    const after = startCorrectionPlan(w.store, w.recordings);
    await vi.waitFor(() => expect(JSON.parse(served(after.serve).body)).toEqual({ state: "applied" }));
  });
});
