import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveHub, type LiveHubOptions } from "../../src/live/hub.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage, type StreamRatingChange } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { decodeInput, type RecordInput } from "../../src/records/inputs.ts";
import type { InputStore } from "../../src/records/input-store.ts";
import { createRecordReplayStore } from "../../src/records/replay-store.ts";
import { createRecordService, RATINGS_UNAVAILABLE, RECOVERY_GRACE_MS, type RecordServiceDeps } from "../../src/records/service.ts";
import { binaryRecord, type HistoryInput } from "../../src/replays/history.ts";
import { ReplayCreateError, type ReplayStore } from "../../src/replays/store.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock } from "./helpers.ts";

import { playable } from "../playable.ts";
import { createOnlyRecords } from "../records/create-only-records.js";
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });

function pipeline(options: { rated?: boolean; ratings?: () => Promise<readonly StreamRatingChange[] | null>; pace?: number; private?: boolean;
  startRatings?: LiveHubOptions["startRatings"] } = {}) {
  const clock = new ManualClock(), pending = new Map<string, Uint8Array>(), published = new Map<string, Uint8Array>();
  const privateObjects = new Map<string, Uint8Array>();
  let binFailures = 0, binaryAttempts = 0;
  const writes: { name: string; at: number }[] = [], logs: string[] = [];
  const writer = (objects: Map<string, Uint8Array>): ReplayStore => ({ async create(object) {
    if (object.name.endsWith(".bin")) {
      binaryAttempts++;
      if (binFailures > 0) { binFailures--; throw new Error("injected replay failure"); }
    }
    if (objects.has(object.name)) throw new ReplayCreateError(412);
    objects.set(object.name, object.body); writes.push({ name: object.name, at: clock.now() });
  } });
  const publicStore = writer(published), privateStore = writer(privateObjects);
  const handoff = createRecordHandoff({ codeVersion: "a".repeat(40), store: { async create(object) {
    if (pending.has(object.name)) throw new ReplayCreateError(412);
    pending.set(object.name, object.body);
  } }, log: line => logs.push(line) });
  const inputs: InputStore = { list: async () => [...pending.keys()], get: async name => pending.get(name) ?? null,
    createMarker: async () => true, markerReason: async () => null, delete: async name => { pending.delete(name); } };
  const archive = { forLobby: () => privateStore, open: async () => { throw new Error("not used by these public tests"); } };
  const hub = new LiveHub({ clock, replayStore: publicStore, privateReplayStore: () => privateStore, captureMatchLogs: true, recordHandoff: handoff,
    resultRatings: options.ratings, startRatings: options.startRatings, config: { ...DEFAULT_LIVE_CONFIG, ...(options.pace === undefined ? {} : { paceBytesPerSecond: options.pace }) } });
  close.push(() => hub.close());
  const replays = createRecordReplayStore({ publicStore, readPublic: async id => published.get(`${id}.bin`) ?? null });
  const deps: RecordServiceDeps = { inputs, records: createOnlyRecords(publicStore, archive), replays, codeVersion: "a".repeat(40), now: () => clock.now(), log: line => logs.push(line) };
  const service = (extra: Partial<RecordServiceDeps> = {}) => createRecordService({ ...deps, ...extra });
  function play(seq = 1) {
    let state = createMatch(6006, playable({ ...rulesConfig("redesign"), matchTicks: 4 }));
    hub.startMatch(seq, state, { lobbyId: "test-lobby", visibility: options.private ? "private" : "public", rated: options.rated ?? false });
    while (state.result === null) {
      const commands = state.tick === 0 ? [{ type: "join" as const, agentId: "secret-agent", modelLabel: "test-agent" }] : [];
      hub.appendLog(seq, tickLine(state.tick, commands));
      const out = step(state, commands);
      clock.advance(100); hub.pushTick(seq, out); state = out.state;
    }
  }
  const savedInput = () => decodeInput([...pending.values()][0]!);
  const record = (id: string) => JSON.parse(new TextDecoder().decode(published.get(`${id}.json`)!));
  return { clock, pending, published, privateObjects, writes, logs, hub, play, savedInput, record, service,
    failBinaries: (n: number) => { binFailures = n; }, attempts: () => binaryAttempts };
}

async function ended(p: ReturnType<typeof pipeline>): Promise<RecordInput> {
  p.play();
  await vi.waitFor(() => expect(p.pending.size).toBe(1));
  return p.savedInput();
}

