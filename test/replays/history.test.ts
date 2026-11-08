import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { DECIDED_BY, decodeMessage, encodePublicMessage, WIN_REASONS, type StreamResult } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { PRE_FRONTLINE_CONFIGS } from "../sim/fixtures.ts";
import { threeMapRotation } from "../sim/three-map-rotation.ts";
import { ReplayRecording } from "../../src/replays/recording.ts";
import { ReplayCreateError, type ReplayObject, type ReplayStore } from "../../src/replays/store.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { markerName, type InputStore } from "../../src/records/input-store.ts";
import { decodeInput } from "../../src/records/inputs.ts";
import { createRecordService } from "../../src/records/service.ts";
import { recordStatus, type RecordStore } from "../../src/records/record-store.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { buildGrid, createMatch } from "../../src/sim/map.ts";
import { step, type ServerTerminal } from "../../src/sim/step.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import type { SimConfig } from "../../src/sim/config.ts";
import { takeView } from "../../src/sim/view.ts";
import { captureCells } from "../../src/mcp/cellPages.ts";
import { binaryRecord, HISTORY_TIMEOUT_MS, historyBytes, matchRecord, type MatchRecord } from "../../src/replays/history.ts";
import { playable } from "../playable.ts";

const id = "2026-10-20T02-00-00-000Z-18";
const CODE = "c".repeat(40);

/**
 * The real game-server handoff and the real record service (real history worker), over two separate
 * in-memory create-only buckets: the private inputs the game server writes and the records the service saves.
 */
function recordPath() {
  const inputs = new Map<string, Uint8Array>(), saved = new Map<string, ReplayObject>(), logs: string[] = [];
  const inputBucket: ReplayStore = { create: async object => {
    if (inputs.has(object.name)) throw new ReplayCreateError(412);
    inputs.set(object.name, object.body);
  } };
  const recordBucket: ReplayStore = { create: async object => {
    if (saved.has(object.name)) throw new ReplayCreateError(412);
    saved.set(object.name, object);
  } };
  const serviceInputs: InputStore = {
    list: async () => [...inputs.keys()].sort(),
    get: async name => inputs.get(name) ?? null,
    createMarker: async (match, n, reason, codeVersion) => {
      if (inputs.has(markerName(match, n, codeVersion))) return false;
      inputs.set(markerName(match, n, codeVersion), new TextEncoder().encode(reason));
      return true;
    },
    markerReason: async (match, n, codeVersion) => {
      const body = inputs.get(markerName(match, n, codeVersion));
      return body === undefined ? null : new TextDecoder().decode(body);
    },
    delete: async name => { inputs.delete(name); },
  };
  const handoff = createRecordHandoff({ store: inputBucket, codeVersion: CODE, log: line => logs.push(line), delays: [1] });
  // Public records only, created once in the record bucket: a collision retains the input.
  const records: RecordStore = { forMatch: (id, lobbyId) => lobbyId !== null ? undefined : { async save(body) {
    const status = recordStatus(body, id);
    await recordBucket.create({ name: `${id}.json`, body, contentType: "application/json", ifGenerationMatch: 0 });
    return { complete: status === "complete", outcome: "record created" };
  } } };
  const service = createRecordService({ inputs: serviceInputs, records, codeVersion: CODE, log: line => logs.push(line) });
  return { inputs, saved, logs, handoff, service };
}
/** `rated` makes a rated match's recording: the live hub adds rating changes to the delayed final result. */
function fixture(agents = 8, rules: "v4" | "redesign" = "redesign", recipe = rulesConfig(rules),
  rated?: (result: StreamResult) => StreamResult, levels: readonly (string | undefined)[] = [], tiers: readonly (string | undefined)[] = [],
  identities: readonly (string | undefined)[] = []) {
  const config = { ...playable(recipe), matchTicks: 4, commandFloorTicks: 100, startAnts: 16 };
  let state = createMatch(6006, config);
  const recorder = new SpectatorRecorder(state, { identity: agentId => {
    const displayName = identities[Number(agentId.replace("seat-private-", ""))];
    return displayName === undefined ? undefined : { displayName, elo: 1500 };
  } });
  const full = recorder.initialFull();
  if (rated) full.setup = { ...full.setup, rated: true };
  const messages = [encodePublicMessage({ ...recorder.initial(), full })];
  const lines = [headerLine(state.seed, config)];
  const names = ["model-V1", "model-V2", "model-V3", "model-V4", "model-L1", "model-L2", "model-L3", "model-L4"];
  while (state.result === null) {
    const inputs: SimInput[] = state.tick === 0 ? names.slice(0, agents).map((modelLabel, index) => ({ type: "join", agentId: `seat-private-${index}`, modelLabel,
      ...(levels[index] === undefined ? {} : { thinkingLevel: levels[index] }), ...(tiers[index] === undefined ? {} : { serviceTier: tiers[index] }) }))
      : agents > 0 && state.tick < 3 ? [{ type: "order", agentId: "seat-private-0", order: { kind: "hold" }, intent: "defend" }] : [];
    if (inputs.length) lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    const message = recorder.record(out);
    const events = rated ? message.events.map(event => event.kind === "end" ? { ...event, result: rated(event.result) } : event) : message.events;
    messages.push(encodePublicMessage({ ...message, events, full: null }));
    state = out.state;
  }
  return { id, binary: gzipSync(packMessages(messages)), logLines: lines, endedAt: Date.parse("2026-10-20T02:00:00.404Z") };
}

