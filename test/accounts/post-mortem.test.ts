/// <reference types="node" />
// match_post_mortem end to end below the MCP layer (src/accounts/postMortem.ts): real identities, lobbies and watch
// registry over one in-memory store, records generated here by the real simulation and record builder, and re-runs in
// the real forked child. Ownership is by the lobby's seat identity ids only.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, get as httpGet, request as httpRequest, type ClientRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  CALL_IDLE_NOTE, createPostMortem, DELIVERY_SLOTS, NO_EFFECT_NOTE, noEffectOf, ownedColonies, ownNoEffect, POST_MORTEM_DESCRIPTION, POST_MORTEM_TOOL, REFUSALS,
  registerPostMortemTool, REPLY_BYTES, TICKS_ONLY_NOTE, TIME_NOT_RECORDED, timeOf, TOO_LARGE, undecidedSentence, withResponseScope,
} from "../../src/accounts/postMortem.ts";
import { packFindings, rerunRecord, sameState, unpackFindings, type RerunAnswer } from "../../src/accounts/postMortemChild.ts";
import { createJobs, JobsBusy, type PostMortemJobs, type RecordOpener, type RerunOutcome } from "../../src/accounts/postMortemJobs.ts";
import { PAGE_BYTES, scanRecord } from "../../src/accounts/postMortemRecord.ts";
import type { VersionAnswer, VersionSource } from "../../src/accounts/postMortemVersion.ts";
import { encodePublicMessage } from "../../src/live/format.ts";
import { payload } from "../../src/mcp/replies.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { matchRecord, REPLIES_NOT_RETAINED } from "../../src/replays/history.ts";
import type { ReplayGet } from "../../src/replays/access.ts";
import { CORRECTED_REPLAY_IDS } from "../../src/replays/correctedRecordings.ts";
import { createGcsHistorySource, type HistorySource } from "../../src/replays/history-source.ts";
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
function world(options: { versions?: VersionSource; jobs?: PostMortemJobs; cacheBytes?: number; storedHistory?: Pick<HistorySource, "open">; pageScanBytes?: number; maxRerunBits?: number; readGuardMs?: number; scanWaitMs?: number } = {}) {
  const w = retentionWorld(Date.parse("2026-10-20T00:00:00.000Z"));
  const records = new Map<string, Buffer>();
  const objects = new Map<string, ReplayObject>();
  const archive = createPrivateArchive({ create: async object => { objects.set(object.name, object); } },
    async name => { const o = objects.get(name); return o ? { body: Readable.from([Buffer.from(o.body)]), contentLength: String(o.body.length) } : null; },
    KEY);
  const history = { open: vi.fn(async (id: string) => records.has(id) ? Readable.from([records.get(id)!]) : null) };
  const versions = options.versions ?? versionsAnswering("found");
  // The meter is injected: these tests are about the re-run's path, not this machine's memory (post-mortem-jobs.test.ts).
  const jobs = options.jobs ?? createJobs({ log: () => {}, meter: () => ({ headroomMiB: 4096, source: "numeric" as const }) });
  const registry = createWatchRegistry(w.store);
  const lobbies = createLobbies(w.store, w.ids);
  const postMortem = createPostMortem({ identities: w.ids, lobbies, registry, history, archive, versions, jobs, now: w.now, cacheBytes: options.cacheBytes,
    storedHistory: options.storedHistory, pageScanBytes: options.pageScanBytes, maxRerunBits: options.maxRerunBits,
    readGuardMs: options.readGuardMs, scanWaitMs: options.scanWaitMs });
  let lobbyCount = 0;
  /** A lobby of `seats` [identity, colony], its registry row and its stored record under id. */
  function match(n: number, seats: readonly (readonly [{ id: string; name: string }, 0 | 1])[], options: {
    visibility?: "public" | "private"; playbackFinished?: boolean; lobbyState?: string; record?: unknown; row?: boolean; id?: string;
  } = {}) {
    const lobbyId = `00000000-0000-4000-8000-${String(++lobbyCount).padStart(12, "0")}`;
    const id = options.id ?? replayId(n);
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
  return { w, postMortem, match, store, records, objects, history, versions, jobs, archive, registry, lobbies };
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
    const jobs = createJobs({ log: () => {}, meter: () => ({ headroomMiB: 4096, source: "numeric" as const }), forkChild: () => {
      const child = spawn(process.execPath, ["-e", `
        const { existsSync } = require("node:fs");
        process.stdin.resume();
        process.once("message", () => { const t = setInterval(() => { process.send({ kind: "progress", tick: 0 });
          if (existsSync(${JSON.stringify(gate)})) { clearInterval(t); process.send({ kind: "done", tested: 0, counts: [], bits: new Uint8Array(0), undecided: [] }, () => process.exit(0)); } }, 20); });`],
        { stdio: ["pipe", "ignore", "inherit", "ipc"], serialization: "advanced" });
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

describe("which colonies a caller owns", () => {
  const lobby = (seats: [string, string, 0 | 1][]) => ({ colonies: [0, 1].map(colony => seats.filter(s => s[2] === colony).map(([id, displayName]) => ({ id, displayName }))) as never });

  it("gives the one identity of a colony that colony, however many seats it holds", () => {
    expect(ownedColonies(lobby([["a", "alice", 0], ["a", "alice", 0], ["b", "bob", 1], ["b", "bob", 1]]), "a")).toEqual(new Set([0]));
    expect(ownedColonies(lobby([["a", "alice", 0], ["a", "alice", 1]]), "a")).toEqual(new Set([0, 1]));
  });
  // Credible regression: binding seats by name or position in a colony of several identities.
  it("gives no colony of several identities, even to one of them", () => {
    expect(ownedColonies(lobby([["a", "alice", 0], ["c", "carol", 0]]), "a")).toEqual(new Set());
    expect(ownedColonies(lobby([["a", "alice", 0], ["a", "alice", 1], ["c", "carol", 1]]), "a")).toEqual(new Set([0]));
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
  const answer: RerunAnswer = rerunRecord(scan.reduced);
  if (answer.kind !== "done") return { answer: answer.kind };
  const status = noEffectOf({ kind: "findings", tested: answer.tested, ...packFindings(scan.reduced.seats, answer.findings), undecided: answer.undecided });
  const shown = ownNoEffect(status, answer.findings, new Set(owned), false, 10) as { commands: { seat: number; tick: number }[]; notListed?: string };
  return { listed: shown.commands.some(c => c.seat === 0 && c.tick === at), notListed: shown.notListed ?? null };
}
const LISTED = { listed: true, notListed: null };
const IDLE = { listed: false, notListed: null };
const UNDECIDABLE = { listed: false, notListed: undecidedSentence(1) };

describe("a command on its seat's idle deadline", () => {
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

  // An error reply that still counted as activity must not withhold the command.
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

  // No default idle threshold is assumed.
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
  const shown = { status: "shown", counts: [], bits: new Uint8Array(0), undecided: [] } as const;
  expect(ownNoEffect(shown, [], new Set([0]), true, 10)).toEqual({ status: "shown", note: `${NO_EFFECT_NOTE} ${CALL_IDLE_NOTE}`, commands: [] });
  expect(ownNoEffect(shown, [], new Set([0]), false, 10)).toEqual({ status: "shown", note: NO_EFFECT_NOTE, commands: [] });
});

const UNCONFIRMED = { ok: false, body: { error: "ownership_unconfirmed", message: REFUSALS.ownership_unconfirmed } };
const seatsOf = (reply: { body: unknown }) => (bodyOf(reply).seats as { seat: number }[]).map(s => s.seat);

describe("ownership by the lobby's seat identities alone", () => {
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

describe("a long list, in pages", () => {
  const refusedOf = (reply: { body: unknown }) => (bodyOf(reply).seats as { refused: { at: string }[] }[])[0]!.refused;
  // Credible regression: a reply holding every refused call, or a page that loses or repeats one between pages.
  it("answers 120,002 refused calls a page at a time, each reachable once, every reply within its byte cap, and the no-effect answer beside them", async () => {
    const f = world();
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const record = generatedRecord(replayId(80));
    for (let i = 0; i < 120_000; i++) record.replies.push({ type: "stub", seat: 0, tick: null, tool: "observe", receivedAt: RECEIVED + 1000 + i, answeredAt: RECEIVED + 1001 + i, code: "call_rate" });
    const { lobbyId } = f.match(80, [[alice, 0], [bob, 1]], { record });
    const first = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(first.ok).toBe(true);
    expect(refusedOf(first)).toHaveLength(2000);
    expect(bodyOf(first).refusedPage).toMatchObject({ total: 120_002, first: 0, shown: 2000, remaining: 118_002 });
    expect(bodyOf(first).refusedPage.more).toBe("118002 more refused calls: ask again with refusedContinuation set to this page's continuation.");
    expect(bodyOf(first).refusedPage.scannedBytes).toBeLessThan(bodyOf(first).refusedPage.recordBytes);
    // Every page, in turn, from the continuations the replies give.
    const seen = new Set<string>();
    let continuation: string | undefined, pages = 0, scanned = 0;
    do {
      const reply = await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation });
      expect(reply.ok, JSON.stringify(reply.body).slice(0, 200)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(reply.body))).toBeLessThanOrEqual(REPLY_BYTES);
      for (const r of refusedOf(reply)) { expect(seen.has(r.at)).toBe(false); seen.add(`${r.at}`); }
      expect(bodyOf(reply).refusedPage.first).toBe(pages === 0 ? 0 : seen.size - refusedOf(reply).length);
      expect(bodyOf(reply).refusedPage.scannedBytes).toBeGreaterThan(scanned);
      scanned = bodyOf(reply).refusedPage.scannedBytes;
      continuation = bodyOf(reply).refusedPage.continuation as string | undefined;
      pages++;
    } while (continuation !== undefined);
    expect(pages).toBe(61);
    expect(seen.size).toBe(120_002);
    const done = await settled(() => f.postMortem.query({ key: alice.key, lobbyId }));
    expect(bodyOf(done).noEffect).toMatchObject({ status: "shown", commands: [{ seat: 0, tick: 2, type: "set_brood" }] });
    expect(bodyOf(done).noEffectPage).toMatchObject({ total: 1, shown: 1, remaining: 0 });
    expect(bodyOf(done).noEffectPage).not.toHaveProperty("continuation");
    expect(refusedOf(done)).toHaveLength(2000);
  }, 120_000);

  // Credible regression (CJK): a page measured by its JSON string's length, not its UTF-8 bytes, so names of
  // three-byte characters fill a page well past its byte budget and a reply past its cap. The lone-surrogate case is
  // coverage: such a name is written as 6-byte escapes, which a measure of the raw strings' bytes would undercount.
  it.each([["CJK", "\u89b3".repeat(100) + "\u2026"], ["lone-surrogate", "\ud83d".repeat(100) + "\u2026"]])(
    "pages refused calls with %s tool names by their serialized UTF-8 bytes, every reply within its cap, each call reachable once", async (_, tool) => {
      const f = world();
      const alice = f.w.played("alice"), bob = f.w.played("bob");
      const record = generatedRecord(replayId(81));
      for (let i = 0; i < 3000; i++) record.replies.push({ type: "stub", seat: 0, tick: null, tool, receivedAt: RECEIVED + 1000 + i, answeredAt: RECEIVED + 1001 + i, code: "call_rate" });
      const { lobbyId } = f.match(81, [[alice, 0], [bob, 1]], { record });
      const seen = new Set<string>();
      let continuation: string | undefined, pages = 0;
      do {
        const reply = await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation });
        expect(reply.ok, JSON.stringify(reply.body).slice(0, 200)).toBe(true);
        const entries = refusedOf(reply) as unknown as Record<string, unknown>[];
        expect(entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 32, 0)).toBeLessThanOrEqual(PAGE_BYTES);
        expect(Buffer.byteLength(JSON.stringify(reply.body))).toBeLessThanOrEqual(REPLY_BYTES);
        expect(bodyOf(reply).refusedPage.first).toBe(seen.size);
        for (const r of refusedOf(reply)) { expect(seen.has(r.at)).toBe(false); seen.add(r.at); }
        continuation = bodyOf(reply).refusedPage.continuation as string | undefined;
        pages++;
      } while (continuation !== undefined);
      expect(pages).toBeGreaterThan(1);
      expect(seen.size).toBe(3002);
    }, 60_000);

  it("refuses an empty or over-long continuation before reading anything, and one it did not issue as start again", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(83, [[alice, 0]]);
    f.w.reads.length = 0;
    for (const bad of ["", "x".repeat(16 * 1024 + 1)]) {
      expect((await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: bad })).body.error).toBe("bad_arguments");
      expect((await f.postMortem.query({ key: alice.key, lobbyId, noEffectContinuation: bad })).body.error).toBe("bad_arguments");
    }
    expect(f.w.reads).toEqual([]);
    for (const forged of ["not-a-continuation", Buffer.alloc(64, 7).toString("base64url")]) {
      expect(await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: forged })).toEqual({ ok: false, body: { error: "start_again", message: REFUSALS.start_again } });
    }
    expect(f.history.open).not.toHaveBeenCalled();
  });

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
    // Seat 0's command 2 (its set_brood at tick 2) had no effect; seat 1's four commands, none.
    for (const m of [a, b]) held.finish(m.id, { kind: "findings", tested: 1, counts: [[0, 4], [1, 2]], bits: new Uint8Array([4, 0]), undecided: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let round = 0; round < 3; round++) for (const m of [a, b]) expect(await ask(m.lobbyId)).toMatchObject({ status: "shown", commands: [{ seat: 0, tick: 2 }] });
    expect(held.started).toEqual([a.id, b.id]);
    // Every ask read its record again, nothing but the two no-effect answers being kept: its first pass and refused page
    // (three asks while being worked out), then those and its no-effect page (three asks once shown).
    for (const m of [a, b]) expect(f.history.open.mock.calls.filter(([id]) => id === m.id)).toHaveLength(3 * 2 + 3 * 3);
  });
});

