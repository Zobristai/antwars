import { afterEach, expect, it, vi } from "vitest";
import { decodeMessage, encodeReplayMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { modeCopy, newestStoredReplay } from "../../web/src/replay.ts";
import { openSource, type SpectatorSource } from "../../web/src/source.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const oldest = "2026-10-17T13-58-00-000Z-99";
const newest = "2026-10-21T13-58-00-000Z-1";
const simultaneous = "2026-10-21T13-58-00-000Z-10";
const history = (...ids: string[]) => ({ matches: ids.map(id => ({ id })), nextPageToken: null });
const packets = unpackMessages(packMessages(scale2Packets(8)));
const bytes = new Uint8Array(packMessages(packets.map(packet => encodeReplayMessage(decodeMessage(packet)))));
const active: SpectatorSource[] = [];
afterEach(() => {
  for (const source of active.splice(0)) source.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function documentPort() {
  const state = { textContent: "Connecting…" };
  const error = { textContent: "" };
  const listeners = new Map<string, () => void>();
  const links: { textContent: string; href: string }[] = [];
  const paragraphs = [{ textContent: "Antwars" }, state, { remove: vi.fn() }];
  const panel = { querySelectorAll: () => paragraphs, querySelector: () => ({ remove() {} }), append: (link: typeof links[number]) => links.push(link) };
  const doc = {
    title: "", getElementById: (id: string) => id === "aw-waiting" ? panel : id === "aw-recording-error" ? error : null,
    querySelector: (selector: string) => selector === ".aw-wait-state" ? state : null,
    createElement: () => ({ textContent: "", href: "", style: { cssText: "" } }),
    defaultView: { location: { pathname: "/", hash: "" },
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string, fn: () => void) => { if (listeners.get(name) === fn) listeners.delete(name); },
    },
  } as unknown as Document;
  return { doc, state, error, links, listeners };
}

it("follows empty continuation pages and chooses by immutable timestamp, with numeric ties, not restart-local sequence", async () => {
  const request = vi.fn<typeof fetch>(async input => {
    if (input === "/matches") return Response.json({ ...history(oldest), nextPageToken: "empty" });
    if (input === "/matches?pageToken=empty") return Response.json({ ...history(), nextPageToken: "last+/=" });
    expect(input).toBe("/matches?pageToken=last%2B%2F%3D");
    return Response.json(history(newest, simultaneous, oldest));
  });
  expect(await newestStoredReplay(request)).toBe(simultaneous);
  expect(request).toHaveBeenCalledTimes(3);
  for (const [, options] of request.mock.calls) {
    expect(options?.cache).toBe("no-store");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
});

it.each(["replay", "replay="])("%s waits for complete discovery, then plays and labels the resolved recording through the shared source", async query => {
  let finish!: (value: Response) => void;
  const last = new Promise<Response>(resolve => { finish = resolve; });
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    paths.push(path);
    if (path === "/matches") return Response.json({ ...history(oldest), nextPageToken: "last" });
    if (path === "/matches?pageToken=last") return last;
    // The stored match's rating record; this one has none, so the recording's figures stay.
    if (path === `/watch/ratings/${newest}`) return Response.json({ ratings: [] });
    expect(path).toBe(`/replays/${newest}`);
    return new Response(bytes);
  });
  const { doc } = documentPort(), reject = vi.fn();
  const opening = openSource(new URLSearchParams(query), { now: () => 0 }, doc, reject);
  await vi.waitFor(() => expect(paths).toEqual(["/matches", "/matches?pageToken=last"]));
  finish(Response.json(history(newest)));
  const source = (await opening)!;
  active.push(source);
  expect(source.storedId).toBe(newest);
  expect(source.source).toBe(`replay /replays/${newest}`);
  expect(modeCopy("replay", 4, false, "/", source.storedId).detail).toBe("21 Oct 2026");
  await vi.waitFor(() => expect(source.recording?.complete).toBe(true));
  const playback = new Playback(), frame = new Frame();
  for (let now = 0; now <= 2000; now += 100) {
    for (const { m, at } of source.take(now)) playback.push(m, at);
    playback.sample(source.now(now), frame);
  }
  expect(frame.tick).toBe(decodeMessage(packets.at(-1)!).tick);
  expect(source.lastTick).toBe(frame.tick);
  expect(modeCopy("replay", 4, true, "/", source.storedId).detail).toBe("· recording ended");
  expect(reject).not.toHaveBeenCalled();
  // The second read of the recording is the scrubber marks' (recording.ts); the end was settled at EOF.
  expect(paths).toEqual(["/matches", "/matches?pageToken=last", `/watch/ratings/${newest}`, `/replays/${newest}`, `/replays/${newest}`]);
});

it("complete empty history shows a status and back link, not an error or bundled recording", async () => {
  const request = vi.fn(async () => Response.json(history()));
  vi.stubGlobal("fetch", request);
  const { doc, state, error, links } = documentPort(), reject = vi.fn();
  expect(await openSource(new URLSearchParams("replay"), { now: () => 0 }, doc, reject)).toBeNull();
  expect(state.textContent).toBe("No stored matches available");
  expect(doc.title).toBe("Antwars — no stored matches");
  expect(links).toMatchObject([{ textContent: "Back to live", href: "/?watch=1", style: { cssText: expect.stringContaining("min-height:44px") } }]);
  expect(error.textContent).toBe("");
  expect(reject).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  { matches: "invalid", nextPageToken: null },
  { matches: [] },
  { matches: [null], nextPageToken: null },
  { matches: [{ id: "2026-02-30T00-00-00-000Z-1" }], nextPageToken: null },
  { ...history(oldest), nextPageToken: "" },
  { ...history(oldest), nextPageToken: "\n" },
  { ...history(oldest), nextPageToken: "x".repeat(2049) },
  { ...history(oldest), nextPageToken: 12 },
])("rejects malformed/incomplete history rather than choosing an earlier newest: %j", async page => {
  await expect(newestStoredReplay(async () => Response.json(page))).rejects.toThrow(/unavailable or incomplete/);
});

it.each(["cycle", "json", "network", "http"])("%s after a valid first page produces visible failure, no empty/newest claim and no retries", async failure => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    paths.push(path);
    if (path === "/matches") return Response.json({ ...history(oldest), nextPageToken: "next" });
    if (failure === "cycle") return Response.json({ ...history(newest), nextPageToken: "next" });
    if (failure === "json") return new Response("invalid json");
    if (failure === "network") throw new Error("network failure");
    return new Response(null, { status: 503 });
  });
  const { doc, state, error } = documentPort(), reject = vi.fn();
  expect(await openSource(new URLSearchParams("replay"), { now: () => 0 }, doc, reject)).toBeNull();
  expect(error.textContent).toMatch(/unavailable or incomplete/);
  expect(state.textContent).toBe(error.textContent);
  expect(reject).toHaveBeenCalledTimes(1);
  expect(paths).toEqual(["/matches", "/matches?pageToken=next"]);
});

