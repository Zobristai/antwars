import { randomBytes } from "node:crypto";
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { Lobby } from "../../src/lobby/lobbies.ts";
import { RELAY_END_GRACE_MS, RELAY_LIMITS, RELAY_MAX_MS, watchRoutes } from "../../src/live/watch-routes.ts";
import { RELAY_HEADER, relayKey, verifyRelay } from "../../src/live/relay-signature.ts";
import type { CapLimits } from "../../src/net/admission.ts";
import { openInviteStream } from "../../web/src/invite-stream.ts";
import { openLive, type LinkState } from "../../web/src/stream.ts";
import type { StreamMessage } from "../../src/live/format.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createPrivateArchive } from "../../src/replays/private-archive.ts";
import { HEARTBEAT, LiveHub } from "../../src/live/hub.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import { decodeData, ManualClock } from "./helpers.ts";
import { holdMatch, memoryWatchStore } from "./watch-fixtures.ts";

import { playable } from "../playable.ts";
const id = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const replayId = "2026-10-20T10-00-00-000Z-1";
const close: (() => void | Promise<void>)[] = [];
/** Responses of streams a test holds open: fetch cancels a Response that is garbage-collected, which would close its stream mid-test. */
const held: Response[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); held.length = 0; });
function lobby(lobbyId: string, kind: "public" | "private", rated = true): Lobby {
  return { id: lobbyId, kind, size: 1, state: "holding", rated, slot: `${kind}-0`, creatorId: "a", createdAt: 0, expiresAt: 1000,
    colonies: [[{ id: "a", displayName: "alice" }], [{ id: "b", displayName: "bob" }]], startsAt: 0, outcome: null, mode: null };
}
/** Relay caps and signing keys: the entry (gateway) signs, the slot (owner) verifies. */
interface RelayOptions { readonly relayLimits?: CapLimits; readonly gatewayKey?: Uint8Array; readonly ownerKey?: Uint8Array }
async function fixture(kind: "public" | "private", rated = true, relayMaxMs?: number, relay: RelayOptions = {}) {
  const { docs, store } = memoryWatchStore(); const registry = createWatchRegistry(store);
  for (const lobbyId of [id, second]) holdMatch(docs, lobbyId, "run");
  const lobbies = new Map([[id, lobby(id, kind, rated)]]);
  const streams: { origin: string; writes: string[]; endedAfter: number | null; closed: Promise<void> }[] = [];
  let invite = "current";
  const accounts = { lobbies: {
    readLobby: async (key: string) => lobbies.has(key) ? { ok: true, value: lobbies.get(key)! } : { ok: false, reason: "no_such_lobby" },
    listPublic: async () => [...lobbies.values()].filter(row => row.kind === "public"),
    resolveSlot: async () => ({ runId: "run", mcpUrl: "", spectatorUrl: "" }),
    isInviteCurrent: async (key: string, token: string) => key === id && token === invite,
  }, ratings: {
    // The catalog reads each seat's rating in a ranked match's mode.
    readRating: async (identityId: string) => ({ rating: identityId === "a" ? 1612.4 : 1490, rd: 80, ratedMatches: 12 }),
  } } as unknown as AccountStores;
  const clock = new ManualClock();
  const owner = new LiveHub({ clock, currentInvite: accounts.lobbies.isInviteCurrent, relayKey: relay.ownerKey });
  /** The relay signature each request to the slot's /watch/live carried. */
  const relaySignatures: (string | undefined)[] = [];
  const gateway = new LiveHub(); close.push(() => owner.close(), () => gateway.close());
  const blobs = new Map<string, Uint8Array>();
  const archive = createPrivateArchive({ create: async object => { blobs.set(object.name, object.body); } },
    async name => blobs.has(name) ? { body: Readable.from([blobs.get(name)!]) } : null, new Uint8Array(32).fill(7));
  async function listener(hub: LiveHub) {
    let origin = "";
    let handle: ReturnType<typeof watchRoutes> | undefined;
    const server: Server = createServer((req, res) => {
      if (req.url === `/watch/live/${id}`) {
        if (hub === owner) relaySignatures.push(req.headers[RELAY_HEADER] as string | undefined);
        const stream = { origin, writes: [] as string[], endedAfter: null as number | null, closed: new Promise<void>(resolve => res.once("close", () => resolve())) }; streams.push(stream);
        const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
        res.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          stream.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return write(chunk, ...rest);
        }) as ServerResponse["write"];
        // How many writes preceded a clean end; a write after it would leave this behind writes.length.
        const end = res.end.bind(res) as (...rest: unknown[]) => ServerResponse;
        res.end = ((...rest: unknown[]) => {
          stream.endedAfter ??= stream.writes.length;
          return end(...rest);
        }) as ServerResponse["end"];
      }
      // One handler per server, as the server mounts it, built once the origin is known.
      handle ??= watchRoutes({ accounts, registry, hub, archive, origin, relayMaxMs, relayLimits: relay.relayLimits, relayKey: hub === owner ? relay.ownerKey : relay.gatewayKey });
      void handle(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return origin;
  }
  const ownerOrigin = await listener(owner), gatewayOrigin = await listener(gateway);
  await registry.register({ lobbyId: id, visibility: kind, rated, startedAt: 0, origin: ownerOrigin, slot: `${kind}-0`, runId: "run" });
  const initial = createMatch(33, playable({ ...rulesConfig("redesign"), matchTicks: 2 }));
  owner.startMatch(1, initial, { lobbyId: id, visibility: kind, rated });
  let state = initial;
  while (!state.result) { const out = step(state, []); clock.advance(100); owner.pushTick(1, out); state = out.state; }
  return { registry, accounts, archive, blobs, owner, clock, lobbies, streams, ownerOrigin, gatewayOrigin, relaySignatures, revoke: () => { invite = "fresh"; } };
}
function request(origin: string, path: string, invite?: string) {
  const abort = new AbortController(); close.push(() => abort.abort());
  return fetch(origin + path, { signal: abort.signal, headers: invite ? { "x-antwar-invite": invite } : {} });
}

describe("shared spectator HTTP routes", () => {
  it.each([
    ["public", true], ["public", false], ["private", true], ["private", false],
  ] as const)("preserves immediate and delayed final heartbeats, then ends, for attached and late %s rated=%s owner/proxy viewers", async (kind, rated) => {
    const f = await fixture(kind, rated), invite = kind === "private" ? "current" : undefined;
    const attached = await Promise.all([f.ownerOrigin, f.gatewayOrigin].map(origin => request(origin, `/watch/live/${id}`, invite)));
    f.clock.advance((rated ? 300_000 : 60_000) + 1000);
    // The final data, both final-flush heartbeats, then a clean end: nothing else, and no end before them.
    async function throughResult(response: Response) {
      expect(response.status).toBe(200);
      const reader = response.body!.getReader(); close.push(() => reader.cancel().then(() => {}));
      let pending = "", final = false, comments = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (comments < 2) throw new Error("Stream closed without final result and heartbeat");
          expect(pending).toBe("");
          return;
        }
        pending += new TextDecoder().decode(chunk.value);
        for (let end; (end = pending.indexOf("\n\n")) >= 0;) {
          const frame = pending.slice(0, end + 2); pending = pending.slice(end + 2);
          if (comments === 2) throw new Error(`Written after the final flush: ${frame}`);
          if (final) { expect(frame).toBe(HEARTBEAT); comments++; continue; }
          if (frame.startsWith("data: ")) {
            const message = decodeData(frame.slice(6, -2));
            final = !!message.full?.result || message.events.some(event => event.kind === "end");
          }
        }
      }
    }
    await Promise.all(attached.map(throughResult));
    const late = await Promise.all([f.ownerOrigin, f.gatewayOrigin].map(origin => request(origin, `/watch/live/${id}`, invite)));
    f.clock.advance(99);
    // Opening comment, full result frame, immediate heartbeat; not yet ended.
    const lateOwners = () => f.streams.filter(stream => stream.origin === f.ownerOrigin).slice(2);
    expect(lateOwners().every(stream => stream.writes.length === 3 && stream.endedAfter === null)).toBe(true);
    f.clock.advance(1);
    await Promise.all(late.map(throughResult));
    // Heartbeats would resume here if the responses were still open.
    f.clock.advance(2 * DEFAULT_LIVE_CONFIG.heartbeatMs);
    const owners = f.streams.filter(stream => stream.origin === f.ownerOrigin);
    expect(owners).toHaveLength(4);
    for (const stream of owners) {
      expect(stream.writes.at(-1)).toBe(HEARTBEAT);
      const finalIndex = stream.writes.findIndex(frame => frame.startsWith("data: ") && (() => {
        const message = decodeData(frame.slice(6, -2));
        return !!message.full?.result || message.events.some(event => event.kind === "end");
      })());
      expect(finalIndex).toBeGreaterThanOrEqual(0);
      expect(stream.writes.slice(finalIndex + 1)).toEqual([HEARTBEAT, HEARTBEAT]);
      expect(stream.endedAfter).toBe(stream.writes.length);
    }
    // The proxy forwards the owner's bytes; it introduces no additional flush frame, and ends when the slot ends.
    const proxies = f.streams.filter(stream => stream.origin === f.gatewayOrigin);
    expect(proxies.map(stream => stream.writes.join(""))).toEqual([owners[0]!.writes.join(""), owners[2]!.writes.join("")]);
    expect(proxies.every(stream => stream.endedAfter === stream.writes.length)).toBe(true);
    await Promise.all(f.streams.map(stream => stream.closed));
    expect(owners.slice(2).every(stream => stream.writes.length === 4)).toBe(true);
  });

  it("discovers the owner from another instance and forwards only the rated delayed stream", async () => {
    const f = await fixture("public");
    const catalog = await (await request(f.gatewayOrigin, "/watch/catalog")).json();
    // An unrated-mode registration (no ranked mode) names the seats without ratings.
    expect(catalog.matches).toEqual([{ lobbyId: id, rated: true, startedAt: 0, delaySeconds: 300, colonies: [
      [{ displayName: "alice", rating: null, rd: null, ratedMatches: null }], [{ displayName: "bob", rating: null, rd: null, ratedMatches: null }],
    ] }]);
    expect(JSON.stringify(catalog)).not.toContain(f.ownerOrigin);
    const response = await request(f.gatewayOrigin, `/watch/live/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader(); close.push(() => reader.cancel().then(() => {}));
    const first = (async () => {
      let text = "";
      while (!text.includes("data:")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream ended before its first data frame");
        text += new TextDecoder().decode(chunk.value);
      }
      return text;
    })();
    let received = false; void first.then(() => { received = true; });
    f.clock.advance(299000);
    await new Promise(resolve => setImmediate(resolve));
    expect(received).toBe(false);
    f.clock.advance(2000);
    expect(await first).toContain("data:");
  });

  it.each([
    ["rated", true], ["unrated", false],
  ] as const)("answers a viewer without an invite through the proxy with stream bytes at once during the %s delay", async (_, rated) => {
    const f = await fixture("public", rated);
    // The spectator clock never moves: no delayed frame is released and no 15 s heartbeat is due.
    const response = await request(f.gatewayOrigin, `/watch/live/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = response.body!.getReader(); close.push(() => reader.cancel().then(() => {}));
    let timer: NodeJS.Timeout | undefined;
    // Well inside the proxy's 10 s upstream-header limit.
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("no stream bytes within 3 s")), 3_000); });
    try {
      const first = await Promise.race([reader.read(), deadline]);
      expect(new TextDecoder().decode(first.value)).toBe(HEARTBEAT);
    } finally { clearTimeout(timer); }
    expect(f.streams.filter(stream => stream.origin === f.ownerOrigin).map(stream => stream.writes)).toEqual([[HEARTBEAT]]);
  });

  it("hides private matches and checks the current invite on each new proxy attachment", async () => {
    const f = await fixture("private");
    expect(await (await request(f.gatewayOrigin, "/watch/catalog")).json()).toEqual({ matches: [], lobbies: [] });
    expect((await request(f.gatewayOrigin, `/watch/live/${id}`)).status).toBe(404);
    const response = await request(f.gatewayOrigin, `/watch/live/${id}`, "current");
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); close.push(() => reader.cancel().then(() => {}));
    f.revoke();
    expect((await request(f.gatewayOrigin, `/watch/live/${id}`, "current")).status).toBe(404);
    expect((await request(f.gatewayOrigin, `/watch/status/${id}`, "fresh")).status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(HEARTBEAT);
    f.clock.advance(301000);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data:");
  });

  it("serves encrypted private recordings only with the current invite and without public cache headers", async () => {
    const f = await fixture("private");
    await f.archive.forLobby(id).create({ name: `${replayId}.bin`, body: gzipSync(Buffer.from("recording")), contentType: "application/octet-stream", contentEncoding: "gzip", ifGenerationMatch: 0 });
    expect(await (await request(f.gatewayOrigin, `/watch/recording/${id}`, "current")).json()).toEqual({ replayId: null });
    await f.registry.playbackFinished(id, "run"); await f.registry.replaySaved(id, "run", replayId);
    expect((await request(f.gatewayOrigin, `/watch/recording/${id}`)).status).toBe(404);
    expect(await (await request(f.gatewayOrigin, `/watch/recording/${id}`, "current")).json()).toEqual({ replayId });
    expect([...f.blobs.keys()].every(key => key.startsWith("private/v1/") && key.endsWith(".sealed"))).toBe(true);
    const path = `/watch/replays/${id}/${replayId}`;
    expect((await request(f.gatewayOrigin, path)).status).toBe(404);
    const response = await request(f.gatewayOrigin, path, "current");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("recording");
    f.revoke();
    expect((await request(f.gatewayOrigin, path, "current")).status).toBe(404);
    expect(await (await request(f.gatewayOrigin, path, "fresh")).text()).toBe("recording");
  });

  it("streams a private recording above 32 MiB chunked to a current invite and still refuses without one", async () => {
    const f = await fixture("private");
    // A recording is gzip bytes; random input keeps them above Cloud Run's 32 MiB fixed-length response limit.
    const stored = gzipSync(randomBytes(33 * 1024 * 1024), { level: 1 });
    expect(stored.length).toBeGreaterThan(32 * 1024 * 1024);
    await f.archive.forLobby(id).create({ name: `${replayId}.bin`, body: stored, contentType: "application/octet-stream", contentEncoding: "gzip", ifGenerationMatch: 0 });
    await f.registry.playbackFinished(id, "run"); await f.registry.replaySaved(id, "run", replayId);
    const path = `/watch/replays/${id}/${replayId}`;
    expect((await request(f.gatewayOrigin, path)).status).toBe(404);
    // Raw HTTP: fetch would decode the gzip body and hide the framing headers.
    const response = await new Promise<IncomingMessage>((resolve, reject) =>
      get(f.gatewayOrigin + path, { headers: { "x-antwar-invite": "current" } }, resolve).once("error", reject));
    const chunks: Buffer[] = []; for await (const chunk of response) chunks.push(chunk as Buffer);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["transfer-encoding"]).toBe("chunked");
    expect(Buffer.concat(chunks).equals(stored)).toBe(true);
    f.revoke();
    expect((await request(f.gatewayOrigin, path, "current")).status).toBe(404);
  }, 60_000);

  it.each(["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const)("reports zero delay for a %s lobby before registration and after playback finishes", async mode => {
    const f = await fixture("public");
    f.lobbies.set(second, { ...lobby(second, "public"), mode });
    expect(await (await request(f.gatewayOrigin, `/watch/status/${second}`)).json()).toEqual({
      lobbyId: second, started: false, playbackFinished: false, delaySeconds: 0,
    });
    await f.registry.register({ lobbyId: second, visibility: "public", rated: true, mode, startedAt: 0,
      origin: f.ownerOrigin, slot: "public-0", runId: "run" });
    const catalog = await (await request(f.gatewayOrigin, "/watch/catalog")).json();
    // Each seat with its rating, RD and rated-match count in the match's mode, and the Model Index match's harness phase
    // by its start (here time 0, before every boundary).
    expect(catalog.matches).toContainEqual({ lobbyId: second, rated: true, startedAt: 0, delaySeconds: 0, colonies: [
      [{ displayName: "alice", rating: 1612.4, rd: 80, ratedMatches: 12 }], [{ displayName: "bob", rating: 1490, rd: 80, ratedMatches: 12 }],
    ], harnessPhase: { phase: "rounds 1-7", possibleEffortMismatch: true, pinBoundaryOpen: false } });
    await f.registry.playbackFinished(second, "run");
    expect(await (await request(f.gatewayOrigin, `/watch/status/${second}`)).json()).toEqual({
      lobbyId: second, started: true, playbackFinished: true, delaySeconds: 0,
    });
  });

  it("reports waiting from feed registration, not the past countdown, without disclosing picks or outcomes", async () => {
    const f = await fixture("public"); f.lobbies.set(second, lobby(second, "public"));
    expect(await (await request(f.gatewayOrigin, `/watch/status/${second}`)).json()).toEqual({ lobbyId: second, started: false, playbackFinished: false, delaySeconds: 300 });
    expect((await request(f.gatewayOrigin, "/watch/status/..%2f..%2fother")).status).toBe(404);
  });

  it.each([["ended", true], ["expired", true], ["open", false], ["waiting", false]] as const)("reports a %s lobby with no stream as finished %s, so only a lobby that can still start keeps its link waiting", async (state, finished) => {
    const f = await fixture("public"); f.lobbies.set(second, { ...lobby(second, "public"), state, startsAt: null, slot: null });
    expect(await (await request(f.gatewayOrigin, `/watch/status/${second}`)).json()).toEqual({
      lobbyId: second, started: finished, playbackFinished: finished, delaySeconds: 300,
    });
  });

  it("names a team seat held twice by its stream name, reads its rating once, and lists a match whose lobby is gone without seats", async () => {
    const f = await fixture("public");
    const reads: string[] = [];
    const ratings = f.accounts.ratings as unknown as { readRating: (identityId: string, mode?: string) => Promise<unknown> };
    const read = ratings.readRating;
    ratings.readRating = async (identityId, mode) => { reads.push(`${identityId}:${mode}`); return read(identityId, mode); };
    f.lobbies.set(second, { ...lobby(second, "public"), size: 2, mode: "2v2",
      colonies: [[{ id: "a", displayName: "alice" }, { id: "a", displayName: "alice" }], [{ id: "b", displayName: "bob" }, { id: "c", displayName: "antwars/gpt-6-luna" }]] });
    await f.registry.register({ lobbyId: second, visibility: "public", rated: true, mode: "2v2", startedAt: 5, origin: f.ownerOrigin, slot: "public-0", runId: "run" });
    const third = "00000000-0000-4000-8000-000000000003";
    await f.registry.register({ lobbyId: third, visibility: "public", rated: true, mode: "1v1", startedAt: 9, origin: f.ownerOrigin, slot: "public-0", runId: "run" });
    const catalog = await (await request(f.gatewayOrigin, "/watch/catalog")).json();
    expect(catalog.matches.find((match: { lobbyId: string }) => match.lobbyId === second).colonies).toEqual([
      [{ displayName: "alice #1", rating: 1612.4, rd: 80, ratedMatches: 12 }, { displayName: "alice #2", rating: 1612.4, rd: 80, ratedMatches: 12 }],
      [{ displayName: "bob", rating: 1490, rd: 80, ratedMatches: 12 }, { displayName: "antwars/gpt-6-luna", rating: 1490, rd: 80, ratedMatches: 12 }],
    ]);
    expect(reads.sort()).toEqual(["a:2v2", "b:2v2", "c:2v2"]);
    expect(catalog.matches.find((match: { lobbyId: string }) => match.lobbyId === third).colonies).toEqual([[], []]);
  });
});

