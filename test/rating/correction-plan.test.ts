import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { decodeRating, encodeRating, ratingCollection, ratingWrites, RANKED_MODES, storedRecord, type RankedMode, type Winner } from "../../src/rating/ratings.ts";
import {
  CORRECTION_MARKER, NEVER_JOINED, planCorrections, planDigest, planNeverJoined, PLAN_PATH, REFUSAL_CODES, refusalCode, SOL_MOVES, SOL_PLAN_PATH, startCorrectionPlan,
  type NeverJoinedPlan, type Plan, type PlanState,
} from "../../src/rating/correctionPlan.ts";
import { DAY_MS } from "../../src/identity/retention.ts";
import { RELEASED_NAME } from "../../src/live/queue-catalog.ts";
import { firestoreWrites, verify } from "../../src/rating/unrateNeverJoined.ts";
import { createFirestore, CREATE_TIME_BATCH, FirestoreError, type Fields, type Store, type Write } from "../../src/store/firestore.ts";
import { RecordingChangedError, RecordingHeldError, type RecordingHolds, type RecordingObjects } from "../../src/replays/abandonRecording.ts";
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
/** The never-joined lobby's run. */
const RUN = "3f2b8c1e-6a4d-4e2f-9b7c-0d1e2f3a4b5c";

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

/**
 * The recording bucket in memory, as Cloud Storage keeps it: each object at a generation and a metageneration that
 * each hold change advances, a hold set only on an unheld object at its generation, cleared only at the generation
 * and metageneration it was set at, and a held object never replaced. The correction itself never replaces one;
 * `overwrite` stands for any other writer and `holdElsewhere` for a hold another party set.
 */