it("a long non-cyclic history that reaches the page bound fails instead of playing a partial selection", async () => {
  let pages = 0;
  const request = vi.fn(async () => Response.json({ ...history(oldest), nextPageToken: `page-${++pages}` }));
  await expect(newestStoredReplay(request)).rejects.toThrow(/unavailable or incomplete/);
  expect(request).toHaveBeenCalledTimes(1000);
});

it("bounds a silent history request and cancels on pagehide", async () => {
  vi.useFakeTimers();
  const request: typeof fetch = (_input, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  });
  const result = newestStoredReplay(request).catch(error => error);
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await result).message).toMatch(/unavailable or incomplete/);
  expect(vi.getTimerCount()).toBe(0);
  vi.stubGlobal("fetch", request);
  const { doc, listeners } = documentPort(), reject = vi.fn();
  const opening = openSource(new URLSearchParams("replay"), { now: () => 0 }, doc, reject);
  listeners.get("pagehide")!();
  expect(await opening).toBeNull();
  expect(reject).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([`replay=${newest}`, "recording=bench&capture=1"])("preserves the direct/capture route independently of discovery: %s", async query => {
  const expected = query.startsWith("recording") ? "recordings/bench.bin" : `/replays/${newest}`;
  const request = vi.fn(async (path: string) => {
    // A stored replay also reads its match's rating record; the bundled excerpt and recordings do not.
    if (path === `/watch/ratings/${newest}`) return Response.json({ ratings: [] });
    expect(path).toBe(expected);
    return new Response(query.startsWith("recording") ? new Uint8Array(packMessages(packets)) : bytes);
  });
  vi.stubGlobal("fetch", request);
  const { doc } = documentPort();
  const source = (await openSource(new URLSearchParams(query), { now: () => 0 }, doc, vi.fn()))!;
  active.push(source);
  expect(source.recorded).toBe(true);
  expect(request).toHaveBeenCalledTimes(query === `replay=${newest}` ? 2 : 1);
});

// The bundled recording is deleted: an empty ?replay with a capture or lobby parameter behaves as a bare ?replay.
it.each(["replay&capture=1", "replay&lobby=gone", "replay=&capture=1&lobby=gone"])("%s discovers and plays the newest stored recording as a bare ?replay does, never the bundled file", async query => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    paths.push(path);
    if (path === "/matches") return Response.json(history(newest, oldest));
    // The stored match's rating record; this one has none, so the recording's figures stay.
    if (path === `/watch/ratings/${newest}`) return Response.json({ ratings: [] });
    expect(path).toBe(`/replays/${newest}`);
    return new Response(bytes);
  });
  const { doc } = documentPort(), reject = vi.fn();
  const source = (await openSource(new URLSearchParams(query), { now: () => 0 }, doc, reject))!;
  active.push(source);
  expect([source.storedId, source.source, source.recorded]).toEqual([newest, `replay /replays/${newest}`, true]);
  expect(paths).toEqual(["/matches", `/watch/ratings/${newest}`, `/replays/${newest}`]);
  expect(reject).not.toHaveBeenCalled();
});

it.each(["replay&capture=1", "replay&lobby=gone"])("%s with empty history shows the same no-stored-matches status as a bare ?replay", async query => {
  const request = vi.fn(async () => Response.json(history()));
  vi.stubGlobal("fetch", request);
  const { doc, state, error } = documentPort(), reject = vi.fn();
  expect(await openSource(new URLSearchParams(query), { now: () => 0 }, doc, reject)).toBeNull();
  expect(state.textContent).toBe("No stored matches available");
  expect(error.textContent).toBe("");
  expect(request).toHaveBeenCalledTimes(1);
});