describe("relayed live stream lifetime", () => {
  /** Rated delayed playback (300 s) has released the opening snapshot of the fixture's match but not its result. */
  const PRE_RESULT_MS = 299_950;
  async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); });
    try { return await Promise.race([promise, deadline]); } finally { clearTimeout(timer); }
  }
  const relayed = (f: Awaited<ReturnType<typeof fixture>>) => ({
    owner: f.streams.filter(stream => stream.origin === f.ownerOrigin), gateway: f.streams.filter(stream => stream.origin === f.gatewayOrigin),
  });

  it("closes the relay and its slot fetch as soon as the viewer's connection closes", async () => {
    // The production bound: only the viewer's close can end this stream within the test.
    const f = await fixture("public");
    const abort = new AbortController(); close.push(() => abort.abort());
    const response = await fetch(`${f.gatewayOrigin}/watch/live/${id}`, { signal: abort.signal });
    expect(new TextDecoder().decode((await response.body!.getReader().read()).value)).toBe(HEARTBEAT);
    const { owner, gateway } = relayed(f);
    expect([owner.length, gateway.length]).toEqual([1, 1]);
    abort.abort();
    await within(Promise.all([gateway[0]!.closed, owner[0]!.closed]), 2_000, "viewer close ends the relay and the slot stream");
  });

  it(`ends a relayed stream cleanly at its bound (${RELAY_MAX_MS} ms in production) while a viewer that never closes keeps reading`, async () => {
    const f = await fixture("public", true, 300);
    f.clock.advance(301_000);
    const started = Date.now();
    const response = await request(f.gatewayOrigin, `/watch/live/${id}`);
    const reader = response.body!.getReader();
    let text = "";
    // A clean end resolves done; a destroyed response would reject the read instead.
    await within((async () => { for (let chunk; !(chunk = await reader.read()).done;) text += new TextDecoder().decode(chunk.value); })(), 2_000, "relay ends at its bound");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(text.startsWith(HEARTBEAT)).toBe(true);
    expect(text).toContain("data:");
    await within(relayed(f).owner[0]!.closed, 2_000, "slot stream closes at the bound");
  });

  it("still closes the relay within the bound plus its end grace when the frontend stops reading", async () => {
    const f = await fixture("public");
    let cancelled = false;
    // One upstream chunk far larger than socket buffers, then an upstream that never ends.
    const upstream = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024).fill(58)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const hub = new LiveHub(); close.push(() => hub.close());
    let closed!: Promise<void>;
    const server = createServer((req, res) => {
      closed = new Promise(resolve => res.once("close", () => resolve()));
      void watchRoutes({ accounts: f.accounts, registry: f.registry, hub, origin: "http://gateway.test", relayMaxMs: 100, request: (async () => upstream()) as typeof fetch })(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    close.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const viewer = get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/watch/live/${id}`, response => {
        expect(response.statusCode).toBe(200);
        response.pause(); response.on("error", () => {}); resolve();
      });
      viewer.on("error", () => {}); close.push(() => { viewer.destroy(); });
      setTimeout(() => reject(new Error("no response headers")), 2_000);
    });
    await within(closed, 100 + RELAY_END_GRACE_MS + 1_000, "non-reading viewer's relay closes");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(cancelled).toBe(true);
  });

  it("resumes the same lobby's stream in the browser client when the bound ends it before the result", async () => {
    const f = await fixture("private", true, 300);
    // Delayed playback has released the opening snapshot but not the result (a drop before the result reconnects).
    f.clock.advance(PRE_RESULT_MS);
    const states: LinkState[] = [];
    const delivered: StreamMessage[] = [];
    const link = openLive(`/watch/live/${id}`, m => { delivered.push(m); }, state => states.push(state), {
      source: path => openInviteStream(path, "current", ((url, init) => fetch(f.gatewayOrigin + String(url), init)) as typeof fetch),
    });
    close.push(() => link.close());
    await within((async () => { while (delivered.length < 2) await new Promise(resolve => setTimeout(resolve, 20)); })(), 8_000, "second connection delivers data");
    expect(delivered.some(m => m.full?.result || m.events.some(event => event.kind === "end"))).toBe(false);
    // The listener records only /watch/live/<this lobby>: a second relayed stream is the same lobby reopened.
    expect(relayed(f).gateway.length).toBeGreaterThanOrEqual(2);
    expect(states.slice(0, 5)).toEqual(["connecting", "open", "reconnecting", "connecting", "open"]);
  }, 15_000);

  it("closes the browser client's stream once it has a finished match's result, and does not reconnect when the slot ends it", async () => {
    const f = await fixture("private");
    f.clock.advance(301_000);
    const states: LinkState[] = [];
    const delivered: StreamMessage[] = [];
    let requests = 0;
    const link = openLive(`/watch/live/${id}`, m => { delivered.push(m); }, state => states.push(state), {
      source: path => { requests++; return openInviteStream(path, "current", ((url, init) => fetch(f.gatewayOrigin + String(url), init)) as typeof fetch); },
    });
    close.push(() => link.close());
    await within((async () => { while (delivered.length < 1) await new Promise(resolve => setTimeout(resolve, 20)); })(), 4_000, "result delivered");
    expect(delivered[0]!.full?.result).toBeTruthy();
    // The slot's final follow-up heartbeat, then its end, which the relay passes on.
    f.clock.advance(100);
    const { owner, gateway } = relayed(f);
    await within(Promise.all([owner[0]!.closed, gateway[0]!.closed]), 2_000, "slot and relay end the finished stream");
    // Past openLive's 3 s reopen delay and the browser's default retry.
    await new Promise(resolve => setTimeout(resolve, 3_500));
    expect(requests).toBe(1);
    expect(relayed(f).gateway).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(states).toEqual(["connecting", "open"]);
  }, 15_000);
});

describe("live relay caps and signing", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  // Test-only keys; documentation-range viewer addresses.
  const KEY = relayKey(Buffer.alloc(32, 7))!;
  const WRONG_KEY = relayKey(Buffer.alloc(32, 9))!;
  async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  /** One viewer of the lobby's live stream through origin, from a viewer address; a 200 stays open until closed. */
  async function viewer(origin: string, address?: string) {
    const abort = new AbortController(); close.push(() => abort.abort());
    const res = await fetch(`${origin}/watch/live/${id}`, { signal: abort.signal, headers: address === undefined ? {} : { "x-forwarded-for": address } });
    if (res.status !== 200) await res.body?.cancel(); else held.push(res);
    return { status: res.status, retryAfter: res.headers.get("retry-after"), headers: res.headers, close: () => abort.abort() };
  }
  const gatewayStreams = (f: Awaited<ReturnType<typeof fixture>>) => f.streams.filter(stream => stream.origin === f.gatewayOrigin);

  it("caps the entry's live relays per server and per viewer source, refusing past either with a retryable 503", async () => {
    expect(RELAY_LIMITS).toEqual({ max: 512, perSource: 16 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await fixture("public", true, undefined, { relayLimits: { max: 3, perSource: 2 } });
    const first = await viewer(f.gatewayOrigin, "192.0.2.1");
    expect((await viewer(f.gatewayOrigin, "203.0.113.9, 192.0.2.1")).status).toBe(200);
    const sameSource = await viewer(f.gatewayOrigin, "192.0.2.1");
    expect([sameSource.status, sameSource.retryAfter]).toEqual([503, "1"]);
    expect((await viewer(f.gatewayOrigin, "192.0.2.2")).status).toBe(200);
    const full = await viewer(f.gatewayOrigin, "192.0.2.3");
    expect([full.status, full.retryAfter]).toEqual([503, "1"]);
    // A refused viewer reaches no slot; a closed relay frees its place.
    expect(f.relaySignatures).toHaveLength(3);
    first.close();
    await gatewayStreams(f)[0]!.closed;
    expect((await viewer(f.gatewayOrigin, "192.0.2.3")).status).toBe(200);
  });

  it("signs each relay, so the slot admits relayed viewers past its per-source bound and counts them toward its cap", async () => {
    const f = await fixture("public", true, undefined, { gatewayKey: KEY, ownerKey: KEY });
    // Seventeen viewers from seventeen addresses, all reaching the slot from the entry's one address.
    for (let i = 1; i <= 17; i += 1) expect((await viewer(f.gatewayOrigin, `192.0.2.${i}`)).status).toBe(200);
    expect(f.owner.spectatorCap.open).toBe(17);
    expect(f.relaySignatures).toHaveLength(17);
    for (const header of f.relaySignatures) expect(verifyRelay(KEY, id, header)).toBe(true);
  });

  it("during a key mismatch, the slot admits 16 relayed viewers per entry address and refuses the rest retryably, never for the signature alone; neither side logs or echoes the header or the key", async () => {
    const output: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
    }
    const f = await fixture("public", true, undefined, { gatewayKey: WRONG_KEY, ownerKey: KEY });
    const viewers = [];
    for (let i = 1; i <= 17; i += 1) viewers.push(await viewer(f.gatewayOrigin, `192.0.2.${i}`));
    expect(viewers.map(v => v.status)).toEqual([...Array<number>(16).fill(200), 503]);
    expect(f.owner.spectatorCap.open).toBe(16);
    // Every relay carried a signature, none valid here.
    expect(f.relaySignatures).toHaveLength(17);
    for (const header of f.relaySignatures) expect(verifyRelay(KEY, id, header)).toBe(false);
    // The slot's own refusal is the retryable one.
    const direct = await fetch(`${f.ownerOrigin}/watch/live/${id}`, { headers: { [RELAY_HEADER]: f.relaySignatures[0]! } });
    await direct.body?.cancel();
    expect([direct.status, direct.headers.get("retry-after")]).toEqual([503, "1"]);
    const secrets = [...f.relaySignatures as string[], ...f.relaySignatures.map(header => header!.split(".")[1]!),
      ...[KEY, WRONG_KEY].flatMap(key => [key.toString("hex"), key.toString("base64"), key.toString("base64url")])];
    const logged = output.join("\n");
    for (const secret of secrets) expect(logged).not.toContain(secret);
    for (const response of [...viewers, { headers: direct.headers }]) {
      expect(response.headers.has(RELAY_HEADER)).toBe(false);
      for (const [, value] of response.headers) for (const secret of secrets) expect(value).not.toContain(secret);
    }
  });

  it("shows a refused viewer's page reconnecting, then opens it once a place is free", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await fixture("private", true, undefined, { relayLimits: { max: 1, perSource: 1 } });
    const source = (path: string) => openInviteStream(path, "current", ((url, init) => fetch(f.gatewayOrigin + String(url), init)) as typeof fetch);
    const holderStates: LinkState[] = [], states: LinkState[] = [];
    const holder = openLive(`/watch/live/${id}`, () => {}, state => holderStates.push(state), { source });
    close.push(() => holder.close());
    await waitFor(() => holderStates.includes("open"), 4_000, "first viewer open");
    const refused = openLive(`/watch/live/${id}`, () => {}, state => states.push(state), { source });
    close.push(() => refused.close());
    await waitFor(() => states.includes("reconnecting"), 4_000, "refused viewer reconnecting");
    expect(states).toEqual(["connecting", "reconnecting"]);
    holder.close();
    await gatewayStreams(f)[0]!.closed;
    // openLive reopens a refused stream after 3 s.
    await waitFor(() => states.includes("open"), 6_000, "refused viewer opens once a place is free");
    expect(states.slice(0, 2)).toEqual(["connecting", "reconnecting"]);
    expect(states.at(-1)).toBe("open");
  }, 15_000);
});
