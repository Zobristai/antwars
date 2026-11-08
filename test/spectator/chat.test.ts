/**
 * Chat log: one line per new intent
 * and per newly laid mark, read from the delayed playback's boards across the
 * full-snapshot boundary (first join, a same-match reconnect after a dropped
 * message, a new match), and what each line reads (web/src/words.ts markReading).
 */
import { describe, expect, it } from "vitest";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessage } from "../../src/live/format.ts";
import { playScripted, recordLog } from "../../src/live/record.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { boardPixelCheck, boardWidths, boundedReady, replayCaptureTick, startFixtureStream } from "../../web/capture/page-polish.ts";
import type { StreamAgent, StreamEvent, StreamFull, StreamMark, StreamMessage, StreamQueen, StreamSetup } from "../../src/live/format.ts";
import { WORDS } from "../../src/sim/types.ts";
import { Frame, Playback, type ChatLine } from "../../web/src/buffer.ts";
import { LOG_EXPLAINER, THOUGHT_LABEL, agentCard, cardSubject, orderTarget, orderText, storyWhen } from "../../web/src/overlays.ts";
import { markByline, markReading } from "../../web/src/words.ts";
import { playable } from "../playable.ts";

const ants = { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) };
const setup = { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] as [[number, number], [number, number]] };
const agent = (colony: 0 | 1, modelLabel: string, intent: string): StreamAgent => ({ colony, modelLabel, joinTick: 0, lastCallTick: 0, prevCallTick: -1, order: "forage", orderX: 0, orderY: 0, intent });
const mark = (id: number, a: number, colony: 0 | 1, words: number[], laidTick: number): StreamMark => ({ id, agent: a, colony, tileX: 3, tileY: 3, words, laidTick, answered: 0 });
const full = (match: number, agents: StreamAgent[], marks: StreamMark[]): StreamFull => ({ match, setup, territory: new Uint8Array(64), marks, agents, overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null });
const msg = (tick: number, f: StreamFull | null, events: StreamEvent[] = []): StreamMessage => ({ tick, ants, full: f, events });

/** Push each message as it arrives in real time, then read the chat once playback has reached the newest tick. */
function play(p: Playback, ms: StreamMessage[]): ChatLine[] {
  for (const m of ms) p.push(m, m.tick * TICK_MS);
  const f = new Frame();
  p.sample(1e9, f);
  return f.chat;
}
const said = (lines: readonly ChatLine[]) => lines.map((l) => (l.kind === "intent" ? `${l.agent}: ${l.text}` : `${l.agent} marks ${l.words.join(",")}`));