it("replays recorded config and retains eight labels plus accepted/refused requests and reasons", () => {
  const record = matchRecord(fixture());
  expect(record).toMatchObject({ source: "match-log", status: "complete", startedAt: "2026-10-20T02:00:00.000Z",
    endedAt: "2026-10-20T02:00:00.404Z", rules: { holdBehaviour: "ant115", config: { matchTicks: 4 } } });
  expect(record.seats.map(seat => seat.modelLabel)).toEqual(["model-V1", "model-V2", "model-V3", "model-V4", "model-L1", "model-L2", "model-L3", "model-L4"]);
  expect(record.seats[0]!.commands.slice(1)).toEqual([
    { tick: 1, type: "order", accepted: true, request: { type: "order", order: { kind: "hold" }, intent: "defend" }, error: null },
    { tick: 2, type: "order", accepted: false, request: { type: "order", order: { kind: "hold" }, intent: "defend" }, error: expect.objectContaining({ code: "rate_limited" }) },
  ]);
  expect(JSON.stringify(record)).not.toContain("seat-private");
  expect(record.setup).not.toHaveProperty("seed");
});

it.each(["v4", "redesign"] as const)("an empty built-in-planner match uses its recorded %s rules and produces no invented seats", rules => {
  const record = matchRecord(fixture(0, rules));
  expect(record.seats).toEqual([]);
  expect(record.rules!.config).toMatchObject({ rules, matchTicks: 4 });
  expect(record.result).not.toBeNull();
});

it("preserves independent thinking levels in binary, verified log and record-service output", async () => {
  const levels = ["high", "low", "🧠".repeat(32), undefined, "max", undefined, "xhigh", "minimal"];
  const input = fixture(8, "redesign", undefined, undefined, levels);
  const expected = levels.map(level => level ?? null);
  expect(binaryRecord(input).seats.map(seat => seat.thinkingLevel)).toEqual(expected);
  expect(matchRecord(input).seats.map(seat => seat.thinkingLevel)).toEqual(expected);
  const path = recordPath();
  path.handoff.submit({ ...input, lobbyId: null });
  await vi.waitFor(() => expect(path.inputs.has(`${id}.input`)).toBe(true));
  await path.service.sweep();
  const saved = path.saved.get(`${id}.json`);
  expect(saved).toBeDefined();
  const record = JSON.parse(new TextDecoder().decode(saved!.body)) as MatchRecord;
  expect(record.status).toBe("complete");
  expect(record.seats.map(seat => seat.thinkingLevel)).toEqual(expected);
});

