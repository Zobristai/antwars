import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { COLONY_NAMES, PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { streamQueens, type StreamQueen } from "../../src/live/format.ts";
import { Frame, Playback, QUEEN_COLLAPSE_MS } from "../../web/src/buffer.ts";
import { LOST_EMBLEM, QueenHomes } from "../../web/src/effects.ts";
import { storyText } from "../../web/src/overlays.ts";
import { boardQueenHp } from "../../web/src/variant.ts";
import { winRules } from "../../web/src/story.ts";
import { markerParticles } from "../../web/src/board3d/markers3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { Nests } from "../../web/src/board3d/nests.ts";
import { playable } from "../playable.ts";

function fixture() {
  const r = new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG)));
  const full = r.initialFull(), ants = r.initial().ants;
  const extra: StreamQueen = { id: 1, colony: 0, x: 18.5 * 256, y: 10.5 * 256, foundedTick: 0, lostTick: null, overrun: 0 };
  return { full, ants, extra };
}

it.each([0, 1] as const)("names colony %s and queen number in events, without coordinates or squad labels", (colony) => {
  const base = { id: 1, tick: 10, colony, agent: 7, x: 18.5, y: 10.5 };
  expect(storyText({ ...base, kind: "queen_founded", queenId: 3 }, [], 10)).toEqual({ what: "Queen 4 founded", who: COLONY_NAMES[colony] });
  expect(storyText({ ...base, kind: "queen_lost", queenId: 1 }, [], 10)).toEqual({ what: "Queen 2 lost", who: COLONY_NAMES[colony] });
});

it("uses the shipped board's 60-second overrun duration in the win rules", () => {
  const full = new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG))).initialFull();
  expect(full.overrunRequired).toBe(600);
  expect(boardQueenHp(full)).toBeUndefined();
  expect(boardQueenHp({ queens: undefined })).toBeUndefined();
  expect(winRules(full.setup, full.overrunRequired, true).rules.join(" ")).toContain("60");
});

it("draws founded queens only when delayed playback reaches them and retains earlier immutable boards", () => {
  const { full, ants, extra } = fixture(), p = new Playback(), f = new Frame();
  p.push({ tick: 0, full, ants, events: [] }, 0); p.sample(250, f);
  const earlier = f.board!;
  p.push({ tick: 1, full: null, ants, events: [{ kind: "queenFounded", queen: extra }] }, 100);
  p.sample(250, f); expect(streamQueens(f.board!)).toHaveLength(2);
  p.sample(350, f); expect(streamQueens(f.board!)).toHaveLength(3); expect(streamQueens(earlier)).toHaveLength(2);
  const homes = new QueenHomes(10); homes.update(f); expect(homes.zones).toHaveLength(3);
  const markers = markerParticles(f, (x, y) => [x * 10, y * 10]);
  expect(markers.particles.filter((x) => x.kind === "queen0")).toHaveLength(2);
  expect(f.story.filter((e) => e.kind === "queen_founded")).toHaveLength(1);
  expect(storyText(f.story.find((e) => e.kind === "queen_founded")!, [], 1)).toEqual({ what: "Queen 2 founded", who: COLONY_NAMES[0] });
  p.push({ tick: 2, full: null, ants, events: [{ kind: "queenOverrun", colony: 0, queenId: 1, progress: 100, required: 100 }, { kind: "queenLost", queen: { ...extra, lostTick: 1, overrun: 100 } }] }, 200);
  p.sample(450, f); homes.update(f); expect(homes.zones).toHaveLength(2);
  // The lost queen's emblem collapses: drawn whole at the moment of loss, shrinking through the collapse, and
  // staying once it is over as the dimmed, smaller landmark of where she was.
  const collapsing = markerParticles(f, (x, y) => [x, y]).particles.filter((x) => x.kind === "queen0");
  expect(collapsing).toHaveLength(2);
  expect(collapsing.map((x) => x.scaleX === 1)).toEqual([true, true]);
  p.sample(450 + QUEEN_COLLAPSE_MS / 2, f);
  expect(markerParticles(f, (x, y) => [x, y]).particles.filter((x) => x.kind === "queen0").map((x) => x.scaleX < 1)).toEqual([false, true]);
  p.sample(450 + QUEEN_COLLAPSE_MS, f); homes.update(f); expect(homes.zones).toHaveLength(2);
  expect(markerParticles(f, (x, y) => [x, y]).particles.filter((x) => x.kind === "queen0").map((x) => [x.scaleX, x.alpha])).toEqual([[1, 1], [LOST_EMBLEM.scale, LOST_EMBLEM.alpha]]);
  expect(f.story.find((e) => e.kind === "overrun")).toMatchObject({ queenId: 1, outcome: "took" });
  expect(storyText(f.story.find((e) => e.kind === "queen_lost")!, [], 2)).toEqual({ what: "Queen 2 lost", who: COLONY_NAMES[0] });
});

