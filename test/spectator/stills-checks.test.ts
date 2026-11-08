/** The checks the stills run applies to every scene's record (web/capture/scene-checks.ts). */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Browser, Route } from "playwright-core";
import { servePage } from "../../web/capture/browser.ts";
import { sceneProblems, type SceneRecord } from "../../web/capture/scene-checks.ts";
import { MODEL_LABEL_FIXTURE_OFFSETS, countLabelCandidates, countLabelSample, markLabelToggleProblems, withModelLabelFixture, type CountLabelCandidate, type CountLabelProbe, type MarkLabelsSnapshot } from "../../web/capture/stills.ts";
import { decodeMessage, encodeMessage, type StreamAgent, type StreamMark, type StreamMessage } from "../../src/live/format.ts";

const clean: SceneRecord = { file: "3d-landscape-mark.jpg", emptyCorners: [], boardShare: 0.5 };

describe("reviewed dock label recording fixtures", () => {
  it("distributes all families and stress names across existing seats/batches, survives the stream round trip, and keeps snapshots and joins consistent", () => {
    const agent = (colony: 0 | 1): StreamAgent => ({ colony, modelLabel: "before", joinTick: 0, lastCallTick: 0, prevCallTick: -1, order: "forage", orderX: 0, orderY: 0, intent: "" });
    const agents = [agent(0), agent(1), agent(0), agent(1), agent(0), agent(1)];
    const first: StreamMessage = {
      tick: 0,
      ants: { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) },
      // Every stream setup carries grid scale 2, or the round trip refuses it.
      full: { setup: { mapW: 8, mapH: 8, gridScale: 2, ticksPerSecond: 10, matchTicks: 1000, idleTicks: 300, overrunRadiusTiles: 2, queens: [[128, 128], [1920, 1920]] }, territory: new Uint8Array(64), hatched: [0, 0], agents, marks: [], overrun: [0, 0], overrunRequired: 80, deaths: [0, 0], result: null },
      events: [],
    };
    const messages: StreamMessage[] = [first, { ...first, tick: 1, full: null, events: [{ kind: "join", agent: 6, colony: 0, modelLabel: "later" }] }, { ...first, tick: 2, full: { ...first.full!, agents: [...agents, agent(0)] } }];
    const original = structuredClone(messages);
    const fixture = withModelLabelFixture(messages);
    expect(messages).toEqual(original);
    expect(withModelLabelFixture(messages)).toEqual(fixture);
    const labels = fixture[0]!.full!.agents.map((a) => a.modelLabel);
    const own = [0, 1].map((colony) => fixture[0]!.full!.agents.filter((a) => a.colony === colony).map((a) => a.modelLabel));
    expect(own[0]![0]!.length).toBeGreaterThan(40);
    expect(new TextEncoder().encode(own[0]![1]!).length).toBe(64);
    expect(own[0]![1]).not.toMatch(/\s/);
    expect(own[0]![2]).toBe('<img src=x onerror="alert(1)">');
    expect(own[1]).toEqual([own[0]![2], "GLM-5", "Claude Opus"]);
    expect(decodeMessage(encodeMessage(fixture[0]!)).full!.agents.map((a) => a.modelLabel)).toEqual(labels);
    expect(fixture[2]!.full!.agents.slice(0, 6).map((a) => a.modelLabel)).toEqual(labels);
    expect(fixture[1]!.events[0]).toMatchObject({ kind: "join", agent: 6, modelLabel: fixture[2]!.full!.agents[6]!.modelLabel });
    // Only labels change, never ants, orders, territory, events or setup.
    const restore = fixture.map((m, i) => ({ ...m, full: m.full && { ...m.full, agents: m.full.agents.map((a, j) => ({ ...a, modelLabel: messages[i]!.full!.agents[j]!.modelLabel })) }, events: m.events.map((e, j) => e.kind === "join" ? { ...e, modelLabel: (messages[i]!.events[j] as Extract<typeof e, { kind: "join" }>).modelLabel } : e) }));
    expect(restore).toEqual(messages);
    // The failed action scenes seen in browser checks have four seats, not the six-seat fixture above.
    const small: StreamMessage = { ...first, full: { ...first.full!, agents: [agent(0), agent(1), agent(0), agent(1)] } };
    const smallBefore = structuredClone(small);
    const smallVariants = MODEL_LABEL_FIXTURE_OFFSETS.map((offset) => withModelLabelFixture([small], offset)[0]!);
    const smallLabels = smallVariants.flatMap((variant) => variant.full!.agents.map((a) => a.modelLabel));
    expect(smallLabels).toContain('<img src=x onerror="alert(1)">');
    expect(smallLabels).toContain("UnlistedModel" + "x".repeat(51));
    expect(MODEL_LABEL_FIXTURE_OFFSETS).toEqual([0, 3, 6, 9]);
    expect(small).toEqual(smallBefore);
    for (const variant of smallVariants) {
      expect(variant.full!.agents).toHaveLength(4);
      expect(variant.full!.agents.map(({ modelLabel: _, ...a }) => a)).toEqual(small.full!.agents.map(({ modelLabel: _, ...a }) => a));
      expect(variant.ants).toBe(small.ants);
    }
    const variants = MODEL_LABEL_FIXTURE_OFFSETS.map((offset) => withModelLabelFixture(messages, offset));
    for (const variant of variants) {
      expect(decodeMessage(encodeMessage(variant[0]!)).full!.agents.map((a) => a.modelLabel)).toEqual(variant[0]!.full!.agents.map((a) => a.modelLabel));
      expect(variant[1]!.events[0]).toMatchObject({ kind: "join", agent: 6, modelLabel: variant[2]!.full!.agents[6]!.modelLabel });
      expect(variant[0]!.ants).toBe(first.ants);
      expect(variant[0]!.full!.agents.map(({ modelLabel: _, ...a }) => a)).toEqual(first.full!.agents.map(({ modelLabel: _, ...a }) => a));
    }
  });

});

