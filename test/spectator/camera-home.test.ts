import { describe, expect, it } from "vitest";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { Camera, fightLane, queensBox } from "../../web/src/camera.ts";
import { fitOpeningView, openingBounds } from "../../web/src/start-framing.ts";
import { sevenMapRotation } from "../sim/seven-map-rotation.ts";

// Desktop Chromium/WebKit geometry at ce711c2c4d46c1c4c3694140adbc3a1d7daa8604; the same horizontal drift occurred
// on all maps.
const desktop = { width: 1440, height: 900 };
const area = { x0: 24, y0: 163.984375, x1: 1092, y1: 748.4375 };
function fixture(mapId: string) {
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  const base = sevenMapRotation(newMatchConfig(rulesConfig("redesign")));
  const state = createMatch(7001, { ...base, terrain: { ...base.terrain!, mapId },
    initialQueens: [[{ tileX: 4, tileY: 24 }], [{ tileX: 111, tileY: 48 }]],
  });
  const full = new SpectatorRecorder(state).initialFull();
  const camera = () => new Camera(full.setup.mapW, full.setup.mapH, desktop.width, desktop.height,
    area, fightLane(full.setup), queensBox(full.setup), full.setup.gridScale);
  return { full, camera };
}

describe.each(["open-field", "three-crossings", "central-lake"])("desktop 2D Home on %s", mapId => {
  it("restores the exact designed opening default through public zoom/pan", () => {
    const { full, camera: makeCamera } = fixture(mapId);
    expect(full.setup.terrain?.mapId).toBe(mapId);
    const camera = makeCamera(), bounds = openingBounds(full)!;
    camera.setOpeningBounds(bounds);
    const initial = { ...camera.view };
    expect(initial).toEqual(fitOpeningView(bounds, area));
    expect(initial).toEqual({ tilePx: 5.588053385416667, ox: 205.95263671875, oy: 187.984375 });
    // The actual capture sequence: Whole board, excursion, then public zoom and pan.
    camera.reset();
    camera.zoomAt(1.2, desktop.width / 2, desktop.height / 2);
    camera.panBy(24, 16);
    expect(camera.view).not.toEqual(initial);
    camera.zoomAt(initial.tilePx / camera.view.tilePx, desktop.width / 2, desktop.height / 2);
    camera.panBy(initial.ox - camera.view.ox, initial.oy - camera.view.oy);
    // Before the fix: ox 55.80952380952408, tilePx 8.095238095238093.
    // Zoom roundoff defeated the opening exemption and clamped the right edge by 8.38px.
    expect(camera.view).toEqual(initial);
    expect(camera.homeView()).toEqual(initial);
    expect(camera.atHome()).toBe(true);
  });

  it("keeps ordinary pan/zoom clamps and removes the exception when opening ends", () => {
    const { full, camera: makeCamera } = fixture(mapId);
    const camera = makeCamera(), normal = makeCamera();
    camera.setOpeningBounds(openingBounds(full));
    const initial = { ...camera.view };
    // A real move, even much smaller than a pixel, must not be treated as roundoff.
    camera.panBy(0.000001, 0);
    expect(camera.view).not.toEqual(initial);
    expect(camera.toScreen(full.setup.mapW, 0)[0]).toBeLessThanOrEqual(area.x1 + 1e-10);
    camera.zoomAt(0.000001, desktop.width / 2, desktop.height / 2);
    expect(camera.view).toEqual(initial);
    camera.setOpeningBounds(null);
    for (const input of [initial, { ...initial, ox: -10000 }, { ...initial, oy: 10000 },
      { ...initial, tilePx: normal.fit.tilePx / 2 }]) {
      camera.set(input); normal.set(input);
      expect(camera.view).toEqual(normal.view);
    }
  });
});
