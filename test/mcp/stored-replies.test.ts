/// <reference types="node" />
/**
 * Every call a seat makes to the match server, game and account tools alike, is one ordered line for that
 * seat's match recording: an entry (tick, received and answered times, the tool, the arguments as sent and the reply
 * as answered, together within 8,192 bytes, observe/join/rules replies without the map page, every credential field a
 * named marker) within the seat's recording budget, a stub for a rate-limited call, an SDK error or a call past it. Rules text, join briefing and tool descriptions are text lines,
 * once per match, uncapped, named by digest.
 */
import { createHash, randomBytes } from "node:crypto";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { registerAccountTools } from "../../src/accounts/mcpTools.ts";
import { redactedMarker, STORED_ENTRY_BYTES, STORED_NAMES_BYTES, storedCall } from "../../src/mcp/replies.ts";
import type { MatchInputs } from "../../src/records/handoff.ts";
import { ReplayRecording } from "../../src/replays/recording.ts";
import { START_PICK_WINDOW_MS } from "../../src/sim/startPlacement.ts";
import { expandCells } from "../../src/sim/view.ts";
import { startHarness, TEST_MCP_CONFIG, type Harness } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
});

// Test reads of recorded JSON.
type Entry = { type: string; agentId: string; tick: number | null; tool: string; receivedAt: number; answeredAt: number; arguments?: any;
  argumentsTrimmed?: string[]; redacted?: string[]; reply: any; isError?: true; trimmed?: string[]; textRefs?: Record<string, string> };
type Text = { type: "text"; digest: string; kind: string; text: string };
type Stub = { type: "stub"; agentId: string; tick: number | null; tool: string; receivedAt: number; answeredAt: number; code: string | null };
const lines = (harness: Harness): any[] => harness.replies.map(({ line }) => JSON.parse(line));
const entries = (harness: Harness): Entry[] => lines(harness).filter(line => line.type === "reply") as Entry[];
const texts = (harness: Harness): Text[] => lines(harness).filter(line => line.type === "text") as Text[];
const stubs = (harness: Harness): Stub[] => lines(harness).filter(line => line.type === "stub") as Stub[];
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** The reply lines a match recording hands off in its record input after receiving lines, with one tick of play. */
async function storedLines(lines: readonly string[]): Promise<any[]> {
  const submitted: MatchInputs[] = [];
  const recording = new ReplayRecording(0, 1, { create: async () => {} }, undefined,
    { handoff: { submit: (inputs: MatchInputs) => { submitted.push(inputs); } }, logHeader: "{\"header\":1}" });
  for (const line of lines) recording.appendLog(line);
  recording.appendLog(JSON.stringify({ tick: 0, inputs: [] }));
  const frame = randomBytes(64);
  frame[3] = frame[3]! & 0xfe;
  recording.capture(frame);
  recording.append(frame);
  recording.ended(100, { publishAfter: 100, rated: false });
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  return (submitted[0]!.replyLines ?? []).map(line => JSON.parse(line));
}

/** Per seat and second of answer time, how many stub lines; and every call the stub lines account for (1 + omitted each). */
const stubsPerSecond = (lines: any[]): number => Math.max(0, ...Object.values(lines.filter(line => line.type === "stub")
  .reduce<Record<string, number>>((n, stub) => ({ ...n, [`${stub.agentId}@${Math.floor(stub.answeredAt / 1000)}`]: (n[`${stub.agentId}@${Math.floor(stub.answeredAt / 1000)}`] ?? 0) + 1 }), {})));
const stubCalls = (lines: any[]): number => lines.filter(line => line.type === "stub").reduce((n, stub) => n + 1 + (stub.omitted ?? 0), 0);

