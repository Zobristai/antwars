/** Public default, loop-free fallback, and renderer-explicit capture contracts. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureQuery } from "../../web/capture/browser.ts";
import { boardMode, fallbackUrl, runBoard, type Starters } from "../../web/src/webgl2.ts";
import { QualityController, TIERS, WINDOW } from "../../web/src/board3d/quality.ts";
import { createQualitySampler } from "../../web/src/board3d/main3d.ts";

const origin = "https://example.test/";

function page(href: string, options: { webgl2?: boolean; load3d?: () => Promise<void> } = {}) {
  const starts: string[] = [];
  const errors: unknown[] = [];
  const state = { href, reloads: 0, messages: 0, rejected: false };
  const starters: Starters = {
    probe2: () => options.webgl2 ?? true,
    start3d: async () => {
      starts.push("3d");
      await options.load3d?.();
    },
    start2d: async () => { starts.push("2d"); },
    webglSupported: () => true,
    show: () => { state.messages++; },
    log: (error) => { errors.push(error); },
    reject: () => { state.rejected = true; },
    fallback2d: () => {
      state.href = fallbackUrl(state.href);
      state.reloads++;
    },
  };
  const start = () => runBoard(boardMode(new URL(state.href).searchParams), starters);
  return { state, starters, starts, errors, start };
}

describe("public board selection", () => {
  it.each(["", "?board=3d", "?replay", "?replay&board=3d", "?match=7", "?board=unknown"])("%s starts 3D", async (query) => {
    const p = page(`${origin}${query}`);
    await p.start();
    expect(p.starts).toEqual(["3d"]);
    expect(p.state.reloads).toBe(0);
  });

  it.each(["?board=2d", "?board=2d&replay", "?board=2d&match=7"])("%s starts 2D without probing or loading 3D", async (query) => {
    const p = page(`${origin}${query}`);
    p.starters.probe2 = () => { throw new Error("2D must not probe WebGL2"); };
    await p.start();
    expect(p.starts).toEqual(["2d"]);
    expect(p.state.messages).toBe(0);
  });

  it.each(["", "?board=3d", "?replay"])("%s starts 2D directly when WebGL2 is missing, without an error message or reload", async (query) => {
    const p = page(`${origin}${query}`, { webgl2: false });
    await p.start();
    expect(p.starts).toEqual(["2d"]);
    expect(p.errors).toEqual([]);
    expect(p.state).toMatchObject({ reloads: 0, messages: 0, rejected: false });
  });

  it("an import failure reloads just once, then starts 2D with the same match, replay and capture parameters", async () => {
    const fail = new TypeError("Failed to fetch dynamically imported module");
    const href = `${origin}?match=7&replay&recording=fixture&capture=1&tilt=0&trails=0#board`;
    const p = page(href, { load3d: () => Promise.reject(fail) });
    await p.start();
    expect(p.errors).toEqual([fail]);
    const after = new URL(p.state.href);
    expect(after.searchParams.get("board")).toBe("2d");
    after.searchParams.delete("board");
    expect([...after.searchParams]).toEqual([...new URL(href).searchParams]);
    expect(after.hash).toBe("#board");
    await p.start();
    expect(p.starts).toEqual(["3d", "2d"]);
    expect(p.state).toMatchObject({ reloads: 1, messages: 0, rejected: false });
  });

  it.each([origin, `${origin}?board=3d`, `${origin}?board=2d`, `${origin}?board=3d&board=3d&replay&x=1&x=2#view`])("fallback is explicit and idempotent for %s", (href) => {
    const next = fallbackUrl(href);
    const url = new URL(next);
    expect(url.searchParams.getAll("board")).toEqual(["2d"]);
    expect(boardMode(url.searchParams)).toBe("2d");
    expect(fallbackUrl(next)).toBe(next);
    const original = new URL(href);
    original.searchParams.delete("board");
    url.searchParams.delete("board");
    expect(url.toString()).toBe(original.toString());
  });

  it("the slow-board fallback also leaves the next load on 2D", async () => {
    const p = page(origin);
    await p.start();
    const quality = new QualityController(TIERS.length - 1);
    for (let i = 0; i <= WINDOW; i++) {
      if (quality.frame(i * 60) === "fallback") p.starters.fallback2d();
    }
    await p.start();
    expect(p.starts).toEqual(["3d", "2d"]);
    expect(p.state.reloads).toBe(1);
  });
});

describe("reconnect catch-up quality sampling", () => {
  it("excludes reconnect catch-up intervals without carrying their cost into the next frame", () => {
    const q = new QualityController(0), sample = createQualitySampler(q);
    let now = 0;
    expect(sample(now, false)).toBe('hold');
    for (let i = 0; i < WINDOW; i++) {
      now += 1000;
      expect(sample(now, true)).toBe('hold');
      expect(q.filling).toBe(i);
      now += 16;
      expect(sample(now, false)).toBe('hold');
    }
    expect(q.lastMedian).toBe(16);
    expect(q.tier).toBe(0);
  });

  it("preserves ordinary slow samples across reconnects and still falls back on a slow device", () => {
    const q = new QualityController(0), sample = createQualitySampler(q);
    let now = 0;
    sample(now, false);
    for (let i = 1; i <= WINDOW; i++) {
      if (i % 10 === 0) { now += 1000; expect(sample(now, true)).toBe('hold'); }
      now += 429;
      expect(sample(now, false)).toBe(i === WINDOW ? 'fallback' : 'hold');
    }
    expect(q.lastMedian).toBe(429);
  });

  it("preserves consecutive slow-window thresholds, including on an ended page outside catch-up", () => {
    const q = new QualityController(0), sample = createQualitySampler(q);
    let now = 0;
    sample(now, false);
    for (let i = 1; i <= WINDOW * 2; i++) {
      if (i === WINDOW + 1) { now += 5000; sample(now, true); }
      now += 40;
      expect(sample(now, false)).toBe(i === WINDOW * 2 ? 'step' : 'hold');
    }
    expect(q.tier).toBe(1);
  });

  it("uses real intervals unchanged when there is no live reconnect (including recordings)", () => {
    const direct = new QualityController(TIERS.length - 1);
    const sampled = new QualityController(TIERS.length - 1), sample = createQualitySampler(sampled);
    for (let i = 0; i <= WINDOW * 2; i++) expect(sample(5000 + i * 60, false)).toBe(direct.frame(5000 + i * 60));
    expect(sampled.lastMedian).toBe(direct.lastMedian);
  });
});

describe("capture renderer selection", () => {
  it("legacy stills and replay explicitly ask for 2D", () => {
    expect([...captureQuery({ recording: "fixture", tilt: false })]).toEqual([
      ["recording", "fixture"], ["capture", "1"], ["tilt", "0"], ["board", "2d"],
    ]);
    const replay = captureQuery({ recording: "ignored", replay: true, tilt: false });
    expect(replay.has("recording")).toBe(false);
    expect(replay.has("replay")).toBe(true);
    expect(boardMode(replay)).toBe("2d");
  });

  it("stills --board 3d keeps selecting 3D, including a labelled replay", () => {
    for (const replay of [false, true]) {
      const query = captureQuery({ recording: "fixture", replay, tilt: true, board: "3d" });
      expect(query.get("board")).toBe("3d");
      expect(boardMode(query)).toBe("3d");
    }
  });
});

describe("entrypoint wiring", () => {
  it("both renderers share prepared live intake, recorded intake and presentation helpers", () => {
    for (const path of ["../../web/src/main.ts", "../../web/src/board3d/main3d.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).toMatch(/import \{ openSource \} from "\.\.?\/source\.ts"/);
      expect(source).toMatch(/const input = await openSource\(params, clock, document,/);
      expect(source).toContain("for (const arrival of input.take(realMs)) {");
      expect(source).toMatch(/if \(arrival.kind === "prepared"\) (?:\{\s*)?playback.pushPrepared\(arrival.prepared, arrival.at\)/);
      expect(source).toContain("else playback.push(arrival.m, arrival.at)");
      expect(source).toContain("new Playback({ live: !input.recorded })");
      expect(source).toContain("const now = input.now(realMs)");
      expect(source).not.toMatch(/loadRecording\(|REPLAY_PATH/);
      expect(source).toContain("modeCopy(mode, board.agents.length, ended, location.pathname, input.storedId, board.setup.rated, input.delaySeconds, input.matchNote)");
      expect(source).toContain("excerptEnded(frame.tick, input.lastTick)");
      // The stills tap a mark on its label where one is drawn (a label tap opens the mark, never the ant beneath): both boards expose the drawn labels.
      expect(source).toContain("markLabels: () => (words.layer.visible ? words.drawnLabels() : [])");
    }
  });

  // Regression caught in the baseline-4498ec4 stills: without WebGL the page showed its message and nothing
  // else worked. The page now reads its source and mounts the HUD with the message in its window, and the stills' WebGL-off
  // pass requires the HUD's Agents panel shown, its heading whole and clear on the screen.
  it("without WebGL the rest of the page works: the message's starter mounts the HUD with the message, and the stills pass requires the Agents panel", () => {
    const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/show: \(\) => \{[^}]*showNeedsWebGL\(document\);[^}]*startWithoutBoard\(document\.getElementById\("aw-waiting"\)\)/);
    expect(main).toMatch(/async function startWithoutBoard\([^)]*\)[\s\S]*new Overlays\(document\.body[\s\S]*overlays\.update\(frame\)[\s\S]*overlays\.mountHud\(\{ deck: false, replay: controls\?\.el \?\? null, teamView: null, waiting: message \}\)/);
    const stills = readFileSync(new URL("../../web/capture/stills.ts", import.meta.url), "utf8");
    expect(stills).toContain(`page.waitForSelector(".d2-agents-title"`);
    expect(stills).toContain("the Agents panel is not shown");
  });

  it("context loss and a slow or failed 3D board use the explicit-2D fallback", () => {
    const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
    const three = readFileSync(new URL("../../web/src/board3d/main3d.ts", import.meta.url), "utf8");
    expect(main).toContain("location.replace(fallbackUrl(location.href))");
    expect(main).toContain("fallback: fallbackTo2d");
    expect(main).toContain("fallback2d: fallbackTo2d");
    expect(three).toContain("engine.onContextLostObservable.add(() => giveUp(");
    expect(three).toContain("addEventListener(\"webglcontextlost\", () => giveUp(");
    expect(three).toContain("decision === \"fallback\"");
    expect(three).toContain("if (gaveUp) return");
    expect(three).toContain("client.fallback(why)");
    expect(main).toContain('console.warn(`3D board: ${reason}; reloading as the 2D board`)');
    expect(main).toContain('const fallbackTo2d = (reason = "it failed to start")');
    expect(three).toContain('!input.recorded && playback.resets > 1 && playback.resets !== qualityResets');
    expect(three).toContain('sampleQuality(clock.now(), reconnectCatchUp)');
  });
});
