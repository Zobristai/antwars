/// <reference types="node" />
// match_post_mortem end to end below the MCP layer (src/accounts/postMortem.ts): real identities, lobbies and watch
// registry over one in-memory store, records generated here by the real simulation and record builder, and re-runs in
// the real forked child. Ownership is by the lobby's seat identity ids only.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CALL_IDLE_NOTE, createPostMortem, NO_EFFECT_NOTE, noEffectOf, ownedSeats, ownNoEffect, REFUSALS, TICKS_ONLY_NOTE, TIME_NOT_RECORDED, timeOf, undecidedSentence } from "../../src/accounts/postMortem.ts";
import { rerunRecord, sameState, type ChildMessage } from "../../src/accounts/postMortemChild.ts";
import { createJobs, type PostMortemJobs, type RerunOutcome } from "../../src/accounts/postMortemJobs.ts";
import { scanRecord } from "../../src/accounts/postMortemRecord.ts";
import type { VersionAnswer, VersionSource } from "../../src/accounts/postMortemVersion.ts";
import { encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { matchRecord } from "../../src/replays/history.ts";
import { createPrivateArchive } from "../../src/replays/private-archive.ts";
import { privateMediaName, sealPrivateMedia } from "../../src/replays/private-media.ts";
import type { ReplayObject } from "../../src/replays/store.ts";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { ServerTerminal } from "../../src/sim/step.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import { retentionWorld } from "../identity/retentionStore.ts";
import { startHarness } from "../mcp/harness.ts";
import { playable } from "../playable.ts";

const CODE = "c".repeat(40);
const KEY = Buffer.alloc(32, 5);
const RECEIVED = Date.parse("2026-10-20T02:00:00.000Z");
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const brood = (seat: number, value = "workers"): SimInput => ({ type: "set_brood", agentId: `seat-private-${seat}`, brood: value });
const observe = (seat: number): SimInput => ({ type: "observe", agentId: `seat-private-${seat}` });

/**
 * A stored public record of a 2-seat match, built by the real simulation, spectator recorder and record builder, with the
 * server's house-idle clock applied as src/mcp/game.ts advanceMatch does: a seat is idle once its last counted call is
 * `idleTicks` old, its colony then losing (or the match abandoned in the Model Index). `counts: false` marks a call the
 * server does not count (an adapter refusal's observe).
 */
function houseMatch(id: string, options: {
  names?: readonly string[]; idleTicks: number; stopAt: number; modelIndex?: boolean;
  /** The match's rules give no command idle allowance: any call keeps a seat awake (historical configs). */
  callIdle?: boolean;
  calls: Record<number, readonly (SimInput | { input: SimInput; counts: false })[]>;
}) {
  const names = options.names ?? ["alice", "bob"];
  const { commandIdleTicks: _historical, ...rules } = playable(rulesConfig("redesign"));
  const config: SimConfig = { ...rules, matchTicks: 40, commandFloorTicks: 100, startAnts: 16, ...(options.callIdle ? {} : { commandIdleTicks: 1 }) };
  let state: SimState = createMatch(6006, config);
  const activity = new Map<string, number>();
  const recorder = new SpectatorRecorder(state, { identity: agentId => ({ displayName: names[Number(agentId.replace("seat-private-", ""))]! }),
    houseIdle: { idleTicks: options.idleTicks, activityTick: agentId => activity.get(agentId) }, ...(options.modelIndex ? { modelIndex: true } : {}) });
  const messages = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const lines = [headerLine(state.seed, config)];
  while (state.result === null) {
    const tick = state.tick, planned = (options.calls[tick] ?? []).map(c => "counts" in c ? c : { input: c, counts: true });
    const inputs = planned.map(c => c.input);
    let terminal: ServerTerminal = tick === options.stopAt;
    let out = step(state, inputs, undefined, undefined, undefined, terminal, true);
    planned.forEach((call, i) => { if (call.counts && out.results[i]?.ok) activity.set(call.input.agentId, tick); });
    if (terminal === false) {
      const idle = [...new Set(out.state.agents.filter(a => tick - (activity.get(a.id) ?? a.joinedTick ?? 0) >= options.idleTicks).map(a => a.colony))].sort();
      if (idle.length > 0) {
        terminal = options.modelIndex ? "abandoned" : { idle };
        out = step(state, inputs, undefined, undefined, undefined, terminal, true);
      }
    }
    lines.push(tickLine(tick, inputs, terminal, true));
    messages.push(encodePublicMessage({ ...recorder.record(out), full: null }));
    state = out.state;
  }
  return { ...JSON.parse(JSON.stringify(matchRecord({ id, binary: gzipSync(packMessages(messages)), logLines: lines, endedAt: RECEIVED + 404, rerun: true }))), codeVersion: CODE };
}

const joinAs = (seat: number, colony?: 0 | 1): SimInput =>
  ({ type: "join", agentId: `seat-private-${seat}`, modelLabel: `model-${seat}`, ...(colony === undefined ? {} : { colony }) }) as SimInput;

/**
 * Seat 0's recorded commands are join 0, observe 1, set_brood 2, a refused set_brood 3 and, in one step, a repeat of
 * its brood 4 (no effect) then a change 5; seat 1 sets its brood at tick 1 and repeats it at tick 2, its index 2.
 */
function indexRecord(id: string) {
  return houseMatch(id, { idleTicks: 1000, stopAt: 4, calls: {
    0: [joinAs(0), joinAs(1)],
    1: [brood(1, "soldiers"), observe(0), brood(0, "soldiers"), brood(0, "nope")],
    2: [brood(1, "soldiers"), brood(0, "soldiers"), brood(0, "mixed")],
  } });
}

/** A 2v2 record of four players, alice and carol on colony 0, bob and dave on colony 1, its handles in that order. */
function teamRecord(id: string) {
  return houseMatch(id, { names: ["alice", "carol", "bob", "dave"], idleTicks: 1000, stopAt: 4, calls: {
    0: [joinAs(0, 0), joinAs(1, 0), joinAs(2, 1), joinAs(3, 1)],
  } });
}

/**
 * A finished 2-seat public match stopped at tick 4: seat 0 (colony 0) sets its brood at tick 1, sets the same
 * brood again at tick 2 (a command with no effect) and sends a refused set_brood at tick 3; seat 1 sets its brood at
 * tick 2. Its stored record carries re-run data with a house-idle clock far from any deadline, the game version and
 * two refused calls of seat 0. As in the real game, a call is answered at the tick after the step that ran it.
 */
function generatedRecord(id: string, names: readonly [string, string] = ["alice", "bob"], options: { callIdle?: boolean } = {}) {
  const built = houseMatch(id, { names, idleTicks: 1000, stopAt: 4, callIdle: options.callIdle, calls: {
    0: [0, 1].map(seat => ({ type: "join", agentId: `seat-private-${seat}`, modelLabel: `model-${seat}` }) as SimInput),
    1: [brood(0)], 2: [brood(0), brood(1)], 3: [brood(0, "nope")],
  } });
  return {
    ...built,
    replies: [
      { type: "stub", seat: 0, tick: null, tool: "join", receivedAt: RECEIVED - 50, answeredAt: RECEIVED - 49, code: "call_rate" },
      { type: "reply", seat: 0, tick: 4, tool: "set_brood", receivedAt: RECEIVED + 300, answeredAt: RECEIVED + 301, isError: true,
        reply: { error: { code: "bad_brood", message: "brood is one of workers, soldiers, mixed." } } },
      { type: "reply", seat: 1, tick: 3, tool: "set_brood", receivedAt: RECEIVED + 200, answeredAt: RECEIVED + 201, reply: { ok: true } },
      { type: "stub", seat: 1, tick: null, tool: "observe", receivedAt: RECEIVED - 40, answeredAt: RECEIVED - 39, code: "sdk_error" },
    ],
  };
}

/** A reply's body, read loosely: a refusal's fields are its error and message. */
const bodyOf = (reply: { body: unknown }) => reply.body as Record<string, any>;
const replayId = (n: number) => `2026-10-20T02-00-00-000Z-${n}`;
const versionsAnswering = (answer: VersionAnswer): VersionSource & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async lookup(commit) { asked.push(commit); return answer; } };
};