describe("times", () => {
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

describe("the command-idle timer with no join tick", () => {
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

/** A findings outcome's no-effect commands, named by the record's own commands. */
function findingsOf(record: { seats: { seat: number; commands: { tick: number; type: string }[] }[] }, outcome: RerunOutcome) {
  if (outcome.kind !== "findings") return [];
  return unpackFindings(outcome.counts, outcome.bits).map(([seat, index]) => {
    const command = record.seats.find(s => s.seat === seat)!.commands[index]!;
    return { seat, tick: command.tick, type: command.type };
  });
}

/** The real forked re-run child's answer for a record. */
async function childAnswer(record: unknown, options: { stallMs?: number; open?: () => Promise<Readable> } = {}) {
  const jobs = createJobs({ log: () => {}, meter: () => ({ headroomMiB: 4096, source: "numeric" as const }), ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }) });
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
      const found = findingsOf(record, outcome);
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
        const outcome = await childAnswer(record);
        if (outcome.kind !== "findings") throw new Error(outcome.kind);
        const listed = findingsOf(record, outcome).some(f => f.seat === 0 && f.tick === at);
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

describe("ownership proven before anything is read", () => {
  for (const visibility of ["public", "private"] as const) {
    // Credible regression: a caller holding a seat of a colony of several identities reaching a scan, a kept page or a
    // record read before ownership is refused.
    it(`refuses a caller of a colony of several identities before any scan, kept page or record read (${visibility})`, async () => {
      const scan = vi.fn((run: () => Promise<unknown>) => run());
      const f = world({ jobs: { ...heldJobs().jobs, scan: scan as PostMortemJobs["scan"] } });
      const consume = vi.spyOn(f.archive, "consume");
      const alice = f.w.played("alice"), carol = f.w.played("carol"), bob = f.w.played("bob");
      const { lobbyId, id } = f.match(300, [[alice, 0], [carol, 0], [bob, 1]], { visibility });
      // bob's own colony is read and kept first.
      expect((await f.postMortem.query({ key: bob.key, lobbyId })).ok).toBe(true);
      const reads = { scans: scan.mock.calls.length, opens: f.history.open.mock.calls.length, consumes: consume.mock.calls.length };
      for (const reply of [await f.postMortem.query({ key: alice.key, lobbyId }), await f.postMortem.query({ key: carol.key, matchId: id }),
        await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: "anything" })]) expect(reply).toEqual(UNCONFIRMED);
      expect({ scans: scan.mock.calls.length, opens: f.history.open.mock.calls.length, consumes: consume.mock.calls.length }).toEqual(reads);
    });
  }
});

describe("no-effect answers that settle nothing now, or for good", () => {
  // Credible regression: a match too large to re-run retried forever, or its refused calls withheld.
  it("keeps a match too large to re-run as not available, still showing its refused calls, and never re-runs it again", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(310, [[alice, 0]]);
    await f.postMortem.query({ key: alice.key, lobbyId });
    await vi.waitFor(() => expect(held.started).toEqual([id]));
    held.finish(id, { kind: "too_large" });
    await new Promise(resolve => setTimeout(resolve, 0));
    f.w.at(f.w.now() + 10 * 60_000);
    for (let i = 0; i < 3; i++) {
      const reply = await f.postMortem.query({ key: alice.key, lobbyId });
      expect(bodyOf(reply).noEffect).toEqual({ status: "not_available", reason: TOO_LARGE });
      expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
    }
    expect(held.started).toEqual([id]);
  });

  // Credible regression: a record over the bit limit forked anyway, or its version looked up, before it is settled.
  it("settles a record over the bit limit as too large for good, with no version lookup and no re-run", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs, maxRerunBits: 15 });
    const alice = f.w.played("alice");
    // Seat 0's 4 commands and seat 1's 2 pad to 16 bits: one over this limit.
    const { lobbyId } = f.match(315, [[alice, 0]]);
    for (let i = 0; i < 3; i++) {
      const reply = await f.postMortem.query({ key: alice.key, lobbyId });
      expect(bodyOf(reply).noEffect).toEqual({ status: "not_available", reason: TOO_LARGE });
      expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
    }
    expect(held.started).toEqual([]);
    expect((f.versions as ReturnType<typeof versionsAnswering>).asked).toEqual([]);
    // At 16 bits it is re-run.
    const g = world({ jobs: held.jobs, maxRerunBits: 16 });
    const bob = g.w.played("bob");
    const at = g.match(316, [[bob, 0]]);
    await g.postMortem.query({ key: bob.key, lobbyId: at.lobbyId });
    await vi.waitFor(() => expect(held.started).toEqual([at.id]));
    // Two seat elements of one seat number are padded each in turn, never merged: 8 + 8 bits, over a limit of 15
    // (merged, their 6 commands would pad to 8).
    const h = world({ jobs: held.jobs, maxRerunBits: 15 });
    const carol = h.w.played("carol");
    const record = generatedRecord(replayId(317));
    record.seats[1].seat = 0;
    const same = h.match(317, [[carol, 0]], { record });
    expect(bodyOf(await h.postMortem.query({ key: carol.key, lobbyId: same.lobbyId })).noEffect).toEqual({ status: "not_available", reason: TOO_LARGE });
    expect(held.started).toEqual([at.id]);
  });

  // Credible regression: every temporary answer worded as short of memory, which only memory causes are.
  it("words a stalled or failed re-run as not computed now, try later, and only memory causes as short of memory", () => {
    expect(noEffectOf({ kind: "stopped", cause: "stalled" })).toEqual({ status: "not_computed_now", reason: "No-effect commands are not computed now (the re-run stalled). Try later." });
    expect(noEffectOf({ kind: "stopped", cause: "crashed" })).toEqual({ status: "not_computed_now", reason: "No-effect commands are not computed now (the re-run failed). Try later." });
    for (const cause of ["admission", "memory", "meter"] as const) {
      expect(noEffectOf({ kind: "stopped", cause })).toEqual({ status: "not_computed_now", reason: "No-effect commands are not available right now (the server is short of memory). Ask again later." });
    }
  });

  // Credible regression: memory pressure or an unreadable meter answered as a permanent "not available".
  it("answers memory pressure and an unreadable meter as not available right now, ask again later, and re-runs after the wait", async () => {
    for (const cause of ["admission", "memory", "meter"] as const) {
      const held = heldJobs();
      const f = world({ jobs: held.jobs });
      const alice = f.w.played("alice");
      const { lobbyId, id } = f.match(320, [[alice, 0]]);
      await f.postMortem.query({ key: alice.key, lobbyId });
      await vi.waitFor(() => expect(held.started).toEqual([id]));
      held.finish(id, { kind: "stopped", cause });
      await new Promise(resolve => setTimeout(resolve, 0));
      const reply = await f.postMortem.query({ key: alice.key, lobbyId });
      expect(bodyOf(reply).noEffect).toEqual({ status: "not_computed_now", reason: "No-effect commands are not available right now (the server is short of memory). Ask again later." });
      expect((bodyOf(reply).seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
      expect(held.started).toEqual([id]);
      f.w.at(f.w.now() + 61_000);
      await f.postMortem.query({ key: alice.key, lobbyId });
      await vi.waitFor(() => expect(held.started).toEqual([id, id]));
    }
  });
});

