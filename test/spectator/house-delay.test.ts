import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import type { Intake, IntakeTick } from "../../web/src/intake.ts";
import { modeCopy } from "../../web/src/replay.ts";
import { liveLobbyDelay, openSource } from "../../web/src/source.ts";
import { decodeData, type EventSourceLike } from "../../web/src/stream.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const lobbyId = "00000000-0000-4000-8000-000000000417";
const packet = scale2Packets(1)[0]!;
const intake: Intake = {
  decode: async data => { const m = await decodeData(data); return { m, prepared: { m }, workerMs: 0 } as unknown as IntakeTick; },
  reset() {}, close() {},
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([0, 60, 300])("carries lobby status delay %s through the actual source to the live label", async delaySeconds => {
  const requests: { path: string; options?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (path: string, options?: RequestInit) => {
    requests.push({ path, options });
    return Response.json({ lobbyId, started: true, playbackFinished: false, delaySeconds });
  });
  const doc = { getElementById: () => null, defaultView: { location: { hash: "#invite=private-token" }, addEventListener() {} } } as unknown as Document;
  const message = decodeMessage(packet); message.full!.setup.rated = delaySeconds !== 60;
  const bytes = encodeMessage(message);
  const es: EventSourceLike = { onopen: null, onmessage: null, onerror: null, readyState: 1, close() {} };
  const reject = vi.fn();
  const source = await openSource(new URLSearchParams({ lobby: lobbyId, watch: "1" }), { now: () => 0 }, doc, reject, {
    source: path => {
      expect(path).toBe(`/watch/live/${lobbyId}`);
      queueMicrotask(() => es.onmessage?.({ data: deflateRawSync(bytes).toString("base64") } as MessageEvent<string>));
      return es;
    }, intake,
  });
  expect(source).not.toBeNull();
  try {
    await vi.waitFor(() => expect(source!.delaySeconds).toBe(delaySeconds));
    for (const agents of [0, 4]) {
      expect(modeCopy("live", agents, false, "/", source!.storedId, source!.head.full!.setup.rated, source!.delaySeconds).detail)
        .toBe(`${agents === 0 ? "No agents · " : ""}${delaySeconds} s behind the match`);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe(`/watch/status/${lobbyId}`);
    expect(requests[0]!.options).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(new Headers(requests[0]!.options?.headers).get("x-antwar-invite")).toBe("private-token");
    expect(reject).not.toHaveBeenCalled();
  } finally { source!.close(); }
});

it.each([null, {}, { lobbyId: "wrong", delaySeconds: 0 }, { lobbyId, delaySeconds: "0" }, { lobbyId, delaySeconds: -1 }])("ignores malformed optional status %j", async value => {
  expect(await liveLobbyDelay(lobbyId, null, new AbortController().signal, async () => Response.json(value))).toBeUndefined();
});

it("ignores failed or aborted status and never transfers an invite through redirects", async () => {
  expect(await liveLobbyDelay(lobbyId, null, new AbortController().signal, async () => new Response(null, { status: 503 }))).toBeUndefined();
  expect(await liveLobbyDelay(lobbyId, null, new AbortController().signal, async () => { throw new Error("offline"); })).toBeUndefined();
  const controller = new AbortController(); controller.abort();
  expect(await liveLobbyDelay(lobbyId, null, controller.signal, async () => Response.json({ lobbyId, delaySeconds: 0 }))).toBeUndefined();
});

it("keeps legacy fallback and recording copy while all renderer paths receive selected-lobby delay", () => {
  expect(modeCopy("live", 2, false, "/", null, true).detail).toBe("300 s behind the match");
  expect(modeCopy("live", 2, false, "/", null, false).detail).toBe("60 s behind the match");
  expect(modeCopy("replay", 2, false, "/", null, true, 0)).toEqual(modeCopy("replay", 2, false, "/", null, true));
  for (const [path, count] of [["../../web/src/main.ts", 2], ["../../web/src/board3d/main3d.ts", 1]] as const) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(text.match(/input\.storedId, head\.full!\.setup\.rated, input\.delaySeconds, input\.harnessPhase\)/g)).toHaveLength(count);
    expect(text.match(/input\.storedId, board\.setup\.rated, input\.delaySeconds, input\.harnessPhase\)/g)).toHaveLength(count);
  }
});
