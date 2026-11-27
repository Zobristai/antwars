import { gunzipSync } from "node:zlib";
import { setImmediate } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { decodeMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { spectatorDelaySeconds } from "../../src/live/match-access.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { quadrantMatchMaps } from "../../src/sim/mapShapes.ts";
import { step } from "../../src/sim/step.ts";
import { createActivity } from "../../src/slots/activity.ts";
import { ManualClock } from "./helpers.ts";

// Public and house Free-for-all queues both start a canonical quadrants match.
it.each([
  { mode: "quadrants", rated: true }, { mode: "quadrants", rated: false },
  { mode: "1v1", rated: true }, { mode: "1v1", rated: false },
] as const)("$mode, rated $rated: playback publishes the natural finish and releases its hold", async ({ mode, rated }) => {
  const access = { lobbyId: "finish-playback", visibility: "public", mode, rated } as const;
  const clock = new ManualClock(), activity = createActivity(), objects = new Map<string, Uint8Array>();
  const changes = [{ agent: 0, before: 1500, after: 1516 }, { agent: 1, before: 1500, after: 1484 }];
  let committed = false;
  const resultRatings = vi.fn(async () => committed ? changes : null);
  const onReplaySaved = vi.fn();
  const hub = new LiveHub({ clock, activity, resultRatings, onReplaySaved,
    replayStore: { async create(object) { objects.set(object.name, object.body); } } });
  onTestFinished(() => hub.close());

  const quadrants = mode === "quadrants";
  const config = newMatchConfig(rulesConfig("redesign"));
  let state = createMatch(404, { ...config, matchTicks: 4,
    ...(quadrants ? { terrain: { ...config.terrain!, maps: quadrantMatchMaps() }, ffaTerritoryWinnerFirst: true } : {}) });
  expect(state.colonies).toHaveLength(quadrants ? 4 : 2);
  hub.startMatch(1, state, access);
  while (state.result === null) {
    const joins = state.tick === 0 ? state.colonies.map(({ id }) => ({ type: "join" as const, agentId: `seat-${id}`, placement: id })) : [];
    const out = step(state, joins);
    clock.advance(1000 / config.ticksPerSecond); hub.pushTick(1, out); state = out.state;
  }
  expect(state.result.reason).toBe("time_up");
  clock.advance(spectatorDelaySeconds(access) * 1000 - 1);
  expect(hub.watchStatus(access.lobbyId)?.playbackFinished).toBe(false);
  expect(activity.idle).toBe(false);
  expect(objects.size).toBe(0);
  clock.advance(1);
  await setImmediate(); // Let the result read settle and arm its retry, if applicable.
  if (rated && !quadrants) {
    expect(resultRatings).toHaveBeenCalledTimes(1);
    expect(hub.watchStatus(access.lobbyId)?.playbackFinished).toBe(false);
    expect(objects.size).toBe(0);
    expect(activity.idle).toBe(false);
    committed = true;
    clock.advance(1000);
    await setImmediate();
  }
  expect(hub.watchStatus(access.lobbyId)?.playbackFinished).toBe(true);
  await vi.waitFor(() => expect(activity.idle).toBe(true));
  expect(onReplaySaved).toHaveBeenCalledTimes(1);
  const [savedAccess, replayId] = onReplaySaved.mock.calls[0]!;
  expect(savedAccess).toEqual(access);
  const frames = unpackMessages(gunzipSync(objects.get(`${replayId}.bin`)!)).map(decodeMessage);
  expect(frames[0]!.full!.setup.rated).toBe(rated);
  const end = frames.at(-1)!.events.find(e => e.kind === "end");
  expect(end?.result).toMatchObject({ reason: state.result.reason, winner: state.result.winner, tick: state.result.tick });
  expect(end?.result.ratingChanges).toEqual(committed ? changes : undefined);
  clock.advance(10_000);
  expect(resultRatings).toHaveBeenCalledTimes(committed ? 2 : 0);
});