/** A record with its members in another order: `first` leads, `last` ends, the rest keep their stored order. */
function reordered(record: Record<string, unknown>, first: readonly string[], last: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of first) if (k in record) out[k] = record[k];
  for (const k of Object.keys(record)) if (!first.includes(k) && !last.includes(k)) out[k] = record[k];
  for (const k of last) if (k in record) out[k] = record[k];
  return out;
}
/** generatedRecord as a sealed private record names its callers: by agent id, with its agentSeats map. */
function privateRecord(id: string) {
  const { replies, ...record } = generatedRecord(id) as Record<string, unknown> & { replies: Record<string, unknown>[] };
  return { ...record, agentSeats: { "agent-0": 0, "agent-1": 1 }, replies: replies.map(({ seat, ...line }) => ({ ...line, agentId: `agent-${String(seat)}` })) };
}

describe("where refused calls are read from, in any stored order", () => {
  const view = (reply: { body: unknown }) => ({ refusedFrom: bodyOf(reply).refusedFrom, seats: bodyOf(reply).seats, refusedPage: bodyOf(reply).refusedPage });
  for (const visibility of ["public", "private"] as const) {
    // Credible regression: refused calls placed by what was read so far, so a record whose replies or agent map come
    // first or last is answered differently from one in stored order.
    it(`answers the same in stored order, replies before seats and the agent map after replies (${visibility})`, async () => {
      const f = world({ jobs: heldJobs().jobs });
      const consume = vi.spyOn(f.archive, "consume");
      const reads = () => visibility === "private" ? consume.mock.calls.length : f.history.open.mock.calls.length;
      const alice = f.w.played("alice");
      const base = (n: number) => visibility === "private" ? privateRecord(replayId(n)) : generatedRecord(replayId(n));
      const stored = f.match(330, [[alice, 0]], { visibility, record: base(330) });
      const expected = view(await f.postMortem.query({ key: alice.key, lobbyId: stored.lobbyId }));
      expect(expected.refusedFrom).toBe("calls");
      expect((expected.seats as { refused: unknown[] }[])[0]!.refused).toHaveLength(2);
      const variants = [reordered(base(331), ["replies"]), reordered(base(332), [], ["replies", "seats"]), reordered(base(333), [], ["agentSeats"])];
      // Every order is read the same: one first pass, then one page.
      for (const [i, record] of variants.entries()) {
        const before = reads();
        const { lobbyId } = f.match(331 + i, [[alice, 0]], { visibility, record });
        expect(view(await f.postMortem.query({ key: alice.key, lobbyId })), `variant ${i}`).toEqual({ ...expected,
          refusedPage: { ...expected.refusedPage, scannedBytes: expect.any(Number), recordBytes: expect.any(Number) } });
        expect(reads() - before, `variant ${i}`).toBe(2);
      }
    });
  }

  // Credible regression: the record's statement about its replies trusted over what it holds.
  it("reads refused calls from a replies array whatever the record declares, and from refused commands where replies are null or absent", async () => {
    const f = world();
    const alice = f.w.played("alice");
    const declaresNone = { ...generatedRecord(replayId(340)), unavailable: [REPLIES_NOT_RETAINED] };
    const nullReplies = { ...generatedRecord(replayId(341)), replies: null };
    const { replies: _r, ...absent } = generatedRecord(replayId(342));
    const answers = [];
    for (const [i, record] of [declaresNone, nullReplies, absent].entries()) {
      const reply = await f.postMortem.query({ key: alice.key, lobbyId: f.match(340 + i, [[alice, 0]], { record }).lobbyId });
      answers.push({ from: bodyOf(reply).refusedFrom, codes: (bodyOf(reply).seats as { refused: { code: string }[] }[])[0]!.refused.map(r => r.code) });
    }
    expect(answers).toEqual([
      { from: "calls", codes: ["call_rate", "bad_brood"] },
      { from: "commands", codes: ["bad_brood"] },
      { from: "commands", codes: ["bad_brood"] },
    ]);
  });

  // Credible regression: a page or first pass trusted where its read failed authentication, or a failed read kept.
  it("refuses a private record that fails authentication on either read, and keeps nothing it read", async () => {
    for (const failing of [1, 2]) {
      const f = world({ jobs: heldJobs().jobs });
      const real = f.archive.consume!.bind(f.archive);
      let calls = 0;
      vi.spyOn(f.archive, "consume").mockImplementation((async (...args: Parameters<typeof real>) => {
        if (++calls === failing) throw new Error("authentication failed");
        return real(...args);
      }) as never);
      const alice = f.w.played("alice");
      const { lobbyId } = f.match(350, [[alice, 0]], { visibility: "private", record: reordered(privateRecord(replayId(350)), [], ["agentSeats"]) });
      expect(await f.postMortem.query({ key: alice.key, lobbyId })).toEqual({ ok: false, body: { error: "record_unreadable", message: REFUSALS.record_unreadable } });
      const after = calls;
      expect((await f.postMortem.query({ key: alice.key, lobbyId })).ok).toBe(true);
      // Nothing the failed read gave was kept: a failed first pass is read again with the page; after a failed page, the
      // first pass that authenticated stands and only the page is read again.
      expect(calls - after).toBe(failing === 1 ? 2 : 1);
    }
  });
});