/** One world: accounts, a lobby per match, its registry row and stored record. */
function world(options: { versions?: VersionSource; jobs?: PostMortemJobs; cacheBytes?: number } = {}) {
  const w = retentionWorld(Date.parse("2026-10-20T00:00:00.000Z"));
  const records = new Map<string, Buffer>();
  const objects = new Map<string, ReplayObject>();
  const archive = createPrivateArchive({ create: async object => { objects.set(object.name, object); } },
    async name => { const o = objects.get(name); return o ? { body: Readable.from([Buffer.from(o.body)]), contentLength: String(o.body.length) } : null; },
    KEY);
  const history = { open: vi.fn(async (id: string) => records.has(id) ? Readable.from([records.get(id)!]) : null) };
  const versions = options.versions ?? versionsAnswering("found");
  // The meter is injected: these tests are about the re-run's path, not this machine's memory (post-mortem-jobs.test.ts).
  const jobs = options.jobs ?? createJobs({ log: () => {}, meter: () => ({ usedMiB: 100, totalMiB: 4096 }) });
  const registry = createWatchRegistry(w.store);
  const lobbies = createLobbies(w.store, w.ids);
  const postMortem = createPostMortem({ identities: w.ids, lobbies, registry, history, archive, versions, jobs, now: w.now, cacheBytes: options.cacheBytes });
  let lobbyCount = 0;
  /** A lobby of `seats` [identity, colony], its registry row and its stored record under id. */
  function match(n: number, seats: readonly (readonly [{ id: string; name: string }, 0 | 1])[], options: {
    visibility?: "public" | "private"; playbackFinished?: boolean; lobbyState?: string; record?: unknown; row?: boolean;
  } = {}) {
    const lobbyId = `00000000-0000-4000-8000-${String(++lobbyCount).padStart(12, "0")}`;
    const id = replayId(n);
    w.docs.set(`lobbies/${lobbyId}`, { kind: options.visibility ?? "public", size: "1", state: options.lobbyState ?? "ended", rated: "false", slot: "",
      seats: JSON.stringify(seats.map(([who, colony]) => ({ id: who.id, displayName: who.name, colony }))), creatorId: seats[0]?.[0].id ?? "",
      createdAt: String(w.now()), inviteVerifier: "", startsAt: "", matchRunId: "run-1", outcome: "colony_0_won", mode: "" });
    if (options.row !== false) {
      w.docs.set(`watchMatches/${lobbyId}`, { visibility: options.visibility ?? "public", rated: "false", mode: "",
        startedAt: String(RECEIVED).padStart(16, "0"), origin: "https://slot.example", slot: "public-0", runId: "run-1",
        playbackFinished: String(options.playbackFinished ?? true), replayId: id });
    }
    store(lobbyId, id, options.visibility ?? "public", options.record ?? generatedRecord(id));
    return { lobbyId, id };
  }
  /** Stores (or replaces, as the record service does) a match's record. */
  function store(lobbyId: string, id: string, visibility: "public" | "private", record: unknown) {
    const body = Buffer.from(JSON.stringify(record));
    if (visibility === "public") records.set(id, body);
    else {
      const identity = { lobbyId, replayId: id, kind: "match-record" } as const;
      objects.set(privateMediaName(identity), { name: privateMediaName(identity), body: sealPrivateMedia(identity, body, KEY), contentType: "application/octet-stream", ifGenerationMatch: 0 });
    }
  }
  return { w, postMortem, match, store, records, objects, history, versions, jobs };
}

/** Asks until no-effect has an answer, as a builder would: the first reply never waits for the re-run. */
async function settled(ask: () => ReturnType<ReturnType<typeof createPostMortem>["query"]>) {
  let reply = await ask();
  for (let i = 0; i < 400 && reply.ok && (bodyOf(reply).noEffect as { status: string }).status === "being_worked_out"; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    reply = await ask();
  }
  return reply;
}