describe("the chat log", () => {
  const a0 = agent(0, "m-zero", "hold the ridge");
  const a1 = agent(1, "m-one", "flank east");

  it("on joining, posts each agent's current intent and nothing for the marks already live", () => {
    const p = new Playback();
    expect(said(play(p, [msg(100, full(42, [a0, a1, agent(0, "m-two", "")], [mark(7, 0, 0, [1, 2], 90)]))]))).toEqual(["0: hold the ridge", "1: flank east"]);
  });

  it("posts one line per new intent and per newly laid mark, the newest last; a repeated intent posts nothing", () => {
    const p = new Playback();
    const lines = play(p, [
      msg(100, full(42, [a0, a1], [mark(7, 0, 0, [1, 2], 90)])),
      msg(101, null, [
        { kind: "order", agent: 1, order: "attack", tileX: 5, tileY: 5, intent: "push the queen" },
        { kind: "mark", mark: mark(8, 1, 1, [3, 4], 101) },
      ]),
      msg(102, null, [{ kind: "order", agent: 0, order: "hold", tileX: 2, tileY: 2, intent: "hold the ridge" }]),
      msg(103, null, [{ kind: "order", agent: 0, order: "go_to", tileX: 2, tileY: 2, intent: "fall back" }]),
    ]);
    expect(said(lines)).toEqual(["0: hold the ridge", "1: flank east", "1: push the queen", "1 marks 3,4", "0: fall back"]);
    expect(lines.map((l) => l.tick)).toEqual([100, 100, 101, 101, 103]);
  });

  it("shows no line before the delayed playback reaches its tick", () => {
    const p = new Playback();
    p.push(msg(100, full(42, [a0], [])), 100 * TICK_MS);
    p.push(msg(150, null, [{ kind: "order", agent: 0, order: "hold", tileX: 2, tileY: 2, intent: "later" }]), 150 * TICK_MS);
    const f = new Frame();
    p.sample(120 * TICK_MS, f);
    expect(said(f.chat)).toEqual(["0: hold the ridge"]);
    p.sample(1e9, f);
    expect(said(f.chat)).toEqual(["0: hold the ridge", "0: later"]);
  });

  it("after a dropped message, a same-match reconnect posts what it carried once and repeats nothing", () => {
    const p = new Playback();
    const before = play(p, [
      msg(100, full(42, [a0, a1], [mark(7, 0, 0, [1, 2], 90)])),
      msg(101, null, [{ kind: "mark", mark: mark(8, 1, 1, [3, 4], 101) }]),
      // Message 104 is dropped: it carried agent 0's new intent and mark 9.
    ]);
    expect(said(before)).toEqual(["0: hold the ridge", "1: flank east", "1 marks 3,4"]);
    const reconnect = full(42, [agent(0, "m-zero", "retreat home"), a1], [mark(7, 0, 0, [1, 2], 90), mark(8, 1, 1, [3, 4], 101), mark(9, 0, 0, [5], 104)]);
    const after = play(p, [msg(105, reconnect)]);
    expect(said(after)).toEqual(["0: hold the ridge", "1: flank east", "1 marks 3,4", "0: retreat home", "0 marks 5"]);
    // The same lines, kept across the reconnect (the chat is not rebuilt).
    expect(after.slice(0, 3)).toEqual(before);
    // Reconnecting again with nothing changed posts nothing.
    expect(play(p, [msg(106, reconnect)])).toHaveLength(5);
  });

  it("keeps each mark line's mark id, tile and laid tick, across a reconnect and after the mark has gone", () => {
    const p = new Playback();
    const m8 = { ...mark(8, 1, 1, [3, 4], 101), tileX: 5, tileY: 6 };
    play(p, [msg(100, full(42, [a0, a1], [])), msg(101, null, [{ kind: "mark", mark: m8 }])]);
    const m9 = { ...mark(9, 0, 0, [5], 104), tileX: 2, tileY: 7 };
    // A reconnect carrying mark 9 (its event was dropped), then both marks gone.
    const lines = play(p, [msg(105, full(42, [a0, a1], [m8, m9])), msg(106, null, [{ kind: "markGone", markId: 8 }, { kind: "markGone", markId: 9 }])]);
    const marks = lines.filter((l) => l.kind === "mark").map((l) => [l.markId, l.agent, l.tileX, l.tileY, l.laidTick]);
    expect(marks).toEqual([
      [8, 1, 5, 6, 101],
      [9, 0, 2, 7, 104],
    ]);
    expect(lines.filter((l) => l.kind === "intent").every((l) => l.markId === -1)).toBe(true);
  });

  it("a different match starts an empty chat", () => {
    const p = new Playback();
    play(p, [msg(100, full(42, [a0, a1], [])), msg(101, null, [{ kind: "mark", mark: mark(8, 1, 1, [3, 4], 101) }])]);
    expect(said(play(p, [msg(10, full(43, [agent(0, "x", ""), agent(1, "y", "scout")], [mark(1, 1, 1, [1], 5)]))]))).toEqual(["1: scout"]);
  });

  // Regression caught in the screenshot of main: "marks for teammates: — here" for a bare
  // mark the stream carries no words or verb for. This lane's choice: such a mark shows nothing in the feed.
  it("posts no line for a wordless mark the stream carries no verb for; a count mark with its verb and a word mark still post", () => {
    const p = new Playback();
    const lines = play(p, [
      msg(100, full(42, [a0, a1], [])),
      msg(101, null, [{ kind: "mark", mark: mark(8, 1, 1, [], 101) }]),
      msg(102, null, [{ kind: "mark", mark: { ...mark(9, 0, 0, [], 102), verb: "DEFEND", count: 6, claimed: 0 } }]),
      msg(103, null, [{ kind: "mark", mark: mark(10, 1, 1, [3], 103) }]),
    ]);
    expect(lines.filter((l) => l.kind === "mark").map((l) => l.markId)).toEqual([9, 10]);
    // Nor later, when a reconnect's snapshot carries it again.
    expect(play(p, [msg(104, full(42, [a0, a1], [mark(8, 1, 1, [], 101), { ...mark(9, 0, 0, [], 102), verb: "DEFEND", count: 6, claimed: 0 }, mark(10, 1, 1, [3], 103)]))]).filter((l) => l.kind === "mark")).toHaveLength(2);
  });

  // Regression: a count mark laid again in place (its id kept,
  // StreamMark.revision; the stream sends the mark again) left its line at the first count, "ATTACK · 20 requested", read
  // beside the board's current answered ants while the board and its tooltip said 30 requested.
  it("a count mark laid again in place revises its one line, so the feed and the board carry the same order; the line keeps the last order once the mark has gone", () => {
    const p = new Playback();
    const laid: StreamMark = { ...mark(9, 0, 0, [], 102), verb: "ATTACK", count: 20, claimed: 0, revision: 0 };
    const relaid: StreamMark = { ...laid, count: 30, claimed: 25, tileX: 5, laidTick: 110, revision: 1 };
    for (const m of [msg(100, full(42, [a0, a1], [])), msg(102, null, [{ kind: "mark", mark: laid }]), msg(110, null, [{ kind: "mark", mark: relaid }])]) p.push(m, m.tick * TICK_MS);
    const f = new Frame();
    p.sample(1e9, f);
    const lines = f.chat.filter((l) => l.kind === "mark");
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    // One line, at the tick it was first laid, carrying the mark as the board carries it now.
    expect(line).toMatchObject({ markId: 9, tick: 102, verb: "ATTACK", count: 30, tileX: 5, laidTick: 110 });
    const live = f.marks.find((v) => v.mark.id === 9)!.mark;
    expect(live).toMatchObject({ count: 30, claimed: 25 });
    expect(markReading(live)).toBe("ATTACK · 30 requested · 25 answered");
    // Gone from the board: the same line, its last order kept, without the answered ants.
    expect(play(p, [msg(120, null, [{ kind: "markGone", markId: 9 }])]).filter((l) => l.kind === "mark")).toEqual([line]);
    expect(markReading(line)).toBe("ATTACK · 30 requested");
  });
});