const servers: Server[] = [];
afterAll(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
/**
 * Public records as the bucket stores them, behind the real history source: each object's stored bytes (gzip or plain,
 * with or without a gzip label), its generation and stored length on every reply, a pinned generation answered only while
 * it is the object's own. Every read is logged with the generation and Range it asked for.
 */
async function bucket() {
  const objects = new Map<string, { body: Buffer; generation: string; label: boolean; replyGeneration?: string }>();
  const asked: { id: string; generation: string | null; range: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!).slice(0, -".json".length);
    const generation = url.searchParams.get("generation");
    asked.push({ id, generation, range: req.headers.range });
    const object = objects.get(id);
    if (object === undefined || (generation !== null && generation !== object.generation)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { ...(object.label ? { "content-encoding": "gzip" } : {}), "x-goog-generation": object.replyGeneration ?? object.generation,
      "x-goog-stored-content-length": String(object.body.length) }).end(object.body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const request: typeof fetch = async () => Response.json({ access_token: "fake-history-token", expires_in: 3600 });
  const get: ReplayGet = (url, options, response) => httpGet(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options, response);
  return {
    source: createGcsHistorySource("fake-history", request, get), objects, asked,
    put(id: string, record: unknown, options: { gzip?: boolean; label?: boolean; generation?: string } = {}) {
      const json = Buffer.from(JSON.stringify(record));
      objects.set(id, { body: options.gzip ? gzipSync(json) : json, generation: options.generation ?? "1700000000000001", label: options.label ?? false });
    },
  };
}

/** A record of seat 0 with `n` more refused calls than generatedRecord's two, each with its own receive time. */
function manyRefusals(id: string, n: number) {
  const record = generatedRecord(id);
  for (let i = 0; i < n; i++) record.replies.push({ type: "stub", seat: 0, tick: null, tool: "observe", receivedAt: RECEIVED + 1000 + i, answeredAt: RECEIVED + 1001 + i, code: "call_rate" });
  return record;
}
/** Every page of one owner's refused calls, by continuation, with each reply's read count. */
async function everyPage(f: ReturnType<typeof world>, key: string, lobbyId: string, reads: () => number) {
  const at: string[] = [];
  const opens: number[] = [];
  let continuation: string | undefined, pages = 0;
  do {
    const before = reads();
    const reply = await f.postMortem.query({ key, lobbyId, refusedContinuation: continuation });
    if (!reply.ok) return { at, opens, pages, refusal: reply.body.error };
    opens.push(reads() - before);
    at.push(...(bodyOf(reply).seats as { refused: { at: string }[] }[])[0]!.refused.map(r => r.at));
    continuation = bodyOf(reply).refusedPage.continuation as string | undefined;
    if (++pages > 5000) throw new Error("pages did not progress");
  } while (continuation !== undefined);
  return { at, opens, pages, refusal: null };
}
const allAt = (n: number) => [RECEIVED - 50, RECEIVED + 300, ...Array.from({ length: n }, (_, i) => RECEIVED + 1000 + i)].map(t => new Date(t).toISOString());

describe("records that cannot be range-read, paged exactly once", () => {
  const BUDGETS = [1, 7, 4096, 64 * 1024, 1024 * 1024, undefined] as const;
  // Credible regression: a gzip-stored record (whose byte ranges are compressed bytes), a mislabelled one, a sealed
  // private one or a rebuilt corrected one losing, repeating or reordering a refused call between pages, a page read
  // twice, or any read asking for a byte range.
  for (const mode of ["gzip, labelled", "gzip, unlabelled", "plain, labelled gzip", "plain", "private", "corrected"] as const) {
    it(`gives every refused call exactly once, in record order, at every page budget: ${mode}`, async () => {
      for (const budget of BUDGETS) {
        const store = await bucket();
        const f = world({ jobs: heldJobs().jobs, storedHistory: store.source, pageScanBytes: budget });
        const consume = vi.spyOn(f.archive, "consume");
        const alice = f.w.played("alice");
        const id = mode === "corrected" ? [...CORRECTED_REPLAY_IDS][0]! : replayId(400);
        const record = mode === "private" ? privateRecord(id) : generatedRecord(id);
        for (let i = 0; i < 2500; i++) record.replies.push({ type: "stub", ...(mode === "private" ? { agentId: "agent-0" } : { seat: 0 }), tick: null, tool: "observe",
          receivedAt: RECEIVED + 1000 + i, answeredAt: RECEIVED + 1001 + i, code: "call_rate" } as never);
        const { lobbyId } = f.match(400, [[alice, 0]], { record, id, visibility: mode === "private" ? "private" : "public" });
        if (mode !== "private" && mode !== "corrected") store.put(id, record, { gzip: mode.startsWith("gzip"), label: mode.includes("labelled") && !mode.includes("unlabelled") });
        const reads = () => mode === "private" ? consume.mock.calls.length : mode === "corrected" ? f.history.open.mock.calls.length : store.asked.length;
        const all = await everyPage(f, alice.key, lobbyId, reads);
        expect(all.refusal, `budget ${budget}`).toBeNull();
        expect(all.at, `budget ${budget}`).toEqual(allAt(2500));
        // A fresh start reads the first pass and one page; each continuation, one page.
        expect(all.opens, `budget ${budget}`).toEqual(all.opens.map((_, i) => i === 0 ? 2 : 1));
        if (budget === undefined) expect(all.pages).toBe(2);
        if (mode === "corrected") expect(store.asked).toEqual([]);
        expect(store.asked.every(r => r.range === undefined)).toBe(true);
      }
    }, 120_000);
  }

  // Credible regression: no-effect findings lost or repeated between pages of a gzip-stored record.
  it("gives every no-effect command of a gzip-stored record exactly once across pages", async () => {
    const held = heldJobs();
    const store = await bucket();
    const f = world({ jobs: held.jobs, storedHistory: store.source, pageScanBytes: 1 });
    const alice = f.w.played("alice");
    const record = generatedRecord(replayId(401));
    const { lobbyId, id } = f.match(401, [[alice, 0]], { record });
    store.put(id, record, { gzip: true });
    await f.postMortem.query({ key: alice.key, lobbyId });
    await vi.waitFor(() => expect(held.started).toEqual([id]));
    // Seat 0's join, first set_brood and repeat (indices 0 to 2) had no effect; its refused set_brood is never listed.
    held.finish(id, { kind: "findings", tested: 3, counts: [[0, 4], [1, 2]], bits: new Uint8Array([0b1111, 0]), undecided: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    const indices: number[] = [];
    let continuation: string | undefined;
    do {
      const reply = await f.postMortem.query({ key: alice.key, lobbyId, noEffectContinuation: continuation });
      indices.push(...(bodyOf(reply).noEffect.commands as { commandIndex: number }[]).map(c => c.commandIndex));
      continuation = bodyOf(reply).noEffectPage.continuation as string | undefined;
    } while (continuation !== undefined);
    expect(indices).toEqual([0, 1, 2]);
  });
});

describe("pinned to the stored generation its first pass read", () => {
  // Credible regression: a later page read unpinned, a replaced record's bytes shown under an older continuation, a
  // missing pinned generation answered as no record, or a stale first pass kept so a fresh start cannot progress.
  it("pins every later read to the first pass's reply, and starts again, then progresses, once the record is replaced", async () => {
    const store = await bucket();
    const f = world({ jobs: heldJobs().jobs, storedHistory: store.source });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(410, [[alice, 0]], { record: manyRefusals(replayId(410), 4000) });
    store.put(id, manyRefusals(id, 4000), { generation: "1700000000000005" });
    const first = await f.postMortem.query({ key: alice.key, lobbyId });
    const continuation = bodyOf(first).refusedPage.continuation as string;
    expect(store.asked.map(r => r.generation)).toEqual([null, "1700000000000005"]);
    const second = await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation });
    expect(store.asked.at(-1)!.generation).toBe("1700000000000005");
    // Replaced: the pinned generation is gone. (A page already read stays kept under its own continuation.)
    store.put(id, manyRefusals(id, 4001), { generation: "1700000000000009" });
    const stale = await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: bodyOf(second).refusedPage.continuation as string });
    expect(stale).toEqual({ ok: false, body: { error: "start_again", message: REFUSALS.start_again } });
    // A fresh start reads the replaced record afresh: its first pass was not kept.
    const fresh = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(bodyOf(fresh).refusedPage.total).toBe(4003);
    expect(store.asked.slice(-2).map(r => r.generation)).toEqual([null, "1700000000000009"]);
    const all = await everyPage(f, alice.key, lobbyId, () => store.asked.length);
    expect(all.at).toEqual(allAt(4001));
  });

  it("starts again when a pinned read's reply names another generation", async () => {
    const store = await bucket();
    const f = world({ jobs: heldJobs().jobs, storedHistory: store.source });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(411, [[alice, 0]], { record: manyRefusals(replayId(411), 4000) });
    store.put(id, manyRefusals(id, 4000));
    const continuation = bodyOf(await f.postMortem.query({ key: alice.key, lobbyId })).refusedPage.continuation as string;
    store.objects.get(id)!.replyGeneration = "1700000000000077";
    expect((await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation })).body.error).toBe("start_again");
  });

  // Credible regression: a corrected recording's rebuilt bytes changing between pages under one continuation.
  it("starts again when a corrected recording changes between pages, though its rebuilt bytes carry no generation", async () => {
    const store = await bucket();
    const f = world({ jobs: heldJobs().jobs, storedHistory: store.source });
    const alice = f.w.played("alice");
    const id = [...CORRECTED_REPLAY_IDS][0]!;
    const { lobbyId } = f.match(412, [[alice, 0]], { id, record: manyRefusals(id, 4000) });
    const continuation = bodyOf(await f.postMortem.query({ key: alice.key, lobbyId })).refusedPage.continuation as string;
    f.records.set(id, Buffer.from(JSON.stringify({ ...manyRefusals(id, 4000), setup: { ...manyRefusals(id, 0).setup, rated: false, corrected: true } })));
    expect((await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation })).body.error).toBe("start_again");
    expect(store.asked).toEqual([]);
  });
});