it("refuses thinking-level disagreements between a log and its binary", () => {
  const input = fixture(8, "redesign", undefined, undefined, ["high"]);
  const logLines = input.logLines.map(line => line.replace('"thinkingLevel":"high"', '"thinkingLevel":"low"'));
  expect(() => matchRecord({ ...input, logLines })).toThrow("log calls do not match binary");
});

it("normalizes levels omitted from logs and binaries to null", () => {
  const input = fixture();
  expect(matchRecord(input).seats.every(seat => seat.thinkingLevel === null)).toBe(true);
  const { logLines: _log, endedAt: _end, ...binaryOnly } = input;
  expect(binaryRecord(binaryOnly).seats.every(seat => seat.thinkingLevel === null)).toBe(true);
});

it("preserves each seat's self-reported service tier in binary, verified log and record-service output", async () => {
  const levels = ["high", undefined, "xhigh"];
  const tiers = ["fast", "fast", undefined, "default", "⚡".repeat(32)];
  const input = fixture(8, "redesign", undefined, undefined, levels, tiers);
  const expected = ["fast", "fast", null, "default", "⚡".repeat(32), null, null, null];
  expect(binaryRecord(input).seats.map(seat => seat.serviceTier)).toEqual(expected);
  expect(matchRecord(input).seats.map(seat => seat.serviceTier)).toEqual(expected);
  expect(matchRecord(input).seats.map(seat => seat.thinkingLevel)).toEqual(["high", null, "xhigh", null, null, null, null, null]);
  const path = recordPath();
  path.handoff.submit({ ...input, lobbyId: null });
  await vi.waitFor(() => expect(path.inputs.has(`${id}.input`)).toBe(true));
  await path.service.sweep();
  const saved = path.saved.get(`${id}.json`);
  expect(saved).toBeDefined();
  const record = JSON.parse(new TextDecoder().decode(saved!.body)) as MatchRecord;
  expect(record.status).toBe("complete");
  expect(record.seats.map(seat => seat.serviceTier)).toEqual(expected);
});

it("copies each seat's recorded handle, without a seat suffix, into binary, verified log and record-service output", async () => {
  const identities = ["antwars/gpt-6-1-sol-xhigh", "alice/bot #2", undefined, "antwars/gpt-6-1-sol-high-fast #10", "bob/seat#3"];
  const input = fixture(8, "redesign", undefined, undefined, [], [], identities);
  const expected = ["antwars/gpt-6-1-sol-xhigh", "alice/bot", null, "antwars/gpt-6-1-sol-high-fast", "bob/seat#3", null, null, null];
  expect(binaryRecord(input).seats.map(seat => seat.handle)).toEqual(expected);
  expect(matchRecord(input).seats.map(seat => seat.handle)).toEqual(expected);
  const path = recordPath();
  path.handoff.submit({ ...input, lobbyId: null });
  await vi.waitFor(() => expect(path.inputs.has(`${id}.input`)).toBe(true));
  await path.service.sweep();
  const record = JSON.parse(new TextDecoder().decode(path.saved.get(`${id}.json`)!.body)) as MatchRecord;
  expect(record.status).toBe("complete");
  expect(record.seats.map(seat => seat.handle)).toEqual(expected);
  // A recording whose stream carries no identities, as before spectator stream version 17, records no handle.
  expect(matchRecord(fixture()).seats.every(seat => seat.handle === null)).toBe(true);
});

it("refuses service-tier disagreements between a log and its binary", () => {
  const input = fixture(8, "redesign", undefined, undefined, [], ["fast"]);
  const logLines = input.logLines.map(line => line.replace('"serviceTier":"fast"', '"serviceTier":"slow"'));
  expect(() => matchRecord({ ...input, logLines })).toThrow("log calls do not match binary");
});