describe("match_post_mortem", () => {
  it("shows a seat's owner its refused calls at once, then its no-effect command from the real re-run; another owner sees only its own seat", async () => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const { lobbyId, id } = f.match(18, [[alice, 0], [bob, 1]]);
    const first = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(first.ok).toBe(true);
    expect(first.body).toMatchObject({ matchId: id, lobbyId, refusedFrom: "calls", noEffect: { status: "being_worked_out" } });
    expect(bodyOf(first).seats).toEqual([{ seat: 0, colony: 0, refusedNotRetained: 0, refused: [
      { tick: null, at: new Date(RECEIVED - 50).toISOString(), tool: "join", code: "call_rate" },
      { tick: 4, tickBasis: "answered at tick", viewerTick: 4, viewerSeconds: 0.4, at: new Date(RECEIVED + 300).toISOString(), tool: "set_brood", code: "bad_brood" },
    ] }]);
    expect(first.body).not.toHaveProperty("timeNote");
    const done = await settled(() => f.postMortem.query({ key: alice.key, matchId: id }));
    expect(bodyOf(done).noEffect).toEqual({ status: "shown", note: NO_EFFECT_NOTE,
      commands: [{ seat: 0, commandIndex: 2, type: "set_brood", tick: 2, tickBasis: "simulation step", viewerTick: 3, viewerSeconds: 0.3 }] });
    expect((f.versions as ReturnType<typeof versionsAnswering>).asked).toEqual([CODE]);
    // The same cached record, filtered to bob's own seat: none of alice's calls or findings.
    const other = await f.postMortem.query({ key: bob.key, lobbyId });
    expect(bodyOf(other).seats).toEqual([{ seat: 1, colony: 1, refusedNotRetained: 0, refused: [
      { tick: null, at: new Date(RECEIVED - 40).toISOString(), tool: "observe", code: "sdk_error" }] }]);
    expect(bodyOf(other).noEffect).toEqual({ status: "shown", note: NO_EFFECT_NOTE, commands: [] });
  }, 60_000);

  // Credible regression: the index dropped, the wrong one of two same-type commands in one step listed, or a counter
  // other than the seat's own recorded commands (across seats 7, accepted or non-observe only 3, within the step 1 or 0).
  it("names each no-effect command by its index in its seat's recorded commands, telling apart same-type commands of one step", async () => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const { lobbyId, id } = f.match(80, [[alice, 0], [bob, 1]], { record: indexRecord(replayId(80)) });
    const mine = await settled(() => f.postMortem.query({ key: alice.key, lobbyId }));
    expect((bodyOf(mine).seats as { refused: { code: string }[] }[])[0]!.refused.map(r => r.code)).toEqual(["bad_brood"]);
    expect(bodyOf(mine).noEffect).toEqual({ status: "shown", note: NO_EFFECT_NOTE,
      commands: [{ seat: 0, commandIndex: 4, type: "set_brood", tick: 2, tickBasis: "simulation step", viewerTick: 3, viewerSeconds: 0.3 }] });
    const theirs = await settled(() => f.postMortem.query({ key: bob.key, matchId: id }));
    expect(bodyOf(theirs).noEffect).toEqual({ status: "shown", note: NO_EFFECT_NOTE,
      commands: [{ seat: 1, commandIndex: 2, type: "set_brood", tick: 2, tickBasis: "simulation step", viewerTick: 3, viewerSeconds: 0.3 }] });
  }, 60_000);

  it("refuses a non-owner by match id exactly as an unknown match, before reading any record", async () => {
    const f = world();
    const alice = f.w.played("alice"), mallory = f.w.played("mallory");
    const { id } = f.match(18, [[alice, 0]]);
    const refusals = await Promise.all([
      f.postMortem.query({ key: mallory.key, matchId: id }),
      f.postMortem.query({ key: mallory.key, matchId: replayId(99) }), f.postMortem.query({ key: mallory.key, matchId: "not-an-id" }),
    ]);
    for (const refusal of refusals) expect(JSON.stringify(refusal)).toBe(JSON.stringify({ ok: false, body: { error: "not_found", message: REFUSALS.not_found } }));
    expect(f.history.open).not.toHaveBeenCalledWith(id, expect.anything());
  });

  // Credible regression: a lobby-id refusal that tells an unknown, empty, live or someone else's lobby apart, or says
  // "not ended" before ownership is proven.
  it("refuses by lobby id, byte for byte the same, every lobby whose ownership is not proven, before saying whether it ended", async () => {
    const f = world();
    const alice = f.w.played("alice"), mallory = f.w.played("mallory");
    const ended = f.match(18, [[alice, 0]]);
    const live = f.match(19, [[alice, 0]], { lobbyState: "holding", row: false });
    const empty = f.match(20, []);
    const unreadable = f.match(21, [[alice, 0]]);
    f.w.docs.set(`lobbies/${unreadable.lobbyId}`, { ...f.w.docs.get(`lobbies/${unreadable.lobbyId}`)!, seats: "not json" });
    const refusals = await Promise.all([
      f.postMortem.query({ key: mallory.key, lobbyId: ended.lobbyId }), f.postMortem.query({ key: mallory.key, lobbyId: live.lobbyId }),
      f.postMortem.query({ key: alice.key, lobbyId: empty.lobbyId }), f.postMortem.query({ key: alice.key, lobbyId: unreadable.lobbyId }),
      f.postMortem.query({ key: mallory.key, lobbyId: "00000000-0000-4000-8000-999999999999" }),
    ]);
    for (const refusal of refusals) expect(JSON.stringify(refusal)).toBe(JSON.stringify({ ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } }));
    // The owner of the live lobby still hears that it has not ended.
    expect((await f.postMortem.query({ key: alice.key, lobbyId: live.lobbyId })).body.error).toBe("not_ended");
    expect(f.history.open).not.toHaveBeenCalled();
  });

  // Credible regression: a linked lobby with no recorded seats answered as not found instead of unconfirmed.
  it("cannot confirm ownership by match id when the linked lobby recorded no seats", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const { id } = f.match(22, []);
    expect(await f.postMortem.query({ key: alice.key, matchId: id })).toEqual({ ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } });
  });

  it("reads no lobby, registry row or record for a key that is not valid", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(18, [[alice, 0]]);
    f.w.reads.length = 0;
    expect(await f.postMortem.query({ key: "not-a-key", lobbyId })).toEqual({ ok: false, body: { error: "invalid_key", message: REFUSALS.invalid_key } });
    expect(f.w.reads.filter(path => !path.startsWith("keys/"))).toEqual([]);
    expect(f.history.open).not.toHaveBeenCalled();
  });

  it("refuses its owner before the match has ended and while its delayed playback runs", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const live = f.match(18, [[alice, 0]], { lobbyState: "holding", row: false });
    const delayed = f.match(19, [[alice, 0]], { playbackFinished: false });
    expect((await f.postMortem.query({ key: alice.key, lobbyId: live.lobbyId })).body.error).toBe("not_ended");
    expect((await f.postMortem.query({ key: alice.key, lobbyId: delayed.lobbyId })).body.error).toBe("not_ended");
    expect((await f.postMortem.query({ key: alice.key, matchId: delayed.id })).body.error).toBe("not_ended");
    expect(f.history.open).not.toHaveBeenCalled();
  });

  it("does not let an account holding another player's released name reach that player's post-mortem", async () => {
    const f = world();
    const original = f.w.played("alice");
    const { lobbyId } = f.match(18, [[original, 0]]);
    f.w.at(f.w.now() + 90 * 86_400_000);
    const claimed = await f.w.ids.claimUsername("alice");
    if (!claimed.ok) throw new Error(claimed.reason);
    expect(claimed.value.identity.displayName).toBe("alice");
    expect(claimed.value.identity.id).not.toBe(original.id);
    expect((await f.postMortem.query({ key: claimed.value.key, lobbyId })).body.error).toBe("ownership_unconfirmed");
    expect((await f.postMortem.query({ key: claimed.value.key, matchId: replayId(18) })).body.error).toBe("not_found");
    // The seat's own identity still reads it.
    expect((await f.postMortem.query({ key: original.key, lobbyId })).ok).toBe(true);
  });

  it("cannot confirm ownership when the match's link or lobby can't be read now", async () => {
    for (const broken of ["replayLobby", "read", "readLobby"] as const) {
      const f = world();
      const alice = f.w.played("alice");
      const { lobbyId, id } = f.match(18, [[alice, 0]]);
      const store = f.w.store;
      const original = { query: store.query, get: store.get };
      if (broken === "replayLobby") store.query = async () => { throw new Error("store unavailable"); };
      else store.get = async path => { if (path.startsWith(broken === "read" ? "watchMatches/" : "lobbies/")) throw new Error("store unavailable"); return original.get(path); };
      const reply = await f.postMortem.query({ key: alice.key, ...(broken === "replayLobby" ? { matchId: id } : { lobbyId }) });
      expect(reply).toEqual({ ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } });
    }
  });

  // A test that can fail: attributing this record to its seat handle, which names the caller, would serve it.
  it("refuses a stored match with no recorded seat identity, even when its seat names the caller", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const id = replayId(77);
    f.records.set(id, Buffer.from(JSON.stringify(generatedRecord(id, ["alice", "alice"]))));
    expect(await f.postMortem.query({ key: alice.key, matchId: id })).toEqual({ ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } });
  });

  it("says no-effect commands are not available, still showing refused calls, for a private match, a record without re-run data and one that does not reproduce", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const base = generatedRecord(replayId(30));
    const noRerun = { ...generatedRecord(replayId(31)), rerun: undefined };
    const tampered = generatedRecord(replayId(32));
    tampered.seats[0].commands[2].accepted = false;
    const cases = [
      [f.match(30, [[alice, 0]], { visibility: "private", record: base }), "private"],
      [f.match(31, [[alice, 0]], { record: noRerun }), "re-run data"],
      [f.match(32, [[alice, 0]], { record: tampered }), "did not reproduce"],
    ] as const;
    for (const [{ lobbyId }, reason] of cases) {
      const reply = await settled(() => f.postMortem.query({ key: alice.key, lobbyId }));
      expect(bodyOf(reply).noEffect).toMatchObject({ status: "not_available" });
      expect((bodyOf(reply).noEffect as { reason: string }).reason).toContain(reason);
      expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
    }
  }, 60_000);

  it("answers a version not in main's history as not available, and an unreadable history as try later", async () => {
    for (const [answer, status] of [["absent", "not_available"], ["unavailable", "not_computed_now"]] as const) {
      const f = world({ versions: versionsAnswering(answer) });
      const alice = f.w.played("alice");
      const { lobbyId } = f.match(18, [[alice, 0]]);
      const reply = await settled(() => f.postMortem.query({ key: alice.key, lobbyId }));
      expect(bodyOf(reply).noEffect).toMatchObject({ status });
      expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
    }
  });

  it("serves refused calls promptly while one match's re-run runs and another's waits in the queue", async () => {
    const gate = join(mkdtempSync(join(tmpdir(), "antwar-pm-gate-")), "open");
    dirs.push(join(gate, ".."));
    // A real child held on a gate, then answering as a reproduced re-run with no findings.
    const jobs = createJobs({ log: () => {}, meter: () => ({ usedMiB: 100, totalMiB: 4096 }), forkChild: () => {
      const child = spawn(process.execPath, ["-e", `
        const { existsSync } = require("node:fs");
        process.stdin.resume();
        process.once("message", () => { const t = setInterval(() => { process.send({ kind: "progress", tick: 0 });
          if (existsSync(${JSON.stringify(gate)})) { clearInterval(t); process.send({ kind: "done", tested: 0, findings: [], undecided: [] }, () => process.exit(0)); } }, 20); });`],
        { stdio: ["pipe", "ignore", "inherit", "ipc"] });
      children.push(child);
      return child;
    } });
    const f = world({ jobs });
    const alice = f.w.played("alice");
    const a = f.match(40, [[alice, 0]]), b = f.match(41, [[alice, 0]]), c = f.match(42, [[alice, 0]], { record: { ...generatedRecord(replayId(42)), rerun: undefined } });
    await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId });
    await vi.waitFor(() => expect(jobs.pending(a.id)).toBeDefined());
    await f.postMortem.query({ key: alice.key, lobbyId: b.lobbyId });
    await vi.waitFor(() => expect(jobs.pending(b.id)).toBeDefined());
    for (const { lobbyId } of [a, b, c]) {
      const started = performance.now();
      const reply = await f.postMortem.query({ key: alice.key, lobbyId });
      const ms = performance.now() - started;
      expect(ms).toBeLessThan(30_000);
      expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
      expect((bodyOf(reply).noEffect as { status: string }).status).toBe(lobbyId === c.lobbyId ? "not_available" : "being_worked_out");
    }
    writeFileSync(gate, "");
    expect(existsSync(gate)).toBe(true);
    for (const { lobbyId } of [a, b]) {
      expect(bodyOf((await settled(() => f.postMortem.query({ key: alice.key, lobbyId })))).noEffect).toEqual({ status: "shown", note: NO_EFFECT_NOTE, commands: [] });
    }
  }, 60_000);
});