describe("a record that is unavailable, then completed", () => {
  // Credible regression: an unavailable record's lack of re-run data kept as a lasting "not available", so its completed
  // replacement is never re-run.
  it("keeps no count or status for an unavailable record, and re-runs its completed replacement", async () => {
    const held = heldJobs();
    const store = await bucket();
    const f = world({ jobs: held.jobs, storedHistory: store.source });
    const alice = f.w.played("alice");
    const unavailable = { id: replayId(420), status: "unavailable", source: "unavailable" };
    const { lobbyId, id } = f.match(420, [[alice, 0]], { record: unavailable });
    store.put(id, unavailable, { generation: "1700000000000001" });
    expect((await f.postMortem.query({ key: alice.key, lobbyId })).body.error).toBe("record_unavailable");
    expect(held.started).toEqual([]);
    store.put(id, generatedRecord(id), { generation: "1700000000000002" });
    const reply = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(bodyOf(reply).noEffect.status).toBe("being_worked_out");
    await vi.waitFor(() => expect(held.started).toEqual([id]));
    held.finish(id, { kind: "findings", tested: 1, counts: [[0, 4], [1, 2]], bits: new Uint8Array([4, 0]), undecided: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(bodyOf(await f.postMortem.query({ key: alice.key, lobbyId })).noEffect).toMatchObject({ status: "shown", commands: [{ seat: 0, commandIndex: 2 }] });
  });

  // Credible regression: a re-run fed a replaced record's bytes under the first pass's identity.
  it("gives a re-run only the bytes its first pass read, and drops that first pass once they are gone", async () => {
    const store = await bucket();
    const openers: RecordOpener[] = [];
    const held = heldJobs();
    const jobs: PostMortemJobs = { ...held.jobs, rerun(id, version, open, maxBits) { openers.push(open); return held.jobs.rerun(id, version, open, maxBits); } };
    const f = world({ jobs, storedHistory: store.source });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(421, [[alice, 0]]);
    store.put(id, generatedRecord(id), { generation: "1700000000000001" });
    await f.postMortem.query({ key: alice.key, lobbyId });
    await vi.waitFor(() => expect(openers).toHaveLength(1));
    const same = await openers[0]!(AbortSignal.timeout(5000));
    expect(same).not.toBeNull();
    same!.destroy();
    expect(store.asked.at(-1)!.generation).toBe("1700000000000001");
    store.put(id, generatedRecord(id), { generation: "1700000000000003" });
    expect(await openers[0]!(AbortSignal.timeout(5000))).toBeNull();
    // The next fresh start reads a new first pass, unpinned.
    const before = store.asked.length;
    await f.postMortem.query({ key: alice.key, lobbyId });
    expect(store.asked.slice(before).map(r => r.generation)).toEqual([null, "1700000000000003"]);
  });
});

describe("a private record's pages", () => {
  // Credible regression: a page that stops reading at its budget, so entries are released before the tag at the end
  // has verified; or a failed page kept or logged.
  it("releases nothing of a record whose ciphertext fails after the page's budget, keeps nothing of it, and logs nothing", async () => {
    const f = world({ jobs: heldJobs().jobs, pageScanBytes: 1 });
    const logs = (["log", "info", "warn", "error"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    const consume = vi.spyOn(f.archive, "consume");
    const alice = f.w.played("alice");
    const record = privateRecord(replayId(430));
    for (let i = 0; i < 50; i++) record.replies.push({ type: "stub", agentId: "agent-0", tick: null, tool: "observe", receivedAt: RECEIVED + 1000 + i, answeredAt: RECEIVED + 1001 + i, code: "call_rate" } as never);
    const { lobbyId, id } = f.match(430, [[alice, 0]], { visibility: "private", record });
    const first = await f.postMortem.query({ key: alice.key, lobbyId });
    const continuation = bodyOf(first).refusedPage.continuation as string;
    expect(bodyOf(first).refusedPage.shown).toBeLessThan(5);
    const name = privateMediaName({ lobbyId, replayId: id, kind: "match-record" });
    const object = f.objects.get(name)!;
    const flipped = Buffer.from(object.body);
    flipped[flipped.length - 1] ^= 1;
    f.objects.set(name, { ...object, body: flipped });
    expect(await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation })).toEqual({ ok: false, body: { error: "record_unreadable", message: REFUSALS.record_unreadable } });
    f.objects.set(name, object);
    const before = consume.mock.calls.length;
    const again = await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation });
    expect(again.ok).toBe(true);
    expect(consume.mock.calls.length - before).toBe(1);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("continuations", () => {
  // Credible regression: a continuation opened, or a record read, before ownership is proven.
  it("refuses a non-owner holding an owner's valid continuation exactly as without one, reading nothing", async () => {
    const scan = vi.fn((run: () => Promise<unknown>) => run());
    const f = world({ jobs: { ...heldJobs().jobs, scan: scan as PostMortemJobs["scan"] } });
    const alice = f.w.played("alice"), mallory = f.w.played("mallory");
    const { lobbyId, id } = f.match(440, [[alice, 0]], { record: manyRefusals(replayId(440), 3000) });
    const continuation = bodyOf(await f.postMortem.query({ key: alice.key, lobbyId })).refusedPage.continuation as string;
    const reads = { scans: scan.mock.calls.length, opens: f.history.open.mock.calls.length };
    expect(JSON.stringify(await f.postMortem.query({ key: mallory.key, lobbyId, refusedContinuation: continuation })))
      .toBe(JSON.stringify(await f.postMortem.query({ key: mallory.key, lobbyId })));
    expect(JSON.stringify(await f.postMortem.query({ key: mallory.key, matchId: id, refusedContinuation: continuation })))
      .toBe(JSON.stringify({ ok: false, body: { error: "not_found", message: REFUSALS.not_found } }));
    expect({ scans: scan.mock.calls.length, opens: f.history.open.mock.calls.length }).toEqual(reads);
  });

  // Credible regression: a continuation accepted after tampering, for another match, owner or list, or after a restart.
  it("starts again on a tampered continuation, one of another match, owner or list, and one from before a restart", async () => {
    const f = world({ jobs: heldJobs().jobs });
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const a = f.match(441, [[alice, 0], [bob, 1]], { record: manyRefusals(replayId(441), 3000) });
    const b = f.match(442, [[alice, 0]], { record: manyRefusals(replayId(442), 3000) });
    const mine = bodyOf(await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId })).refusedPage.continuation as string;
    const theirs = bodyOf(await f.postMortem.query({ key: bob.key, lobbyId: a.lobbyId })).refusedPage;
    expect(theirs.continuation).toBeUndefined();
    const START = { ok: false, body: { error: "start_again", message: REFUSALS.start_again } };
    // One bit of the sealed text flipped where nothing else checks it: "public" read as "qublic" if the tag were not checked.
    const raw = Buffer.from(mine, "base64url");
    raw[28 + `{"v":1,"list":"refused","base":{"replayId":"${a.id}","visibility":"`.length]! ^= 1;
    const tampered = raw.toString("base64url");
    expect(await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: tampered })).toEqual(START);
    expect(await f.postMortem.query({ key: alice.key, lobbyId: b.lobbyId, refusedContinuation: mine })).toEqual(START);
    expect(await f.postMortem.query({ key: bob.key, lobbyId: a.lobbyId, refusedContinuation: mine })).toEqual(START);
    expect(await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, noEffectContinuation: mine })).toEqual(START);
    const restarted = createPostMortem({ identities: f.w.ids, lobbies: f.lobbies, registry: f.registry, history: f.history, archive: f.archive, versions: f.versions, jobs: f.jobs, now: f.w.now });
    expect(await restarted.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: mine })).toEqual(START);
    expect((await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: mine })).ok).toBe(true);
  });
});

describe("a read that takes too long", () => {
  // Credible regression: a stalled read answered as an unreadable record, for good, instead of asking again later.
  it("answers a read stopped by its guard as one to ask again later, and keeps nothing of it", async () => {
    const f = world({ jobs: heldJobs().jobs, readGuardMs: 50 });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(450, [[alice, 0]]);
    const body = f.records.get(id)!;
    let sent = false;
    f.history.open.mockImplementationOnce(async () => new Readable({ read() { if (!sent) { sent = true; this.push(body.subarray(0, 10)); } } }));
    expect(await f.postMortem.query({ key: alice.key, lobbyId })).toEqual({ ok: false, body: { error: "read_timed_out", message: REFUSALS.read_timed_out } });
    expect((await f.postMortem.query({ key: alice.key, lobbyId })).ok).toBe(true);
  });
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const refusal = (error: keyof typeof REFUSALS) => ({ ok: false, body: { error, message: REFUSALS[error] } });
/** A response that never finishes until the test ends or destroys it. */
const openResponse = () => new Writable({ write(_chunk, _encoding, done) { done(); } });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

/**
 * The tool served for real: a real McpServer, the real MCP handler and StreamableHTTPServerTransport (stateful, SSE, as
 * the entry server serves it), behind an HTTP server that runs each request in its response scope as server.ts does.
 * A gated test tool "slow" holds a request open; "noop" answers at once.
 */
async function overHttp(f: ReturnType<typeof world>) {
  const slow = gate();
  const h = await startHarness({ start: false, extraTools: server => {
    registerPostMortemTool(server, f.postMortem);
    server.registerTool("slow", { description: "Answers once the test lets it." }, async () => { await slow.opened; return payload({ slow: true }); });
    server.registerTool("noop", { description: "Answers at once." }, async () => payload({ noop: true }));
  } });
  const posts: { name: string; res: ServerResponse }[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST") posts.push({ name: String(req.headers["x-test-request"] ?? ""), res });
    void withResponseScope(res, () => h.handler.handle(req, res));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "post-mortem-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  const live: ClientRequest[] = [];
  closers.push(async () => {
    for (const req of live) req.destroy();
    slow.open();
    await client.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await h.close();
  });
  /** POST responses not yet finished or closed. */
  const openPosts = () => posts.filter(p => !p.res.writableFinished && !p.res.destroyed);
  /** One raw POST of one message or a batch, its SSE replies collected by id. */
  function post(name: string, messages: readonly Record<string, unknown>[]) {
    const replies = new Map<unknown, any>();
    const waiters: (() => void)[] = [];
    let buffer = "";
    let ended!: () => void;
    const done = new Promise<void>(resolve => { ended = resolve; });
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-session-id": transport.sessionId!, "mcp-protocol-version": LATEST_PROTOCOL_VERSION, "x-test-request": name } }, res => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          for (const line of buffer.slice(0, at).split("\n")) if (line.startsWith("data: ")) { const message = JSON.parse(line.slice(6)); replies.set(message.id, message); }
          buffer = buffer.slice(at + 2);
        }
        for (const wake of waiters.splice(0)) wake();
      });
      res.on("end", ended);
      res.on("close", ended);
    });
    // The test's own teardown destroys requests still open.
    req.on("error", () => {});
    live.push(req);
    req.end(JSON.stringify(messages.length === 1 ? messages[0] : messages));
    return {
      replies, done, req,
      async reply(id: number) { while (!replies.has(id)) await new Promise<void>(resolve => waiters.push(resolve)); return replies.get(id); },
    };
  }
  return { client, slow, posts, openPosts, post };
}
const toolCall = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const served = (message: any) => message.result.isError !== true && typeof message.result.structuredContent?.matchId === "string";
const refusalOf = (message: any) => message.result.isError === true ? message.result.structuredContent.error as string : null;
/** Lobby reads made to prove ownership, the first of them held until the gate opens. */
function holdOwnership(f: ReturnType<typeof world>) {
  const readLobby = f.lobbies.readLobby.bind(f.lobbies);
  const held = gate();
  const spy = vi.spyOn(f.lobbies, "readLobby").mockImplementationOnce(async id => { await held.opened; return readLobby(id); });
  return { ...held, spy };
}
/** Record reads from now on, the nth of them held until the gate opens. */
function holdRead(f: ReturnType<typeof world>, nth: number) {
  const open = f.history.open.getMockImplementation()!;
  const held = gate();
  let n = 0;
  f.history.open.mockImplementation(async (id: string) => { if (++n === nth) await held.opened; return open(id); });
  return held;
}