describe("durable match-end recording recovery", () => {
  it("hands off the seats' start ratings the hub reads at match end, and none when it knows none", async () => {
    const starts = { "kite": { rating: 1520, rd: 70, ratedMatches: 12 } };
    const asked: unknown[] = [];
    const input = await ended(pipeline({ startRatings: access => { asked.push(access); return starts; } }));
    expect(input.startRatings).toEqual(starts);
    expect(asked).toEqual([expect.objectContaining({ lobbyId: "test-lobby" })]);
    expect(await ended(pipeline({ startRatings: () => undefined }))).not.toHaveProperty("startRatings");
    expect(await ended(pipeline())).not.toHaveProperty("startRatings");
  });

  it("saves privately before final release; a closed server is recovered after delay plus grace by a fresh service", async () => {
    const p = pipeline(), input = await ended(p);
    expect(input).toMatchObject({ endedAt: 400, publishAfter: 60_400, rated: false, lobbyId: null });
    expect(p.published.size).toBe(0);
    const frames = unpackMessages(gunzipSync(input.binary)).map(decodeMessage);
    expect(frames.map(frame => frame.tick)).toEqual([0, 1, 2, 3, 4]);
    expect(frames.at(-1)!.events.some(event => event.kind === "end")).toBe(true);
    expect(frames[0]!.full!.setup).not.toHaveProperty("seed");
    p.hub.close();
    await p.service().sweep();
    expect(p.published.size).toBe(0);
    p.clock.advance(60_000 + RECOVERY_GRACE_MS - 1);
    await p.service().sweep();
    expect(p.published.size).toBe(0);
    p.clock.advance(1);
    await p.service().sweep();
    expect([...p.published.keys()]).toEqual([`${input.id}.bin`, `${input.id}.json`]);
    expect(p.record(input.id)).toMatchObject({ status: "complete", source: "match-log" });
    expect(p.pending.size).toBe(0);
    expect(p.writes.every(write => write.at >= input.publishAfter! + RECOVERY_GRACE_MS)).toBe(true);
    expect(p.logs).toEqual([]);
  });

  it("a failed first normal replay upload is recovered without losing the private input", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = pipeline(), input = await ended(p);
    p.failBinaries(1);
    p.clock.advance(60_000);
    await vi.waitFor(() => expect(p.attempts()).toBe(1));
    expect(p.pending.size).toBe(1);
    expect(p.published.size).toBe(0);
    p.clock.advance(RECOVERY_GRACE_MS);
    await p.service().sweep();
    expect(p.attempts()).toBe(2);
    expect(p.record(input.id).status).toBe("complete");
    expect(p.pending.size).toBe(0);
  });

  it("retries a failed recovery upload after a service restart, without counting a verification failure", async () => {
    const p = pipeline(), input = await ended(p);
    p.hub.close(); p.failBinaries(1);
    p.clock.advance(60_000 + RECOVERY_GRACE_MS);
    await p.service().sweep();
    expect([...p.pending.keys()]).toEqual([`${input.id}.input`]);
    expect(p.published.size).toBe(0);
    expect(p.logs).toContainEqual(expect.stringContaining("injected replay failure"));
    await p.service().sweep();
    expect(p.record(input.id).status).toBe("complete");
  });

  it("keeps the normal rated binary and ratings when paced release completes inside the grace window", async () => {
    let available = false;
    const changes: readonly StreamRatingChange[] = [{ agent: 0, before: 1500, after: 1516 }];
    const p = pipeline({ rated: true, ratings: async () => available ? changes : null, pace: 1 });
    const input = await ended(p);
    // Isolate arbitration from the independently owned rated verifier comparison.
    // The service must pass the exact existing binary, not a ratings-stripped checkpoint, to its verifier.
    const build = vi.fn(async (history: HistoryInput) => {
      const decoded = binaryRecord(history);
      return new TextEncoder().encode(JSON.stringify({ ...decoded, status: "complete", source: "match-log" }));
    });
    p.clock.advance(300_000);
    await p.service({ build }).sweep();
    expect(build).not.toHaveBeenCalled();
    expect(p.published.size).toBe(0);
    available = true;
    p.clock.advance(5_000);
    await vi.waitFor(() => expect(p.published.has(`${input.id}.bin`)).toBe(true));
    const normal = p.published.get(`${input.id}.bin`)!;
    expect(normal).not.toEqual(input.binary);
    const svc = p.service({ build });
    await svc.sweep(); await svc.sweep();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]![0].binary).toEqual(normal);
    expect(p.record(input.id).result.ratingChanges).toEqual(changes);
    expect(p.record(input.id).unavailable).not.toContain(RATINGS_UNAVAILABLE);
    expect(p.attempts()).toBe(1);
    expect([...p.published.keys()]).toHaveLength(2);
  });

  it.each([false, true])("publishes a rated fallback with ratings explicitly unavailable after grace (server stopped: %s)", async stopped => {
    const p = pipeline({ rated: true, ratings: async () => null }), input = await ended(p);
    if (stopped) p.hub.close();
    p.clock.advance(300_000 + RECOVERY_GRACE_MS - 1);
    await p.service().sweep();
    expect(p.published.size).toBe(0);
    p.clock.advance(1);
    await p.service().sweep();
    expect(p.record(input.id)).toMatchObject({ status: "complete", result: expect.not.objectContaining({ ratingChanges: expect.anything() }) });
    expect(p.record(input.id).unavailable).toContain(RATINGS_UNAVAILABLE);
    expect(p.writes.every(write => write.at >= input.publishAfter! + RECOVERY_GRACE_MS)).toBe(true);
  });

  it("keeps private recovery held when no private replay adapter is configured, never publishing public", async () => {
    const p = pipeline({ private: true }), input = await ended(p);
    p.hub.close(); p.clock.advance(60_000 + RECOVERY_GRACE_MS);
    await p.service().sweep();
    expect(input.lobbyId).toBe("test-lobby");
    expect(p.published.size).toBe(0);
    expect(p.privateObjects.size).toBe(0);
    expect(p.pending.size).toBe(1);
    expect(p.logs).toContainEqual(expect.stringContaining("replay recovery storage is not configured"));
  });
});