it("normalizes service tiers omitted from logs, current binaries and historical binaries to null", () => {
  const input = fixture(8, "redesign", undefined, undefined, ["high"]);
  expect(matchRecord(input).seats.every(seat => seat.serviceTier === null)).toBe(true);
  const { logLines: _log, endedAt: _end, ...binaryOnly } = input;
  expect(binaryRecord(binaryOnly).seats.every(seat => seat.serviceTier === null)).toBe(true);
});

it("binary fallback keeps facts and explicitly marks missing rules, refusal details and wall time", () => {
  const { logLines: _log, endedAt: _end, ...input } = fixture();
  const record = binaryRecord(input);
  expect(record).toMatchObject({ status: "partial", source: "binary", rules: null, endedAt: null });
  expect(record.simulationEndedAt).toBe("2026-10-20T02:00:00.400Z");
  const commands = record.seats[0]!.commands;
  expect(commands[1]).toMatchObject({ type: "order", accepted: true, request: { order: { kind: "hold" } } });
  expect(commands[2]).toMatchObject({ type: "order", accepted: false, request: null, error: null });
  expect(record.unavailable.join(" ")).toContain("refusal reasons");
});

// Recordings made before recordings stored their grid scale carry no grid scale and are archived: their setup is refused, never read at another scale.
it("refuses a landed binary from before grid scales were stored without running today's simulation", () => {
  const binary = readFileSync(new URL("../live/fixtures/historical-v4.bin", import.meta.url));
  expect(() => binaryRecord({ id, binary })).toThrow("stream setup version 4 carries no grid scale: every match plays at grid scale 2");
});

it("does not pass an incomplete, duplicate or unrelated log as complete", () => {
  const input = fixture();
  expect(() => matchRecord({ ...input, logLines: input.logLines.slice(0, -1) })).toThrow("calls do not match");
  expect(() => matchRecord({ ...input, logLines: [...input.logLines, input.logLines[1]!] })).toThrow("duplicate log tick");
  const altered = input.logLines.slice();
  altered[0] = altered[0]!.replace('"seed":6006', '"seed":1');
  expect(() => matchRecord({ ...input, logLines: altered })).toThrow("does not match binary");
  expect(() => matchRecord({ ...input, logLines: ["not JSON"] })).toThrow();
});