describe("a caller that has gone", () => {
  // Credible regression: the SDK's cancellation (a client's timeout) not treated as the caller going while its POST stays
  // open, so a page is read and a reply shaped, holding a slot, for a reply the SDK drops.
  it("on a real client's timeout during the ownership check, starts one first pass and reads, re-runs and delivers nothing more, its POST still open", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs, scanWaitMs: 5_000 });
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const { lobbyId, id } = f.match(500, [[alice, 0], [bob, 1]]);
    const ownership = holdOwnership(f);
    const asked = vi.spyOn(f.postMortem, "query");
    const http = await overHttp(f);
    await expect(http.client.callTool({ name: POST_MORTEM_TOOL, arguments: { key: alice.key, lobbyId } }, undefined, { timeout: 200 })).rejects.toThrow(/timed out/i);
    await vi.waitFor(() => expect(asked.mock.calls[0]?.[1]?.aborted).toBe(true));
    ownership.open();
    expect(await asked.mock.results[0]!.value).toEqual(refusal("still_reading"));
    // Its first pass was read, once; no page, no re-run, no slot; the cancelled call's POST never ends.
    expect(f.history.open).toHaveBeenCalledTimes(1);
    expect(held.started).toEqual([]);
    expect(f.postMortem.deliveriesHeld()).toBe(0);
    expect(http.openPosts()).toHaveLength(1);
    // A later live ask reads no first pass again: only its first page; and starts the re-run.
    const reply = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(reply.ok).toBe(true);
    expect(f.history.open).toHaveBeenCalledTimes(2);
    expect(held.started).toEqual([id]);
  });

  // Credible regression: the stop check before the slot removed, so a caller that went during its page read has its
  // reply shaped and a slot held by a response the SDK never finishes.
  it("on a real client's timeout during a page read, shapes nothing and holds no slot, its POST still open", async () => {
    const f = world({ jobs: heldJobs().jobs, scanWaitMs: 5_000 });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(501, [[alice, 0]]);
    const page = holdRead(f, 2);
    const asked = vi.spyOn(f.postMortem, "query");
    const http = await overHttp(f);
    await expect(http.client.callTool({ name: POST_MORTEM_TOOL, arguments: { key: alice.key, lobbyId } }, undefined, { timeout: 200 })).rejects.toThrow(/timed out/i);
    await vi.waitFor(() => expect(asked.mock.calls[0]?.[1]?.aborted).toBe(true));
    expect(f.history.open).toHaveBeenCalledTimes(2);
    page.open();
    expect(await asked.mock.results[0]!.value).toEqual(refusal("still_reading"));
    expect(f.postMortem.deliveriesHeld()).toBe(0);
    expect(http.openPosts()).toHaveLength(1);
  });

  // Credible regression: departed callers each starting their own first pass, or one not starting any.
  it("shares one first pass between live askers and departed owners of a record", async () => {
    const f = world({ jobs: heldJobs().jobs, scanWaitMs: 5_000 });
    const alice = f.w.played("alice"), bob = f.w.played("bob");
    const { lobbyId } = f.match(502, [[alice, 0], [bob, 1]]);
    const firstPass = holdRead(f, 1);
    const gone = () => { const c = new AbortController(); c.abort(); return c.signal; };
    const asks = [f.postMortem.query({ key: alice.key, lobbyId }, gone()), f.postMortem.query({ key: alice.key, lobbyId }),
      f.postMortem.query({ key: bob.key, lobbyId }), f.postMortem.query({ key: alice.key, lobbyId }), f.postMortem.query({ key: bob.key, lobbyId }, gone())];
    await vi.waitFor(() => expect(f.history.open).toHaveBeenCalledTimes(1));
    await sleep(50);
    expect(f.history.open).toHaveBeenCalledTimes(1);
    firstPass.open();
    const replies = await Promise.all(asks);
    expect([replies[0], replies[4]]).toEqual([refusal("still_reading"), refusal("still_reading")]);
    expect(replies.slice(1, 4).every(reply => reply.ok)).toBe(true);
  });

  // Credible regression: a departed non-owner triggering a record read or scan.
  it("reads no record for a departed non-owner, only the lobby that refuses it", async () => {
    const scan = vi.fn((run: () => Promise<unknown>) => run());
    const f = world({ jobs: { ...heldJobs().jobs, scan: scan as PostMortemJobs["scan"] } });
    const alice = f.w.played("alice"), carol = f.w.played("carol");
    const { lobbyId } = f.match(503, [[alice, 0]]);
    const readLobby = vi.spyOn(f.lobbies, "readLobby");
    const c = new AbortController(); c.abort();
    expect(await f.postMortem.query({ key: carol.key, lobbyId }, c.signal)).toEqual(UNCONFIRMED);
    expect(readLobby).toHaveBeenCalled();
    expect(f.history.open).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  // Credible regression: a departed owner's continuation reading a page or its first pass.
  it("reads nothing for a departed owner's continuation", async () => {
    const f = world({ jobs: heldJobs().jobs });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(504, [[alice, 0]], { record: manyRefusals(replayId(504), 3000) });
    const continuation = bodyOf(await f.postMortem.query({ key: alice.key, lobbyId })).refusedPage.continuation as string;
    const opens = f.history.open.mock.calls.length;
    const c = new AbortController(); c.abort();
    expect(await f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation }, c.signal)).toEqual(refusal("still_reading"));
    expect(f.history.open.mock.calls.length).toBe(opens);
  });

  // Credible regression: a full scan pool's refusal escaping as an unhandled rejection, or holding a slot, for a departed owner.
  it("drops a departed owner's busy scan pool quietly, holding no slot", async () => {
    const f = world({ jobs: { ...heldJobs().jobs, scan: () => Promise.reject(new JobsBusy()) } });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(505, [[alice, 0]]);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const c = new AbortController(); c.abort();
      expect(await f.postMortem.query({ key: alice.key, lobbyId }, c.signal)).toEqual(refusal("busy"));
      await sleep(20);
      expect(unhandled).not.toHaveBeenCalled();
      expect(f.postMortem.deliveriesHeld()).toBe(0);
    } finally { process.off("unhandledRejection", unhandled); }
  });

  // Credible regression: a page read queued in the scan pool runs once its turn comes though every caller waiting on it
  // has gone, opening (or, for a private record, downloading and authenticating) the record for nobody; or a live owner
  // who joined that read is dropped with them.
  it.each(["public", "private"] as const)("reads no queued %s page whose callers have all gone by its turn, and reads it once for a live owner who joined", async visibility => {
    let n = 0, held: number | null = null;
    const turn = gate();
    let next = turn;
    const scan = (async (run: () => Promise<unknown>) => { if (++n === held) await next.opened; return run(); }) as PostMortemJobs["scan"];
    const f = world({ jobs: { ...heldJobs().jobs, scan } });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(506, [[alice, 0]], { visibility, record: manyRefusals(replayId(506), 3000) });
    const consume = vi.spyOn(f.archive, "consume");
    const reads = () => visibility === "public" ? f.history.open.mock.calls.length : consume.mock.calls.length;
    // The first pass and the first page, read by a completed ask.
    const continuation = bodyOf(await f.postMortem.query({ key: alice.key, lobbyId })).refusedPage.continuation as string;
    expect(reads()).toBe(2);
    // The next page's read waits for its turn; its one caller leaves meanwhile.
    held = n + 1;
    const leaving = new AbortController();
    const gone = f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation }, leaving.signal);
    await vi.waitFor(() => expect(n).toBe(held));
    leaving.abort();
    turn.open();
    expect(await gone).toEqual(refusal("still_reading"));
    expect(reads()).toBe(2);
    // Again, with a live owner joining the same queued read: it is read once, for them.
    next = gate();
    held = n + 1;
    const leaving2 = new AbortController();
    const gone2 = f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation }, leaving2.signal);
    const live = f.postMortem.query({ key: alice.key, lobbyId, refusedContinuation: continuation });
    await vi.waitFor(() => expect(n).toBe(held));
    await sleep(50);
    leaving2.abort();
    next.open();
    expect(await gone2).toEqual(refusal("still_reading"));
    expect((await live).ok).toBe(true);
    expect(n).toBe(held);
    expect(reads()).toBe(3);
  });

  // Credible regression: the version lookup and re-run started before the caller's pages are read, so an owner whose
  // connection closes while a page waits starts both for nobody, through the real tool, SDK transport and response scope.
  it("starts no version lookup or re-run for an owner whose connection closes during its page read; the next owner starts each once", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs, scanWaitMs: 5_000 });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(507, [[alice, 0]]);
    const http = await overHttp(f);
    const page = holdRead(f, 2);
    const call = http.post("gone", [toolCall(1, POST_MORTEM_TOOL, { key: alice.key, lobbyId })]);
    await vi.waitFor(() => expect(f.history.open).toHaveBeenCalledTimes(2));
    call.req.destroy();
    await vi.waitFor(() => expect(http.openPosts()).toHaveLength(0));
    page.open();
    await sleep(50);
    expect((f.versions as ReturnType<typeof versionsAnswering>).asked).toEqual([]);
    expect(held.started).toEqual([]);
    expect(f.postMortem.deliveriesHeld()).toBe(0);
    // Its first pass is kept: the next owner reads nothing again, is told the version is being checked, and starts each once.
    const reply = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(bodyOf(reply).noEffect).toEqual({ status: "being_worked_out", reason: "Checking this match's game version. Ask again shortly." });
    expect(f.history.open).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(held.started).toEqual([id]));
    expect((f.versions as ReturnType<typeof versionsAnswering>).asked).toHaveLength(1);
  });

  // Credible regression: the no-effect answer tied to its caller's response, so a lookup still pending when the answered
  // owner's response closes (as every response does once its reply is written) never queues the re-run it announced.
  it("queues the re-run of an answered owner whose version lookup was still pending when its response closed", async () => {
    const held = heldJobs();
    const lookup = gate();
    const asked: string[] = [];
    const f = world({ jobs: held.jobs, versions: { async lookup(commit) { asked.push(commit); await lookup.opened; return "found"; } } });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(508, [[alice, 0]]);
    const http = await overHttp(f);
    const call = http.post("answered", [toolCall(1, POST_MORTEM_TOOL, { key: alice.key, lobbyId })]);
    expect((await call.reply(1)).result.structuredContent.noEffect.status).toBe("being_worked_out");
    await call.done;
    expect(http.openPosts()).toHaveLength(0);
    expect(asked).toHaveLength(1);
    expect(held.started).toEqual([]);
    lookup.open();
    await vi.waitFor(() => expect(held.started).toEqual([id]));
  });
});