describe("a log line", () => {
  const words = [0, 1];
  const markLine: ChatLine = { kind: "mark", tick: 101, agent: 1, colony: 1, text: "", words, markId: 8, tileX: 14, tileY: 22, laidTick: 100 };

  it("labels a thought on the agent's card, and the Rules page's explainer says only spectators see thoughts", () => {
    expect(LOG_EXPLAINER).toMatch(/only spectators see them/);
    expect(THOUGHT_LABEL).toBe("Thought");
  });

  // Regression caught: "tile 30, 32 · 45s ago" beside the clock time on every mark line; then
  // ATTACK W FEW glossed into "attack a few of us, to the west".
  // Regression caught: ATTACK W FEW glossed into "attack a few of us, to the west".
  it("reads a mark as its words as written, and a count mark in the set feed form", () => {
    const spelled = words.map((w) => WORDS[w]!);
    // The agent's own words, quoted, each as the vocabulary spells it.
    expect(markReading(markLine)).toBe(`“${spelled.join(" · ")}”`);
    expect(markReading(markLine)).toBe("“FOOD · ENEMY”");
    // A count mark reads the set feed form, its answered count moving with the board.
    const counted: ChatLine = { ...markLine, words: [], verb: "ATTACK", count: 20 };
    expect(markReading({ ...counted, claimed: 12 })).toBe("ATTACK · 20 requested · 12 answered");
    expect(markReading(counted)).toBe("ATTACK · 20 requested");
    // Regression: "ATTACK · 20 requested · 25 answered" while the
    // board read 30 requested, the mark laid again in place. While live, the board's mark is the whole reading's one source.
    expect(markReading({ words: [], verb: "ATTACK", count: 30, claimed: 25 })).toBe("ATTACK · 30 requested · 25 answered");
  });

  it("keeps a mark's age in its tooltip, current to the playback second", () => {
    // Laid mid-second (tick 3513); the tooltip's byline moves as the second turns.
    for (let now = 3580; now < 3590; now++) expect(markByline({ agent: 1, laidTick: 3513 }, now, 10)).toBe("by Triangle, 7s ago");
    expect(markByline({ agent: 1, laidTick: 3513 }, 3590, 10)).toBe("by Triangle, 8s ago");
  });

  it("says marks are the only messages, and that only squads on follow_trail are steered by them", () => {
    expect(LOG_EXPLAINER).toMatch(/only messages between teammates/);
    expect(LOG_EXPLAINER).toMatch(/only squads whose agent ordered follow_trail/);
    expect(LOG_EXPLAINER).toMatch(/moves no other ants/);
    // The order itself says marks, not the trails switch.
    expect(orderText({ colony: 0, order: "follow_trail", orderX: 0, orderY: 0 })).toBe("follow the colony's strongest mark");
  });

  // Regression caught on the b178149 stills: "attack tile 28, 23" wherever an order was worded.
  it("names each target's colony and guards friendly queens, without leaking tile coordinates", () => {
    const setup = { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 300, overrunRadiusTiles: 2, queens: [[8 * 256 + 128, 24 * 256 + 128], [55 * 256 + 128, 24 * 256 + 128]] } as unknown as StreamSetup;
    const queen = (id: number, colony: 0 | 1, x: number, y: number, lostTick: number | null): StreamQueen => ({ id, colony, x: x * 256 + 128, y: y * 256 + 128, foundedTick: 0, lostTick, overrun: 0 });
    const board = { setup, queens: [queen(0, 0, 8, 24, null), queen(1, 0, 20, 30, 500), queen(0, 1, 55, 24, null)] };
    const enemy = orderTarget(55, 24, board), own = orderTarget(8, 24, board), nest = orderTarget(20, 30, board);
    expect(enemy).toEqual({ label: "Lake Hodges Colony's Queen 1", colony: 1, liveQueen: true });
    expect(nest).toEqual({ label: "Very Large Colony's nest", colony: 0, liveQueen: false });
    expect(orderTarget(28, 23, board)).toBeNull();
    expect(orderTarget(8, 24, { setup })).toEqual(own);
    for (const order of ["attack", "go_to"] as const) {
      const a = { colony: 0 as const, order, orderX: 55, orderY: 24 };
      expect(orderText(a, enemy)).toBe(`${order === "attack" ? "attack" : "go to"} Lake Hodges Colony's Queen 1`);
      expect(orderText(a, own)).toBe("guard Very Large Colony's Queen 1");
      expect(orderText({ ...a, colony: 1 }, enemy)).toBe("guard Lake Hodges Colony's Queen 1");
      expect(orderText(a, nest)).toBe(`${order === "attack" ? "attack" : "go to"} Very Large Colony's nest`);
      expect(orderText(a)).toBe(order === "attack" ? "attack" : "go to");
    }
    expect(orderText({ colony: 0, order: "hold", orderX: 55, orderY: 24 }, enemy)).toBe("hold");
    expect(orderText({ colony: 0, order: "forage", orderX: 0, orderY: 0 }, enemy)).toBe("forage");
  });});