it.each([false, true])("uploads caste-bearing v18 history without hiding real log disagreements (altered log: %s)", async altered => {
  const config = { ...threeMapRotation(newMatchConfig(PRE_FRONTLINE_CONFIGS.redesign)), matchTicks: 192, commandFloorTicks: 100 };
  let state = createMatch(132310736, config);
  const recorder = new SpectatorRecorder(state);
  const opening = encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() });
  expect(config).toMatchObject({ mapWidth: 128, mapHeight: 96, gridScale: 2 });
  expect(opening[2]).toBe(18);
  const objects: ReplayObject[] = [], errors: string[] = [];
  const records = recordPath();
  const header = headerLine(altered ? 132310737 : state.seed, config);
  const recording = new ReplayRecording(Date.parse("2026-10-20T02:00:00.000Z"), 18,
    { create: async object => { objects.push(object); } }, error => errors.push(error),
    { logHeader: header, handoff: records.handoff });
  recording.append(opening);
  let casteDelta = false;
  while (state.result === null) {
    const inputs: SimInput[] = state.tick === 0
      ? [{ type: "join", agentId: "private-caste-seat", modelLabel: "caste recorder" }]
      : state.tick === 1 ? [{ type: "order", agentId: "private-caste-seat", order: { kind: "hold" }, intent: "defend" }] : [];
    if (inputs.length) recording.appendLog(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    const delta = encodePublicMessage({ ...recorder.record(out), full: null });
    const decoded = decodeMessage(delta);
    if (decoded.tick >= 64 && decoded.ants.caste !== undefined) casteDelta = true;
    recording.append(delta);
    state = out.state;
  }
  expect(state.tick).toBe(192);
  expect(casteDelta).toBe(true);
  recording.ended(Date.parse("2026-10-20T02:00:19.200Z"));
  expect(await recording.finish()).toBe(true);
  // The game server uploads only the binary and hands the match's inputs to the record service.
  expect(objects.map(object => object.name)).toEqual([`${id}.bin`]);
  expect(errors).toEqual([]);
  await vi.waitFor(() => expect([...records.inputs.keys()]).toEqual([`${id}.input`]));
  const input = decodeInput(records.inputs.get(`${id}.input`)!);
  expect(input).toMatchObject({ id, codeVersion: CODE, endedAt: Date.parse("2026-10-20T02:00:19.200Z"), lobbyId: null });
  expect(input.logLines[0]).toBe(header);
  expect(input.logLines.slice(1)).toEqual([tickLine(0, [{ type: "join", agentId: "private-caste-seat", modelLabel: "caste recorder" }]),
    tickLine(1, [{ type: "order", agentId: "private-caste-seat", order: { kind: "hold" }, intent: "defend" }])]);
  expect(Buffer.from(input.binary).equals(Buffer.from(objects[0]!.body))).toBe(true);

  // The record service builds the readable record from those inputs alone.
  await records.service.sweep();
  if (altered) {
    // A log/replay disagreement is never saved complete: the service retries, then saves it unavailable.
    expect(records.saved.size).toBe(0);
    await records.service.sweep();
    expect(records.saved.size).toBe(0);
    await records.service.sweep();
  }
  expect([...records.saved.keys()]).toEqual([`${id}.json`]);
  expect(records.saved.get(`${id}.json`)!.contentType).toBe("application/json");
  expect([...records.inputs.keys()]).toEqual(altered
    ? [`${id}.input`, markerName(id, 1, CODE), markerName(id, 2, CODE), markerName(id, 3, CODE)]
    : []);
  const record = JSON.parse(new TextDecoder().decode(records.saved.get(`${id}.json`)!.body)) as MatchRecord;
  if (altered) {
    expect(record).toMatchObject({ status: "unavailable", source: "unavailable", rules: null, result: null, seats: [] });
    expect(record.unavailable.join(" ")).toContain("does not match binary");
    expect(records.logs.filter(line => line.includes("build failed"))).toHaveLength(3);
  } else {
    expect(records.logs).toEqual([]);
    expect(record.status, record.unavailable.join("; ")).toBe("complete");
    expect(record).toMatchObject({ status: "complete", source: "match-log", rules: { config },
      result: state.result, endedAt: "2026-10-20T02:00:19.200Z" });
    expect(record.seats).toHaveLength(1);
    expect(record.seats[0]).toMatchObject({ modelLabel: "caste recorder", commands: [
      { tick: 0, type: "join", accepted: true },
      { tick: 1, type: "order", accepted: true, request: { order: { kind: "hold" }, intent: "defend" } },
    ] });
    expect(JSON.stringify(record)).not.toContain("private-caste-seat");
  }
}, 30_000);

describe("isolated serialization worker", () => {
  it("returns typed JSON through the real Node TypeScript resolver", async () => {
    const record = JSON.parse(new TextDecoder().decode(await historyBytes(fixture()))) as MatchRecord;
    expect(record.status).toBe("complete");
    expect(record.seats).toHaveLength(8);
  });
  it.each([new Uint8Array([4]), new Uint8Array([0, 0, 0, 0]), new Uint8Array([1, 0, 0, 0, 1])])("writes an explicit stub for damaged/unsupported bytes", async binary => {
    const record = JSON.parse(new TextDecoder().decode(await historyBytes({ id, binary }))) as MatchRecord;
    expect(record).toMatchObject({ source: "unavailable", status: "unavailable", result: null, seats: [] });
    expect(record.unavailable[0]!.length).toBeGreaterThan(0);
  });
  it("forwards the worker's actual error instead of a generic one", async () => {
    await expect(historyBytes({ id: "not-a-replay-id", binary: new Uint8Array([4]) })).rejects.toThrow(/^invalid replay id$/);
  });
});