describe("a seat's calls in its match recording", () => {
  it("records a successful join and a command reply in full, with the arguments exactly as sent and the call's tick", async () => {
    h = await startHarness();
    h.clock.now = 1_762_428_000_000;
    const a = await h.connect();
    const joined = await a.call("join", { displayName: "Ada" });
    // An unknown field the order schema strips before the handler: the recording keeps it, as sent.
    const order = await a.call("order", { kind: "forage", intent: "east", extra: [1, 2] });
    expect(order.isError).toBe(false);
    const recorded = entries(h);
    expect(recorded.map(entry => entry.tool)).toEqual(["join", "order"]);
    expect(h.replies.every(({ seq }) => seq === h!.game.match!.seq)).toBe(true);
    const [join, command] = recorded;
    expect(join).toMatchObject({ type: "reply", agentId: joined.data.agentId, tool: "join", arguments: { displayName: "Ada" } });
    // The command reply is the reply the agent received, whole; the arguments are as sent, intent unclamped.
    expect(command).toEqual({ type: "reply", agentId: joined.data.agentId, tick: h.game.match!.state.tick, tool: "order",
      receivedAt: 1_762_428_000_000, answeredAt: 1_762_428_000_000, arguments: { kind: "forage", intent: "east", extra: [1, 2] }, reply: order.data });
  });

  it("stores observe without the map page, territory and enemy queens, keeping the page's cursor, offset and count and every other field", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.call("join", {});
    const observed = await a.call("observe", { map: true });
    const view = observed.data.view;
    expect(view.territory).toBeDefined();
    const entry = entries(h).at(-1)!;
    expect(entry.tool).toBe("observe");
    expect(entry.arguments).toEqual({ map: true });
    expect(entry.trimmed).toBeUndefined();
    const { cells, territory: _territory, enemyQueens: _enemyQueens, ...kept } = view;
    expect(entry.reply.view).toEqual({ ...kept, cellsOffset: 0, cellsCount: expandCells(cells).length });
    expect(entry.reply.view).toHaveProperty("cellsTick");
    expect(entry.reply.view).toHaveProperty("cellsMore");
    expect(entry.reply.view).toHaveProperty("cellsCursor");
    const { view: _view, ...rest } = observed.data;
    const { view: _storedView, ...storedRest } = entry.reply;
    expect(storedRest).toEqual(rest);
    expect(bytes(entry.reply)).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
  });

  it("carries the rules text and join briefing once per match as text lines that rules and join replies name; drops the largest fields of an over-cap observe", async () => {
    h = await startHarness();
    const a = await h.connect();
    const joined = await a.call("join", {});
    const rules = await a.call("rules", {});
    expect(bytes(rules.data)).toBeGreaterThan(STORED_ENTRY_BYTES);
    await a.call("rules", {});
    const served = texts(h);
    expect(served.map(text => text.kind)).toEqual(["briefing", "rules"]);
    const [briefing, rulesText] = served;
    expect(briefing!.text).toBe(joined.data.briefing);
    expect(rulesText!.text).toBe(rules.data.rules);
    expect(rulesText!.digest).toBe(createHash("sha256").update(rules.data.rules).digest("hex"));
    const [joinEntry, ...rulesEntries] = entries(h);
    expect(joinEntry!.textRefs).toEqual({ briefing: briefing!.digest });
    expect(joinEntry!.reply).not.toHaveProperty("briefing");
    expect(rulesEntries).toHaveLength(2);
    for (const entry of rulesEntries) {
      expect(entry.textRefs).toEqual({ rules: rulesText!.digest });
      expect(entry.trimmed).toBeUndefined();
      expect(entry.reply).toEqual(Object.fromEntries(Object.entries(rules.data).filter(([key]) => key !== "rules")));
    }
    // Each text line comes before the first entry naming it.
    const order = lines(h).map(line => line.type === "text" ? line.kind : line.tool);
    expect(order).toEqual(["briefing", "join", "rules", "rules", "rules"]);

    // An observe over the cap once its map page is gone: a long events page and a large marks table.
    const events = Array.from({ length: 20 }, (_, i) => ({ type: "message", tick: i, text: "e".repeat(400) }));
    const marks = Array.from({ length: 30 }, (_, i) => ({ markId: i, words: ["FOOD"], note: "m".repeat(100) }));
    const data = { status: [12, "order observe"], view: { tick: 9, food: 3, cells: { data: "c".repeat(50_000) }, territory: "t".repeat(9_000),
      enemyQueens: [], cellsTick: 9, cellsMore: false, cellsCursor: null, events, marks, eventCursor: 20 } };
    const result: CallToolResult = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    const stored = storedCall("observe", { map: true }, result);
    expect(stored.call.trimmed).toEqual(["reply.view.events"]);
    expect(stored.texts).toEqual([]);
    expect(bytes({ arguments: stored.call.arguments, reply: stored.call.reply })).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
    expect(stored.call.reply).toEqual({ status: data.status, view: { tick: 9, food: 3, cellsTick: 9, cellsMore: false, cellsCursor: null, marks, eventCursor: 20 } });
    // A command reply keeps its map page; over the cap it too loses its largest fields first.
    const command = storedCall("order", { kind: "hold" }, result).call;
    expect(command.trimmed![0]).toBe("reply.view.cells");
    expect(command.arguments).toEqual({ kind: "hold" });
    const small = { tick: 3, accepted: true };
    expect(storedCall("order", { kind: "hold" }, { content: [], structuredContent: small }).call).toEqual({ arguments: { kind: "hold" }, reply: small });
  });

  it("records calls refused inside the admitted window in full, with the arguments sent and the reply received; a rate-limited call as a stub", async () => {
    h = await startHarness({ mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 } });
    h.clock.now = 5_000;
    const a = await h.connect();
    await a.call("join", {});
    await a.call("observe", {});
    const limited = await a.call("order", { kind: "forage", unknown: 1 });
    expect(limited.data.error.code).toBe("call_rate");
    h.clock.now += 1_000;
    // Wrong-typed: the SDK schema turns tileX into null before the handler; the recording keeps what was sent.
    const wrong = await a.call("order", { kind: "go_to", tileX: "east", tileY: 3 });
    expect(wrong.isError).toBe(true);
    h.clock.now += 1_000;
    h.game.tick(true);
    const over = await a.call("order", { kind: "forage" });
    expect(over.data.error.code).toBe("match_over");
    const recorded = entries(h).slice(2);
    expect(recorded.map(entry => [entry.tool, entry.arguments, entry.reply])).toEqual([
      ["order", { kind: "go_to", tileX: "east", tileY: 3 }, wrong.data],
      ["order", { kind: "forage" }, over.data],
    ]);
    expect(recorded.every(entry => entry.isError === true)).toBe(true);
    expect(stubs(h)).toEqual([{ type: "stub", agentId: entries(h)[0]!.agentId, tick: expect.any(Number), tool: "order", receivedAt: 5_000, answeredAt: 5_000, code: "call_rate" }]);
    expect(lines(h).map(line => line.type === "text" ? "text" : `${line.type}:${line.tool}`)).toEqual(
      ["text", "reply:join", "reply:observe", "stub:order", "reply:order", "reply:order"]);
  });

  it("over the seat's recording budget every call is a stub, a game-admitted one included, while play admits it; account calls share the budget", async () => {
    const stores = { identities: { rotateKey: async () => ({ ok: true, value: { key: "new-key-41c0" } }) } } as unknown as AccountStores;
    h = await startHarness({ mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 }, extraTools: server => registerAccountTools(server, stores) });
    h.clock.now = 10_000;
    const a = await h.connect();
    const joined = await a.call("join", {});
    // One second: an account call, then 2 game calls. Play admits all three; the recording keeps 2 entries and 1 stub.
    h.clock.now += 1_000;
    const rotated = await a.call("rotate_key", { key: "old-key-77aa" });
    const observed = await a.call("observe", {});
    const ordered = await a.call("order", { kind: "forage" });
    expect([rotated.isError, observed.isError, ordered.isError]).toEqual([false, false, false]);
    expect(entries(h).map(entry => entry.tool)).toEqual(["join", "rotate_key", "observe"]);
    expect(entries(h)[1]!.reply.key).toBe(redactedMarker("key"));
    expect(stubs(h)).toEqual([{ type: "stub", agentId: joined.data.agentId, tick: expect.any(Number), tool: "order", receivedAt: 11_000, answeredAt: 11_000, code: null }]);
    // Still that second: another account call and the game's own refusals are stubs too, carrying neither arguments nor reply.
    await a.call("rotate_key", { key: "old-key-77aa" });
    for (let i = 0; i < 3; i += 1) expect((await a.call("order", { kind: "forage" })).data.error.code).toBe("call_rate");
    expect(stubs(h).map(stub => [stub.tool, stub.code])).toEqual([["order", null], ["rotate_key", null], ["order", "call_rate"], ["order", "call_rate"], ["order", "call_rate"]]);
    expect(stubs(h).every(stub => !("arguments" in stub) && !("reply" in stub))).toBe(true);
    // A second later the budget is free again.
    h.clock.now += 1_000;
    await a.call("observe", {});
    expect(entries(h).at(-1)!.tool).toBe("observe");
  });

  it("holds a queued seat's calls, not_started included, until its match begins, then hands them on first, in order", async () => {
    h = await startHarness({ start: false });
    const a = await h.connect();
    await a.call("join", {});
    const queued = await a.call("observe", {});
    const refused = await a.call("order", { kind: "forage" });
    expect(refused.data.error.code).toBe("not_started");
    expect(h.replies).toEqual([]);
    h.game.startMatch(1);
    h.advance(1);
    expect(h.replies.every(({ seq }) => seq === 1)).toBe(true);
    expect(entries(h).map(entry => [entry.tool, entry.tick, entry.reply])).toEqual([
      ["join", null, expect.anything()], ["observe", null, queued.data], ["order", null, refused.data]]);
  });

  it("holds a flood of account calls before the match starts within the per-seat bound, in memory and in the stored record", async () => {
    const stores = { identities: { rotateKey: async () => ({ ok: true, value: { key: "new-key-6b2e" } }) } } as unknown as AccountStores;
    h = await startHarness({ start: false, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 }, extraTools: server => registerAccountTools(server, stores) });
    h.clock.now = 10_000;
    const a = await h.connect();
    await a.call("join", {});
    // Two seconds of 30 account calls each, every one answered, while the seat waits for its match.
    for (const second of [10_000, 11_000]) {
      h.clock.now = second;
      for (let i = 0; i < 30; i += 1) expect((await a.call("rotate_key", { key: "old-key-19fd" })).isError).toBe(false);
    }
    expect(h.replies).toEqual([]);
    // Held in memory: at most 2 entries and 2 stubs a second, the rest only counted.
    const held = (h.game as unknown as { heldReplies: { line: string }[] }).heldReplies.map(({ line }) => JSON.parse(line));
    expect(held.filter(line => line.type === "reply").map(line => line.tool)).toEqual(["join", "rotate_key", "rotate_key", "rotate_key"]);
    expect(held.filter(line => line.type === "stub").map(line => [line.answeredAt, line.omitted])).toEqual([
      [10_000, undefined], [10_000, undefined], [11_000, 27], [11_000, undefined]]);
    h.game.startMatch(1);
    h.advance(1);
    // Handed on at the first tick: the held lines, then a closing stub for the calls left out since the last one held.
    const handedOn = lines(h);
    expect(handedOn.filter(line => line.type === "stub").map(line => [line.answeredAt, line.omitted])).toEqual([
      [10_000, undefined], [10_000, undefined], [11_000, 27], [11_000, undefined], [11_000, 25]]);
    expect(handedOn.filter(line => line.type === "reply").length + stubCalls(handedOn)).toBe(61);
    // The stored record: 2 entries a second at most, 2 stubs a second plus the closing one, and every call counted exactly.
    const stored = await storedLines(h.replies.map(({ line }) => line));
    expect(stored.filter(line => line.type === "reply").length).toBe(4);
    expect(stored.filter(line => line.type === "stub").map(line => [line.answeredAt, line.omitted])).toEqual([
      [10_000, 0], [10_000, 0], [11_000, 27], [11_000, 0], [11_000, 25]]);
    expect(stubsPerSecond(stored.slice(0, -1))).toBe(2);
    expect(stored.filter(line => line.type === "reply").length + stubCalls(stored)).toBe(61);
  });

  it("keeps a seat's record within its pre-match allowance of full entries through a long wait for the match to start", async () => {
    h = await startHarness({ start: false, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 } });
    const a = await h.connect();
    const joined = await a.call("join", {});
    // The allowance: the budget's 2 a second over the pick window (a bare Game has no countdown or poll before it).
    const allowance = Math.floor(2 * START_PICK_WINDOW_MS / 1000);
    // Five minutes of 2 calls a second, every one within the per-second budget, while the match does not start.
    const seconds = 300;
    for (let second = 1; second <= seconds; second += 1) {
      for (let i = 0; i < 2; i += 1) {
        const at = second * 1_000 + i;
        h.game.recordReply(joined.data.agentId, { tool: "observe", receivedAt: at, answeredAt: at, code: null, alwaysStub: false },
          () => ({ entry: { tool: "observe", receivedAt: at, answeredAt: at, reply: { queued: true } }, texts: [] }));
      }
    }
    h.game.startMatch(1);
    h.advance(1);
    const stored = await storedLines(h.replies.map(({ line }) => line));
    const recorded = stored.filter(line => line.type === "reply");
    expect(recorded).toHaveLength(allowance);
    // Calls past the allowance are stubs: at most 2 a second, every call counted.
    expect(stubsPerSecond(stored)).toBeLessThanOrEqual(2);
    expect(recorded.length + stubCalls(stored)).toBe(1 + seconds * 2);
    expect(stored.find(line => line.type === "stub")).toMatchObject({ tool: "observe", tick: null, code: null });
  });

  it("holds a fixed number of pre-match stubs through a start held far longer than the countdown, the rest counted in the closing stub", async () => {
    h = await startHarness({ start: false, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 } });
    const a = await h.connect();
    const joined = await a.call("join", {});
    // Both bounds are a 2-a-second rate over the same pre-match period (a bare Game: the pick window alone).
    const allowance = Math.floor(2 * START_PICK_WINDOW_MS / 1000), stubBound = Math.floor(2 * START_PICK_WINDOW_MS / 1000);
    // An hour held at 4 calls a second, every one answered: the budget's 2 and 2 past it.
    const seconds = 3_600;
    for (let second = 1; second <= seconds; second += 1) {
      for (let i = 0; i < 4; i += 1) {
        const at = second * 1_000 + i;
        h.game.recordReply(joined.data.agentId, { tool: "observe", receivedAt: at, answeredAt: at, code: null, alwaysStub: false },
          () => ({ entry: { tool: "observe", receivedAt: at, answeredAt: at, reply: { queued: true } }, texts: [] }));
      }
    }
    const calls = 1 + seconds * 4;
    // Held in memory: the allowance of entries and the stub bound less the one kept for the closing stub, however long
    // the start is held.
    const held = (h.game as unknown as { heldReplies: { line: string }[] }).heldReplies.map(({ line }) => JSON.parse(line));
    expect(held.filter(line => line.type === "reply")).toHaveLength(allowance);
    expect(held.filter(line => line.type === "stub")).toHaveLength(stubBound - 1);
    h.game.startMatch(1);
    h.advance(1);
    const stored = await storedLines(h.replies.map(({ line }) => line));
    const storedStubs = stored.filter(line => line.type === "stub");
    expect(stored.filter(line => line.type === "reply")).toHaveLength(allowance);
    // The bound's stubs, the closing stub among them: the last call left out, its omitted counting every other one exactly.
    expect(storedStubs).toHaveLength(stubBound);
    expect(storedStubs.at(-1)).toMatchObject({ answeredAt: seconds * 1_000 + 3, tick: null });
    expect(allowance + stubCalls(stored)).toBe(calls);
  });

  it("records each case whose entry cannot be built as a stub with exact counts: a request the SDK refuses, and an unserializable reply", async () => {
    h = await startHarness();
    h.clock.now = 20_000;
    const a = await h.connect();
    const joined = await a.call("join", {});
    // The SDK refuses these requests before any tool runs: no tool result exists, so each is a stub, code sdk_error.
    for (const params of [{ name: 7, arguments: {} }, { name: "order", arguments: [1] }, { name: "order", arguments: "hold" }]) {
      await expect(a.client.request({ method: "tools/call", params } as never, CallToolResultSchema)).rejects.toThrow();
    }
    // params missing entirely: the same refusal, a stub with an empty tool name.
    await expect(a.client.request({ method: "tools/call" } as never, CallToolResultSchema)).rejects.toThrow();
    // An unserializable server reply (a defect): storedCall cannot build its entry, so the call is a stub with its own
    // code, the failure reported once per Game instance.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unserializable: CallToolResult = { content: [], structuredContent: { accepted: true, food: 10n } };
    expect(() => storedCall("order", { kind: "hold" }, unserializable)).toThrow(TypeError);
    for (let i = 0; i < 3; i += 1) {
      h.game.recordReply(joined.data.agentId, { tool: "order", receivedAt: 20_000, answeredAt: 20_000, code: null, alwaysStub: false }, () => {
        const { call, texts } = storedCall("order", { kind: "hold" }, unserializable);
        return { entry: { tool: "order", receivedAt: 20_000, answeredAt: 20_000, ...call }, texts };
      });
    }
    expect(spy).toHaveBeenCalledOnce();
    expect(stubs(h).map(stub => [stub.tool, stub.code, stub.answeredAt])).toEqual([
      ["", "sdk_error", 20_000], ["order", "sdk_error", 20_000], ["order", "sdk_error", 20_000], ["", "sdk_error", 20_000],
      ["order", null, 20_000], ["order", null, 20_000], ["order", null, 20_000]]);
    // Stored: 2 stubs in that second, then the closing stub counting the other 4 of the 5 left out.
    const stored = (await storedLines(h.replies.map(({ line }) => line))).filter(line => line.type === "stub");
    expect(stored.map(stub => [stub.tool, stub.code, stub.omitted])).toEqual([["", "sdk_error", 0], ["order", "sdk_error", 0], ["order", null, 4]]);
    expect(stubCalls(stored)).toBe(7);
  });

  it("records the SDK's own error result when a handler throws as a stub", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.call("join", {});
    vi.spyOn(h.game, "call").mockRejectedValueOnce(new Error("boom"));
    const r = await a.client.callTool({ name: "order", arguments: { kind: "hold" } });
    expect(r.isError).toBe(true);
    expect(lines(h).at(-1)).toMatchObject({ type: "stub", tool: "order", code: "sdk_error" });
    expect(lines(h).at(-1)).not.toHaveProperty("reply");
  });

  it("redacts every credential field, in arguments and in replies, as a marker naming it; a session bound to no seat records nothing", async () => {
    h = await startHarness();
    const a = await h.connect();
    const outsider = await h.connect();
    await outsider.call("observe", {});
    const joined = await a.call("join", {});
    expect(entries(h)).toHaveLength(1);
    expect(entries(h)[0]!.reply.reconnectToken).toBe(redactedMarker("reconnectToken"));
    expect(entries(h)[0]!.redacted).toEqual(["reply.reconnectToken"]);
    const again = await h.connect();
    await again.call("join", { token: joined.data.reconnectToken, displayName: "Ada" });
    const entry = entries(h).at(-1)!;
    expect(entry.arguments).toEqual({ token: redactedMarker("token"), displayName: "Ada" });
    expect(entry.reply.reconnectToken).toBe(redactedMarker("reconnectToken"));
    expect(entry.redacted).toEqual(["arguments.token", "reply.reconnectToken"]);
    expect(h.replies.some(({ line }) => line.includes(joined.data.reconnectToken))).toBe(false);
  });

  it("caps arguments and reply together at 8,192 bytes, dropping the largest fields and naming them", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.call("join", {});
    const long = await a.call("order", { kind: "forage", intent: "x".repeat(STORED_ENTRY_BYTES), note: "n".repeat(3_000) });
    expect(long.isError).toBe(true);
    const entry = entries(h).at(-1)!;
    // Only the largest field goes: the rest then fits, arguments and reply together.
    expect(entry.arguments).toEqual({ kind: "forage", note: "n".repeat(3_000) });
    expect(entry.trimmed).toEqual(["arguments.intent"]);
    expect(entry.reply).toEqual(long.data);
    expect(bytes({ arguments: entry.arguments, reply: entry.reply })).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
    // Two fields that fit apart but not together: the larger goes, from whichever side.
    await a.call("order", { kind: "forage", note: "n".repeat(5_000), memo: "m".repeat(4_000) });
    expect(entries(h).at(-1)!.trimmed).toEqual(["arguments.note"]);
    await a.call("order", { kind: "forage", note: "n".repeat(3_000) });
    expect(entries(h).at(-1)!.arguments).toEqual({ kind: "forage", note: "n".repeat(3_000) });
    expect(entries(h).at(-1)!).not.toHaveProperty("trimmed");
  });

  it("keeps an entry of many small fields within its bound: names within 256 bytes, the rest counted", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.call("join", {});
    const many = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`f${i}`, "xxxx"]));
    const answered = await a.call("order", { kind: "forage", ...many });
    const entry = entries(h).at(-1)! as Entry & { trimmedMore?: number };
    expect(bytes({ arguments: entry.arguments, reply: entry.reply })).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
    expect(bytes(entry.trimmed)).toBeLessThanOrEqual(STORED_NAMES_BYTES);
    // Every field dropped, from either side, is named or counted.
    const dropped = 5_001 - Object.keys(entry.arguments).length + Object.keys(answered.data).filter(key => !(key in entry.reply)).length;
    expect(entry.trimmed!.length + entry.trimmedMore!).toBe(dropped);
    // Largest first: the reply's larger fields and kind ("forage", larger than each filler) go before any filler.
    expect(entry.trimmed![0]).toBe("reply.order");
    expect(Object.values(entry.arguments).every(value => value === "xxxx")).toBe(true);
  });

  it("keeps a game-admitted call with arguments nested too deep to store as a full entry, the arguments dropped and named", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.call("join", {});
    const nest = (depth: number): unknown => { let value: unknown = 1; for (let i = 0; i < depth; i++) value = [value]; return value; };
    // The order schema strips the unknown field, so play admits the call; only its recording meets the depth.
    const answered = await a.call("order", { kind: "forage", key: "deep-secret-41c9", x: nest(3_000) });
    expect(answered.isError).toBe(false);
    const entry = entries(h).at(-1)!;
    expect(entry.tool).toBe("order");
    expect(entry.arguments).toBeNull();
    expect(entry.trimmed).toEqual(["arguments"]);
    expect(entry.reply).toEqual(answered.data);
    expect(entry).not.toHaveProperty("redacted");
    expect(stubs(h)).toEqual([]);
    expect(h.replies.some(({ line }) => line.includes("deep-secret-41c9"))).toBe(false);
    // Deep past JSON.stringify's own limit as well.
    const { call } = storedCall("order", { kind: "forage", x: nest(50_000) }, { content: [], structuredContent: { accepted: true } });
    expect(call).toEqual({ arguments: null, reply: { accepted: true }, trimmed: ["arguments"] });
  });

  it("records a call whose entry cannot be built (a defect), and an unknown tool's long name, as stubs", async () => {
    h = await startHarness();
    const a = await h.connect();
    const joined = await a.call("join", {});
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.game.recordReply(joined.data.agentId, { tool: "order", receivedAt: 1, answeredAt: 2, code: null, alwaysStub: false }, () => { throw new RangeError("too deep"); });
    expect(lines(h).at(-1)).toEqual({ type: "stub", agentId: joined.data.agentId, tick: expect.any(Number), tool: "order", receivedAt: 1, answeredAt: 2, code: null });
    expect(spy).toHaveBeenCalledOnce();
    const r = await a.client.callTool({ name: "t".repeat(500), arguments: {} });
    expect(r.isError).toBe(true);
    expect(lines(h).at(-1)).toMatchObject({ type: "stub", tool: `${"t".repeat(100)}…`, code: "sdk_error" });
  });

  it("records a seat's account-tool calls and the tool descriptions it was served, once, and no credential issued or accepted reaches the recording", async () => {
    const LOBBY = "0b8c1a7e-4d5f-4c3b-9a2e-1f6d7c8b9a0e";
    const secrets = { oldKey: "old-key-0f3a9c", newKey: "new-key-7d21be", invite: "invite-token-5e88a1" };
    const stores = {
      identities: { rotateKey: async () => ({ ok: true, value: { key: secrets.newKey } }) },
      lobbies: {
        issueInvite: async () => ({ ok: true, value: { inviteToken: secrets.invite } }),
        join: async () => ({ ok: true, value: { id: LOBBY } }),
      },
    } as unknown as AccountStores;
    h = await startHarness({ extraTools: server => registerAccountTools(server, stores) });
    const a = await h.connect();
    const listed = await a.client.listTools();
    const joined = await a.call("join", {});
    const rotated = await a.call("rotate_key", { key: secrets.oldKey });
    expect(rotated.data.key).toBe(secrets.newKey);
    const invite = await a.call("issue_invite", { key: secrets.newKey, lobbyId: LOBBY });
    expect(invite.data.inviteLink).toContain(secrets.invite);
    await a.call("join_lobby", { key: secrets.newKey, lobbyId: LOBBY, inviteToken: secrets.invite });
    // The reconnect token issued by join is accepted again from a new session.
    const b = await h.connect();
    await b.call("join", { reconnectToken: joined.data.reconnectToken });
    await a.call("observe", {});

    const recorded = entries(h);
    expect(recorded.map(entry => entry.tool)).toEqual(["join", "rotate_key", "issue_invite", "join_lobby", "join", "observe"]);
    const [, rotate, issue, joinLobby] = recorded;
    expect(rotate).toMatchObject({ arguments: { key: redactedMarker("key") }, reply: { key: redactedMarker("key"), warning: rotated.data.warning },
      redacted: ["arguments.key", "reply.key"] });
    expect(issue!.reply).toEqual({ inviteLink: redactedMarker("inviteLink"), inviteToken: redactedMarker("inviteToken") });
    expect(joinLobby!.arguments).toEqual({ key: redactedMarker("key"), lobbyId: LOBBY, inviteToken: redactedMarker("inviteToken") });
    // The tool descriptions this session was served: one text line, before the first entry.
    const tools = texts(h).filter(text => text.kind === "tools");
    expect(tools).toHaveLength(1);
    expect(lines(h)[0]).toMatchObject({ type: "text", kind: "tools" });
    expect((JSON.parse(tools[0]!.text) as { name: string; description?: string }[]).map(tool => [tool.name, tool.description]))
      .toEqual(listed.tools.map(tool => [tool.name, tool.description]));

    const recording = [...h.replies.map(({ line }) => line), ...h.log].join("\n");
    for (const secret of [...Object.values(secrets), joined.data.reconnectToken as string]) expect(recording).not.toContain(secret);
  });
});
