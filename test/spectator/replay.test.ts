/**
 * The live-or-recorded line's words (web/src/replay.ts) and the excerpt cutter (web/capture/excerpt.ts),
 * played the way the client plays a recording. The bundled excerpt web/public/replays/agents.bin is deleted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { playScripted, recordLog } from "../../src/live/record.ts";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { excerpt } from "../../web/capture/excerpt.ts";
import { excerptEnded, modeCopy } from "../../web/src/replay.ts";
import { boardMode } from "../../web/src/webgl2.ts";

describe("the live-or-recorded line", () => {
  it("live with no agent: a label, the delay disclosed and the recorded agent match offered", () => {
    expect(modeCopy("live", 0, false, "/")).toEqual({ label: "LIVE", detail: "No agents · 60 s behind the match", link: { text: "Watch a recorded agent match", href: "?replay" } });
  });
  it("live with agents playing: LIVE with the delay disclosed, no offer", () => {
    expect(modeCopy("live", 3, false, "/")).toEqual({ label: "LIVE", detail: "60 s behind the match", link: null });
  });
  it("the recording always says it is not live and links back, with its agent count in the label while it plays, and without once it has ended", () => {
    const id = "2026-10-18T12-34-56-789Z-1";
    expect(modeCopy("replay", 4, false, "/index.html", id)).toEqual({ label: "RECORDING · not live · 4 agents", detail: "18 Oct 2026", link: { text: "Back to live", href: "/index.html?watch=1" } });
    expect(modeCopy("replay", 4, true, "/", id)).toEqual({ label: "RECORDING · not live", detail: "· recording ended", link: { text: "Back to live", href: "/?watch=1" } });
  });
  it("labels no recording older rules, now that the bundled historical excerpt is deleted", () => {
    const id = "2026-10-18T12-34-56-789Z-1";
    for (const ended of [false, true]) for (const stored of [null, id]) {
      const copy = modeCopy("replay", 4, ended, "/", stored);
      expect(`${copy.label} ${copy.detail}`).not.toMatch(/older rules|excerpt/);
    }
  });
  it("says RECORDING once: the line carries it, and the board has no badge of its own", () => {
    for (const copy of [modeCopy("replay", 4, false, "/"), modeCopy("replay", 4, true, "/")]) expect(`${copy.label} ${copy.detail}`.match(/RECORDING/g)).toHaveLength(1);
    const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    expect(html).not.toMatch(/aw-rec-badge/);
    for (const path of ["../../web/src/replay.ts", "../../web/src/main.ts", "../../web/src/board3d/main3d.ts"]) expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toMatch(/RecordingBadge|BADGE_TEXT/);
  });
  it("the labelled recording follows the same default and explicit board selection as live", () => {
    expect(boardMode(new URLSearchParams("replay"))).toBe("3d");
    expect(boardMode(new URLSearchParams("replay=1&board=3d"))).toBe("3d");
    expect(boardMode(new URLSearchParams("board=3d&replay"))).toBe("3d");
    expect(boardMode(new URLSearchParams("board=2d&replay"))).toBe("2d");
  });
  it("claims nothing about agents coordinating", () => {
    const all = [modeCopy("live", 0, false, "/"), modeCopy("live", 2, false, "/"), modeCopy("replay", 4, false, "/"), modeCopy("replay", 4, true, "/")];
    const words = all.map((c) => `${c.label} ${c.detail} ${c.link?.text ?? ""}`).join(" ");
    expect(words).not.toMatch(/coordinat|cooperat|together|team|ally|allies|help|work with|strateg/i);
  });
});

/** Play messages one tick of client time apart, as web/src/main.ts plays a recording, and sample at client time ms. */
function playAt(ms: readonly StreamMessage[], at: number): Frame {
  const p = new Playback();
  ms.forEach((m, i) => p.push(m, i * TICK_MS));
  const f = new Frame();
  p.sample(at, f);
  return f;
}

describe("excerpt", () => {
  const lines = playScripted({ seed: 5205, config: withGridScale(DEFAULT_CONFIG), agents: 2, ticks: 900, attack: true }).lines;
  const whole = recordLog(lines, 800).map(decodeMessage);
  const cut = excerpt(lines, 500, 800);

  it("starts with a full snapshot at `from`, then one message per tick to `to`, each the match's own", () => {
    expect(cut[0]!.full).not.toBeNull();
    expect(cut[0]!.tick).toBe(500);
    expect(cut.map((m) => m.tick)).toEqual(Array.from({ length: 301 }, (_, i) => 500 + i));
    const at = new Map(whole.map((m) => [m.tick, m]));
    expect(encodeMessage({ ...cut[0]!, full: null })).toEqual(encodeMessage({ ...at.get(500)!, events: [] }));
    for (const m of cut.slice(1)) expect(encodeMessage(m)).toEqual(encodeMessage(at.get(m.tick)!));
  });

  it("a viewer of the excerpt sees the board a viewer of the whole match sees at its last tick", () => {
    const a = playAt(cut, 1e9).board!;
    const b = playAt(whole, 1e9).board!;
    expect([...a.territory]).toEqual([...b.territory]);
    expect(a.deaths).toEqual(b.deaths);
    expect(a.agents.map((x) => [x.colony, x.order, x.intent])).toEqual(b.agents.map((x) => [x.colony, x.order, x.intent]));
    expect(a.marks.map((m) => m.id)).toEqual(b.marks.map((m) => m.id));
  });

  it("plays the excerpt to a detected end at its last tick, and not before", () => {
    const last = cut.at(-1)!.tick;
    const end = (cut.length - 1) * TICK_MS + RENDER_DELAY_MS;
    expect(excerptEnded(playAt(cut, end - 10 * TICK_MS).tick, last)).toBe(false);
    const after = playAt(cut, end);
    expect(after.tick).toBe(800);
    expect(excerptEnded(after.tick, last)).toBe(true);
    expect(after.board!.agents).toHaveLength(2);
  }, 20_000);
});