describe("capture route image response types", () => {
  // Without it every scene's page logged a 404 for its stored-match history (replay.ts loadHistory), failing the run.
  it("answers the stored-match history with one empty page", async () => {
    let handle: ((route: Route) => Promise<unknown>) | undefined;
    const page = { on() {}, addInitScript: async () => {}, clock: { install: async () => {}, pauseAt: async () => {} } };
    const context = { newPage: async () => page, addInitScript: async () => {}, route: async (_pattern: string, handler: (route: Route) => Promise<unknown>) => { handle = handler; } };
    const browser = { newContext: async () => context, browserType: () => ({ name: () => "chromium" }) } as unknown as Browser;
    await servePage(browser, { recording: "unused", width: 390, height: 844, tilt: false });
    let response: NonNullable<Parameters<Route["fulfill"]>[0]> | undefined;
    if (handle === undefined) throw new Error("capture route was not installed");
    await handle({
      request: () => ({ url: () => "http://localhost:4718/matches", method: () => "GET" }),
      fulfill: async (value: NonNullable<Parameters<Route["fulfill"]>[0]>) => { response = value; },
    } as unknown as Route);
    expect(response?.status).toBe(200);
    expect(response?.contentType).toBe("application/json");
    expect(JSON.parse(String(response?.body))).toEqual({ matches: [], nextPageToken: null });
  });
});