type Recordings = RecordingObjects & RecordingHolds & {
  overwrite(name: string): Promise<void>;
  holdElsewhere(name: string): void;
  readonly held: ReadonlySet<string>;
  readonly holdCalls: [string, boolean][];
};
function bucket(bodies: Map<string, Uint8Array>): Recordings {
  const generations = new Map([...bodies.keys()].map(name => [name, 1]));
  const metagenerations = new Map([...bodies.keys()].map(name => [name, 1]));
  const held = new Set<string>();
  const holdCalls: [string, boolean][] = [];
  const toggle = (name: string, on: boolean) => { if (on) held.add(name); else held.delete(name); metagenerations.set(name, metagenerations.get(name)! + 1); };
  return {
    held, holdCalls,
    async read(name) {
      const body = bodies.get(name);
      return body ? { body, generation: String(generations.get(name)), contentType: "application/json", ...(name.endsWith(".bin") ? { contentEncoding: "gzip" as const } : {}) } : null;
    },
    async generation(name) { return bodies.has(name) ? String(generations.get(name)) : null; },
    async replace() { throw new Error("the correction must never replace a recording"); },
    async hold(name, generation) {
      holdCalls.push([name, true]);
      if (!bodies.has(name) || String(generations.get(name)) !== generation) throw new RecordingChangedError(name);
      if (held.has(name)) throw new RecordingHeldError(name);
      toggle(name, true);
      return { name, generation, metageneration: String(metagenerations.get(name)) };
    },
    async release(hold) {
      holdCalls.push([hold.name, false]);
      if (String(generations.get(hold.name)) !== hold.generation || String(metagenerations.get(hold.name)) !== hold.metageneration) return false;
      toggle(hold.name, false);
      return true;
    },
    holdElsewhere(name) { toggle(name, true); },
    async overwrite(name) {
      if (held.has(name)) throw new Error(`object ${name} is under a hold`);
      generations.set(name, generations.get(name)! + 1);
    },
  };
}

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
    { op: "create", path: `lobbies/${lobby}`, fields: { state: "ended", rated: "true", mode: "1v1", outcome: "colony_1_won", createdAt: String(at - MIN),
      startsAt: String(at), matchRunId: RUN, seats: JSON.stringify([{ id: users[0], colony: 0 }, { id: users[1], colony: 1 }]) } },
    { op: "create", path: `watchMatches/${lobby}`, fields: { visibility: "public", rated: "true", mode: "1v1", startedAt: startedAt(NEVER_JOINED.replayId),
      playbackFinished: "true", origin: "https://example.test", slot: "public-1", runId: RUN, replayId: NEVER_JOINED.replayId } },
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
    ...[lobby, ...lobbies].flatMap(id => [`lobbies/${id}`, `ratedMatches/${id}`, `watchMatches/${id}`]), `ratingCorrections/${lobby}`, `ratingCorrectionClaims/${lobby}`, CORRECTION_MARKER,
    ...[...users, house.value.identity.id, ...ids.values()].map(id => `identities/${id}`), "usernames/absent-player", "usernames/joined-player", "usernames/antwars"];
  const snapshot = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, await store.get(path)] as const)));
  return { store, recordings: bucket(objects), users, ids, lobbies, snapshot };
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
    // The plan at start is the never-joined part alone, so the Sol refusal's code is read from planCorrections.
    expect(await planCorrections(w.store, w.recordings).then(() => null, refusalCode)).toBe("not-reproduced-change");
  });

  it("serves a refusal as a fixed code naming the check, never an id, a name or the logged detail", async () => {
    expect(REFUSAL_CODES.every(code => /^[a-z]+(-[a-z]+)*$/.test(code))).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusal = async (store: Store, recordings: Recordings) => {
      const { serve } = startCorrectionPlan(store, recordings);
      await vi.waitFor(() => expect(JSON.parse(served(serve).body).state).toBe("refused"));
      return served(serve).body;
    };
    const w = await world();
    await commit(w.store, [{ op: "delete", path: `watchMatches/${NEVER_JOINED.lobbyId}` }]);
    const body = await refusal(w.store, w.recordings);
    expect(JSON.parse(body)).toEqual({ state: "refused", reason: "never-joined-watch-entry" });
    for (const id of [...w.users, ...w.ids.values(), NEVER_JOINED.lobbyId, NEVER_JOINED.replayId]) expect(body).not.toContain(id);
    // The log carries the fixed message and the code only, never the check's detail.
    expect(warn.mock.calls).toEqual([["antwar rating correction plan refused", { reason: "never-joined-watch-entry" }]]);
    // A failed store read, and any other throw, each have their own code.
    const failing = (error: Error): Store => ({ ...w.store, get: async () => { throw error; }, transaction: async () => { throw error; } });
    expect(JSON.parse(await refusal(failing(new FirestoreError("get", 403, "PERMISSION_DENIED")), w.recordings))).toEqual({ state: "refused", reason: "store-error" });
    expect(JSON.parse(await refusal(failing(new Error(`lobby ${NEVER_JOINED.lobbyId}`)), w.recordings))).toEqual({ state: "refused", reason: "error" });
    warn.mockRestore();
  });

  it("codes a stored row that is not reproduced by the field that differs", async () => {
    const w = await world();
    // A moved-to handle with matches in the window, so its row is replayed and its record compared.
    const path = `${ratingCollection(MODE)}/${w.ids.get("antwars/gpt-6-1-sol-high-fast")}`;
    const row = (await w.store.get(path))!;
    for (const [fields, reason] of [
      [{ rating: encodeRating(decodeRating(row.rating!) + 1) }, "not-reproduced-rating"],
      [{ rd: encodeRating(decodeRating(row.rd!) + 1) }, "not-reproduced-rd"],
      [{ ratedAt: String(Number(row.ratedAt) + 1) }, "not-reproduced-rated-at"],
      [{ wins: String(Number(row.wins) + 1), losses: String(Number(row.losses) - 1) }, "not-reproduced-record"],
    ] as const) {
      await commit(w.store, [{ op: "update", path, fields }]);
      // The Sol part is not run at start, so its code is read from planCorrections.
      expect(await planCorrections(w.store, w.recordings).then(() => null, refusalCode)).toBe(reason);
      await commit(w.store, [{ op: "update", path, fields: row }]);
    }
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

});