describe("which record seats a caller owns", () => {
  const lobby = (seats: [string, string, 0 | 1][]) => ({ colonies: [0, 1].map(colony => seats.filter(s => s[2] === colony).map(([id, displayName]) => ({ id, displayName }))) as never });
  const seat = (n: number, colony: 0 | 1, handle: string | null) => ({ seat: n, colony, handle });

  it("gives the one identity of a colony every record seat of that colony, whatever their handles", () => {
    expect(ownedSeats(lobby([["a", "alice", 0], ["a", "alice", 0], ["b", "bob", 1], ["b", "bob", 1]]), "a",
      [seat(0, 0, "alice"), seat(1, 0, null), seat(2, 1, "bob"), seat(3, 1, "bob")])).toEqual([0, 1]);
    expect(ownedSeats(lobby([["a", "alice", 0], ["b", "bob", 1]]), "a", [seat(0, 0, "someone else"), seat(1, 1, null)])).toEqual([0]);
  });
  // Credible regression: binding seats by name or position in a colony of several identities.
  it("serves no seat of a colony of several identities, even one named after the caller", () => {
    expect(() => ownedSeats(lobby([["a", "alice", 0], ["c", "carol", 0]]), "a", [seat(0, 0, "alice"), seat(1, 0, "carol")])).toThrow();
    expect(ownedSeats(lobby([["a", "alice", 0], ["a", "alice", 1], ["c", "carol", 1]]), "a", [seat(0, 0, "alice"), seat(1, 1, "alice"), seat(2, 1, "carol")])).toEqual([0]);
  });
  it("cannot confirm when the caller's colony has no record seat", () => {
    expect(() => ownedSeats(lobby([["a", "alice", 0], ["b", "bob", 1]]), "a", [seat(0, 1, "bob")])).toThrow();
  });
});

/**
 * Seat 0 sets its brood at tick 1; under a house idle limit of 5 ticks its deadline is tick 6. At `at` it sets the same
 * brood again, which changes nothing in the game, beside `observes` observes of its own; seat 1 observes every tick and
 * stays awake. `lines` are seat 0's observe reply and stub lines, answered at at + 1 beside its set_brood reply.
 */
function deadlineRecord(id: string, lines: readonly Record<string, unknown>[], options: { at?: number; observes?: number; modelIndex?: boolean; names?: readonly [string, string]; callIdle?: boolean } = {}) {
  const at = options.at ?? 6, observes = options.observes ?? lines.filter(l => l.tool !== "set_brood" && l.code !== "call_rate").length;
  const calls: Record<number, SimInput[]> = { 0: [0, 1].map(seat => ({ type: "join", agentId: `seat-private-${seat}`, modelLabel: `model-${seat}` }) as SimInput) };
  for (let tick = 1; tick <= 9; tick++) calls[tick] = [observe(1)];
  calls[1] = [brood(0), observe(1)];
  calls[at] = [brood(0), ...Array.from({ length: observes }, () => observe(0)), observe(1)];
  const built = houseMatch(id, { idleTicks: 5, stopAt: 9, calls, modelIndex: options.modelIndex, names: options.names, callIdle: options.callIdle });
  const answered = { seat: 0, tick: at + 1, receivedAt: RECEIVED + at * 100, answeredAt: RECEIVED + at * 100 + 1 };
  return { ...built, replies: [{ type: "reply", ...answered, tool: "set_brood", arguments: { brood: "workers" }, reply: { ok: true } },
    ...lines.map(line => ({ ...answered, ...line }))] };
}
/** Seat 0's observe reply line: its stored arguments (none when undefined) and its error code (null: it succeeded). */
const obs = (args: Record<string, unknown> | undefined, code: string | null = null) => ({ type: "reply", tool: "observe",
  ...(args === undefined ? {} : { arguments: args }), ...(code === null ? { reply: { ok: true } } : { isError: true, reply: { error: { code, message: "x" } } }) });
const stub = (code: string | null, tool = "observe") => ({ type: "stub", tool, code });

/** The seat-level answer seat 0's owner reads: whether its deadline-tick command is listed, and the omission sentence. */
async function seatAnswer(record: Record<string, unknown>, at = 6, owned: readonly number[] = [0]) {
  const scan = await scanRecord(Readable.from([Buffer.from(JSON.stringify(record))]), undefined, "rerun");
  const answer: ChildMessage = rerunRecord(scan.reduced);
  if (answer.kind !== "done") return { answer: answer.kind };
  const shown = ownNoEffect(noEffectOf({ kind: "findings", tested: answer.tested, findings: answer.findings, undecided: answer.undecided }), new Set(owned), false, 10) as
    { commands: { seat: number; tick: number }[]; notListed?: string };
  return { listed: shown.commands.some(c => c.seat === 0 && c.tick === at), notListed: shown.notListed ?? null };
}
const LISTED = { listed: true, notListed: null };
const IDLE = { listed: false, notListed: null };
const UNDECIDABLE = { listed: false, notListed: undecidedSentence(1) };