describe("whom the agent card is about", () => {
  const diamondAnt = { antId: 7, colony: 0, agent: 0 };
  it("follows a badge tapped after an ant: the badge's agent, without the other agent's ant", () => {
    // A Diamond ant was clicked (its agent selected too), then Triangle's badge: the ant stays selected.
    expect(cardSubject(diamondAnt, 0)).toEqual({ ant: diamondAnt, agent: 0 });
    expect(cardSubject(diamondAnt, 1)).toEqual({ ant: null, agent: 1 });
  });
  it("shows a clicked ant and its agent with no agent selected, and an ant with no squad as such", () => {
    expect(cardSubject(diamondAnt, -1)).toEqual({ ant: diamondAnt, agent: 0 });
    const loner = { antId: 9, colony: 1, agent: -1 };
    expect(cardSubject(loner, -1)).toEqual({ ant: loner, agent: -1 });
    expect(cardSubject(null, -1)).toEqual({ ant: null, agent: -1 });
  });
});

describe("the early-look chat fixture", () => {
  // Measured at 9f4ff74a (essential config, this test only): alone 3.4–3.8 s; loaded (6 busy loops,
  // 2 workers, 4 CPUs) 7.4–7.8 s. CI timed out at the 5 s default; the limit is about 4× the worst loaded run.
  it("seeks past a real recorded mark without weakening the populated rail check", { timeout: 35_000 }, () => {
    // The scripted grid-scale-2 agent match the early-look capture plays (web/capture/page-polish.ts), made in process:
    // the bundled agent recording is deleted.
    const log = playScripted({ seed: 5205, config: playable(DEFAULT_CONFIG), agents: 4, ticks: 1800, attack: true }).lines;
    const messages = recordLog(log, 1800).map(decodeMessage);
    const tick = replayCaptureTick(messages);
    expect(tick).toBe(3);
    const lines = play(new Playback(), messages.filter((message) => message.tick <= tick));
    expect(lines.some((line) => line.kind === "mark")).toBe(true);
    expect(lines.some((line) => line.kind === "intent")).toBe(true);
  });

  it("serves the page and held-open SSE from exactly the same real origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-origin-"));
    writeFileSync(join(root, "index.html"), "same-origin fixture page");
    const stream = await startFixtureStream("data: fixture\n\n", root);
    const abort = new AbortController();
    try {
      const pageUrl = new URL("/index.html", stream.url);
      expect(pageUrl.origin).toBe(new URL(stream.url).origin);
      const page = await fetch(pageUrl);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html");
      expect(await page.text()).toBe("same-origin fixture page");
      const response = await fetch(new URL("/live/current", pageUrl), { signal: abort.signal });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      const pending = reader.read();
      const state = await Promise.race([
        pending.then((result) => result.done ? "closed" : "more data"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still open"), 40)),
      ]);
      expect(state).toBe("still open");
      abort.abort();
      await pending.catch(() => {});
    } finally {
      abort.abort();
      await stream.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds a stuck ready promise with the scene name using a real clock", async () => {
    await expect(boundedReady(new Promise<never>(() => {}), "2d-1920x1080-live", 20)).rejects.toThrow("2d-1920x1080-live: client ready timed out after 20 ms");
    await expect(boundedReady(Promise.resolve("ready"), "working", 20)).resolves.toBe("ready");
    await expect(boundedReady(Promise.reject(new Error("renderer failed")), "failed", 20)).rejects.toThrow("renderer failed");
  });

  it("rejects clear/transparent primary canvases and sparse markers even when their variance is high", () => {
    const background = [11, 8, 5, 255] as const;
    const blank = Array.from({ length: 192 }, () => background);
    expect(boardPixelCheck(blank, background).nonblank).toBe(false);
    expect(boardPixelCheck(blank.map(() => [0, 0, 0, 0]), background).nonblank).toBe(false);
    expect(boardPixelCheck([], background).nonblank).toBe(false);
    const markers = blank.map((pixel, i) => i < 5 ? [255, 176, 0, 255] as const : pixel);
    const sparse = boardPixelCheck(markers, background);
    expect(sparse.rgbDeviation).toBeGreaterThan(4);
    expect(sparse.groundFraction).toBeLessThan(0.4);
    expect(sparse.nonblank).toBe(false);
  });

  it("accepts broadly painted, textured ground but refuses too few visible samples", () => {
    const background = [11, 8, 5, 255] as const;
    const ground = Array.from({ length: 192 }, (_, i): [number, number, number, number] => [30 + i % 23, 19 + i % 17, 10 + i % 11, 255]);
    const result = boardPixelCheck(ground, background);
    expect(result.nonblank).toBe(true);
    expect(result.opaqueFraction).toBe(1);
    expect(result.groundFraction).toBe(1);
    expect(boardPixelCheck(ground.slice(0, 31), background).nonblank).toBe(false);
    expect(boardPixelCheck(ground.map((pixel, i) => i < 20 ? [0, 0, 0, 0] : pixel), background).nonblank).toBe(false);
  });

  it("separates unclipped perspective bounds from visible board and midline widths", () => {
    const stage = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(boardWidths([[-20, 0], [120, 0], [140, 100], [-40, 100]], stage)).toEqual({ projectedBoundsWidth: 180, boardWidth: 100, midlineWidth: 100 });
    expect(boardWidths([[25, 10], [75, 10], [75, 90], [25, 90]], stage)).toEqual({ projectedBoundsWidth: 50, boardWidth: 50, midlineWidth: 50 });
    expect(boardWidths([[110, 10], [160, 10], [160, 90], [110, 90]], stage)).toEqual({ projectedBoundsWidth: 50, boardWidth: 0, midlineWidth: 0 });
  });
});

