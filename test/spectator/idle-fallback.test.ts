import { deflateRawSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { playerLabel, ratingResultRows } from "../../web/src/compose.ts";
import type { Intake, IntakeTick } from "../../web/src/intake.ts";
import { modeCopy, setFallback } from "../../web/src/replay.ts";
import { CONNECT_MS, DROP_CHECKS, HANDOVER_KEY, LOBBY_STATUS_RECHECK_MS, openSource, type SpectatorSource } from "../../web/src/source.ts";
import { decodeData, type EventSourceLike } from "../../web/src/stream.ts";
import { STARTING_COPY } from "../../web/src/waiting.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { playScripted } from "../../src/live/record.ts";
import { excerpt } from "../../web/capture/excerpt.ts";

/** A result line as the HUDs show it (ratingResultRows): a seat's shown name and its rating change. */
const row = (name: string, text: string) => ({ name, badges: [] as string[], text });

const packets = unpackMessages(packMessages(scale2Packets(20)));
const firstTick = decodeMessage(packets[0]!).tick;
const bytes = new Uint8Array(packMessages(packets));
const older = "2026-10-17T13-58-00-000Z-99", newest = "2026-10-21T13-58-00-000Z-1";
const match = (lobbyId: string, delaySeconds: 0 | 60 | 300 = 60) => ({ lobbyId, startedAt: 1, rated: delaySeconds !== 60, delaySeconds });
class Source implements EventSourceLike {
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  readyState = 1;
  emit(packet: Uint8Array) { this.onmessage?.({ data: deflateRawSync(packet).toString("base64") } as MessageEvent<string>); }
  close() { this.readyState = 2; }
  drop() { this.readyState = 2; this.onerror?.(new Event("error")); }
}
const intake: Intake = {
  decode: async data => { const m = await decodeData(data); return { m, prepared: { m }, workerMs: 0 } as unknown as IntakeTick; },
  reset() {}, close() {},
};
function page(stored: Record<string, string> = {}) {
  const reload = vi.fn(), storage = new Map(Object.entries(stored));
  const view = Object.assign(new EventTarget(), {
    location: { reload, hash: "" },
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
  });
  const error = { textContent: "" }, state = { textContent: "Connecting…" };
  const doc = { title: "", defaultView: view, getElementById: (id: string) => id === "aw-recording-error" ? error : null,
    querySelector: (selector: string) => selector === ".aw-wait-state" ? state : null } as unknown as Document;
  return { doc, reload, storage, view, error, state };
}
function serve(initial: ReturnType<typeof match>[] = [], history: string[] = []) {
  const server = { matches: initial, history, catalogFailure: false, recordingFailure: false, paths: [] as string[], status: null as object | null,
    recording: bytes, ratings: { ratings: [] } as object | "fail" };
  vi.stubGlobal("fetch", async (path: string) => {
    server.paths.push(path);
    if (path.startsWith("/watch/status/")) return server.status ? Response.json(server.status) : new Response(null, { status: 404 });
    if (path === "/watch/catalog") {
      if (server.catalogFailure) throw new Error("offline");
      return Response.json({ matches: server.matches, lobbies: [] });
    }
    if (path === "/matches") return Response.json({ matches: server.history.map(id => ({ id })), nextPageToken: null });
    if (path.startsWith("/replays/")) return server.recordingFailure ? new Response(null, { status: 404 }) : new Response(server.recording);
    if (path.startsWith("/watch/ratings/")) return server.ratings === "fail" ? new Response(null, { status: 503 }) : Response.json(server.ratings);
    throw new Error(`Unexpected request ${path}`);
  });
  return server;
}
const active: SpectatorSource[] = [];
async function open(doc: Document, es = new Source(), emit = true, query = "") {
  const pending = openSource(new URLSearchParams(query), { now: () => 0 }, doc, vi.fn(), {
    source: () => { if (emit) queueMicrotask(() => es.emit(packets[0]!)); return es; }, intake,
  });
  const source = (await pending)!;
  if (source) active.push(source);
  return source;
}
afterEach(() => { active.splice(0).forEach(s => s.close()); setFallback(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("an empty catalog plays the newest stored recording with its own date, not the retired main match", async () => {
  const server = serve([], [newest, older]);
  const { doc, reload } = page();
  const source = await open(doc);
  expect([source.replay, source.recorded, source.feed, source.storedId]).toEqual([true, true, null, newest]);
  expect(source.head.tick).toBe(firstTick);
  expect(source.take(0).map(a => a.m.tick)).toEqual([firstTick]);
  expect(server.paths).toEqual(["/watch/catalog", "/matches", `/watch/ratings/${newest}`, `/replays/${newest}`]);
  expect(modeCopy("replay", 4, false, "/", source.storedId)).toEqual({ label: "RECORDING · no live match · 4 agents", detail: "21 Oct 2026", link: null });
  expect(reload).not.toHaveBeenCalled();
});

/** A pre-switch rated recording: Elo figures at match time, built as replay-ratings.test.ts does. */
function eloRecording() {
  // A tile-2 excerpt with two seated agents stands in for the bundled excerpt deleted, as in replay-ratings.test.ts.
  const messages = excerpt(playScripted({ seed: 5205, config: withGridScale(DEFAULT_CONFIG), agents: 2, ticks: 502, attack: true }).lines, 500, 502);
  const head = messages[0]!.full!;
  head.setup.rated = true;
  head.agents = head.agents.slice(0, 2);
  head.agents[0]!.identity = { displayName: "glm", elo: 1483.3 };
  head.agents[1]!.identity = { displayName: "deepseek", elo: 1486.6 };
  const last = messages.at(-1)!;
  last.events = [{ kind: "end", result: { winner: 0, reason: "overrun", decidedBy: "overrun", tick: last.tick - 1, nextStartMs: null,
    ratingChanges: [{ agent: 0, before: 1483.3, after: 1499.5 }, { agent: 1, before: 1486.6, after: 1470.4 }] } }];
  return new Uint8Array(packMessages(messages.map(encodeMessage)));
}
async function shown(source: SpectatorSource) {
  const out: StreamMessage[] = [];
  let real = 0;
  // Playback advances at most 250 ms of real time per take.
  await vi.waitFor(() => { out.push(...source.take(real += 250).map(arrival => arrival.m)); expect(out).toHaveLength(3); });
  const agents = out[0]!.full!.agents;
  const end = out.flatMap(m => m.events).find(event => event.kind === "end");
  return { labels: agents.map((agent, index) => playerLabel(index, agent)),
    result: ratingResultRows(out[0]!.full!.setup.rated, agents, end?.kind === "end" ? end.result : null) };
}
const recorded = { labels: ["glm · Rating 1483", "deepseek · Rating 1487"],
  result: [row("glm", "Rating 1483 → 1500 (+17)"), row("deepseek", "Rating 1487 → 1470 (-17)")] };

it.each([
  ["a stored record", { ratings: [{ displayName: "glm", before: 1512.25, after: 1561.75 }, { displayName: "deepseek", before: 1530.5, after: 1488 }] },
    { labels: ["glm · Rating 1512", "deepseek · Rating 1531"], result: [row("glm", "Rating 1512 → 1562 (+50)"), row("deepseek", "Rating 1531 → 1488 (-43)")] }],
  ["a failed lookup", "fail" as const, recorded],
  ["no stored record", { ratings: [] }, recorded],
])("an Elo-recorded stand-in with %s shows the stored figures where there are any, as a replay does", async (_case, ratings, expected) => {
  const server = serve([], [newest]);
  server.recording = eloRecording();
  server.ratings = ratings;
  const { doc, error } = page();
  const source = await open(doc);
  expect([source.replay, source.recorded, source.feed, source.storedId]).toEqual([true, true, null, newest]);
  expect(await shown(source)).toEqual(expected);
  expect(server.paths).toEqual(["/watch/catalog", "/matches", `/watch/ratings/${newest}`, `/replays/${newest}`]);
  expect(error.textContent).toBe("");
});

// The bundled recording is deleted: with no stored recording to stand in, the page shows the existing text for
// that cause, and a live match that becomes available still takes over (the subscriptions stay open).
const HISTORY_UNAVAILABLE = "Stored match history is unavailable or incomplete. Please try again.";
const NOT_FOUND = "This recording was not found (HTTP 404).";
const CAUSES = [
  ["empty stored history", "", "No stored matches available"],
  ["unavailable stored history", HISTORY_UNAVAILABLE, HISTORY_UNAVAILABLE],
  ["incomplete stored history", HISTORY_UNAVAILABLE, HISTORY_UNAVAILABLE],
  ["a newest recording that fails before its first snapshot", NOT_FOUND, NOT_FOUND],
] as const;
function failing(cause: (typeof CAUSES)[number][0], initial: ReturnType<typeof match>[] = []) {
  const server = serve(initial, cause === "empty stored history" ? [] : [newest]);
  server.recordingFailure = cause === "a newest recording that fails before its first snapshot";
  if (cause === "unavailable stored history" || cause === "incomplete stored history") {
    const request = globalThis.fetch;
    vi.stubGlobal("fetch", (path: string, options?: RequestInit) => {
      if (!path.startsWith("/matches")) return request(path, options);
      server.paths.push(path);
      // Unavailable: the history route fails. Incomplete: before any match is listed, its continuation repeats a page it already gave.
      return Promise.resolve(cause === "unavailable stored history" ? new Response(null, { status: 503 })
        : Response.json({ matches: [], nextPageToken: "again" }));
    });
  }
  return server;
}

it.each(CAUSES)("automatic Watch with %s shows that cause's existing text, loads no bundled recording, then a live match takes over", async (cause, message, waiting) => {
  vi.useFakeTimers();
  const server = failing(cause);
  const { doc, error, state, reload } = page();
  const pending = open(doc);
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  expect(await pending).toBeNull();
  expect(error.textContent).toBe(message);
  expect(state.textContent).toBe(waiting);
  expect(server.paths.some(path => path.includes("agents.bin"))).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  server.matches = [match("new")];
  await vi.advanceTimersByTimeAsync(1500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it.each(CAUSES)("an explicit lobby link with %s still shows the Leaderboard and reads no stored history, then its live stream takes over", async cause => {
  vi.useFakeTimers();
  const server = failing(cause);
  const { doc, error, reload, storage } = page();
  const lobby = openLobby(doc, "silent", "late");
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  expect(await lobby.pending).toBeNull();
  expect(lobby.leaderboard).toHaveBeenCalledTimes(1);
  expect(error.textContent).toBe("");
  expect(storedReads(server.paths)).toEqual([]);
  lobby.stream().emit(packets[0]!);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(storage.get(HANDOVER_KEY)).toBe("late");
});

it.each(CAUSES)("a capture-only route with %s shows that cause's existing text and opens no live subscription", async (cause, message, waiting) => {
  const server = failing(cause);
  const { doc, error, state } = page();
  const streams: string[] = [];
  const source = await openSource(new URLSearchParams({ capture: "1" }), { now: () => 0 }, doc, vi.fn(), {
    source: path => { streams.push(path); return new Source(); }, intake,
  });
  expect(source).toBeNull();
  expect(error.textContent).toBe(message);
  expect(state.textContent).toBe(waiting);
  expect(streams).toEqual([]);
  expect(server.paths.filter(path => path === "/watch/catalog" || path.startsWith("/watch/status/"))).toEqual([]);
  expect(server.paths.some(path => path.includes("agents.bin"))).toBe(false);
});

it.each([0, 0.99])("opens a random catalog match once and preserves its delay without polling reshuffles (%s)", async random => {
  vi.useFakeTimers();
  const server = serve([match("house", 0), match("ranked", 300)]);
  vi.spyOn(Math, "random").mockReturnValue(random);
  const { doc, reload } = page();
  const paths: string[] = [], es = new Source();
  const pending = openSource(new URLSearchParams(), { now: () => 0 }, doc, vi.fn(), {
    source: path => { paths.push(path); queueMicrotask(() => es.emit(packets[0]!)); return es; }, intake,
  });
  await vi.advanceTimersByTimeAsync(0);
  const source = (await pending)!; active.push(source);
  const chosen = random === 0 ? "house" : "ranked";
  expect(source.source).toBe(`/watch/live/${chosen}`);
  expect(source.delaySeconds).toBe(random === 0 ? 0 : 300);
  expect([source.replay, source.recorded, source.recording]).toEqual([false, false, null]);
  await vi.advanceTimersByTimeAsync(4500);
  expect(paths).toEqual([`/watch/live/${chosen}`]);
  expect(server.paths.every(path => path === "/watch/catalog")).toBe(true);
  expect(reload).not.toHaveBeenCalled();
});

it.each(["live", "fallback"])("automatic Watch requests /watch/catalog once per polling interval (%s)", async mode => {
  vi.useFakeTimers();
  const server = serve(mode === "live" ? [match("selected")] : [], [newest]);
  const { doc } = page();
  const pending = open(doc);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  const catalog = () => server.paths.filter(path => path === "/watch/catalog").length;
  const start = catalog();
  expect(start).toBe(1);
  for (let interval = 1; interval <= 6; interval++) {
    await vi.advanceTimersByTimeAsync(1500);
    expect(catalog()).toBe(start + interval);
  }
});

it("a match appearing during fallback reloads once; closing cancels discovery", async () => {
  vi.useFakeTimers();
  const server = serve([], [newest]), { doc, reload, view } = page();
  const source = await open(doc);
  server.matches = [match("new")];
  await vi.advanceTimersByTimeAsync(4500);
  expect(reload).toHaveBeenCalledTimes(1);
  view.dispatchEvent(new Event("pagehide"));
  const requests = server.paths.length;
  await vi.advanceTimersByTimeAsync(9000);
  expect(server.paths).toHaveLength(requests);
  source.nextMatch();
  expect(reload).toHaveBeenCalledTimes(1);
});

it("a silent selected stream uses stored fallback, ignores finished snapshots, then hands over on a running snapshot", async () => {
  vi.useFakeTimers();
  serve([match("selected")], [newest]);
  const { doc, reload, storage } = page(), es = new Source();
  const pending = open(doc, es, false);
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  const source = await pending;
  expect(source.replay).toBe(true);
  const m = decodeMessage(packets[0]!);
  es.emit(encodeMessage({ ...m, full: { ...m.full!, result: { winner: null, reason: "time_up", decidedBy: "draw", tick: m.tick, nextStartMs: null } } }));
  await vi.advanceTimersByTimeAsync(50);
  expect(reload).not.toHaveBeenCalled();
  es.emit(packets[0]!);
  // DecompressionStream completes on the real async transport, not the fake timer clock.
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(storage.get(HANDOVER_KEY)).toBe("selected");
});

it("holds the stand-in with two silent delayed matches until the selected stream delivers a running snapshot", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  serve([match("selected", 300), match("also-delayed", 300)], [newest]);
  const { doc, reload, storage } = page(), es = new Source();
  const pending = open(doc, es, false);
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  const source = await pending;
  expect(source.recorded).toBe(true);
  expect(source.take(0)[0]!.m.tick).toBe(firstTick);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reload).not.toHaveBeenCalled();
  es.emit(packets[0]!);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(storage.get(HANDOVER_KEY)).toBe("selected");
});

it("a silent selection disappearing from the confirmed catalog permits a fresh selection", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const server = serve([match("selected", 300), match("also-delayed", 300)]);
  const { doc, reload } = page();
  const pending = open(doc, new Source(), false);
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  await pending;
  await vi.advanceTimersByTimeAsync(4500);
  expect(reload).not.toHaveBeenCalled();
  server.matches = [match("also-delayed", 300)];
  await vi.advanceTimersByTimeAsync(1500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it("handover pins the confirmed lobby rather than picking another random match, but a failed handover is bounded", async () => {
  vi.useFakeTimers();
  serve([match("one"), match("two")], [newest]);
  vi.spyOn(Math, "random").mockReturnValue(0);
  const { doc, storage } = page({ [HANDOVER_KEY]: "two" });
  const paths: string[] = [];
  const pending = openSource(new URLSearchParams(), { now: () => 0 }, doc, vi.fn(), { source: path => { paths.push(path); return new Source(); }, intake });
  await vi.advanceTimersByTimeAsync(10_000);
  const source = (await pending)!; active.push(source);
  expect(paths).toEqual(["/watch/live/two"]);
  expect(source.recorded).toBe(true);
  expect(storage.has(HANDOVER_KEY)).toBe(false);
});

it("catalog failure does not make a dropped live feed idle; repeated confirmed absence does", async () => {
  vi.useFakeTimers();
  const server = serve([match("selected")]), { doc, reload } = page(), es = new Source();
  const source = await open(doc, es);
  es.drop(); server.catalogFailure = true;
  await vi.advanceTimersByTimeAsync(4500);
  expect(reload).not.toHaveBeenCalled();
  server.catalogFailure = false; server.matches = [];
  await vi.advanceTimersByTimeAsync(1500 * (DROP_CHECKS - 1));
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(source.recorded).toBe(false);
});

it("after the displayed result automatic Watch selects again, whereas explicit lobby links remain pinned", async () => {
  serve([match("selected")]);
  const automatic = page(), auto = await open(automatic.doc);
  auto.nextMatch(); auto.nextMatch();
  expect(automatic.reload).toHaveBeenCalledTimes(1);
  auto.close();
  const pinned = page();
  const source = await open(pinned.doc, new Source(), true, "lobby=explicit&watch=1");
  source.nextMatch();
  expect(pinned.reload).not.toHaveBeenCalled();
});

/** Opens an explicit lobby link whose stream is refused like a 404 (closed with an error), or opens and sends nothing. */
function openLobby(doc: Document, stream: "refused" | "silent", lobby = "gone", es = new Source()) {
  const streams: string[] = [];
  const leaderboard = vi.fn();
  let settled = false;
  const pending = openSource(new URLSearchParams({ lobby }), { now: () => 0 }, doc, vi.fn(), {
    source: path => {
      streams.push(path);
      const opened = new Source();
      if (stream === "refused") queueMicrotask(() => opened.drop());
      else es = opened;
      return opened;
    }, intake,
  }, { leaderboard }).then(source => { settled = true; if (source) active.push(source); return source; });
  return { pending, streams, leaderboard, settled: () => settled, stream: () => es };
}
/** Requests that read stored history or a stored recording: a lobby link never makes one. */
const storedReads = (paths: readonly string[]) => paths.filter(path => path.startsWith("/matches") || path.startsWith("/replays/") || path.startsWith("/watch/ratings/"));

it.each(["refused", "silent"] as const)("a lobby link with no live stream (%s) leaves Connecting within CONNECT_MS for the Leaderboard, never a stored recording", async stream => {
  vi.useFakeTimers();
  const server = serve([], [newest]);
  const { doc, reload, error } = page();
  const lobby = openLobby(doc, stream);
  await vi.advanceTimersByTimeAsync(CONNECT_MS - 1);
  expect(lobby.settled()).toBe(false);
  expect(lobby.leaderboard).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await lobby.pending).toBeNull();
  expect(lobby.leaderboard).toHaveBeenCalledTimes(1);
  expect(lobby.leaderboard).toHaveBeenCalledWith(doc);
  expect(storedReads(server.paths)).toEqual([]);
  expect(lobby.streams[0]).toBe("/watch/live/gone");
  expect(error.textContent).toBe("");
  // Nothing reloads while the lobby stays silent.
  await vi.advanceTimersByTimeAsync(9000);
  expect(reload).not.toHaveBeenCalled();
});

it.each([true, false])("a silent lobby whose status reads started %s, playback finished, shows the Leaderboard", async started => {
  vi.useFakeTimers();
  const server = serve([], [newest]);
  server.status = { lobbyId: "ended", started, playbackFinished: true, delaySeconds: 300 };
  const { doc, state } = page();
  const lobby = openLobby(doc, "silent", "ended");
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  expect(await lobby.pending).toBeNull();
  expect(lobby.leaderboard).toHaveBeenCalledTimes(1);
  expect(state.textContent).toBe("Connecting…");
  expect(storedReads(server.paths)).toEqual([]);
});

it.each([true, false])("a silent lobby whose status reads started %s, not finished, waits in the panel saying the live match is starting, then plays that match live", async started => {
  vi.useFakeTimers();
  const server = serve([], [newest]);
  server.status = { lobbyId: "delayed", started, playbackFinished: false, delaySeconds: 60 };
  const { doc, state, reload } = page();
  const lobby = openLobby(doc, "silent", "delayed");
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  expect(state.textContent).toBe(STARTING_COPY);
  // Before the start and through the spectator delay the panel stays, with no recording and no Leaderboard, until the stream's first release.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lobby.settled()).toBe(false);
  expect(lobby.leaderboard).not.toHaveBeenCalled();
  expect(storedReads(server.paths)).toEqual([]);
  lobby.stream().emit(packets[0]!);
  const source = (await lobby.pending)!;
  expect([source.recorded, source.replay, source.recording, source.storedId, source.source]).toEqual([false, false, null, null, "/watch/live/delayed"]);
  expect(source.feed).not.toBeNull();
  expect(source.delaySeconds).toBe(60);
  expect(source.head.tick).toBe(firstTick);
  expect(reload).not.toHaveBeenCalled();
});

it("a lobby waiting in the panel that ends or expires without a match switches to the Leaderboard on a status re-read, and a later running snapshot still hands over", async () => {
  vi.useFakeTimers();
  const server = serve([], [newest]);
  server.status = { lobbyId: "lapsed", started: false, playbackFinished: false, delaySeconds: 300 };
  const { doc, state, reload, storage } = page();
  const lobby = openLobby(doc, "silent", "lapsed");
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  expect(state.textContent).toBe(STARTING_COPY);
  const reads = () => server.paths.filter(path => path === "/watch/status/lapsed").length;
  expect(reads()).toBe(1);
  // Still waiting, then an unavailable read: the panel stays.
  await vi.advanceTimersByTimeAsync(LOBBY_STATUS_RECHECK_MS);
  expect(reads()).toBe(2);
  server.status = null;
  await vi.advanceTimersByTimeAsync(LOBBY_STATUS_RECHECK_MS);
  expect(reads()).toBe(3);
  expect(lobby.settled()).toBe(false);
  expect(lobby.leaderboard).not.toHaveBeenCalled();
  // The lobby ended or expired: the server now reads it finished.
  server.status = { lobbyId: "lapsed", started: true, playbackFinished: true, delaySeconds: 300 };
  await vi.advanceTimersByTimeAsync(LOBBY_STATUS_RECHECK_MS);
  expect(await lobby.pending).toBeNull();
  expect(lobby.leaderboard).toHaveBeenCalledTimes(1);
  expect(storedReads(server.paths)).toEqual([]);
  // Re-reads stop once settled.
  await vi.advanceTimersByTimeAsync(3 * LOBBY_STATUS_RECHECK_MS);
  expect(reads()).toBe(4);
  expect(reload).not.toHaveBeenCalled();
  lobby.stream().emit(packets[0]!);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(storage.get(HANDOVER_KEY)).toBe("lapsed");
});

it("a waiting lobby's status re-reads stop when its first snapshot opens it live", async () => {
  vi.useFakeTimers();
  const server = serve([], [newest]);
  server.status = { lobbyId: "starts", started: false, playbackFinished: false, delaySeconds: 60 };
  const { doc } = page();
  const lobby = openLobby(doc, "silent", "starts");
  await vi.advanceTimersByTimeAsync(CONNECT_MS + LOBBY_STATUS_RECHECK_MS);
  lobby.stream().emit(packets[0]!);
  const source = (await lobby.pending)!;
  expect(source.source).toBe("/watch/live/starts");
  const reads = server.paths.filter(path => path === "/watch/status/starts").length;
  await vi.advanceTimersByTimeAsync(3 * LOBBY_STATUS_RECHECK_MS);
  expect(server.paths.filter(path => path === "/watch/status/starts").length).toBe(reads);
  expect(lobby.leaderboard).not.toHaveBeenCalled();
});

it("a lobby link showing the Leaderboard hands over once when its stream delivers a snapshot, and the reloaded page waits up to 10 s", async () => {
  vi.useFakeTimers();
  serve([], [newest]);
  const first = page();
  const lobby = openLobby(first.doc, "silent", "late");
  await vi.advanceTimersByTimeAsync(CONNECT_MS);
  expect(await lobby.pending).toBeNull();
  expect(lobby.leaderboard).toHaveBeenCalledTimes(1);
  lobby.stream().emit(packets[0]!);
  await vi.waitFor(() => expect(first.reload).toHaveBeenCalledTimes(1));
  expect(first.storage.get(HANDOVER_KEY)).toBe("late");

  const second = page({ [HANDOVER_KEY]: "late" });
  const reloaded = openLobby(second.doc, "silent", "late");
  await vi.advanceTimersByTimeAsync(5000);
  expect(reloaded.settled()).toBe(false);
  reloaded.stream().emit(packets[0]!);
  const source = (await reloaded.pending)!;
  expect([source.recorded, source.replay, source.source]).toEqual([false, false, "/watch/live/late"]);
  expect(second.storage.has(HANDOVER_KEY)).toBe(false);
  expect(second.reload).not.toHaveBeenCalled();
  expect(reloaded.leaderboard).not.toHaveBeenCalled();
});

it("a just-finished lobby whose retained stream sends its final snapshot at once shows the Leaderboard, then its next match's running snapshot hands over to live", async () => {
  const server = serve([], [newest]);
  server.status = { lobbyId: "finished", started: true, playbackFinished: true, delaySeconds: 60 };
  const m = decodeMessage(packets[0]!);
  const final = encodeMessage({ ...m, full: { ...m.full!, result: { winner: 0, reason: "overrun", decidedBy: "overrun", tick: m.tick, nextStartMs: null } } });
  const first = page(), opened = Date.now();
  const lobby = openLobby(first.doc, "silent", "finished");
  await vi.waitFor(() => expect(lobby.streams).toHaveLength(1));
  lobby.stream().emit(final);
  expect(await lobby.pending).toBeNull();
  // The arrival decided it, inside CONNECT_MS, not the silent-stream bound.
  expect(Date.now() - opened).toBeLessThan(CONNECT_MS);
  expect(lobby.leaderboard).toHaveBeenCalledTimes(1);
  expect(storedReads(server.paths)).toEqual([]);
  // Another finished snapshot is still no live match; the next match's running snapshot is.
  lobby.stream().emit(final);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(first.reload).not.toHaveBeenCalled();
  lobby.stream().emit(packets[0]!);
  await vi.waitFor(() => expect(first.reload).toHaveBeenCalledTimes(1));
  expect(first.storage.get(HANDOVER_KEY)).toBe("finished");

  const second = page({ [HANDOVER_KEY]: "finished" });
  const reloaded = openLobby(second.doc, "silent", "finished");
  await vi.waitFor(() => expect(reloaded.streams).toHaveLength(1));
  reloaded.stream().emit(packets[0]!);
  const source = (await reloaded.pending)!;
  expect([source.recorded, source.replay, source.recording, source.source]).toEqual([false, false, null, "/watch/live/finished"]);
  expect(source.head.full!.result).toBeNull();
  expect(reloaded.leaderboard).not.toHaveBeenCalled();
  expect(second.reload).not.toHaveBeenCalled();
});

it("a lobby link whose server sends within CONNECT_MS opens live even when this page decodes slowly", async () => {
  vi.useFakeTimers();
  serve([], [newest]);
  const { doc, reload } = page(), es = new Source();
  const slow: Intake = { ...intake, decode: async data => { await new Promise(resolve => setTimeout(resolve, 2500)); return intake.decode(data); } };
  const pending = openSource(new URLSearchParams({ lobby: "running" }), { now: () => 0 }, doc, vi.fn(), {
    source: () => { queueMicrotask(() => es.emit(packets[0]!)); return es; }, intake: slow,
  });
  await vi.advanceTimersByTimeAsync(3000);
  const source = (await pending)!; active.push(source);
  expect([source.recorded, source.replay, source.recording]).toEqual([false, false, null]);
  expect(source.head.tick).toBe(firstTick);
  expect(reload).not.toHaveBeenCalled();
});

it("the stand-in restarts at EOF instead of remaining on a still board", async () => {
  serve([], [newest]);
  const { doc, reload } = page(), source = await open(doc);
  for (let now = 0; now <= 5000 && !reload.mock.calls.length; now += 250) {
    source.take(now);
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(reload).toHaveBeenCalledTimes(1);
});

it("cancels a silent initial catalog on pagehide without opening any recording or stream", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", (_path: string, options?: RequestInit) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(new Error("closed")), { once: true });
  }));
  const { doc, view } = page();
  const pending = open(doc, new Source(), false);
  view.dispatchEvent(new Event("pagehide"));
  expect(await pending).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