describe("a command on its seat's idle deadline (report-0266d09b, report-9f076091)", () => {
  // The control: one tick before the deadline the same command is judged by itself, whatever its observe says.
  it("judges the command normally off the deadline tick", async () => {
    expect(await seatAnswer(deadlineRecord(replayId(200), [obs({ since: 3 })], { at: 5 }), 5)).toEqual(LISTED);
  });

  // Credible regression: a cursor observe judged from its own reply alone.
  it.each([
    ["c1: a bad_cells_cursor observe beside only the command's reply: idle", [obs({ cellsCursor: "s:1" }, "bad_cells_cursor")], IDLE],
    ["c2: beside an ok observe with since: undecidable", [obs({ cellsCursor: "s:1" }, "bad_cells_cursor"), obs({ since: 3 })], UNDECIDABLE],
    ["c3: beside an ok cursor observe: undecidable", [obs({ cellsCursor: "s:1" }, "bad_cells_cursor"), obs({ cellsCursor: "s:2" })], UNDECIDABLE],
    ["c4: beside a plain ok observe: active", [obs({ cellsCursor: "s:1" }, "bad_cells_cursor"), obs(undefined)], LISTED],
  ] as const)("%s", async (_name, lines, expected) => {
    expect(await seatAnswer(deadlineRecord(replayId(201), lines))).toEqual(expected);
  });

  // Credible regression: a decided reply counted as uncertain, hiding a valid finding.
  it.each([
    ["p1: bad_event_cursor carrying since and cellsCursor", [obs({ since: 9, cellsCursor: "s:1" }, "bad_event_cursor")]],
    ["p2: bad_arguments carrying cellsCursor", [obs({ cellsCursor: "s:1" }, "bad_arguments")]],
    ["p3: a bad_arguments stub", [stub("bad_arguments")]],
  ] as const)("settles %s as not counting: idle, not listed, no sentence", async (_name, lines) => {
    expect(await seatAnswer(deadlineRecord(replayId(202), lines))).toEqual(IDLE);
  });

  // The decided-activity error test (report-0266d09b): an error reply that still counted must not withhold the command.
  it.each([
    ["observe_reply_too_large without since or cellsCursor", [obs(undefined, "observe_reply_too_large")]],
    ["the same with empty arguments", [obs({}, "observe_reply_too_large")]],
    ["an ok rules read", [{ type: "reply", tool: "rules", reply: { ok: true } }]],
  ] as const)("counts %s as activity: listed, no sentence", async (_name, lines) => {
    expect(await seatAnswer(deadlineRecord(replayId(203), lines))).toEqual(LISTED);
  });

  // Credible regression: an unknown code assumed to be activity, a false no-effect claim.
  it.each([
    ["an unrecognized code without since or cellsCursor", [obs(undefined, "a_future_code")]],
    ["an ok observe with since", [obs({ since: 3 })]],
    ["an ok cursor observe", [obs({ cellsCursor: "s:1" })]],
    ["a stub with code null", [stub(null)]],
    ["a stub with observe_reply_too_large", [stub("observe_reply_too_large")]],
    ["an ok observe whose arguments the record trimmed", [{ ...obs({ since: 3 }), trimmed: ["arguments"] }]],
    ["an observe the lines do not account for", []],
  ] as const)("leaves %s undecidable: not listed, sentence with N = 1", async (_name, lines) => {
    const record = deadlineRecord(replayId(204), lines, { observes: 1 });
    expect(await seatAnswer(record)).toEqual(UNDECIDABLE);
  });

  it("ignores a call_rate stub, which reaches no simulation step", async () => {
    expect(await seatAnswer(deadlineRecord(replayId(205), [obs(undefined), stub("call_rate")]))).toEqual(LISTED);
    expect(await seatAnswer(deadlineRecord(replayId(206), [obs({ cellsCursor: "s:1" }, "bad_cells_cursor"), stub("call_rate")]))).toEqual(IDLE);
  });

  it("treats a command that kept its seat awake as an effect in the Model Index too", async () => {
    expect(await seatAnswer(deadlineRecord(replayId(207), [obs({ cellsCursor: "s:1" }, "bad_cells_cursor")], { modelIndex: true }))).toEqual(IDLE);
  });

  // Credible regression: a count summed match-wide, or taken from unfiltered findings.
  it("shows the omission count only to the owner of the seat it belongs to, summed over that owner's seats", async () => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const lines = [obs({ cellsCursor: "s:1" }, "bad_cells_cursor"), obs({ since: 3 })];
    const pair = f.match(208, [[alice, 0], [bob, 1]], { record: deadlineRecord(replayId(208), lines) });
    const mine = bodyOf(await settled(() => f.postMortem.query({ key: alice.key, lobbyId: pair.lobbyId })));
    expect(mine.noEffect).toMatchObject({ status: "shown", notListed: undecidedSentence(1) });
    expect((mine.noEffect.commands as { tick: number }[]).some(c => c.tick === 6)).toBe(false);
    const theirs = await settled(() => f.postMortem.query({ key: bob.key, lobbyId: pair.lobbyId }));
    expect(bodyOf(theirs).noEffect).toEqual({ status: "shown", note: NO_EFFECT_NOTE, commands: [] });
    expect(JSON.stringify(theirs)).not.toMatch(/not listed|notListed|undecided/);
    const both = f.match(209, [[alice, 0], [alice, 1]], { record: deadlineRecord(replayId(209), lines, { names: ["alice", "alice"] }) });
    expect(bodyOf(await settled(() => f.postMortem.query({ key: alice.key, lobbyId: both.lobbyId }))).noEffect).toMatchObject({ notListed: undecidedSentence(1) });
  }, 60_000);
});

/** An independent re-run over the fully parsed record: each tick from the seats' commands, without the reduced record. */
function fullRecordFindings(record: Record<string, any>) {
  const commands = new Map<number, { seat: number; c: any; index: number }[]>();
  for (const seat of record.seats) seat.commands.forEach((c: any, index: number) => commands.set(c.tick, [...(commands.get(c.tick) ?? []), { seat: seat.seat, c, index }]));
  const order = record.events.filter((e: any) => e.event.kind === "call").map((e: any) => [e.tick, e.event.agent]);
  let state: SimState = createMatch(record.rerun.seed, record.rules.config);
  const found: { seat: number; tick: number; type: string }[] = [];
  while (state.result === null) {
    const tick = state.tick, pool = [...(commands.get(tick) ?? [])];
    const calls: { seat: number; c: any; index: number }[] = order.filter(([t]: number[]) => t === tick)
      .map(([, seat]: number[]) => pool.splice(pool.findIndex(x => x.seat === seat), 1)[0]!);
    const inputs = calls.map(x => ({ ...x.c.request, agentId: `seat-${x.seat}` }) as SimInput);
    const idle = record.rerun.idle.find((x: any) => x.tick === tick);
    const terminal = (idle ? { idle: idle.colonies } : record.rerun.abandonments.includes(tick) ? "abandoned" : record.rerun.stops.includes(tick)) as ServerTerminal;
    const out = step(state, inputs, undefined, undefined, undefined, terminal, true);
    calls.forEach((x, i) => {
      if (!x.c.accepted || ["observe", "join", "rejoin"].includes(x.c.type)) return;
      const without = step(state, inputs.filter((_, j) => j !== i), undefined, undefined, undefined, terminal, true);
      if (sameState(out.state, without.state, `seat-${x.seat}`)) found.push({ seat: x.seat, tick, type: x.c.type });
    });
    state = out.state;
  }
  return found;
}


describe("the reproduction gate and the idle data", () => {
  const answerOf = async (record: Record<string, any>, size = 4096) => {
    const bytes = Buffer.from(JSON.stringify(record));
    async function* chunked() { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); }
    return rerunRecord((await scanRecord(chunked(), undefined, "rerun")).reduced);
  };

  it("reproduces a stored record read in any chunking", async () => {
    for (const size of [7, 333, 65536]) {
      expect(await answerOf(generatedRecord(replayId(210)), size)).toMatchObject({ kind: "done", findings: [{ seat: 0, tick: 2, type: "set_brood" }], undecided: [] });
    }
  });

  // Credible regression: findings from a re-run whose calls all agree but whose events or result do not (report: the
  // result alone can match a different history).
  it.each([
    ["a changed stored event", (r: Record<string, any>) => { const e = r.events.find((x: any) => x.event.kind !== "call"); e.event.extra = 1; }],
    ["a stored event the re-run never produces", (r: Record<string, any>) => { r.events.push({ tick: 250, event: { kind: "note" } }); }],
    ["a missing stored event", (r: Record<string, any>) => { r.events.pop(); }],
    ["a changed result field", (r: Record<string, any>) => { r.result.decidedBy = "something else"; }],
  ])("does not reproduce %s", async (_name, tamper) => {
    const record = generatedRecord(replayId(211));
    tamper(record);
    expect((await answerOf(record)).kind).toBe("mismatch");
  });

  it("leaves rating changes, a join's identity and a call's activity tick out of the comparison", async () => {
    const record = generatedRecord(replayId(212));
    record.result.ratingChanges = [{ seat: 0, delta: 3 }];
    expect(await answerOf(record)).toMatchObject({ kind: "done" });
  });

  // Ruling 2 (report-9f076091): no default idle threshold is assumed.
  it("answers no-effect not available, still showing refused calls, when the record lacks its idle data", async () => {
    const noThreshold = generatedRecord(replayId(213));
    delete noThreshold.setup.houseIdleTicks;
    expect(await answerOf(noThreshold)).toEqual({ kind: "no_idle_data" });
    const noActivity = generatedRecord(replayId(214));
    delete noActivity.events.find((e: any) => e.event.kind === "call").event.houseActivityTick;
    expect(await answerOf(noActivity)).toEqual({ kind: "no_idle_data" });
    const f = world();
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(213, [[alice, 0]], { record: noThreshold });
    const reply = bodyOf(await settled(() => f.postMortem.query({ key: alice.key, lobbyId })));
    expect(reply.noEffect).toMatchObject({ status: "not_available" });
    expect(reply.noEffect.reason).toContain("idle-clock data");
    expect(reply.seats[0].refused).toHaveLength(2);
  }, 60_000);

  // Credible regression: the reduced record dropping or misordering a command the full record holds.
  it("finds from the reduced record exactly what a re-run of the full record finds", async () => {
    for (const record of [generatedRecord(replayId(215)), deadlineRecord(replayId(216), [obs(undefined)], { at: 5 })]) {
      const answer = await answerOf(record);
      expect(answer.kind).toBe("done");
      expect((answer as { findings: { seat: number; tick: number; type: string }[] }).findings.map(({ seat, tick, type }) => ({ seat, tick, type })))
        .toEqual(fullRecordFindings(record));
    }
  });
});