describe("waiting for a record's first pass", () => {
  // Credible regression: the wait timed from the call's start, so an owner whose ownership check outlasts it never
  // reaches its first pass.
  it("serves an owner whose ownership check outlasts the wait", async () => {
    const f = world({ jobs: heldJobs().jobs, scanWaitMs: 1_000 });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(510, [[alice, 0]]);
    const ownership = holdOwnership(f);
    const firstPass = holdRead(f, 1);
    const started = performance.now();
    let answered = false;
    const ask = f.postMortem.query({ key: alice.key, lobbyId }).finally(() => { answered = true; });
    await sleep(1_500);
    expect(performance.now() - started).toBeGreaterThan(1_000);
    expect(answered).toBe(false);
    expect(f.history.open).not.toHaveBeenCalled();
    ownership.open();
    // Its first pass takes a little of the wait, which starts only once ownership is proven.
    await vi.waitFor(() => expect(f.history.open).toHaveBeenCalledTimes(1));
    await sleep(100);
    firstPass.open();
    const reply = await ask;
    expect(reply.ok).toBe(true);
    expect(seatsOf(reply)).toEqual([0]);
  });

  // Credible regression: the ownership check raced against the wait, so a slow non-owner is told to ask again.
  it("refuses a non-owner whose ownership check outlasts the wait exactly as any non-owner, reading nothing", async () => {
    const f = world({ jobs: heldJobs().jobs, scanWaitMs: 100 });
    const alice = f.w.played("alice"), carol = f.w.played("carol");
    const { lobbyId } = f.match(511, [[alice, 0]]);
    const ownership = holdOwnership(f);
    const ask = f.postMortem.query({ key: carol.key, lobbyId });
    await sleep(300);
    ownership.open();
    expect(await ask).toEqual(UNCONFIRMED);
    expect(f.history.open).not.toHaveBeenCalled();
  });

  // Credible regression: the wait removed, so an owner waits on a slow first pass past its client's own deadline.
  it("tells an owner to ask again once the wait runs out, while the first pass is still held", async () => {
    const f = world({ jobs: heldJobs().jobs, scanWaitMs: 100 });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(512, [[alice, 0]]);
    const firstPass = holdRead(f, 1);
    const reply = await Promise.race([f.postMortem.query({ key: alice.key, lobbyId }), sleep(5_000).then(() => "no answer")]);
    expect(reply).toEqual(refusal("still_reading"));
    firstPass.open();
  });

  // Credible regression: the stop check after the first pass removed, so a timed-out ask reads a page and starts a re-run
  // for nobody.
  it("after the wait has run out, reads no page and starts no re-run, and keeps the first pass for the next ask", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs, scanWaitMs: 100 });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(513, [[alice, 0]]);
    const firstPass = holdRead(f, 1);
    const asked = vi.spyOn(f.postMortem, "query");
    expect(await f.postMortem.query({ key: alice.key, lobbyId })).toEqual(refusal("still_reading"));
    firstPass.open();
    // The timed-out ask's own work ends once its first pass has been read.
    await sleep(100);
    expect(f.history.open).toHaveBeenCalledTimes(1);
    expect(held.started).toEqual([]);
    expect(f.postMortem.deliveriesHeld()).toBe(0);
    expect(asked).toHaveBeenCalledTimes(1);
    const reply = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(reply.ok).toBe(true);
    expect(f.history.open).toHaveBeenCalledTimes(2);
    expect(held.started).toEqual([id]);
  });
});

describe("one answer per request", () => {
  // Credible regression: several calls of one request each building a reply (no claim), the claim taken before ownership
  // is proven, or a listener added to the response per call.
  it("answers one proven owner's call of a batch, refuses the others one per request and a non-owner as any, with one response listener", async () => {
    const f = world({ jobs: heldJobs().jobs });
    const alice = f.w.played("alice"), bob = f.w.played("bob"), carol = f.w.played("carol");
    const { lobbyId } = f.match(520, [[alice, 0], [bob, 1]]);
    expect((await f.postMortem.query({ key: alice.key, lobbyId })).ok).toBe(true);
    const http = await overHttp(f);
    const batch = (base: number) => [toolCall(base, POST_MORTEM_TOOL, { key: carol.key, lobbyId }),
      ...[1, 2, 3, 4, 5].map(i => toolCall(base + i, POST_MORTEM_TOOL, { key: i % 2 ? alice.key : bob.key, lobbyId })), toolCall(base + 9, "slow")];
    const one = http.post("one", batch(10)), two = http.post("two", batch(20));
    const noop = http.post("noop", [...[1, 2, 3, 4, 5, 6].map(i => toolCall(30 + i, "noop")), toolCall(39, "slow")]);
    for (const [request, base] of [[one, 10], [two, 20]] as const) {
      const replies = await Promise.all([0, 1, 2, 3, 4, 5].map(i => request.reply(base + i)));
      expect(refusalOf(replies[0])).toBe("ownership_unconfirmed");
      expect(replies.slice(1).filter(served)).toHaveLength(1);
      expect(replies.slice(1).map(refusalOf).filter(code => code === "one_per_request")).toHaveLength(4);
    }
    await Promise.all([1, 2, 3, 4, 5, 6].map(i => noop.reply(30 + i)));
    // Both batches held open by "slow": each holds its one slot; a separate owner's request is still served.
    expect(http.openPosts().map(p => p.name).sort()).toEqual(["noop", "one", "two"]);
    expect(f.postMortem.deliveriesHeld()).toBe(2);
    const single = http.post("single", [toolCall(40, POST_MORTEM_TOOL, { key: alice.key, lobbyId })]);
    expect(served(await single.reply(40))).toBe(true);
    await single.done;
    await vi.waitFor(() => expect(f.postMortem.deliveriesHeld()).toBe(2));
    // One listener per request however many post-mortem calls it carries: the batch of six such calls has as many
    // close listeners on its response as a batch of six other calls.
    const listeners = (name: string) => http.posts.find(p => p.name === name)!.res.listenerCount("close");
    expect(listeners("one")).toBe(listeners("noop"));
    expect(listeners("two")).toBe(listeners("noop"));
    http.slow.open();
    await Promise.all([one.done, two.done, noop.done]);
    await vi.waitFor(() => expect(f.postMortem.deliveriesHeld()).toBe(0));
  });

  // Credible regression: the answered call chosen by batch order, not by whose ownership is proven first.
  it("answers the call whose ownership is proven first, whatever its place in the batch", async () => {
    const f = world({ jobs: heldJobs().jobs });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(521, [[alice, 0]]);
    const http = await overHttp(f);
    const ownership = holdOwnership(f);
    const request = http.post("order", [toolCall(1, POST_MORTEM_TOOL, { key: alice.key, lobbyId }), toolCall(2, POST_MORTEM_TOOL, { key: alice.key, lobbyId })]);
    expect(served(await request.reply(2))).toBe(true);
    ownership.open();
    expect(refusalOf(await request.reply(1))).toBe("one_per_request");
  });

  it("states the rule in its refusal and in the tool's description", () => {
    expect(REFUSALS.one_per_request).toBe("Only one match_post_mortem call is answered per request. Send each call in a request of its own.");
    expect(POST_MORTEM_DESCRIPTION).toContain("Only one match_post_mortem call is answered per request: send each call in a request of its own.");
  });
});

