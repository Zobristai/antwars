import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "../../src/live/config.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { RELAY_HEADER, relayKey, signRelay } from "../../src/live/relay-signature.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { playable } from "../playable.ts";

// Live spectator caps on a server hosting matches. Documentation-range addresses and
// test-only keys only.
const LOBBY = "00000000-0000-4000-8000-000000000001";
const KEY = relayKey(Buffer.alloc(32, 7))!;
const WRONG_KEY = relayKey(Buffer.alloc(32, 9))!;

const closers: (() => void | Promise<void>)[] = [];
/** Responses of streams a test holds open: fetch cancels a Response that is garbage-collected, which would close its stream mid-test. */
const held: Response[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  held.length = 0;
  vi.restoreAllMocks();
});

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

/** A hub streaming one public lobby's match, served over HTTP as a slot serves /live and /watch/live. */
async function slot(config: Partial<LiveConfig> = {}, key: Uint8Array | undefined = KEY) {
  const hub = new LiveHub({ config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0, ...config }, relayKey: key });
  hub.startMatch(1, createMatch(33, playable(rulesConfig("redesign"))), { lobbyId: LOBBY, visibility: "public", rated: false });
  const server: Server = createServer((req, res) => void hub.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }), () => hub.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const viewers: { status: number; retryAfter: string | null; headers: Headers; close: () => void }[] = [];
  /** One viewer; a 200 stream stays open until closed. */
  async function watch(headers: Record<string, string> = {}, path = `/watch/live/${LOBBY}`) {
    const abort = new AbortController();
    closers.push(() => abort.abort());
    const res = await fetch(origin + path, { headers, signal: abort.signal });
    if (res.status !== 200) await res.body?.cancel();
    else held.push(res);
    const viewer = { status: res.status, retryAfter: res.headers.get("retry-after"), headers: res.headers, close: () => abort.abort() };
    viewers.push(viewer);
    return viewer;
  }
  return { hub, watch, viewers };
}

const from = (address: string) => ({ "x-forwarded-for": address });
const statuses = (viewers: readonly { status: number }[]) => viewers.map((viewer) => viewer.status);

describe("live spectator caps", () => {
  it("defaults to 256 per server and 16 per source", () => {
    expect(DEFAULT_LIVE_CONFIG.maxSpectators).toBe(256);
    expect(DEFAULT_LIVE_CONFIG.maxSpectatorsPerSource).toBe(16);
  });

  it("refuses a viewer past the server's cap with a retryable 503, counting /live and /watch/live together, and frees a place when a stream closes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await slot({ maxSpectators: 3, maxSpectatorsPerSource: 16 });
    const first = await s.watch(from("192.0.2.1"));
    await s.watch(from("192.0.2.2"), "/live/current");
    await s.watch(from("192.0.2.3"), "/live/1");
    expect(statuses(s.viewers)).toEqual([200, 200, 200]);
    const refused = await s.watch(from("192.0.2.4"));
    expect([refused.status, refused.retryAfter]).toEqual([503, "1"]);
    expect((await s.watch(from("192.0.2.4"), "/live/current")).status).toBe(503);
    first.close();
    await until(() => s.hub.spectatorCap.open === 2);
    expect((await s.watch(from("192.0.2.4"))).status).toBe(200);
  });

  it("bounds one source, by its last forwarded hop only, and counts requests with no client hop under one shared key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await slot({ maxSpectators: 20, maxSpectatorsPerSource: 2 });
    expect((await s.watch(from("192.0.2.1"))).status).toBe(200);
    // A client-supplied earlier hop does not make a new source.
    expect((await s.watch(from("203.0.113.9, 192.0.2.1"))).status).toBe(200);
    expect((await s.watch(from("203.0.113.10, 192.0.2.1"))).status).toBe(503);
    expect((await s.watch(from("198.51.100.7"))).status).toBe(200);
    // No header, or an invalid last hop: one shared key.
    expect((await s.watch()).status).toBe(200);
    expect((await s.watch(from("not-an-address"))).status).toBe(200);
    expect((await s.watch()).status).toBe(503);
  });

  it("lets a relay the entry signed skip only the per-source bound: it still counts toward the server's cap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await slot({ maxSpectators: 6, maxSpectatorsPerSource: 2 });
    // Every relay arrives from the entry's one address.
    for (let i = 0; i < 6; i += 1) expect((await s.watch({ ...from("192.0.2.50"), [RELAY_HEADER]: signRelay(KEY, LOBBY) })).status).toBe(200);
    const past = await s.watch({ ...from("192.0.2.50"), [RELAY_HEADER]: signRelay(KEY, LOBBY) });
    expect([past.status, past.retryAfter]).toEqual([503, "1"]);
  });

  it("treats a wrong-key signature as unsigned: relayed viewers are admitted up to 16 per source, the 17th gets a retryable 503, and none is refused for the signature alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Defaults: 256 per server, 16 per source. The entry signs under a key this slot does not hold.
    const s = await slot();
    for (let i = 0; i < 16; i += 1) {
      const viewer = await s.watch({ ...from("192.0.2.50"), [RELAY_HEADER]: signRelay(WRONG_KEY, LOBBY) });
      expect(viewer.status).toBe(200);
    }
    const seventeenth = await s.watch({ ...from("192.0.2.50"), [RELAY_HEADER]: signRelay(WRONG_KEY, LOBBY) });
    expect([seventeenth.status, seventeenth.retryAfter]).toEqual([503, "1"]);
    // Stale, forged and malformed signatures are unsigned too: from another source, each is admitted.
    for (const [i, header] of [signRelay(KEY, LOBBY, Date.now() - 120_000), `${Date.now()}.${"A".repeat(43)}`, "garbage"].entries()) {
      expect((await s.watch({ ...from(`198.51.100.${i + 1}`), [RELAY_HEADER]: header })).status).toBe(200);
    }
    // The same relays under the slot's own key are all admitted.
    const matching = await slot();
    for (let i = 0; i < 17; i += 1) expect((await matching.watch({ ...from("192.0.2.50"), [RELAY_HEADER]: signRelay(KEY, LOBBY) })).status).toBe(200);
  });

  it("never logs or echoes the relay header or the key", async () => {
    const output: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
    }
    const s = await slot({ maxSpectators: 3, maxSpectatorsPerSource: 1 });
    const valid = signRelay(KEY, LOBBY), wrong = signRelay(WRONG_KEY, LOBBY);
    const sent = [valid, wrong, valid, wrong, valid];
    for (const header of sent) await s.watch({ ...from("192.0.2.50"), [RELAY_HEADER]: header });
    expect(statuses(s.viewers)).toEqual([200, 200, 200, 503, 503]);
    // The refusals were logged, as counts.
    expect(output.join("\n")).toMatch(/refused 1 request past the cap/);
    const secrets = [valid, wrong, valid.split(".")[1]!, wrong.split(".")[1]!, KEY.toString("hex"), KEY.toString("base64"), KEY.toString("base64url")];
    for (const secret of secrets) expect(output.join("\n")).not.toContain(secret);
    for (const viewer of s.viewers) {
      expect(viewer.headers.has(RELAY_HEADER)).toBe(false);
      for (const [, value] of viewer.headers) for (const secret of secrets) expect(value).not.toContain(secret);
    }
  });
});
