import { afterEach, describe, expect, it, vi } from "vitest";
import { inviteRecordingRequest, lobbyRecordingPath } from "../../web/src/invite-recording.ts";
import { replayPath } from "../../web/src/replay.ts";
import { openSource } from "../../web/src/source.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const id = "2026-10-20T10-00-00-000Z-1";
const params = new URLSearchParams({ lobby: "private-lobby", replay: id });
const path = `/watch/replays/private-lobby/${id}`;
const bytes = new Uint8Array(packMessages(scale2Packets(2)));
function documentPort(hash: string): Document {
  return {
    getElementById: (id: string) => id === "aw-recording-error" ? { textContent: "" } : null, querySelector: () => null,
    defaultView: { location: { hash }, addEventListener: () => {} },
  } as unknown as Document;
}
afterEach(() => vi.unstubAllGlobals());

describe("invite recording transport", () => {
  it("keeps existing public URLs and validates the recording id before building a lobby path", () => {
    expect(replayPath(new URLSearchParams({ replay: id }))).toBe(`/replays/${id}`);
    expect(lobbyRecordingPath(params)).toBe(path);
    for (const lobby of ["", ".", ".."]) expect(() => lobbyRecordingPath(new URLSearchParams({ lobby, replay: id }))).toThrow();
    expect(() => lobbyRecordingPath(new URLSearchParams({ lobby: "private-lobby", replay: "../invalid" }))).toThrow();
  });


  it("uses a private no-store header request and preserves cancellation, not caller request options", async () => {
    const request = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    const controller = new AbortController();
    await inviteRecordingRequest(path, "secret", request)(path, {
      signal: controller.signal, redirect: "follow", cache: "force-cache", method: "POST", headers: { other: "value" },
    });
    const [url, options] = vi.mocked(request).mock.calls[0]!;
    expect(url).toBe(path);
    expect(options).toMatchObject({ method: "GET", signal: controller.signal, redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", credentials: "same-origin" });
    expect(Object.fromEntries(new Headers(options?.headers))).toEqual({ accept: "application/octet-stream", "x-antwar-invite": "secret" });
    await expect(inviteRecordingRequest(path, "secret", request)("https://other.test/recording")).rejects.toThrow("changed its route");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("plays private media through the existing incremental reader for every shared viewer source", async () => {
    const request = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", request);
    const rejected = vi.fn();
    const source = await openSource(params, { now: () => 0 }, documentPort("#invite=secret"), rejected);
    try {
      expect(source?.recorded).toBe(true);
      expect(source?.feed).toBeNull();
      expect(source?.take(0)[0]?.kind).toBe("recorded");
      // The recording plus the stored match's rating record, both invite-gated.
      const calls = request.mock.calls as unknown as Parameters<typeof fetch>[];
      expect(calls.map(([url]) => url)).toEqual([`/watch/ratings/${id}`, path]);
      for (const [, options] of calls) expect(new Headers(options?.headers).get("x-antwar-invite")).toBe("secret");
      expect(rejected).not.toHaveBeenCalled();
    } finally { source?.close(); }
  });

  it.each([403, 404])("does not fall back to public media when the invite is missing or refused (%s)", async status => {
    const request = vi.fn(async () => new Response("Refused", { status }));
    vi.stubGlobal("fetch", request);
    const rejected = vi.fn();
    expect(await openSource(params, { now: () => 0 }, documentPort(""), rejected)).toBeNull();
    expect(rejected).toHaveBeenCalled();
    // The recording plus the stored match's rating record; neither carries an invite.
    const calls = request.mock.calls as unknown as Parameters<typeof fetch>[];
    expect(calls.map(([url]) => url)).toEqual([`/watch/ratings/${id}`, path]);
    for (const [, options] of calls) expect(new Headers(options?.headers).has("x-antwar-invite")).toBe(false);
  });
});