describe("worker timeout", () => {
  const delays = async (run: () => Promise<unknown>) => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try { await run().catch(() => {}); return spy.mock.calls.map(call => call[1]); } finally { spy.mockRestore(); }
  };
  it("defaults to 300 seconds when omitted", async () => {
    expect(HISTORY_TIMEOUT_MS).toBe(300_000);
    expect(await delays(() => historyBytes({ id, binary: new Uint8Array([4]) }))).toContain(300_000);
  });
  it("uses an explicit override", async () => {
    const observed = await delays(() => historyBytes({ id, binary: new Uint8Array([4]) }, 600_000));
    expect(observed).toContain(600_000);
    expect(observed).not.toContain(300_000);
  });
  it("rejects with the timeout message when the override elapses", async () => {
    await expect(historyBytes(fixture(), 1)).rejects.toThrow(/^match record worker timed out$/);
  });
});

it.each(["time_up", "double_overrun", "queens_killed"] as const)("retains a kills-decided %s result in readable match records", reason => {
  const state = createMatch(6006, playable(rulesConfig("redesign")));
  const result = { winner: 0 as const, reason, decidedBy: "kills" as const, tick: 0 };
  const recorder = new SpectatorRecorder(state);
  const first = { ...recorder.initial(), full: recorder.initialFull() };
  const end = { tick: 1, ants: first.ants, full: null,
    events: [{ kind: "end" as const, result: { ...result, nextStartMs: null } }] };
  const binary = gzipSync(packMessages([encodePublicMessage(first), encodePublicMessage(end)]));
  expect(binaryRecord({ id, binary }).result).toEqual(result);
});

it("the verified log record retains the new scoring marker and result", () => {
  const input = fixture(8, "redesign", PRE_FRONTLINE_CONFIGS.redesign);
  const record = matchRecord(input);
  expect(record.rules).toMatchObject({ version: 27, holdBehaviour: "ant115", config: { adjudication: "kills-first" } });
  expect(record.result).toEqual(binaryRecord(input).result);
});

describe("rated match records", () => {
  const ratingChanges = [{ agent: 0, before: 1500, after: 1516.25 }, { agent: 1, before: 1500, after: 1483.75 }];
  const withRatings = (result: StreamResult): StreamResult => ({ ...result, ratingChanges });

  it("builds a complete record from the match log and publishes the binary's rating changes", async () => {
    const input = fixture(8, "redesign", undefined, withRatings);
    expect(binaryRecord(input).result!.ratingChanges).toEqual(ratingChanges);
    const record = matchRecord(input);
    expect(record).toMatchObject({ status: "complete", source: "match-log", result: { ratingChanges } });
    expect(record.result).toEqual(binaryRecord(input).result);
    // The serialized record the record service saves keeps them too.
    const published = JSON.parse(new TextDecoder().decode(await historyBytes(input))) as MatchRecord;
    expect(published).toMatchObject({ status: "complete", source: "match-log", result: { ratingChanges } });
  });

  it.each([
    ["winner", (result: StreamResult): StreamResult => ({ ...result, winner: result.winner === 0 ? 1 : 0 })],
    ["reason", (result: StreamResult): StreamResult => ({ ...result, reason: WIN_REASONS.find(reason => reason !== result.reason)! })],
    ["decidedBy", (result: StreamResult): StreamResult => ({ ...result, decidedBy: DECIDED_BY.find(by => by !== result.decidedBy)! })],
  ] as const)("still refuses a log whose result differs from the rated binary's in %s", (_field, alter) => {
    const input = fixture(8, "redesign", undefined, result => withRatings(alter(result)));
    expect(() => matchRecord(input)).toThrow("log result does not match binary under recorded rules");
  });
});