describe("recording-derived count label selection", () => {
  const counted = (id = 7): StreamMark => ({ id, agent: 0, colony: 0, tileX: 10, tileY: 10, laidTick: 1, answered: 0, words: [], verb: "DEFEND", count: 20, claimed: 12 });
  const message = (tick: number, marks: StreamMark[] | null, events: StreamMessage["events"] = []): StreamMessage => ({
    tick, events,
    ants: { count: 0, id: new Uint32Array(), x: new Uint16Array(), y: new Uint16Array(), heading: new Uint8Array(), colony: new Uint8Array(), agent: new Int16Array() },
    full: marks === null ? null : { setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 300, overrunRadiusTiles: 2, queens: [[0, 0], [1000, 1000]] }, marks, agents: [], territory: new Uint8Array(), overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null },
  });

  it("waits for a live count's fade-in, follows claims and removal, and never mutates the recording", () => {
    const messages = [message(0, []), message(1, null, [{ kind: "mark", mark: counted() }]), message(2, null), message(5, null), message(6, null), message(7, null, [{ kind: "mark", mark: { ...counted(), claimed: 13 } }]), message(8, null, [{ kind: "markGone", markId: 7 }])];
    const before = structuredClone(messages);
    expect(countLabelCandidates(messages)).toEqual([
      { tick: 5, counts: [{ id: 7, verb: "DEFEND", text: "12/20" }] },
      { tick: 7, counts: [{ id: 7, verb: "DEFEND", text: "13/20" }] },
    ]);
    expect(messages).toEqual(before);
  });

  it("does not use the sixth word mark: only a later eligible count can supply the toggle scene", () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ ...counted(i), verb: undefined, words: [0, 1] }));
    const messages = [message(0, words), message(20, null, [{ kind: "mark", mark: { ...counted(), laidTick: 19 } }]), message(24, null)];
    expect(countLabelCandidates(messages).map((c) => c.tick)).toEqual([24]);
    expect(countLabelCandidates([message(0, words), message(10, null)])).toEqual([]);
    expect(countLabelCandidates([message(2000, [counted()])])).toEqual([]);
    expect(countLabelCandidates([message(0, []), message(1, null, [{ kind: "mark", mark: counted() }]), message(2, null, [{ kind: "markGone", markId: 7 }]), message(5, null)])).toEqual([]);
  });

  it("rejects the eligible count's offstage label and accepts a later actual matching sample on this stage", () => {
    const candidate: CountLabelCandidate = { tick: 24, counts: [{ id: 7, verb: "DEFEND", text: "12/20" }] };
    const probe: CountLabelProbe = { labels: [{ id: 7, text: "12/20", rect: { x0: 150, y0: 140, x1: 220, y1: 160 } }], markers: [{ id: 7, x: 130, y: 150 }], stage: { x0: 100, y0: 100, x1: 300, y1: 300 }, uncovered: [7] };
    const offstage = { ...probe, labels: [{ ...probe.labels[0]!, rect: { x0: 310, y0: 140, x1: 380, y1: 160 } }] };
    expect(countLabelSample(candidate, offstage)).toBeNull();
    expect(countLabelSample(candidate, { ...probe, labels: [] })).toBeNull();
    expect(countLabelSample(candidate, { ...probe, uncovered: [] })).toBeNull();
    expect(countLabelSample(candidate, { ...probe, markers: [{ id: 7, x: 105, y: 150 }] })).toBeNull();
    expect(countLabelSample(candidate, { ...probe, labels: [{ ...probe.labels[0]!, text: "13/20" }] })).toBeNull();
    expect(countLabelSample(candidate, probe)).toBe(7);
  });

  it("wires candidate attempts into playback independently of the generic mark moment and fails missing samples", () => {
    const source = readFileSync(new URL("../../web/capture/stills.ts", import.meta.url), "utf8");
    expect(source).toContain('labelTicks.map((t): [Step, number] => ["mark-labels", t.tick])');
    expect(source).toContain("countLabelSample(candidate, probe)");
    expect(source).toContain("no eligible compact count label on the captured stage");
    expect(source).toContain("labels toggle not proven");
  });
});

