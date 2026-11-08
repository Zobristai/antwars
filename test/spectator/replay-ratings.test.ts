import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { playScripted } from "../../src/live/record.ts";
import { excerpt } from "../../web/capture/excerpt.ts";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { playerLabel, ratingResultRows } from "../../web/src/compose.ts";
import { openRecording } from "../../web/src/recording.ts";
import { restateRatings, storedReplayRatings } from "../../web/src/replay-ratings.ts";

/** A result line as the HUDs show it (ratingResultRows): a seat's shown name and its rating change. */
const row = (name: string, text: string) => ({ name, badges: [] as string[], text });

/**
 * A pre-switch (Elo-recorded) rated replay: the recording carries the Elo figures at
 * match time; the stored change record carries the recomputed Glicko figures.
 */
function eloRecording(): StreamMessage[] {
  // A tile-2 excerpt stands in for the bundled excerpt deleted.
  const messages = excerpt(playScripted({ seed: 5205, config: withGridScale(DEFAULT_CONFIG), agents: 2, ticks: 502, attack: true }).lines, 500, 502);
  const head = messages[0]!.full!;
  head.setup.rated = true;
  head.agents = head.agents.slice(0, 2);
  head.agents[0]!.identity = { displayName: "glm", elo: 1383.3 };
  head.agents[1]!.identity = { displayName: "deepseek", elo: 1386.6 };
  const last = messages.at(-1)!;
  last.events = [{ kind: "end", result: { winner: 0, reason: "overrun", decidedBy: "overrun", tick: last.tick - 1, nextStartMs: null,
    ratingChanges: [{ agent: 0, before: 1383.3, after: 1399.5 }, { agent: 1, before: 1386.6, after: 1370.4 }] } }];
  // Round-trip through the wire format, as a stored recording is played.
  return messages.map(m => decodeMessage(encodeMessage(m)));
}
const glicko = { byColony: true, ratings: new Map([["0:glm", { before: 1412.25, after: 1461.75 }], ["1:deepseek", { before: 1430.5, after: 1388 }]]) };
const shown = (messages: readonly StreamMessage[]) => {
  const agents = messages[0]!.full!.agents;
  const end = messages.flatMap(m => m.events).find(event => event.kind === "end");
  return { labels: agents.map((agent, index) => playerLabel(index, agent)),
    result: ratingResultRows(messages[0]!.full!.setup.rated, agents, end?.kind === "end" ? end.result : null) };
};