it("refuses as ownership unconfirmed a match whose stored link names a lobby that can't be read", async () => {
  const f = world();
  const alice = f.w.played("alice");
  const { lobbyId, id } = f.match(220, [[alice, 0]]);
  f.w.docs.delete(`lobbies/${lobbyId}`);
  expect(await f.postMortem.query({ key: alice.key, matchId: id })).toEqual({ ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } });
  expect(await f.postMortem.query({ key: alice.key, lobbyId })).toEqual({ ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } });
  expect(f.history.open).not.toHaveBeenCalled();
});

it("adds the call-idle sentence where any call keeps a seat awake", () => {
  const shown = { status: "shown", commands: [], undecided: [] } as const;
  expect(ownNoEffect(shown, new Set([0]), true, 10)).toEqual({ status: "shown", note: `${NO_EFFECT_NOTE} ${CALL_IDLE_NOTE}`, commands: [] });
  expect(ownNoEffect(shown, new Set([0]), false, 10)).toEqual({ status: "shown", note: NO_EFFECT_NOTE, commands: [] });
});

const UNCONFIRMED = { ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } };
const seatsOf = (reply: { body: unknown }) => (bodyOf(reply).seats as { seat: number }[]).map(s => s.seat);

describe("ownership by the lobby's seat identities alone (report-ee0b8157)", () => {
  for (const visibility of ["public", "private"] as const) {
    // Credible regression: binding a seat by its recorded handle or position when its colony held several identities.
    it(`refuses every identity of a colony of several, byte for byte, and serves a colony of one (${visibility})`, async () => {
      const f = world();
      const alice = f.w.played("alice"), bob = f.w.played("bob"), carol = f.w.played("carol");
      const mixed = f.match(60, [[alice, 0], [carol, 0], [bob, 1]], { visibility });
      for (const key of [alice.key, carol.key]) {
        for (const ask of [{ lobbyId: mixed.lobbyId }, { matchId: mixed.id }]) {
          expect(JSON.stringify(await f.postMortem.query({ key, ...ask }))).toBe(JSON.stringify(UNCONFIRMED));
        }
      }
      // The control: bob alone in his colony of the same match is served his seat.
      expect(seatsOf(await f.postMortem.query({ key: bob.key, lobbyId: mixed.lobbyId }))).toEqual([1]);
      const single = f.match(61, [[alice, 0], [bob, 1]], { visibility });
      expect(seatsOf(await f.postMortem.query({ key: alice.key, lobbyId: single.lobbyId }))).toEqual([0]);
    }, 60_000);
  }

  it("serves a colony of one identity whatever handles the record holds, named or none, and never by name", async () => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const named = f.match(62, [[alice, 0], [bob, 1]], { record: generatedRecord(replayId(62), ["someone", "else"]) });
    const unnamed = generatedRecord(replayId(63));
    for (const seat of unnamed.seats) seat.handle = null;
    const none = f.match(63, [[alice, 0], [bob, 1]], { record: unnamed });
    for (const { lobbyId } of [named, none]) expect(seatsOf(await f.postMortem.query({ key: alice.key, lobbyId }))).toEqual([0]);
  });

  it("serves a queue match's colony of one identity holding two seats, and a caller split across colonies only its colony of one", async () => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob"), carol = f.w.played("carol");
    const queue = f.match(64, [[alice, 0], [alice, 0], [bob, 1], [bob, 1]]);
    expect(seatsOf(await f.postMortem.query({ key: alice.key, lobbyId: queue.lobbyId }))).toEqual([0]);
    expect(seatsOf(await f.postMortem.query({ key: bob.key, matchId: queue.id }))).toEqual([1]);
    const split = f.match(65, [[alice, 0], [alice, 1], [carol, 1]]);
    expect(seatsOf(await f.postMortem.query({ key: alice.key, lobbyId: split.lobbyId }))).toEqual([0]);
  });

  // Credible regression: pairing a team colony's players to its record seats by name or order when their counts match.
  it.each(["public", "private"] as const)("refuses every player of a %s team lobby whose colonies each hold different players", async visibility => {
    const f = world();
    const alice = f.w.played("alice"), carol = f.w.played("carol"), bob = f.w.played("bob"), dave = f.w.played("dave");
    const team = f.match(81, [[alice, 0], [carol, 0], [bob, 1], [dave, 1]], { visibility, record: teamRecord(replayId(81)) });
    for (const key of [alice.key, carol.key, bob.key, dave.key]) {
      for (const ask of [{ lobbyId: team.lobbyId }, { matchId: team.id }]) {
        expect(JSON.stringify(await f.postMortem.query({ key, ...ask }))).toBe(JSON.stringify(UNCONFIRMED));
      }
    }
  });

  it("cannot confirm ownership by match id when the lobby's seat entries can't be read", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(66, [[alice, 0]]);
    f.w.docs.set(`lobbies/${lobbyId}`, { ...f.w.docs.get(`lobbies/${lobbyId}`)!, seats: "not json" });
    expect(await f.postMortem.query({ key: alice.key, matchId: id })).toEqual(UNCONFIRMED);
  });
});

describe("records that are unavailable, replaced, or fail authentication", () => {
  const unavailable = (id: string) => ({ id, status: "unavailable", source: "unavailable" });

  // Credible regression: an unavailable record kept as an empty summary, or its refusal turned into unreadable by the
  // private read's wrapper.
  it.each(["public", "private"] as const)("refuses an unavailable %s record as unavailable, keeps nothing, and serves it once a complete record replaces it", async visibility => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const { lobbyId, id } = f.match(70, [[alice, 0], [bob, 1]], { visibility, record: unavailable(replayId(70)) });
    expect(await f.postMortem.query({ key: alice.key, lobbyId })).toEqual({ ok: false, body: { error: "record_unavailable", message: REFUSALS.record_unavailable } });
    f.store(lobbyId, id, visibility, generatedRecord(id));
    const reply = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(reply.ok).toBe(true);
    expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
  });

  // Credible regression: reading what an unauthenticated private record says before its tag has verified.
  it("keeps a private record that fails authentication unreadable, even when its content says unavailable", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(71, [[alice, 0]], { visibility: "private", record: unavailable(replayId(71)) });
    const name = privateMediaName({ lobbyId, replayId: id, kind: "match-record" });
    const object = f.objects.get(name)!;
    const body = Buffer.from(object.body);
    body[body.length - 1] ^= 1;
    f.objects.set(name, { ...object, body });
    expect(await f.postMortem.query({ key: alice.key, lobbyId })).toEqual({ ok: false, body: { error: "record_unreadable", message: REFUSALS.record_unreadable } });
  });

  it("says no-effect commands are not available, still showing refused calls, for a record with no game version", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const record: Record<string, unknown> = generatedRecord(replayId(72));
    delete record.codeVersion;
    const { lobbyId } = f.match(72, [[alice, 0]], { record });
    const reply = bodyOf(await settled(() => f.postMortem.query({ key: alice.key, lobbyId })));
    expect(reply.noEffect).toEqual({ status: "not_available", reason: "This match's game version is unknown." });
    expect(reply.seats[0].refused).toHaveLength(2);
  });
});

