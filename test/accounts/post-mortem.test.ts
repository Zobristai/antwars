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
import { createPostMortem, ownedSeats, REFUSALS } from "../../src/accounts/postMortem.ts";
import { createJobs, type PostMortemJobs } from "../../src/accounts/postMortemJobs.ts";
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
import { rulesConfig } from "../../src/sim/config.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { retentionWorld } from "../identity/retentionStore.ts";
import { playable } from "../playable.ts";

const CODE = "c".repeat(40);
const KEY = Buffer.alloc(32, 5);
const RECEIVED = Date.parse("2026-10-20T02:00:00.000Z");
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/**
 * A finished 2-seat public match, 8 ticks stopped at tick 4: seat 0 (colony 0) sets its brood at tick 1, sets the same
 * brood again at tick 2 (a command with no effect) and sends a refused set_brood at tick 3; seat 1 sets its brood at
 * tick 2. Its stored record carries re-run data, the game version and two refused calls of seat 0.
 */
function generatedRecord(id: string, names: readonly [string, string] = ["alice", "bob"]) {
  const config = { ...playable(rulesConfig("redesign")), matchTicks: 8, commandFloorTicks: 100, startAnts: 16, commandIdleTicks: 1 };
  let state = createMatch(6006, config);
  const recorder = new SpectatorRecorder(state, { identity: agentId => ({ displayName: names[Number(agentId.replace("seat-private-", ""))]! }) });
  const messages = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const lines = [headerLine(state.seed, config)];
  const brood = (seat: number, value = "workers"): SimInput => ({ type: "set_brood", agentId: `seat-private-${seat}`, brood: value });
  const calls: Record<number, SimInput[]> = {
    0: [0, 1].map(seat => ({ type: "join", agentId: `seat-private-${seat}`, modelLabel: `model-${seat}` }) as SimInput),
    1: [brood(0)], 2: [brood(0), brood(1)], 3: [brood(0, "nope")],
  };
  while (state.result === null) {
    const tick = state.tick, inputs = calls[tick] ?? [], stop = tick === 4;
    lines.push(tickLine(tick, inputs, stop, true));
    const out = step(state, inputs, undefined, undefined, undefined, stop, true);
    messages.push(encodePublicMessage({ ...recorder.record(out), full: null }));
    state = out.state;
  }
  const built = JSON.parse(JSON.stringify(matchRecord({ id, binary: gzipSync(packMessages(messages)), logLines: lines, endedAt: RECEIVED + 404, rerun: true })));
  return {
    ...built, codeVersion: CODE,
    replies: [
      { type: "stub", seat: 0, tick: null, tool: "join", receivedAt: RECEIVED - 50, answeredAt: RECEIVED - 49, code: "call_rate" },
      { type: "reply", seat: 0, tick: 3, tool: "set_brood", receivedAt: RECEIVED + 300, answeredAt: RECEIVED + 301, isError: true,
        reply: { error: { code: "bad_brood", message: "brood is one of workers, soldiers, mixed." } } },
      { type: "reply", seat: 1, tick: 2, tool: "set_brood", receivedAt: RECEIVED + 200, answeredAt: RECEIVED + 201, reply: { ok: true } },
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
function world(options: { versions?: VersionSource; jobs?: PostMortemJobs } = {}) {
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
  const postMortem = createPostMortem({ identities: w.ids, lobbies, registry, history, archive, versions, jobs, now: w.now });
  let lobbyCount = 0;
  /** A lobby of `seats` [identity, colony], its registry row and its stored record under id. */
  function match(n: number, seats: readonly (readonly [{ id: string; name: string }, 0 | 1])[], options: {
    visibility?: "public" | "private"; playbackFinished?: boolean; lobbyState?: string; record?: unknown; row?: boolean;
  } = {}) {
    const lobbyId = `00000000-0000-4000-8000-${String(++lobbyCount).padStart(12, "0")}`;
    const id = replayId(n);
    w.docs.set(`lobbies/${lobbyId}`, { kind: options.visibility ?? "public", size: "1", state: options.lobbyState ?? "ended", rated: "false", slot: "",
      seats: JSON.stringify(seats.map(([who, colony]) => ({ id: who.id, displayName: who.name, colony }))), creatorId: seats[0]![0].id,
      createdAt: String(w.now()), inviteVerifier: "", startsAt: "", matchRunId: "run-1", outcome: "colony_0_won", mode: "" });
    if (options.row !== false) {
      w.docs.set(`watchMatches/${lobbyId}`, { visibility: options.visibility ?? "public", rated: "false", mode: "",
        startedAt: String(RECEIVED).padStart(16, "0"), origin: "https://slot.example", slot: "public-0", runId: "run-1",
        playbackFinished: String(options.playbackFinished ?? true), replayId: id });
    }
    const body = Buffer.from(JSON.stringify(options.record ?? generatedRecord(id)));
    if ((options.visibility ?? "public") === "public") records.set(id, body);
    else {
      const identity = { lobbyId, replayId: id, kind: "match-record" } as const;
      objects.set(privateMediaName(identity), { name: privateMediaName(identity), body: sealPrivateMedia(identity, body, KEY), contentType: "application/octet-stream", ifGenerationMatch: 0 });
    }
    return { lobbyId, id };
  }
  return { w, postMortem, match, records, history, versions, jobs };
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
      { tick: 3, at: new Date(RECEIVED + 300).toISOString(), tool: "set_brood", code: "bad_brood" },
    ] }]);
    const done = await settled(() => f.postMortem.query({ key: alice.key, matchId: id }));
    expect(bodyOf(done).noEffect).toEqual({ status: "shown", commands: [{ seat: 0, tick: 2, type: "set_brood", matchSeconds: 0.2 }] });
    expect((f.versions as ReturnType<typeof versionsAnswering>).asked).toEqual([CODE]);
    // The same cached record, filtered to bob's own seat: none of alice's calls or findings.
    const other = await f.postMortem.query({ key: bob.key, lobbyId });
    expect(bodyOf(other).seats).toEqual([{ seat: 1, colony: 1, refusedNotRetained: 0, refused: [
      { tick: null, at: new Date(RECEIVED - 40).toISOString(), tool: "observe", code: "sdk_error" }] }]);
    expect(bodyOf(other).noEffect).toEqual({ status: "shown", commands: [] });
  }, 60_000);

  it("refuses a non-owner exactly as an unknown lobby or match, before reading any record", async () => {
    const f = world();
    const alice = f.w.played("alice"), mallory = f.w.played("mallory");
    const { lobbyId, id } = f.match(18, [[alice, 0]]);
    const refusals = await Promise.all([
      f.postMortem.query({ key: mallory.key, lobbyId }), f.postMortem.query({ key: mallory.key, matchId: id }),
      f.postMortem.query({ key: mallory.key, lobbyId: "00000000-0000-4000-8000-999999999999" }),
      f.postMortem.query({ key: mallory.key, matchId: replayId(99) }), f.postMortem.query({ key: mallory.key, matchId: "not-an-id" }),
    ]);
    for (const refusal of refusals) expect(JSON.stringify(refusal)).toBe(JSON.stringify({ ok: false, body: { error: "not_found", message: REFUSALS.not_found } }));
    expect(f.history.open).not.toHaveBeenCalledWith(id, expect.anything());
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
    expect((await f.postMortem.query({ key: claimed.value.key, lobbyId })).body.error).toBe("not_found");
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
        process.once("message", () => { const t = setInterval(() => { process.send({ kind: "progress", tick: 0 });
          if (existsSync(${JSON.stringify(gate)})) { clearInterval(t); process.send({ kind: "done", tested: 0, findings: [] }, () => process.exit(0)); } }, 20); });`],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] });
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
      expect(bodyOf((await settled(() => f.postMortem.query({ key: alice.key, lobbyId })))).noEffect).toEqual({ status: "shown", commands: [] });
    }
  }, 60_000);
});

describe("which record seats a caller owns", () => {
  const lobby = (seats: [string, string, 0 | 1][]) => ({ colonies: [0, 1].map(colony => seats.filter(s => s[2] === colony).map(([id, displayName]) => ({ id, displayName }))) as never });
  const seat = (n: number, colony: 0 | 1, handle: string | null) => ({ seat: n, colony, handle });

  it("gives one identity every seat it held in its colony", () => {
    expect(ownedSeats(lobby([["a", "alice", 0], ["a", "alice", 0], ["b", "bob", 1]]), "a", [seat(0, 0, "alice"), seat(1, 0, "alice"), seat(2, 1, "bob")])).toEqual([0, 1]);
  });
  it("cannot confirm when two identities in the colony share the name", () => {
    expect(() => ownedSeats(lobby([["a", "alice", 0], ["c", "alice", 0]]), "a", [seat(0, 0, "alice"), seat(1, 0, "alice")])).toThrow();
  });
  it("serves a seat with no recorded handle only when the colony held the caller alone", () => {
    expect(ownedSeats(lobby([["a", "alice", 0], ["b", "bob", 1]]), "a", [seat(0, 0, null), seat(1, 1, null)])).toEqual([0]);
    expect(() => ownedSeats(lobby([["a", "alice", 0], ["c", "carol", 0]]), "a", [seat(0, 0, null), seat(1, 0, "carol")])).toThrow();
  });
  it("cannot confirm when the record holds no seat matching the caller", () => {
    expect(() => ownedSeats(lobby([["a", "alice", 0]]), "a", [seat(0, 0, "someone")])).toThrow();
  });
});
