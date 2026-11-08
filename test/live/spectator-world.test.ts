import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createSpectatorWorld, until } from "../../web/capture/spectator-world.ts";
import { openFeed } from "../../web/src/feed.ts";
import { openInviteStream } from "../../web/src/invite-stream.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { HEARTBEAT } from "../../src/live/hub.ts";

/** Verify the browser fixture's real transport/data before delegating rendered observations. */
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("two-origin browser spectator fixture", () => {
  it("keeps an attached private feed and its clock alive through the result and its final flush after revocation, then ends the stream without reconnecting", async () => {
    const world = await createSpectatorWorld();
    const intervals = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    let feed: ReturnType<typeof openFeed> | undefined;
    let drain: ReturnType<typeof setInterval> | undefined;
    let playbackTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const match = await world.start("private", true, 44);
      const invite = match.inviteToken!;
      let requests = 0, closes = 0, attached!: () => void;
      const connection = new Promise<void>(resolve => { attached = resolve; });
      let viewer: SpectatorState | undefined;
      const ticks: number[] = [];
      let sawFinalFrame = false, postResultHeartbeats = 0;
      feed = openFeed(`/watch/live/${match.lobbyId}`, () => Date.now(), () => {}, {
        source: path => {
          requests++;
          const stream = openInviteStream(path, invite, async (path, options) => {
            const response = await fetch(world.origins[0] + path, options);
            if (response.ok && response.body) {
              // Observe the real stream without prefetching or changing its backpressure.
              const getReader = response.body.getReader.bind(response.body);
              response.body.getReader = (() => {
                const reader = getReader(), read = reader.read.bind(reader), decoder = new TextDecoder();
                let text = "";
                reader.read = async () => {
                  const chunk = await read();
                  if (!chunk.done) {
                    text += decoder.decode(chunk.value, { stream: true });
                    for (let end; (end = text.indexOf("\n\n")) >= 0;) {
                      const frame = text.slice(0, end + 2); text = text.slice(end + 2);
                      if (frame.startsWith("data: ")) {
                        const message = decodeMessage(inflateRawSync(Buffer.from(frame.slice(6, -2), "base64")));
                        if (message.full?.result || message.events.some(event => event.kind === "end")) sawFinalFrame = true;
                      } else if (sawFinalFrame && frame === HEARTBEAT) postResultHeartbeats++;
                    }
                  }
                  return chunk;
                };
                return reader;
              }) as typeof response.body.getReader;
              attached();
            }
            return response;
          });
          const close = stream.close;
          stream.close = () => { closes++; close(); };
          return stream;
        },
        decode: async data => {
          // Model asynchronous browser worker preparation, retaining the real bounded feed.
          await new Promise(resolve => setTimeout(resolve, 30));
          return decodeMessage(inflateRawSync(Buffer.from(data, "base64")));
        },
      });
      drain = setInterval(() => {
        for (const { m } of feed!.take()) {
          if (m.full) viewer = new SpectatorState(m.full, m.tick, m.ants);
          else viewer!.apply(m);
          ticks.push(m.tick);
        }
      }, 16);
      await connection;
      await world.revoke(match.lobbyId);
      const refused = await fetch(`${world.origins[0]}/watch/live/${match.lobbyId}`, { headers: { "x-antwar-invite": invite } });
      expect(refused.status).toBe(404);
      await refused.body?.cancel();
      world.advance(match.untilReleaseMs() - 1);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ticks).toEqual([]);
      const playbackStartedAt = Date.now();
      await match.play();
      await until(() => !!viewer?.full.result);
      const writes = world.finalWrites.filter(write => write.lobbyId === match.lobbyId);
      expect(writes).toHaveLength(2); // The owner and the browser-facing proxy each wrote the result.
      expect(writes.map(write => write.origin)).toEqual([match.origin, world.origins[0]]);
      expect(writes.every(write => write.tick === match.finalTick && !write.full && write.writtenAt >= playbackStartedAt && write.writtenAt <= Date.now())).toBe(true);
      expect(writes[0]!.writtenAt).toBeLessThanOrEqual(writes[1]!.writtenAt);
      // The feed closes its stream once it has delivered the result, so it may stop reading before the
      // slot's 100 ms follow-up flush; the slot's two final flushes and its end are proven in watch-routes.test.ts.
      expect(closes).toBe(1);
      expect(postResultHeartbeats).toBeLessThanOrEqual(2);
      expect(ticks).toEqual(Array.from({ length: match.finalTick + 1 }, (_, tick) => tick));
      expect(match.finalTick).toBe(30);
      expect(viewer!.full.agents.map(agent => agent.identity?.displayName)).toEqual(world.displayNames);
      expect(viewer!.full.result!.ratingChanges).toHaveLength(2);
      const pacingCalls = () => intervals.mock.calls.flatMap((call, index) => call[1] === 100 ? [intervals.mock.results[index]!.value as ReturnType<typeof setInterval>] : []);
      expect(pacingCalls()).toHaveLength(1);
      playbackTimer = pacingCalls()[0];
      await match.play(); // Repeated playback must reuse the fixture's clock, not double its rate.
      expect(pacingCalls()).toEqual([playbackTimer]);
      // The slot has ended the finished stream: past openLive's 3 s reopen delay nothing reconnects to it,
      // and no further heartbeat arrives.
      await new Promise(resolve => setTimeout(resolve, 3_500));
      expect(ticks).toEqual(Array.from({ length: match.finalTick + 1 }, (_, tick) => tick));
      expect(feed.inbox.dropped).toBe(0);
      expect(requests).toBe(1);
      expect(closes).toBe(1);
      expect(postResultHeartbeats).toBeLessThanOrEqual(2);
      const replay = await world.recording(match.lobbyId);
      const path = `${world.origins[0]}/watch/replays/${match.lobbyId}/${replay}`;
      const old = await fetch(path, { headers: { "x-antwar-invite": invite } });
      expect(old.status).toBe(404); await old.body?.cancel();
      const fresh = await world.renew(match.lobbyId);
      const recording = await fetch(path, { headers: { "x-antwar-invite": fresh } });
      expect(recording.status).toBe(200);
      expect(recording.headers.get("cache-control")).toBe("no-store");
      expect((await recording.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(world.finalWrites).toHaveLength(2); // Finite recording downloads are not live result writes.
    } finally {
      clearInterval(drain); feed?.link.close();
      try {
        await world.close();
        if (playbackTimer !== undefined) expect(clear).toHaveBeenCalledWith(playbackTimer);
      } finally { intervals.mockRestore(); clear.mockRestore(); }
    }
  }, 45_000);

  it("delivers real seated names and exact final ratings despite immediate slot reuse", async () => {
    const world = await createSpectatorWorld();
    const abort = new AbortController();
    try {
      // Seed 44 draws Twin Shields, which keeps the fixture's short match; 42 draws Wide Plain's 36,000 ticks.
      const original = await world.start("public", true, 44);
      const response = await fetch(`${world.origins[1]}/watch/live/${original.lobbyId}`, { signal: abort.signal });
      expect(response.status).toBe(200);
      const newer = await world.start("public", false, 43);
      expect(newer.lobbyId).not.toBe(original.lobbyId);
      world.advance(301000);
      const reader = response.body!.getReader();
      let text = "", viewer: SpectatorState | undefined;
      while (!viewer?.full.result) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Fixture ended without result");
        text += new TextDecoder().decode(chunk.value);
        let end: number;
        while ((end = text.indexOf("\n\n")) >= 0) {
          const event = text.slice(0, end); text = text.slice(end + 2);
          const encoded = /^data: (.+)$/m.exec(event)?.[1];
          if (!encoded) continue;
          const message = decodeMessage(inflateRawSync(Buffer.from(encoded, "base64")));
          if (message.full) viewer = new SpectatorState(message.full, message.tick, message.ants);
          else viewer!.apply(message);
        }
      }
      await reader.cancel();
      expect(viewer.full.agents.map(agent => agent.identity?.displayName)).toEqual(world.displayNames);
      expect(viewer.full.agents.every(agent => agent.identity?.elo === 1500)).toBe(true);
      expect(viewer.full.setup.rated).toBe(true);
      expect(viewer.full.result.ratingChanges).toHaveLength(2);
      expect(viewer.full.result.ratingChanges!.every(change => change.before === 1500)).toBe(true);
      expect(viewer.tick).toBe(original.finalTick);
      expect(await world.recording(original.lobbyId)).toMatch(/^1970-/);
      const cursor = world.finalWrites.length, attachedAt = Date.now();
      const late = await fetch(`${world.origins[1]}/watch/live/${original.lobbyId}`, { signal: abort.signal });
      expect(late.status).toBe(200);
      await until(() => world.finalWrites.length === cursor + 2);
      const writes = world.finalWrites.slice(cursor);
      expect(writes.map(write => write.origin)).toEqual([original.origin, world.origins[1]]);
      expect(writes.every(write => write.full && write.tick === original.finalTick && write.writtenAt >= attachedAt)).toBe(true);
      expect(writes[0]!.requestId).not.toBe(world.finalWrites[0]!.requestId);
      await late.body?.cancel();
    } finally { abort.abort(); await world.close(); }
  }, 90_000);
});