describe("a rated replay shows its stored rating record", () => {
  it("restates an Elo-recorded replay's pre-match ratings and result lines with the stored figures", () => {
    const restate = restateRatings(glicko);
    expect(shown(eloRecording())).toEqual({ labels: ["glm · Rating 1383", "deepseek · Rating 1387"],
      result: [row("glm", "Rating 1383 → 1400 (+17)"), row("deepseek", "Rating 1387 → 1370 (-17)")] });
    expect(shown(eloRecording().map(restate))).toEqual({ labels: ["glm · Rating 1412", "deepseek · Rating 1431"],
      result: [row("glm", "Rating 1412 → 1462 (+50)"), row("deepseek", "Rating 1431 → 1388 (-43)")] });
  });

  it("leaves a replay whose recording already holds its stored record showing the same figures", () => {
    const recorded = eloRecording();
    const same = { byColony: true, ratings: new Map([["0:glm", { before: 1383.3, after: 1399.5 }], ["1:deepseek", { before: 1386.6, after: 1370.4 }]]) };
    expect(recorded.map(restateRatings(same))).toEqual(recorded);
  });

  it("plays a recording through the restatement, and as it is when there is none", async () => {
    const bytes = packMessages(eloRecording().map(encodeMessage));
    const open = (restate?: Promise<((m: StreamMessage) => StreamMessage) | null>) =>
      openRecording("/replays/x", undefined, async () => new Response(new Blob([bytes as BlobPart]).stream()), restate ? { restate } : {});
    const played = async (restate?: Promise<((m: StreamMessage) => StreamMessage) | null>) => {
      const recording = open(restate);
      await recording.first;
      const out: StreamMessage[] = [];
      let real = 0;
      // Playback advances at most 250 ms of real time per take.
      await vi.waitFor(() => { out.push(...recording.take(real += 250).map(arrival => arrival.m)); expect(out).toHaveLength(3); });
      recording.close();
      return out;
    };
    expect(shown(await played(Promise.resolve(restateRatings(glicko))))).toEqual({ labels: ["glm · Rating 1412", "deepseek · Rating 1431"],
      result: [row("glm", "Rating 1412 → 1462 (+50)"), row("deepseek", "Rating 1431 → 1388 (-43)")] });
    expect(shown(await played(Promise.resolve(null)))).toEqual(shown(eloRecording()));
  });

  it("reads the figures by replay id with the invite only when given, and keeps the recording's on any failure", async () => {
    const calls: [string, Headers][] = [];
    const answer = (status: number, body: unknown): typeof fetch => async (url, init) => {
      calls.push([String(url), new Headers(init?.headers)]);
      return new Response(JSON.stringify(body), { status });
    };
    const signal = new AbortController().signal;
    const ratings = { ratings: [{ displayName: "glm", before: 1412.25, after: 1461.75 }] };
    expect(await storedReplayRatings("2026-01-02T03-04-05-000Z-7", null, signal, answer(200, ratings))).toEqual({ byColony: false, ratings: new Map([["glm", { before: 1412.25, after: 1461.75 }]]) });
    expect(calls[0]![0]).toBe("/watch/ratings/2026-01-02T03-04-05-000Z-7");
    expect(calls[0]![1].has("x-antwar-invite")).toBe(false);
    await storedReplayRatings("2026-01-02T03-04-05-000Z-7", "token", signal, answer(200, ratings));
    expect(calls[1]![1].get("x-antwar-invite")).toBe("token");
    expect(await storedReplayRatings("x", null, signal, answer(200, { ratings: [] }))).toBeNull();
    expect(await storedReplayRatings("x", null, signal, answer(404, {}))).toBeNull();
    expect(await storedReplayRatings("x", null, signal, answer(200, { ratings: [{ displayName: "glm", before: "1412" }] }))).toBeNull();
    expect(await storedReplayRatings("x", null, signal, async () => { throw new Error("offline"); })).toBeNull();
  });

  it("keys rows by colony and display name, refusing a repeated pair or rows mixing with and without colony", async () => {
    const read = (ratings: unknown[]) => storedReplayRatings("x", null, new AbortController().signal, async () => new Response(JSON.stringify({ ratings })));
    expect(await read([{ colony: 0, displayName: "glm", before: 1412.25, after: 1461.75 }, { colony: 1, displayName: "glm", before: 1430.5, after: 1388 }]))
      .toEqual({ byColony: true, ratings: new Map([["0:glm", { before: 1412.25, after: 1461.75 }], ["1:glm", { before: 1430.5, after: 1388 }]]) });
    expect(await read([{ colony: 0, displayName: "glm", before: 1412.25, after: 1461.75 }, { colony: 0, displayName: "glm", before: 1430.5, after: 1388 }])).toBeNull();
    expect(await read([{ colony: 0, displayName: "glm", before: 1412.25, after: 1461.75 }, { displayName: "deepseek", before: 1430.5, after: 1388 }])).toBeNull();
    expect(await read([{ colony: 2, displayName: "glm", before: 1412.25, after: 1461.75 }])).toBeNull();
  });

  it("restates by display name from rows that carry no colony, as it always has", async () => {
    const rows = { ratings: [{ displayName: "deepseek", before: 1430.5, after: 1388 }, { displayName: "glm", before: 1412.25, after: 1461.75 }] };
    const stored = await storedReplayRatings("x", null, new AbortController().signal, async () => new Response(JSON.stringify(rows)));
    expect(shown(eloRecording().map(restateRatings(stored!)))).toEqual({ labels: ["glm · Rating 1412", "deepseek · Rating 1431"],
      result: [row("glm", "Rating 1412 → 1462 (+50)"), row("deepseek", "Rating 1431 → 1388 (-43)")] });
  });
});