it("tracks concurrent overruns per queen and recovers lifecycle lines once on reconnect", () => {
  const { full, ants, extra } = fixture(); full.queens!.push(extra);
  const p = new Playback(), f = new Frame(); p.push({ tick: 1, full, ants, events: [] }, 0);
  p.push({ tick: 2, full: null, ants, events: [
    { kind: "queenOverrun", colony: 0, queenId: 0, progress: 1, required: 100 },
    { kind: "queenOverrun", colony: 0, queenId: 1, progress: 1, required: 100 },
  ] }, 100);
  p.sample(350, f); expect(f.story.filter((e) => e.kind === "overrun")).toHaveLength(2);
  const reconnect = { ...full, queens: [...full.queens!.filter((q) => q.id === 0), { ...extra, lostTick: 2, overrun: 100 }] };
  p.push({ tick: 3, full: reconnect, ants, events: [] }, 200); p.sample(450, f);
  expect(f.story.filter((e) => e.kind === "queen_founded")).toHaveLength(1);
  expect(f.story.filter((e) => e.kind === "queen_lost")).toHaveLength(1);
  p.push({ tick: 4, full: reconnect, ants, events: [] }, 300); p.sample(550, f);
  expect(f.story.filter((e) => e.kind === "queen_lost")).toHaveLength(1);
  expect(winRules(full.setup, 100, true).rules[0]).toContain("every queen has been overrun");
});

// A lost queen's nest stays drawn as a landmark, dimmed, instead of vanishing.
it("adds 3D nest meshes for new queens, reuses them, keeps a lost queen's nest as a dimmed landmark without the queen, and hides missing queens", () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const { full, extra } = fixture(), ground = new Ground(scene, full.setup.mapW, full.setup.mapH);
    const nests = new Nests(scene, ground, full.setup, 0.4, COLONY_RGB);
    nests.update([...streamQueens(full), extra]);
    expect(nests.casters).toHaveLength(3); expect(scene.getMeshByName("queen0-1")?.isEnabled()).toBe(true);
    const rim = scene.getMeshByName("rim0-1")!;
    const lit = rim.material!;
    nests.update([...streamQueens(full), extra]); expect(nests.casters).toHaveLength(3);
    nests.update([...streamQueens(full), { ...extra, lostTick: 100 }]);
    expect(scene.getMeshByName("queen0-1")?.isEnabled()).toBe(false);
    for (const name of ["mound0-1", "rim0-1", "entrance0-1"]) expect(scene.getMeshByName(name)?.isEnabled(), name).toBe(true);
    expect(rim.material).not.toBe(lit);
    expect(rim.material!.name).toBe("rimLost0");
    expect(scene.getMeshByName("queen0")?.isEnabled()).toBe(true);
    // Found again (another match's snapshot lists her standing): her rim lit as before.
    nests.update([...streamQueens(full), extra]);
    expect(scene.getMeshByName("queen0-1")?.isEnabled()).toBe(true);
    expect(rim.material).toBe(lit);
    nests.update([]);
    for (const name of ["queen0", "mound0", "rim0"]) expect(scene.getMeshByName(name)?.isEnabled(), name).toBe(false);
  } finally { scene.dispose(); engine.dispose(); }
});

it("keeps 2D queen emblems separate from ground brackets and mounts them above ants", () => {
  const { full, ants } = fixture(), p = new Playback(), frame = new Frame();
  p.push({ tick: 0, full, ants, events: [] }, 0); p.sample(250, frame);
  const homes = new QueenHomes(10);
  homes.update(frame);
  expect(homes.layer).not.toBe(homes.emblems);
  expect(homes.layer.context.instructions.length).toBeGreaterThan(0);
  expect(homes.emblems.context.instructions.length).toBeGreaterThan(0);
  const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
  const order = main.match(/world\.addChild\(([^;]+)\);/)![1]!;
  expect(order.indexOf("queens.layer")).toBeLessThan(order.indexOf("ants.antLayer"));
  expect(order.indexOf("queens.emblems")).toBeGreaterThan(order.indexOf("ants.antLayer"));
  homes.update({ ...frame, board: null });
  expect(homes.emblems.context.instructions).toHaveLength(0);
});