/**
 * A match whose log carries every server control a tick can be given. Four seats, whose calls interleave within a
 * tick and lay count marks, whose ids follow the input order, so a rebuild must take the cross-seat order from the record's
 * call events. houseActive with a gap at tick 2, where a one-tick command-idle limit lapses the seats, so it takes two
 * ranges that a rebuild must honour. The match ends at tick 4 by the given terminal.
 */
function controlledMatch(terminal: ServerTerminal) {
  const config = { ...playable(rulesConfig("redesign")), matchTicks: 8, commandFloorTicks: 100, startAnts: 16,
    commandIdleTicks: 1 };
  let state = createMatch(6006, config);
  const recorder = new SpectatorRecorder(state);
  const messages = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const lines = [headerLine(state.seed, config)];
  const states: SimState[] = [];
  const order = (seat: number): SimInput => ({ type: "order", agentId: `seat-private-${seat}`, order: { kind: "hold" }, intent: "defend" });
  const defend = (seat: number): SimInput => ({ type: "count_mark", agentId: `seat-private-${seat}`, verb: "DEFEND", count: 1 });
  const observe = (seat: number): SimInput => ({ type: "observe", agentId: `seat-private-${seat}` });
  const calls: Record<number, SimInput[]> = {
    0: [3, 1, 0, 2].map(seat => ({ type: "join", agentId: `seat-private-${seat}`, modelLabel: `model-V${seat + 1}` })),
    1: [defend(2), defend(0), observe(3), order(1), defend(1)],
    2: [observe(1), defend(3), order(2)],
    3: [order(0), observe(2)],
  };
  while (state.result === null) {
    const tick = state.tick, inputs = calls[tick] ?? [];
    const stop: ServerTerminal = tick === 4 ? terminal : false, houseActive = tick !== 2;
    lines.push(tickLine(tick, inputs, stop, houseActive));
    const out = step(state, inputs, undefined, undefined, undefined, stop, houseActive);
    messages.push(encodePublicMessage({ ...recorder.record(out), full: null }));
    state = out.state;
    states.push(state);
  }
  return { input: { id, binary: gzipSync(packMessages(messages)), logLines: lines, endedAt: Date.parse("2026-10-20T02:00:00.404Z") }, states };
}

/**
 * Ways a rebuild can go wrong that the rebuild check must catch: dropping the recorded terminal, giving house-active
 * on every tick instead of the recorded ranges, and sorting each tick's calls by seat instead of the recorded cross-seat order.
 */
type WrongRebuild = "ignore terminal" | "house-active every tick" | "sorted call order";

/** Re-run a match from its public record alone: rules.config, rerun, each seat's requests and the call events' order. */
function rebuild(record: MatchRecord, wrong?: WrongRebuild): SimState[] {
  const rerun = record.rerun!;
  const next = record.seats.map(() => 0);
  const order = new Map<number, number[]>();
  for (const { tick, event } of record.events) if (event.kind === "call") order.set(tick, [...order.get(tick) ?? [], event.agent]);
  if (wrong === "sorted call order") for (const seats of order.values()) seats.sort((a, b) => a - b);
  const within = (tick: number) => wrong === "house-active every tick" || rerun.houseActive.some(([first, last]) => first <= tick && tick <= last);
  let state = createMatch(rerun.seed, record.rules!.config as SimConfig);
  const states: SimState[] = [];
  while (state.result === null) {
    const tick = state.tick;
    const inputs = (order.get(tick) ?? []).map(seat => {
      const command = record.seats[seat]!.commands[next[seat]!++]!;
      expect(command.tick).toBe(tick);
      return { ...command.request, agentId: `seat-${seat}` } as SimInput;
    });
    const idle = rerun.idle.find(entry => entry.tick === tick);
    const terminal: ServerTerminal = idle !== undefined ? { idle: idle.colonies } : rerun.abandonments.includes(tick) ? "abandoned" : rerun.stops.includes(tick);
    state = step(state, inputs, undefined, undefined, undefined, wrong === "ignore terminal" ? false : terminal, within(tick)).state;
    states.push(state);
  }
  return states;
}