/** Jobs whose re-runs the test settles: each re-run queued is recorded, and runs until finished. */
function heldJobs() {
  const runs = new Map<string, { outcome: Promise<RerunOutcome>; settle: (o: RerunOutcome) => void; done: boolean }>();
  const started: string[] = [];
  const jobs: PostMortemJobs = {
    scan: run => run(),
    rerun(id) {
      const live = runs.get(id);
      if (live && !live.done) return { state: "running", outcome: live.outcome };
      started.push(id);
      let settle!: (o: RerunOutcome) => void;
      const run = { outcome: new Promise<RerunOutcome>(resolve => { settle = resolve; }), settle: (o: RerunOutcome) => { run.done = true; settle(o); }, done: false };
      runs.set(id, run);
      return { state: "running", outcome: run.outcome };
    },
    pending: id => { const run = runs.get(id); return run && !run.done ? run.outcome : undefined; },
  };
  return { jobs, started, finish: (id: string, outcome: RerunOutcome) => runs.get(id)!.settle(outcome) };
}

describe("a summary too large to keep", () => {
  // Credible regression: a reply that depends on its summary being kept, which an oversized summary never is.
  it("still answers its refused calls at once, and its re-run's no-effect answer across later asks", async () => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const record = generatedRecord(replayId(80));
    // About 10 MiB of seat 0's refused calls: more than the 8 MiB the post-mortem keeps.
    for (let i = 0; i < 120_000; i++) record.replies.push({ type: "stub", seat: 0, tick: null, tool: "observe", receivedAt: RECEIVED + 1000 + i, answeredAt: RECEIVED + 1001 + i, code: "call_rate" });
    const { lobbyId } = f.match(80, [[alice, 0], [bob, 1]], { record });
    const first = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(first.ok).toBe(true);
    expect((bodyOf(first).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(120_002);
    const done = await settled(() => f.postMortem.query({ key: alice.key, lobbyId }));
    expect(bodyOf(done).noEffect).toMatchObject({ status: "shown", commands: [{ seat: 0, tick: 2, type: "set_brood" }] });
    expect((bodyOf(done).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(120_002);
  }, 120_000);

  // Credible regression: a no-effect answer lost with its dropped summary, so each ask re-runs the match again.
  it("re-runs each of two such matches once, asked in turn, and keeps both answers", async () => {
    const held = heldJobs();
    // Room for both matches' no-effect answers, never for a summary.
    const f = world({ jobs: held.jobs, cacheBytes: 1000 });
    const alice = f.w.played("alice");
    const big = (n: number) => {
      const record = generatedRecord(replayId(n));
      for (let i = 0; i < 20; i++) record.replies.push({ type: "stub", seat: 0, tick: null, tool: "observe", receivedAt: RECEIVED + 1000 + i, answeredAt: RECEIVED + 1001 + i, code: "call_rate" });
      return f.match(n, [[alice, 0]], { record });
    };
    const a = big(81), b = big(82);
    const ask = async (lobbyId: string) => {
      const reply = await f.postMortem.query({ key: alice.key, lobbyId });
      expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(22);
      return bodyOf(reply).noEffect as { status: string };
    };
    for (let round = 0; round < 3; round++) for (const m of [a, b]) {
      expect((await ask(m.lobbyId)).status).toBe("being_worked_out");
      await vi.waitFor(() => expect(held.started).toContain(m.id));
    }
    expect(held.started).toEqual([a.id, b.id]);
    for (const m of [a, b]) held.finish(m.id, { kind: "findings", tested: 1, findings: [{ seat: 0, index: 1, tick: 2, type: "set_brood" }], undecided: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let round = 0; round < 3; round++) for (const m of [a, b]) expect(await ask(m.lobbyId)).toMatchObject({ status: "shown", commands: [{ seat: 0, tick: 2 }] });
    expect(held.started).toEqual([a.id, b.id]);
    // Every ask read its record again: no summary was kept.
    for (const m of [a, b]) expect(f.history.open.mock.calls.filter(([id]) => id === m.id)).toHaveLength(6);
  });
});

describe("times (report-73ab372b)", () => {
  const refusedOf = (reply: { body: unknown }) => (bodyOf(reply).seats as { refused: Record<string, unknown>[] }[])[0]!.refused;

  it("takes the tick rate from the rules, else the match setup, and never assumes one: ticks only then, with a note", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const fromSetup = generatedRecord(replayId(90));
    delete (fromSetup.rules.config as { ticksPerSecond?: number }).ticksPerSecond;
    fromSetup.setup.ticksPerSecond = 4;
    const none = generatedRecord(replayId(91));
    delete (none.rules.config as { ticksPerSecond?: number }).ticksPerSecond;
    delete (none.setup as { ticksPerSecond?: number }).ticksPerSecond;
    const setupReply = await f.postMortem.query({ key: alice.key, lobbyId: f.match(90, [[alice, 0]], { record: fromSetup }).lobbyId });
    expect(refusedOf(setupReply)[1]).toMatchObject({ tick: 4, tickBasis: "answered at tick", viewerTick: 4, viewerSeconds: 1 });
    expect(setupReply.body).not.toHaveProperty("timeNote");
    const noneReply = await f.postMortem.query({ key: alice.key, lobbyId: f.match(91, [[alice, 0]], { record: none }).lobbyId });
    expect(bodyOf(noneReply).timeNote).toBe(TICKS_ONLY_NOTE);
    // Nothing dropped, the recorded tick still shown.
    expect(refusedOf(noneReply)).toEqual([
      { tick: null, at: new Date(RECEIVED - 50).toISOString(), tool: "join", code: "call_rate" },
      { tick: 4, tickBasis: "answered at tick", viewerTick: 4, at: new Date(RECEIVED + 300).toISOString(), tool: "set_brood", code: "bad_brood" },
    ]);
  });

  it("lists a refusal with neither a tick nor a receive time as time not recorded", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const record = generatedRecord(replayId(92));
    delete (record.replies[0] as { receivedAt?: number }).receivedAt;
    const reply = await f.postMortem.query({ key: alice.key, lobbyId: f.match(92, [[alice, 0]], { record }).lobbyId });
    expect(refusedOf(reply)[0]).toEqual({ tick: null, at: null, time: TIME_NOT_RECORDED, tool: "join", code: "call_rate" });
    expect(refusedOf(reply)[1]).not.toHaveProperty("time");
  });

  it("times a record's refused commands by their simulation step, where it kept no call replies", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const record = { ...generatedRecord(replayId(93)), replies: null };
    const reply = await f.postMortem.query({ key: alice.key, lobbyId: f.match(93, [[alice, 0]], { record }).lobbyId });
    expect(bodyOf(reply).refusedFrom).toBe("commands");
    expect(refusedOf(reply)).toEqual([{ tick: 3, tickBasis: "simulation step", viewerTick: 4, viewerSeconds: 0.4, at: null, tool: "set_brood", code: "bad_brood" }]);
  });

  // The cross-path premise, on the real game: a call's reply line carries the tick after the step that ran it, so the
  // two ways a refusal is timed give the same viewer tick.
  it("gives a call answered by the real game the same viewer tick from its reply line as from its simulation step", async () => {
    const h = await startHarness();
    try {
      const agent = await h.connect();
      expect((await agent.call("join", { modelLabel: "timing" })).isError).toBe(false);
      const accepted = await agent.call("order", { kind: "hold" });
      const refused = await agent.call("order", { kind: "hold" });
      expect(accepted.isError).toBe(false);
      expect(refused.isError).toBe(true);
      const steps = h.log.slice(1).map(line => JSON.parse(line) as { tick: number; inputs?: { type: string }[] })
        .filter(entry => (entry.inputs ?? []).some(input => input.type === "order")).map(entry => entry.tick);
      const replies = h.replies.map(r => JSON.parse(r.line) as { tool: string; tick: number }).filter(line => line.tool === "order").map(line => line.tick);
      expect(steps).toHaveLength(2);
      expect(replies).toHaveLength(2);
      for (const [i, step] of steps.entries()) {
        expect(replies[i]).toBe(step + 1);
        expect(timeOf(replies[i]!, "calls", 10)).toEqual({ ...timeOf(step, "step", 10), tick: replies[i], tickBasis: "answered at tick" });
      }
    } finally { await h.close(); }
  });
});

describe("the command-idle timer with no join tick (report-3533dee2)", () => {
  const IDLE_TICKS = 5;
  const id = (n: number) => `seat-private-${n}`;
  const run = (state: SimState, inputs: SimInput[]) => step(state, inputs, undefined, undefined, undefined, false, false);
  /** Command-idle rules, no squads (so waking moves no ant), and the state of the tick seat 0 lapses idle on. */
  function lapseTick() {
    const config: SimConfig = { ...playable(rulesConfig("redesign")), matchTicks: 60, commandFloorTicks: 100, startAnts: 16, commandIdleTicks: IDLE_TICKS, squadSize: 0 };
    let state = run(createMatch(6006, config), [0, 1].map(n => ({ type: "join", agentId: id(n), modelLabel: "m" }) as SimInput)).state;
    // A historical state: no join tick, so the deadline falls back to the last call.
    for (const agent of state.agents) delete (agent as { joinedTick?: number }).joinedTick;
    state = run(state, [brood(0)]).state;
    expect(state.agents[0]!.lastCommandTick).toBeNull();
    const states = [state];
    while (!state.agents[0]!.idle) { state = run(state, []).state; states.push(state); }
    return { before: states.at(-3)!, lapse: states.at(-2)! };
  }

  // Fails if the issuing seat's own lastCallTick is compared: its only difference here is a later deadline.
  it("lists a command whose only difference is the call timer, a later idle deadline, as no effect", () => {
    const { before } = lapseTick();
    const withIt = run(before, [brood(0)]), without = run(before, []);
    expect(withIt.results[0]!.ok).toBe(true);
    expect(withIt.state.agents[0]!.lastCallTick).not.toBe(without.state.agents[0]!.lastCallTick);
    expect(sameState(withIt.state, without.state, id(0))).toBe(true);
    // The deadline did move: one step later, only the run without it has gone idle.
    expect([run(withIt.state, []).state.agents[0]!.idle, run(without.state, []).state.agents[0]!.idle]).toEqual([false, true]);
  });

  // Fails if the idle flag stops being compared: it is the only difference beyond the seat's own timers.
  it("does not list a command that wakes its seat on the tick it lapses idle", () => {
    const { lapse } = lapseTick();
    const withIt = run(lapse, [{ type: "order", agentId: id(0), order: structuredClone(lapse.agents[0]!.order) } as SimInput]), without = run(lapse, []);
    expect(withIt.results[0]!.ok).toBe(true);
    expect([withIt.state.agents[0]!.idle, without.state.agents[0]!.idle]).toEqual([false, true]);
    expect(sameState(withIt.state, without.state, id(0))).toBe(false);
    const idleAlike = structuredClone(without.state);
    idleAlike.agents[0]!.idle = false;
    expect(sameState(withIt.state, idleAlike, id(0))).toBe(true);
  });
});

/** The real forked re-run child's answer for a record. */
async function childAnswer(record: unknown, options: { stallMs?: number; open?: () => Promise<Readable> } = {}) {
  const jobs = createJobs({ log: () => {}, meter: () => ({ usedMiB: 100, totalMiB: 4096 }), ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }) });
  const body = Buffer.from(JSON.stringify(record));
  return jobs.rerun("child", CODE, options.open ?? (async () => Readable.from([body]))).outcome!;
}