describe.skipIf(!host)("the never-joined correction on its own, at start", { timeout: 60_000 }, () => {
  const quiet = () => [vi.spyOn(console, "info").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
  const started = async (store: Store, recordings: Recordings) => {
    const { serve } = startCorrectionPlan(store, recordings);
    await vi.waitFor(() => expect(["planned", "applied", "refused"]).toContain(JSON.parse(served(serve).body).state));
    // Anything the start does after serving its state has settled.
    await new Promise(resolve => setTimeout(resolve, 500));
    return { serve, body: () => JSON.parse(served(serve).body) as PlanState };
  };

  it("serves exactly the never-joined correction, its digest over its writes alone, and never runs the Sol move", async () => {
    const w = await world();
    const [info, warn] = quiet();
    // Every read the start makes, by path and by query.
    const reads: string[] = [];
    const watched: Store = { ...w.store, get: path => { reads.push(path); return w.store.get(path); },
      query: (collection, options) => { reads.push(`query ${collection}`); return w.store.query(collection, options); },
      transaction: step => w.store.transaction(read => step(paths => { reads.push(...paths); return read(paths); })) };
    // A Sol history the Sol plan refuses: the start never reads it.
    const path = `ratedMatches/${w.lobbies[8]}`;
    const changed = JSON.parse((await w.store.get(path))!.changes!) as { before: number }[];
    changed[0]!.before += 1;
    await commit(w.store, [{ op: "update", path, fields: { changes: JSON.stringify(changed) } }]);
    await expect(planCorrections(w.store, w.recordings)).rejects.toThrow("stored history not reproduced");

    const before = await w.snapshot();
    const { serve, body } = await started(watched, w.recordings);
    expect(await w.snapshot()).toEqual(before);
    const lobby = (await w.store.get(`lobbies/${NEVER_JOINED.lobbyId}`))!;
    const changes = JSON.parse((await w.store.get(`ratedMatches/${NEVER_JOINED.lobbyId}`))!.changes!) as { identityId: string; before: number; after: number }[];
    const names = new Map([[w.users[0]!, "absent-player"], [w.users[1]!, "joined-player"]]);
    const row = async (id: string, record: string) => {
      const fields = (await w.store.get(`${ratingCollection("1v1")}/${id}`))!;
      return { handle: names.get(id), mode: "1v1", before: { rating: decodeRating(fields.rating!), rd: decodeRating(fields.rd!), record }, after: null };
    };
    const writes = firestoreWrites(await verify({ store: w.store, recordings: w.recordings }, NEVER_JOINED.lobbyId, NEVER_JOINED.replayId), new Date());
    expect(body()).toEqual({ state: "planned", digest: planDigest(writes), matches: [{
      match: NEVER_JOINED.replayId, startedAt: new Date(Number(lobby.startsAt)).toISOString(),
      before: { status: "rated", seats: ["absent-player", "joined-player"], ratingChanges: changes.map(c => ({ handle: names.get(c.identityId), before: c.before, after: c.after })) },
      after: { status: "abandoned, unrated", seats: ["absent-player", "joined-player"], ratingChanges: [] },
    }], ratings: [await row(w.users[0]!, "0-1-0"), await row(w.users[1]!, "1-0-0")] });
    // The digest covers the never-joined writes alone: one logged line for each, and none for a house row.
    const planned = info.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("antwar rating correction planned: "));
    expect(planned).toHaveLength(writes.length);
    expect(planned.some(line => line.includes(ratingCollection(MODE)))).toBe(false);
    expect(info).toHaveBeenCalledWith("antwar rating correction plan", { digest: planDigest(writes), writes: writes.length });
    // The Sol move queries lobbies and reads the house handles' rows and their lobbies; the never-joined checks read
    // only its two players' rows (in every ranked mode). None of the Sol move's reads is made.
    const house = [...w.ids.values()];
    expect(reads.filter(each => each.startsWith("query ") || house.some(id => each.endsWith(id)) || each.startsWith("usernames/antwars")
      || each.startsWith("identityHandles/") || [...w.lobbies].some(id => each.endsWith(id)))).toEqual([]);
    expect(served(serve, `${PLAN_PATH}/x`).status).toBe(404);
    expect(served(serve, PLAN_PATH, "POST").status).toBe(405);
    expect(warn).not.toHaveBeenCalled();
    info.mockRestore(); warn.mockRestore();
  });

  it("writes nothing at start while the never-joined plan is pending: no claim, correction, marker or rating, and no hold", async () => {
    const w = await world();
    const [info, warn] = quiet();
    // The state in which the removed apply used to write: the correction planned, its record and the marker absent.
    const plan = await planNeverJoined(w.store, w.recordings) as NeverJoinedPlan;
    expect(await w.store.get(`ratingCorrections/${NEVER_JOINED.lobbyId}`)).toBeNull();
    expect(await w.store.get(CORRECTION_MARKER)).toBeNull();
    // Every write any transaction the start runs would commit.
    const writes: Write[] = [];
    const watched: Store = { ...w.store, transaction: step => w.store.transaction(async read => {
      const out = await step(read);
      writes.push(...out.writes);
      return out;
    }) };
    const before = await w.snapshot();
    for (let start = 0; start < 2; start++) {
      const { body } = await started(watched, w.recordings);
      expect(body()).toEqual({ state: "planned", ...plan.summary });
    }
    expect(writes).toEqual([]);
    expect(w.recordings.holdCalls).toEqual([]);
    expect(await w.snapshot()).toEqual(before);
    expect(info.mock.calls.some(([line]) => /applied|not applied/.test(String(line)))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    info.mockRestore(); warn.mockRestore();
  });

  it("serves a rating change only as a checked handle and two finite ratings; anything else refuses and writes nothing", async () => {
    const path = `ratedMatches/${NEVER_JOINED.lobbyId}`;
    for (const value of ["1500<b>", { rating: 1500 }, null, undefined, [1500]]) {
      const w = await world();
      const [info, warn] = quiet();
      const changes = JSON.parse((await w.store.get(path))!.changes!) as Record<string, unknown>[];
      changes[0] = { ...changes[0], before: value };
      await commit(w.store, [{ op: "update", path, fields: { changes: JSON.stringify(changes) } }]);
      const before = await w.snapshot();
      const { serve, body } = await started(w.store, w.recordings);
      expect(body()).toEqual({ state: "refused", reason: "never-joined-rating-change" });
      expect(served(serve).body).toBe('{"state":"refused","reason":"never-joined-rating-change"}');
      expect(await w.snapshot()).toEqual(before);
      info.mockRestore(); warn.mockRestore();
    }
  });

  it("logs a fixed message, never the error, when the plan refuses", async () => {
    const malformed = "zz-malformed-rating-value";
    const logged = (spies: ReturnType<typeof quiet>) => JSON.stringify(spies.flatMap(spy => spy.mock.calls));
    {
      // A malformed stored rating: decoding it throws an error that quotes it.
      const w = await world();
      await commit(w.store, [{ op: "update", path: `${ratingCollection("1v1")}/${w.users[1]}`, fields: { rating: malformed } }]);
      await expect(planNeverJoined(w.store, w.recordings)).rejects.toThrow(malformed);
      const spies = quiet();
      const { body } = await started(w.store, w.recordings);
      expect(body()).toEqual({ state: "refused", reason: "never-joined-only-rated-match" });
      expect(spies[1]!.mock.calls).toEqual([["antwar rating correction plan refused", { reason: "never-joined-only-rated-match" }]]);
      expect(logged(spies)).not.toContain(malformed);
      spies.forEach(spy => spy.mockRestore());
    }
  });

  it("still serves applied, writing nothing, after either player has played another ranked match", async () => {
    const w = await world();
    const [info, warn] = quiet();
    const plan = await planNeverJoined(w.store, w.recordings) as NeverJoinedPlan;
    // Applied as the earlier release applied it: the plan's writes, committed.
    await commit(w.store, plan.writes);
    // Each player rated again, in the mode the correction cleared and in another.
    const opponent = w.ids.get("antwars/kimi-k3")!;
    await w.store.transaction(read => ratingWrites(read, { matchId: randomUUID(), teams: [[w.users[0]!], [opponent]], winner: "a", mode: "1v1", at: Date.now() }));
    await w.store.transaction(read => ratingWrites(read, { matchId: randomUUID(), teams: [[w.users[1]!], [opponent]], winner: "b", mode: MODE, at: Date.now() }));
    const played = await w.snapshot();
    expect(played[`${ratingCollection("1v1")}/${w.users[0]}`]).not.toBeNull();
    expect(played[`${ratingCollection(MODE)}/${w.users[1]}`]).not.toBeNull();
    // The checks alone no longer read the lobby as corrected; the applied correction still is.
    expect((await verify({ store: w.store, recordings: w.recordings }, NEVER_JOINED.lobbyId, NEVER_JOINED.replayId)).ok).toBe(false);
    expect(await planNeverJoined(w.store, w.recordings)).toBe("applied");
    const { body } = await started(w.store, w.recordings);
    expect(body()).toEqual({ state: "applied" });
    // Their new ratings are kept.
    expect(await w.snapshot()).toEqual(played);
    // The house-1v1 rating written here has no lobby, so only the house-1v1 plan may refuse; the never-joined part warns of nothing.
    expect(warn.mock.calls.filter(([line]) => !String(line).startsWith("antwar house-1v1 "))).toEqual([]);
    info.mockRestore(); warn.mockRestore();
  });

  it("plans the Sol move alone, touching nothing of the never-joined correction, once that is applied", async () => {
    const w = await world();
    const both = await planCorrections(w.store, w.recordings) as Plan;
    const plan = await planNeverJoined(w.store, w.recordings) as NeverJoinedPlan;
    // Applied as the earlier release applied it: the plan's writes, committed.
    await commit(w.store, plan.writes);
    const sol = await planCorrections(w.store, w.recordings) as Plan;
    const neverJoined = new Set(plan.writes.map(write => write.path));
    expect(sol.writes.length).toBeGreaterThan(0);
    expect(sol.writes.filter(write => neverJoined.has(write.path))).toEqual([]);
    expect(sol.writes).toEqual(both.writes.filter(write => !neverJoined.has(write.path)));
    expect(sol.summary.matches.map(match => match.match)).not.toContain(NEVER_JOINED.replayId);
    expect(sol.summary.matches).toEqual(both.summary.matches.filter(match => match.match !== NEVER_JOINED.replayId));
    expect(sol.summary.digest).toBe(planDigest(sol.writes));
  });

  it("logs each planned write only as its operation and path, so a malformed run id never reaches the log", async () => {
    const malformed = "zz-malformed-run-id";
    for (const value of [malformed, `${RUN}\n${malformed}`]) {
      const w = await world();
      // Both run-id fields (the checks require them equal): the plan carries it into the correction record.
      await commit(w.store, [
        { op: "update", path: `lobbies/${NEVER_JOINED.lobbyId}`, fields: { matchRunId: value } },
        { op: "update", path: `watchMatches/${NEVER_JOINED.lobbyId}`, fields: { runId: value } },
      ]);
      const before = await w.snapshot();
      const spies = quiet();
      const { body } = await started(w.store, w.recordings);
      expect(body().state).toBe("planned");
      const plan = await planNeverJoined(w.store, w.recordings) as NeverJoinedPlan;
      expect(plan.writes.find(write => write.path.startsWith("ratingCorrections/"))).toMatchObject({ fields: { runId: value } });
      const planned = spies[0]!.mock.calls.map(([line]) => line).filter(line => String(line).startsWith("antwar rating correction planned: "));
      expect(planned).toEqual(plan.writes.map(write => `antwar rating correction planned: ${write.op} ${write.path}`));
      expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain(malformed);
      expect(await w.snapshot()).toEqual(before);
      spies.forEach(spy => spy.mockRestore());
    }
  });

  /** The served house-1v1 plan, once it has settled. */
  const solServed = async (serve: ReturnType<typeof startCorrectionPlan>["serve"]) => {
    await vi.waitFor(() => expect(["planned", "applied", "refused"]).toContain(JSON.parse(served(serve, SOL_PLAN_PATH).body).state), { timeout: 30_000 });
    return JSON.parse(served(serve, SOL_PLAN_PATH).body) as PlanState;
  };
  const appliedWorld = async () => {
    const w = await world();
    const plan = await planNeverJoined(w.store, w.recordings) as NeverJoinedPlan;
    // Applied as the earlier release applied it: the plan's writes, committed.
    await commit(w.store, plan.writes);
    return w;
  };

  it("plans the house-1v1 move at start, read-only, once the never-joined correction is applied, and serves it with its digest", async () => {
    const w = await appliedWorld();
    const expected = await planCorrections(w.store, w.recordings) as Plan;
    const before = await w.snapshot();
    const [info, warn] = quiet();
    const { serve } = startCorrectionPlan(w.store, w.recordings);
    const sol = await solServed(serve);
    expect(sol).toEqual({ state: "planned", ...expected.summary });
    expect(expected.summary.digest).toBe(planDigest(expected.writes));
    // Nothing is written, and the never-joined path still reads applied.
    expect(await w.snapshot()).toEqual(before);
    expect(JSON.parse(served(serve).body)).toEqual({ state: "applied" });
    // Every planned write is logged as its operation and path, then the digest and count.
    expect(info.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("antwar house-1v1 rating correction planned: ")))
      .toEqual(expected.writes.map(write => `antwar house-1v1 rating correction planned: ${write.op} ${write.path}`));
    expect(info).toHaveBeenCalledWith("antwar house-1v1 rating correction plan", { digest: expected.summary.digest, writes: expected.writes.length });
    // The two moved matches are credited to the -fast handles; no identity id is served.
    expect(sol.state === "planned" && sol.matches.filter(m => SOL_MOVES.some(move => move.replayId === m.match)).map(m => m.after.seats)).toEqual([
      ["antwars/gpt-6-1-sol-high-fast", "antwars/glm-5-3"], ["antwars/gpt-6-1-sol-xhigh-fast", "antwars/grok-4-7"]]);
    for (const id of w.ids.values()) expect(served(serve, SOL_PLAN_PATH).body).not.toContain(id);
    expect(served(serve, SOL_PLAN_PATH, "POST").status).toBe(405);
    expect(warn).not.toHaveBeenCalled();
    info.mockRestore(); warn.mockRestore();
  });

  it("refuses the house-1v1 plan when the history is not reproduced: serves the first check's code alone and logs the largest deviation", async () => {
    const w = await appliedWorld();
    // Two stored changes not reproduced: by 1 in an earlier match, by 5 in a later one.
    const edits: [number, number][] = [[7, 1], [8, 5]];
    for (const [i, by] of edits) {
      const path = `ratedMatches/${w.lobbies[i]}`;
      const changes = JSON.parse((await w.store.get(path))!.changes!) as { rdAfter: number }[];
      changes[0]!.rdAfter += by;
      await commit(w.store, [{ op: "update", path, fields: { changes: JSON.stringify(changes) } as Fields }]);
    }
    const largest = JSON.parse((await w.store.get(`ratedMatches/${w.lobbies[8]}`))!.changes!)[0].identityId as string;
    const handle = [...w.ids].find(([, id]) => id === largest)![0];
    const before = await w.snapshot();
    const [info, warn] = quiet();
    const { serve } = startCorrectionPlan(w.store, w.recordings);
    expect(await solServed(serve)).toEqual({ state: "refused", reason: "not-reproduced-change" });
    expect(warn.mock.calls).toEqual([["antwar house-1v1 rating correction plan refused", { reason: "not-reproduced-change",
      deviation: { deviation: expect.closeTo(5, 6), handle, source: `ratedMatches/${w.lobbies[8]}`, count: 2 } }]]);
    // The public answer is the code alone: no handle, match, figure or plan.
    const body = served(serve, SOL_PLAN_PATH).body;
    for (const text of [handle, w.lobbies[7]!, w.lobbies[8]!, "digest", "matches"]) expect(body).not.toContain(text);
    expect(info.mock.calls.some(([line]) => String(line).startsWith("antwar house-1v1 rating correction plan"))).toBe(false);
    expect(await w.snapshot()).toEqual(before);
    info.mockRestore(); warn.mockRestore();
  });

  it("does not plan the house-1v1 move while the never-joined correction is not applied", async () => {
    const w = await world();
    const [info, warn] = quiet();
    // Nothing applies the never-joined correction, so it stays planned, not applied.
    const { serve } = startCorrectionPlan(w.store, w.recordings);
    expect(await solServed(serve)).toEqual({ state: "refused", reason: "never-joined-not-applied" });
    expect(JSON.parse(served(serve).body).state).toBe("planned");
    expect(info.mock.calls.some(([line]) => String(line).startsWith("antwar house-1v1 "))).toBe(false);
    info.mockRestore(); warn.mockRestore();
  });
});
