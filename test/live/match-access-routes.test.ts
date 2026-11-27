import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveHub, type LiveHubOptions } from "../../src/live/hub.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import type { ReplayObject } from "../../src/replays/store.ts";
import { decodeData, ManualClock, RecordedServer } from "./helpers.ts";

import { playable } from "../playable.ts";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const opening = () => createMatch(25, playable({ ...rulesConfig("redesign"), matchTicks: 2 }));
async function fixture(options: LiveHubOptions = {}) {
  const clock = new ManualClock();
  const hub = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 }, playoutMs: 1, ...options });
  const server = new RecordedServer(hub, clock);
  await server.listen();
  cleanup.push(() => server.close(), () => hub.close());
  return { hub, clock, server };
}
async function attach(f: Awaited<ReturnType<typeof fixture>>, path: string, token?: string) {
  const abort = new AbortController(); cleanup.push(() => abort.abort());
  return fetch(f.server.url(path), { signal: abort.signal, headers: token ? { "x-antwar-invite": token } : {} });
}
function endMatch(f: Awaited<ReturnType<typeof fixture>>, seq: number) {
  let state = opening();
  while (!state.result) {
    const out = step(state, []);
    f.clock.advance(100);
    f.hub.pushTick(seq, out);
    state = out.state;
  }
}
const dataWrites = (f: Awaited<ReturnType<typeof fixture>>, path: string) => f.server.responses.find(response => response.path === path)!.writes.filter(write => write.text.startsWith("data:"));