/** A match with a count mark, set_brood repeats and observes in both modes, its house-idle clock far from any deadline. */
function parityRecord(id: string, callIdle: boolean) {
  const mark = { type: "count_mark", agentId: "seat-private-0", verb: "ATTACK", count: 2, tileX: 13, tileY: 43 } as SimInput;
  return houseMatch(id, { idleTicks: 1000, stopAt: 6, callIdle, calls: {
    0: [0, 1].map(seat => ({ type: "join", agentId: `seat-private-${seat}`, modelLabel: `model-${seat}` }) as SimInput),
    1: [mark, brood(1)], 2: [brood(0), observe(1)], 3: [brood(0), observe(0)], 4: [brood(1), observe(0), observe(1)],
  } });
}

describe("the real re-run child in both idle modes", () => {
  for (const callIdle of [false, true]) {
    const mode = callIdle ? "call-idle" : "command-idle";
    // Credible regression: the child's reduced record or its idle classification diverging from a full re-run in one mode.
    it(`finds what a full re-run finds, a count mark and observes included (${mode})`, async () => {
      const record = parityRecord(replayId(callIdle ? 101 : 100), callIdle);
      expect(record.rules.config.commandIdleTicks).toBe(callIdle ? undefined : 1);
      expect(record.seats[0].commands.find((c: { type: string }) => c.type === "count_mark")).toMatchObject({ accepted: true });
      const outcome = await childAnswer(record);
      expect(outcome.kind).toBe("findings");
      const found = (outcome as { findings: { seat: number; tick: number; type: string }[] }).findings.map(({ seat, tick, type }) => ({ seat, tick, type }));
      expect(found).toEqual(fullRecordFindings(record));
      expect(found).toContainEqual({ seat: 0, tick: 3, type: "set_brood" });
    }, 60_000);

    it(`settles a deadline-tick command as no effect, an effect, or undecided (${mode})`, async () => {
      const cases = [
        [deadlineRecord(replayId(110), [obs({ since: 3 })], { at: 5, callIdle }), 5, "listed"],
        [deadlineRecord(replayId(111), [obs({ cellsCursor: "s:1" }, "bad_cells_cursor")], { callIdle }), 6, "effect"],
        [deadlineRecord(replayId(112), [obs({ since: 3 })], { callIdle }), 6, "undecided"],
      ] as const;
      for (const [record, at, expected] of cases) {
        const outcome = await childAnswer(record) as { kind: string; findings: { seat: number; tick: number }[]; undecided: [number, number][] };
        expect(outcome.kind).toBe("findings");
        const listed = outcome.findings.some(f => f.seat === 0 && f.tick === at);
        const undecided = outcome.undecided.find(([seat]) => seat === 0)?.[1] ?? 0;
        expect({ listed, undecided }).toEqual(expected === "listed" ? { listed: true, undecided: 0 } : expected === "effect" ? { listed: false, undecided: 0 } : { listed: false, undecided: 1 });
      }
    }, 120_000);
  }

  // Credible regression: a child that reports progress only once its re-run starts, so a slow record read is killed as stalled.
  it("keeps a child that is still scanning a slowly arriving record alive, and stops one whose record stops arriving", async () => {
    const record = generatedRecord(replayId(120));
    // About 6 MiB of text lines, which the scan skips, arriving 256 KiB every 250 ms: some 6 s of scanning.
    const text = { type: "text", seat: 0, tick: null, text: "t".repeat(64 * 1024) };
    record.replies.push(...Array.from({ length: 96 }, () => text));
    const body = Buffer.from(JSON.stringify(record));
    const slow = (stopAfter = Infinity) => async () => Readable.from((async function* () {
      for (let i = 0, n = 0; i < body.length; i += 256 * 1024, n++) {
        if (n >= stopAfter) await new Promise(() => {});
        yield body.subarray(i, i + 256 * 1024);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    })());
    expect(await childAnswer(record, { stallMs: 2000, open: slow() })).toMatchObject({ kind: "findings" });
    expect(await childAnswer(record, { stallMs: 2000, open: slow(4) })).toEqual({ kind: "stopped", cause: "stalled" });
  }, 120_000);
});