describe("the agent card", () => {
  it("shows the handle and colony, the model, the squad order and target, the full thought, the latest active mark and the agent's call interval (\"Agent calls\")", () => {
    const long = "x".repeat(120);
    const a = { ...agent(1, "m-one", long), order: "attack" as const, orderX: 5, orderY: 9 };
    const marks = [mark(3, 1, 1, [0], 50), { ...mark(4, 1, 1, [1], 80), tileX: 6, tileY: 2 }, mark(5, 0, 0, [2], 90)];
    const lines = agentCard(1, a, marks, 200, 10);
    expect(lines[0]).toMatch(/^Triangle · /);
    // A builder's self-reported label shows as reported.
    expect(lines[1]).toBe("Model: m-one");
    // No coordinates on the card: the order's target by name where its tile holds one, the mark by its reading and age.
    expect(lines[2]).toBe("Squad order: attack");
    expect(agentCard(1, a, marks, 200, 10, { label: "Very Large Colony's Queen 2", colony: 0, liveQueen: true })[2]).toBe("Squad order: attack Very Large Colony's Queen 2");
    expect(lines[3]).toBe(`${THOUGHT_LABEL}: “${long}”`);
    expect(lines[4]).toMatch(/^Latest active mark: .*, 12s ago$/);
    expect(lines[4]).not.toMatch(/tile/);
    // One call so far (no previous call tick); then the interval between the two most recent, from the stream's tick rate.
    expect(lines[5]).toBe("Calls: 1");
    expect(agentCard(1, { ...a, prevCallTick: 10, lastCallTick: 52 }, marks, 200, 10).at(-1)).toBe("Call interval: 4.2 s");
    // No thought: no line for it, and no sentence saying so.
    expect(agentCard(1, { ...a, intent: "" }, [], 200, 10).some((l) => l.startsWith(THOUGHT_LABEL) || /thought/i.test(l))).toBe(false);
    expect(agentCard(1, a, [], 200, 10)[4]).toBe("No active marks");
    expect(agentCard(1, { ...a, modelLabel: "" }, [], 200, 10)).not.toContain("Model: ");
  });
});