describe("delivery slots", () => {
  // Credible regression: a delivered reply's slot freed when its call returns, while its response, still open, holds it.
  it("keeps a delivered reply's slot until its response has finished", async () => {
    const f = world({ jobs: heldJobs().jobs });
    const alice = f.w.played("alice");
    const { lobbyId, id } = f.match(530, [[alice, 0]]);
    const http = await overHttp(f);
    const request = http.post("held", [toolCall(1, POST_MORTEM_TOOL, { key: alice.key, lobbyId }), toolCall(2, "slow")]);
    const delivered = await request.reply(1);
    expect(served(delivered)).toBe(true);
    expect(delivered.result.structuredContent).toMatchObject({ matchId: id, lobbyId, seats: [{ seat: 0 }] });
    expect(http.openPosts().map(p => p.name)).toEqual(["held"]);
    expect(f.postMortem.deliveriesHeld()).toBe(1);
    http.slow.open();
    await request.done;
    await vi.waitFor(() => expect(f.postMortem.deliveriesHeld()).toBe(0));
  });

  /**
   * A record whose re-run answer cannot be shaped: an undecided list whose entry is not a [seat, count] pair (as a broken
   * re-run might send) is kept, then makes shaping the reply throw, after its slot has been taken.
   */
  async function shapingFails(f: ReturnType<typeof world>, held: ReturnType<typeof heldJobs>, alice: { key: string }, n: number) {
    const m = f.match(n, [[alice as { id: string; name: string; key: string }, 0]]);
    expect((await f.postMortem.query({ key: alice.key, lobbyId: m.lobbyId })).ok).toBe(true);
    await vi.waitFor(() => expect(held.started).toContain(m.id));
    held.finish(m.id, { kind: "findings", tested: 1, counts: [[0, 4], [1, 2]], bits: new Uint8Array([4, 0]), undecided: [5] } as unknown as RerunOutcome);
    await sleep(0);
    return m;
  }

  // Credible regression: a reply whose shaping throws keeping its slot for good, outside a request.
  it("frees the slot of a reply whose shaping fails on return, outside a request", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs });
    const alice = f.w.played("alice");
    const { lobbyId } = await shapingFails(f, held, alice, 533);
    expect(await f.postMortem.query({ key: alice.key, lobbyId })).toEqual(refusal("record_unreadable"));
    expect(f.postMortem.deliveriesHeld()).toBe(0);
  });

  // Credible regression: a reply whose shaping throws inside a request keeping its slot after its response has finished.
  it("holds the slot of a reply whose shaping fails until its response has finished, inside a request", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs });
    const alice = f.w.played("alice");
    const { lobbyId } = await shapingFails(f, held, alice, 534);
    const http = await overHttp(f);
    const request = http.post("failed", [toolCall(1, POST_MORTEM_TOOL, { key: alice.key, lobbyId }), toolCall(2, "slow")]);
    expect(refusalOf(await request.reply(1))).toBe("record_unreadable");
    expect(http.openPosts().map(p => p.name)).toEqual(["failed"]);
    expect(f.postMortem.deliveriesHeld()).toBe(1);
    http.slow.open();
    await request.done;
    await vi.waitFor(() => expect(f.postMortem.deliveriesHeld()).toBe(0));
  });

  // Credible regression: slots unbounded, held during scan waits, or never freed when a response finishes or closes.
  it("holds at most four, none while waiting on a scan, each freed once its response finishes or closes", async () => {
    const f = world({ jobs: heldJobs().jobs, scanWaitMs: 5_000 });
    const alice = f.w.played("alice");
    const { lobbyId } = f.match(531, [[alice, 0]]);
    const waiting = f.match(532, [[alice, 0]]);
    expect((await f.postMortem.query({ key: alice.key, lobbyId })).ok).toBe(true);
    // Four asks waiting on another record's first pass hold no slot: a kept record is served meanwhile, outside any request.
    const firstPass = holdRead(f, 1);
    const responses = [0, 1, 2, 3].map(() => openResponse());
    const waits = responses.map(res => withResponseScope(res, () => f.postMortem.query({ key: alice.key, lobbyId: waiting.lobbyId })));
    await vi.waitFor(() => expect(f.history.open).toHaveBeenCalledTimes(3));
    const kept = await f.postMortem.query({ key: alice.key, lobbyId });
    expect(kept.ok).toBe(true);
    expect(f.postMortem.deliveriesHeld()).toBe(0);
    firstPass.open();
    expect((await Promise.all(waits)).every(reply => reply.ok)).toBe(true);
    expect(f.postMortem.deliveriesHeld()).toBe(DELIVERY_SLOTS);
    // A fifth is busy; a finished response frees its slot, and so does a closed one.
    expect(await withResponseScope(openResponse(), () => f.postMortem.query({ key: alice.key, lobbyId }))).toEqual(refusal("busy"));
    responses[0]!.end();
    await vi.waitFor(() => expect(f.postMortem.deliveriesHeld()).toBe(3));
    responses[1]!.destroy();
    await vi.waitFor(() => expect(f.postMortem.deliveriesHeld()).toBe(2));
    // A response already closed when its call is asked takes no slot; outside a request a slot is freed on return.
    const closed = openResponse();
    closed.destroy();
    await sleep(0);
    expect(await withResponseScope(closed, () => f.postMortem.query({ key: alice.key, lobbyId }))).toEqual(refusal("still_reading"));
    expect((await f.postMortem.query({ key: alice.key, lobbyId })).ok).toBe(true);
    expect(f.postMortem.deliveriesHeld()).toBe(2);
    for (const res of responses.slice(2)) res.end();
    await vi.waitFor(() => expect(f.postMortem.deliveriesHeld()).toBe(0));
  });
});

describe("a continuation whose no-effect answer was dropped from the cache", () => {
  const FINDINGS: RerunOutcome = { kind: "findings", tested: 1, counts: [[0, 4], [1, 2]], bits: new Uint8Array([4, 0]), undecided: [] };
  /** Pages a record, has its re-run answer and the answer shown; the first page's continuation. */
  async function pagedAndShown(f: ReturnType<typeof world>, held: ReturnType<typeof heldJobs>, alice: { key: string }, a: { lobbyId: string; id: string }) {
    const continuation = bodyOf(await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId })).refusedPage.continuation as string;
    await vi.waitFor(() => expect(held.started).toEqual([a.id]));
    held.finish(a.id, FINDINGS);
    await sleep(0);
    expect(bodyOf(await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId })).noEffect.status).toBe("shown");
    return continuation;
  }

  // Credible regression: a continuation whose first pass and no-effect answer were both dropped answering "being worked
  // out" for good, its re-run never started again.
  it("reads the first pass again and restarts the re-run once the entry cap has dropped both", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs });
    const alice = f.w.played("alice");
    const a = f.match(540, [[alice, 0]], { record: manyRefusals(replayId(540), 3000) });
    const continuation = await pagedAndShown(f, held, alice, a);
    // 64 other records' no-effect answers, newer than this one's, push it out of the cache.
    for (let n = 0; n < 64; n++) {
      const other = f.match(600 + n, [[alice, 0]]);
      expect((await f.postMortem.query({ key: alice.key, lobbyId: other.lobbyId })).ok).toBe(true);
    }
    const reply = await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: continuation });
    expect(reply.ok).toBe(true);
    await vi.waitFor(() => expect(held.started.filter(id => id === a.id)).toHaveLength(2));
  }, 60_000);

  // Credible regression: as above, under the byte cap.
  it("reads the first pass again and restarts the re-run once the byte cap has dropped both", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs, cacheBytes: 160 });
    const alice = f.w.played("alice");
    const a = f.match(541, [[alice, 0]], { record: manyRefusals(replayId(541), 3000) });
    const continuation = await pagedAndShown(f, held, alice, a);
    const other = f.match(542, [[alice, 0]]);
    expect((await f.postMortem.query({ key: alice.key, lobbyId: other.lobbyId })).ok).toBe(true);
    const opens = f.history.open.mock.calls.filter(([id]) => id === a.id).length;
    const reply = await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: continuation });
    expect(reply.ok).toBe(true);
    // Its first pass read again, then its page.
    expect(f.history.open.mock.calls.filter(([id]) => id === a.id).length).toBe(opens + 2);
    await vi.waitFor(() => expect(held.started).toEqual([a.id, other.id, a.id]));
  });

  // Credible regression: a continuation whose answers were dropped starting the lookup and re-run again as soon as its
  // first pass is read again, before its page, for an owner who leaves during that page.
  it("starts no re-run for a departed owner's continuation whose answers were dropped, and restarts it for the next ask", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs, cacheBytes: 160 });
    const alice = f.w.played("alice");
    const a = f.match(543, [[alice, 0]], { record: manyRefusals(replayId(543), 3000) });
    const continuation = await pagedAndShown(f, held, alice, a);
    const other = f.match(544, [[alice, 0]]);
    expect((await f.postMortem.query({ key: alice.key, lobbyId: other.lobbyId })).ok).toBe(true);
    await vi.waitFor(() => expect(held.started).toEqual([a.id, other.id]));
    const asked = (f.versions as ReturnType<typeof versionsAnswering>).asked.length;
    // Its first pass read again (the first read from now), then its page (the second), held while the caller leaves.
    const opens = f.history.open.mock.calls.length;
    const page = holdRead(f, 2);
    const res = openResponse();
    const gone = withResponseScope(res, () => f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: continuation }));
    await vi.waitFor(() => expect(f.history.open.mock.calls.length).toBe(opens + 2));
    res.destroy();
    await sleep(20);
    page.open();
    expect(await gone).toEqual(refusal("still_reading"));
    await sleep(20);
    expect(held.started).toEqual([a.id, other.id]);
    expect((f.versions as ReturnType<typeof versionsAnswering>).asked).toHaveLength(asked);
    expect((await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: continuation })).ok).toBe(true);
    await vi.waitFor(() => expect(held.started).toEqual([a.id, other.id, a.id]));
  });

  // Credible regression: a re-run restarted for a continuation of a record that has since been replaced.
  it("starts again, re-running nothing, when the record read again is another", async () => {
    const held = heldJobs();
    const f = world({ jobs: held.jobs, cacheBytes: 160 });
    const alice = f.w.played("alice");
    const a = f.match(543, [[alice, 0]], { record: manyRefusals(replayId(543), 3000) });
    const continuation = await pagedAndShown(f, held, alice, a);
    const other = f.match(544, [[alice, 0]]);
    expect((await f.postMortem.query({ key: alice.key, lobbyId: other.lobbyId })).ok).toBe(true);
    f.store(a.lobbyId, a.id, "public", manyRefusals(replayId(543), 3001));
    expect(await f.postMortem.query({ key: alice.key, lobbyId: a.lobbyId, refusedContinuation: continuation })).toEqual(refusal("start_again"));
    await sleep(20);
    expect(held.started).toEqual([a.id, other.id]);
  });
});