describe("mark labels stills checks", () => {
  const before: MarkLabelsSnapshot = { on: true, pressed: "true", markers: [1, 2], badges: 2, labels: [{ id: 1, text: "12/20", rect: { x0: 20, y0: 20, x1: 90, y1: 40 } }] };
  const hidden: MarkLabelsSnapshot = { ...before, on: false, pressed: "false", labels: [] };
  it("accepts only a real off/on toggle with compact labels and unchanged markers and badges", () => {
    expect(markLabelToggleProblems(before, hidden, before, [390, 844])).toEqual([]);
    expect(markLabelToggleProblems(before, { ...hidden, markers: [], badges: 0 }, before, [390, 844])).toContain("toggling labels changed the markers or squad badges");
    expect(markLabelToggleProblems(before, { ...hidden, labels: before.labels }, before, [390, 844])).toContain("labels remain visible with mark labels off");
    expect(markLabelToggleProblems(before, hidden, { ...before, labels: [] }, [390, 844])).toContain("compact labels did not return when switched on");
    expect(markLabelToggleProblems(before, { ...hidden, pressed: "true" }, before, [390, 844])).toContain("mark labels control and board state disagree");
  });
  it("fails missing evidence, verbose counts, and clipped labels", () => {
    expect(markLabelToggleProblems({ ...before, labels: [] }, hidden, before, [390, 844])).toContain("no compact count label is visible; the recording does not prove the labels toggle");
    const verbose = { ...before, labels: [{ ...before.labels[0]!, text: "ATTACK · 20 requested · 12 answered" }] };
    expect(markLabelToggleProblems(verbose, hidden, verbose, [390, 844])).toContain("mark 1 has a non-compact count: ATTACK · 20 requested · 12 answered");
    expect(markLabelToggleProblems(before, hidden, before, [60, 844])).toContain("mark 1's label is clipped");
  });
});

describe("a scene's problems", () => {
  it("a clean record has none", () => {
    expect(sceneProblems(clean)).toEqual([]);
  });

  // At 1920x1080 the recording's status line left "· 4 agents" alone on a second line.
  it("a desktop's status line that takes a second line fails", () => {
    expect(sceneProblems({ ...clean, wraps: [] })).toEqual([]);
    expect(sceneProblems({ ...clean, wraps: ["status line: RECORDING · no live match · older rules · 4 agents (2 lines)"] })).toEqual(["3d-landscape-mark.jpg: status line: RECORDING · no live match · older rules · 4 agents (2 lines); it keeps one line"]);
  });

  it("an empty stage corner and a clipped tooltip each fail", () => {
    const problems = sceneProblems({
      ...clean,
      emptyCorners: ["top left", "bottom right"],
      tooltip: { x0: -4, y0: 10, x1: 120, y1: 60, onScreen: false },
    });
    expect(problems).toEqual([
      "3d-landscape-mark.jpg: the board leaves the stage's top left and bottom right corner(s) empty; the board must fill its area",
      "3d-landscape-mark.jpg: the tooltip at -4,10–120,60 is not whole on the screen",
    ]);
    expect(sceneProblems({ ...clean, tooltip: { x0: 4, y0: 10, x1: 120, y1: 60, onScreen: true } })).toEqual([]);
  });

  // The fallen queen whole in frame at every viewport. A queen the stage's edge cuts (her box: her tile
  // and the mound around it), as the hero tilt left her at the landscape stage, fails the run, named with the still; so
  // does a fall moment at which no colony has fallen.
  it("at the fall moment the fallen colony's queens lie whole in the stage", () => {
    const stage = { x0: 0, y0: 120, x1: 390, y1: 560 };
    const whole = { id: 2, rect: { x0: 100.4, y0: 300, x1: 220, y1: 419.8 } };
    expect(sceneProblems({ ...clean, fall: { colony: 1, stage, nests: [whole] } })).toEqual([]);
    expect(sceneProblems({ ...clean, fall: { colony: 1, stage, nests: [whole, { id: 5, rect: { x0: 300, y0: 480.2, x1: 420, y1: 600 } }] } })).toEqual([
      "3d-landscape-mark.jpg: colony 1's queen 5 at 300,480–420,600 is not whole in the stage at 0,120–390,560; the fallen queen must be whole in frame at every viewport",
    ]);
    expect(sceneProblems({ ...clean, fall: { colony: null, stage, nests: [] } })).toEqual(["3d-landscape-mark.jpg: no colony has fallen at the fall moment; the fall scene must show the fallen queen"]);
  });
});