describe("live route access and mandatory delay", () => {
  it.each([
    { mode: "1v1", rated: true }, { mode: "2v2", rated: true }, { mode: "3v3", rated: true }, { mode: "4v4", rated: true },
    { mode: null, rated: true }, { mode: null, rated: false },
  ] as const)("preserves the delay for mode $mode, rated $rated on numeric and stable routes despite local zero-delay config", async ({ mode, rated }) => {
    const f = await fixture();
    f.hub.startMatch(1, opening(), { lobbyId: "chosen", visibility: "public", rated, mode });
    const numeric = await attach(f, "/live/1");
    const selected = await attach(f, "/watch/live/chosen");
    expect(numeric.status).toBe(200); expect(selected.status).toBe(200);
    endMatch(f, 1);
    const delay = rated ? 300000 : 60000;
    f.clock.advance(delay - f.clock.now() - 1);
    expect(dataWrites(f, "/live/1")).toHaveLength(0);
    expect(dataWrites(f, "/watch/live/chosen")).toHaveLength(0);
    f.clock.advance(201);
    expect(dataWrites(f, "/live/1").length).toBeGreaterThan(0);
    expect(dataWrites(f, "/watch/live/chosen").length).toBeGreaterThan(0);
    expect(f.hub.watchStatus("chosen")).toEqual({ lobbyId: "chosen", started: true, playbackFinished: true, delaySeconds: rated ? 300 : 60 });
  });

  it.each(["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const)("%s serves its running board 300 seconds behind on every live route", async mode => {
    const f = await fixture();
    const initial = opening(), paths = ["/live/1", "/live/current", "/watch/live/house"];
    f.hub.startMatch(1, initial, { lobbyId: "house", visibility: "public", rated: false, mode });
    for (const path of paths) expect((await attach(f, path)).status).toBe(200);
    // The match has advanced enough ticks; the wall-clock floor still applies.
    const out = step(initial, []);
    f.hub.pushTick(1, { ...out, state: { ...out.state, tick: 300 * initial.config.ticksPerSecond } });
    f.clock.advance(299_999);
    for (const path of paths) expect(dataWrites(f, path)).toHaveLength(0);
    f.clock.advance(1);
    for (const path of paths) {
      const frames = dataWrites(f, path);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.t).toBe(300_000);
      expect(decodeData(frames[0]!.text.slice(6).trim()).tick).toBe(initial.tick);
    }
  });

  it("keeps private house admission and honors a larger configured delay", async () => {
    const f = await fixture({ config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 600 }, playoutMs: 100,
      currentInvite: async (_id, token) => token === "current" });
    f.hub.startMatch(1, opening(), { lobbyId: "secret", visibility: "private", rated: false, mode: "house-2v2" });
    const paths = ["/live/1", "/watch/live/secret"];
    for (const path of paths) {
      expect((await attach(f, path)).status).toBe(404);
      expect((await attach(f, path, "current")).status).toBe(200);
    }
    endMatch(f, 1);
    f.clock.advance(599_999 - f.clock.now());
    const frames = (path: string) => f.server.responses.filter(row => row.path === path).at(-1)!.writes.filter(w => w.text.startsWith("data:"));
    for (const path of paths) expect(frames(path)).toHaveLength(0);
    f.clock.advance(1);
    for (const path of paths) expect(frames(path)[0]?.t).toBe(600_000);
    expect(f.hub.currentSeq()).toBeNull();
  });

  it("excludes private streams from current/status and refuses numeric access without a current invite", async () => {
    const f = await fixture({ currentInvite: async (id, token) => id === "secret" && token === "current" });
    f.hub.startMatch(1, opening(), { lobbyId: "secret", visibility: "private", rated: true });
    expect(f.hub.currentSeq()).toBeNull();
    expect(await (await fetch(f.server.url("/live/status"))).json()).toEqual({ kind: "idle", match: null });
    expect((await attach(f, "/live/current", "current")).status).toBe(404);
    expect((await attach(f, "/live/1")).status).toBe(404);
    expect((await attach(f, "/watch/live/secret", "stale")).status).toBe(404);
    const granted = await attach(f, "/watch/live/secret", "current");
    expect(granted.status).toBe(200);
    expect(granted.headers.get("cache-control")).toContain("no-store");
  });

  it("revocation denies new requests but does not tear down an attached stream", async () => {
    let token = "initial";
    const f = await fixture({ currentInvite: async (_id, candidate) => token !== "" && candidate === token });
    f.hub.startMatch(1, opening(), { lobbyId: "secret", visibility: "private", rated: false });
    expect((await attach(f, "/watch/live/secret", "initial")).status).toBe(200);
    token = "";
    expect((await attach(f, "/live/1", "initial")).status).toBe(404);
    endMatch(f, 1); f.clock.advance(60000);
    expect(dataWrites(f, "/watch/live/secret").length).toBeGreaterThan(0);
    token = "fresh";
    expect((await attach(f, "/live/1", "fresh")).status).toBe(200);
  });

  it("retains the selected delayed match while the slot publishes a new one", async () => {
    const f = await fixture({ keepMatches: 1 });
    f.hub.startMatch(1, opening(), { lobbyId: "first", visibility: "public", rated: true });
    endMatch(f, 1);
    f.hub.startMatch(2, opening(), { lobbyId: "second", visibility: "public", rated: false });
    expect(f.hub.hasLobby("first")).toBe(true);
    expect((await attach(f, "/watch/live/first")).status).toBe(200);
    expect(f.hub.catalogMatches().map(match => match.lobbyId)).toEqual(["first", "second"]);
    expect(f.hub.currentSeq()).toBe(1);
  });

  it("never falls back to the public recording writer for private media", async () => {
    const objects: ReplayObject[] = [];
    const f = await fixture({ replayStore: { create: async object => { objects.push(object); } } });
    f.hub.startMatch(1, opening(), { lobbyId: "secret", visibility: "private", rated: false });
    endMatch(f, 1); f.clock.advance(60000);
    await new Promise(resolve => setImmediate(resolve));
    expect(objects).toEqual([]);
    expect(await (await fetch(f.server.url("/live/replays"))).json()).toEqual({ replays: [] });
  });

  it("fails closed when required metadata or the invite checker is unavailable", async () => {
    const f = await fixture({ requireMatchAccess: true, currentInvite: async () => { throw new Error("store down"); } });
    expect(() => f.hub.startMatch(1, opening())).toThrow("Match access metadata required");
    f.hub.startMatch(1, opening(), { lobbyId: "secret", visibility: "private", rated: false });
    expect((await attach(f, "/live/1", "invite")).status).toBe(503);
  });

  it("reports final playback only after its delayed end, not simulation end", async () => {
    const finished = vi.fn();
    const f = await fixture({ onPlaybackFinished: finished });
    f.hub.startMatch(1, opening(), { lobbyId: "first", visibility: "public", rated: true });
    endMatch(f, 1);
    expect(finished).not.toHaveBeenCalled();
    expect(f.hub.watchStatus("first")?.playbackFinished).toBe(false);
    f.clock.advance(300000);
    expect(finished).toHaveBeenCalledOnce();
    expect(f.hub.watchStatus("first")?.playbackFinished).toBe(true);
  });
});