/** A state as a public rebuild names its agents: seat-private-n is seat n (the joins above are in seat order 3, 1, 0, 2). */
const JOIN_SEATS = [2, 1, 3, 0];
const asSeats = (text: string) => text.replace(/seat-private-(\d)/g, (_, agent: string) => `seat-${JOIN_SEATS[Number(agent)]}`);

/** The rebuild check: the first way a rebuilt match differs from the original, in tick count, tick state or a seat's cell page, or null. */
function rebuildMismatch(rebuilt: SimState[], states: SimState[]): string | null {
  if (rebuilt.length !== states.length) return `rebuilt ${rebuilt.length} ticks, original ${states.length}`;
  const page = (s: SimState, agentId: string) => {
    const snapshot = captureCells(takeView(s, buildGrid(s), s.agents.find(a => a.id === agentId)!), s.config);
    return asSeats(JSON.stringify({ tick: snapshot.tick, squadCells: snapshot.squadCells, cells: snapshot.cells }));
  };
  for (const [index, state] of rebuilt.entries()) {
    const original = states[index]!;
    if (JSON.stringify(state) !== asSeats(JSON.stringify(original))) return `state differs after tick ${original.tick}`;
    for (const agent of original.agents) {
      if (page(state, asSeats(agent.id)) !== page(original, agent.id)) return `cell page of ${asSeats(agent.id)} differs after tick ${original.tick}`;
    }
  }
  return null;
}

const TERMINALS = [["stop", true], ["abandoned", "abandoned"], ["idle", { idle: [1] }]] as [string, ServerTerminal][];

describe("public record rerun inputs", () => {
  it.each(TERMINALS)(
    "carries the log's seed and %s control, and rebuilds every tick's state and each seat's cell page from the record alone", (_name, terminal) => {
      const { input, states } = controlledMatch(terminal);
      const record = JSON.parse(JSON.stringify(matchRecord({ ...input, rerun: true }))) as MatchRecord;
      expect(record.status).toBe("complete");
      expect(record.rerun).toEqual({ seed: 6006, stops: terminal === true ? [4] : [], abandonments: terminal === "abandoned" ? [4] : [],
        idle: typeof terminal === "object" ? [{ tick: 4, colonies: [1] }] : [], houseActive: [[0, 1], [3, 4]] });
      expect(JSON.stringify(record)).not.toContain("seat-private");
      expect(rebuildMismatch(rebuild(record), states)).toBeNull();
    });

  it.each((["ignore terminal", "house-active every tick", "sorted call order"] as WrongRebuild[])
    .flatMap(wrong => TERMINALS.map(([name, terminal]) => [wrong, name, terminal] as [WrongRebuild, string, ServerTerminal])))(
    "the rebuild check fails a rebuild that uses %s (%s control)", (wrong, _name, terminal) => {
      const { input, states } = controlledMatch(terminal);
      const record = JSON.parse(JSON.stringify(matchRecord({ ...input, rerun: true }))) as MatchRecord;
      // The same record rebuilt correctly passes the check, so a mismatch below comes from the wrong rebuild alone.
      expect(rebuildMismatch(rebuild(record), states)).toBeNull();
      expect(rebuildMismatch(rebuild(record, wrong), states)).not.toBeNull();
    });

  it("is absent without the flag, and from a record not verified against a log", () => {
    const { input } = controlledMatch(true);
    const record = matchRecord(input);
    expect(record).not.toHaveProperty("rerun");
    expect(record.setup).not.toHaveProperty("seed");
    expect(binaryRecord({ ...input, rerun: true })).not.toHaveProperty("rerun");
    expect(matchRecord({ ...input, logLines: undefined, rerun: true })).not.toHaveProperty("rerun");
  });
});