// Regression in the result card: "22:46 Queen 1 lost" for a fall at 22:53, the attack's
// first bite timed where the loss belonged (traced to the data).
describe("a taken queen's moment is timed at her loss", () => {
  it("times an attack or attempt that took a queen at its data-given end once reached, and at its start otherwise", () => {
    const attack = { kind: "queen_attack" as const, tick: 13660, endTick: 13731, outcome: "took" as const };
    expect(storyWhen(attack, 13731)).toBe(13731);
    expect(storyWhen(attack, 20000)).toBe(13731);
    expect(storyWhen(attack, 13700)).toBe(13660);
    expect(storyWhen({ ...attack, outcome: "repelled" }, 20000)).toBe(13660);
    expect(storyWhen({ kind: "overrun", tick: 5600, endTick: 5741, outcome: "took" }, 6000)).toBe(5741);
    expect(storyWhen({ kind: "lead", tick: 900 }, 6000)).toBe(900);
  });
});

it("retains the last selected caste in the timeline through re-lay, reconnect and expiry", () => {
  const p = new Playback();
  const a = agent(0, "script", "");
  const first: StreamMark = { ...mark(9, 0, 0, [], 102), verb: "ATTACK", count: 20, claimed: 5, caste: "worker" };
  const changed: StreamMark = { ...first, caste: "soldier", revision: 1 };
  let lines = play(p, [msg(100, full(42, [a], [])), msg(102, null, [{ kind: "mark", mark: first }])]);
  expect(markReading(first)).toBe("ATTACK · worker · 20 requested · 5 answered");
  lines = play(p, [msg(110, null, [{ kind: "mark", mark: changed }]), msg(111, full(42, [a], [changed]))]);
  expect(lines).toHaveLength(1);
  expect(lines[0]!.caste).toBe("soldier");
  expect(markReading(changed)).toBe("ATTACK · soldier · 20 requested · 5 answered");
  lines = play(p, [msg(120, null, [{ kind: "markGone", markId: 9 }])]);
  expect(markReading(lines[0]!)).toBe("ATTACK · soldier · 20 requested");
});
