// The result's Share on X: the link it names (source.ts watchUrl) and the post's text (deck model shareText),
// with its fixed wording. Pure helpers; the modal's link is driven in the result-modal tests.
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { SUB_TILE, type StreamAgent, type StreamResult } from "../../../src/live/format.ts";
import { agentHandle, ratingResultRows } from "../../../web/src/compose.ts";
import { watchUrl } from "../../../web/src/source.ts";
import { shareHref, shareText, sideNames } from "../../../web/src/ui/deck/model.ts";

const TICK = 7540;
const URL_ = "https://antwars.example/?replay=2026-10-28-12";

function agent(colony: 0 | 1, name: string | null, modelLabel = "claude-sonnet-5"): StreamAgent {
  return { ...(name === null ? {} : { identity: { displayName: name, elo: 1500 } }), colony, modelLabel, joinTick: 0, lastCallTick: TICK - 20,
    prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" };
}
function frameOf(agents: StreamAgent[], result: Partial<StreamResult> = {}): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100 + 10_000; f.match = 1;
  f.ensure(0); f.count = 0;
  const b = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: false, rules: "redesign" },
    queens: [], territory: new Uint8Array(0), held: [870, 130], marks: [], agents, overrun: [0, 0], overrunRequired: 100, deaths: [0, 0],
    result: { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK - 100, nextStartMs: null, ...result },
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 0, nextHatchTick: TICK, nextCost: 3 }, { food: 0, nextHatchTick: TICK, nextCost: 3 }],
  } as unknown as Board;
  f.board = b;
  return f;
}

describe("the link a result shares (watchUrl)", () => {
  const origin = "https://antwars.example";
  it("names the saved replay when the page plays one, else the live lobby's watch link", () => {
    expect(watchUrl(origin, { private: false, replayId: "2026-10-28-12", lobbyId: "public-3" })).toBe(`${origin}/?replay=2026-10-28-12`);
    expect(watchUrl(origin, { private: false, replayId: null, lobbyId: "public-3" })).toBe(`${origin}/?lobby=public-3`);
    expect(watchUrl(origin, { private: false, replayId: null, lobbyId: "a b" })).toBe(`${origin}/?lobby=a%20b`);
  });
  it("has none for a private match, or with nothing public to name", () => {
    expect(watchUrl(origin, { private: true, replayId: "2026-10-28-12", lobbyId: "private-1" })).toBeNull();
    expect(watchUrl(origin, { private: true, replayId: null, lobbyId: "private-1" })).toBeNull();
    expect(watchUrl(origin, { private: false, replayId: null, lobbyId: null })).toBeNull();
  });
});

describe("the post's text (shareText)", () => {
  it("words a win as approved, by display name", () => {
    expect(shareText(frameOf([agent(0, "fennec"), agent(1, "tidewater")]), URL_))
      .toBe(`fennec beat tidewater on Antwars — Queens killed. Watch: ${URL_}`);
    expect(shareText(frameOf([agent(0, "fennec"), agent(1, "tidewater")], { winner: 1 }), URL_))
      .toBe(`tidewater beat fennec on Antwars — Queens killed. Watch: ${URL_}`);
  });
  it("words a draw as approved", () => {
    expect(shareText(frameOf([agent(0, "fennec"), agent(1, "tidewater")], { winner: null, reason: "double_overrun", decidedBy: "draw" }), URL_))
      .toBe(`fennec and tidewater drew on Antwars — Both last queens fell. Watch: ${URL_}`);
  });
  it("names a Benchmark by its display name with its level and Fast in brackets, never its antwars/ handle", () => {
    const text = shareText(frameOf([agent(0, "antwars/gpt-6-luna"), agent(1, "tidewater")]), URL_)!;
    expect(text).toBe(`GPT-6 Luna (max · Fast) beat tidewater on Antwars — Queens killed. Watch: ${URL_}`);
    expect(text).not.toContain("antwars/");
  });
  it("names each side's player(s) in a team mode: one player holding every seat once, several joined", () => {
    const team = [agent(0, "antwars/claude-opus-5-5 #1"), agent(0, "antwars/claude-opus-5-5 #2"), agent(1, "tidewater #1"), agent(1, "fennec #2")];
    expect(sideNames(team, 0)).toBe("Claude Opus 5.5 (high)");
    expect(sideNames(team, 1)).toBe("tidewater & fennec");
    // Without a seated identity: the agent's model as the HUD names it, else its generated handle, as the deck rows name it;
    // never its provider/model key.
    expect(sideNames([agent(0, null, "openai/gpt-6-luna"), agent(1, null, "")], 0)).toBe("GPT-6 Luna");
    expect(sideNames([agent(0, null, "gpt-6"), agent(1, null, "")], 0)).toBe("gpt-6");
    expect(sideNames([agent(0, null, "gpt-6"), agent(1, null, "")], 1)).toBe(agentHandle(1));
  });
  it("has nothing to share before the result shows, or without a link", () => {
    const f = frameOf([agent(0, "fennec"), agent(1, "tidewater")]);
    expect(shareText(f, null)).toBeNull();
    expect(shareHref(f, null)).toBeNull();
    f.board!.result = null;
    expect(shareText(f, URL_)).toBeNull();
  });
  it("opens X's post intent with the text encoded", () => {
    const href = shareHref(frameOf([agent(0, "fennec"), agent(1, "tidewater")]), URL_)!;
    expect(href.startsWith("https://x.com/intent/post?text=")).toBe(true);
    expect(new URL(href).searchParams.get("text")).toBe(`fennec beat tidewater on Antwars — Queens killed. Watch: ${URL_}`);
  });
});

// No house slug in the result rows or the post.
describe("no house slug in the result or the post", () => {
  it("names an unlisted handle Unlisted model with no badges, and a listed one by its row", () => {
    const agents = [agent(0, "antwars/not-a-row"), agent(1, "antwars/mistral-large-4")];
    expect(sideNames(agents, 0)).toBe("Unlisted model");
    expect(sideNames(agents, 1)).toBe("Mistral Large 4 (high)");
    const result: StreamResult = { winner: 1, reason: "time_up", decidedBy: "territory", tick: 20, nextStartMs: null,
      ratingChanges: [{ agent: 0, before: 1500, after: 1490 }, { agent: 1, before: 1500, after: 1510 }] };
    const rows = ratingResultRows(true, agents, result);
    expect(rows.map(row => [row.name, row.badges])).toEqual([["Unlisted model", []], ["Mistral Large 4", ["high"]]]);
    expect(JSON.stringify([rows, sideNames(agents, 0), sideNames(agents, 1)])).not.toMatch(/not-a-row|mistral-large-4|antwars\//);
  });
});
