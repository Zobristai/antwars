// The scripted local server answers the client's /watch/* and /matches routes from the match it plays.
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { RECORD_CONFIG } from "../../src/live/record.ts";
import { LiveServer } from "../../web/capture/live-check.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let server: LiveServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe("scripted local server routes", () => {
  it("lists, streams and records a scripted match under its lobby", async () => {
    server = new LiveServer({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    const base = await server.listen();
    const match = server.start(1, { seed: 6007, config: { ...RECORD_CONFIG, matchTicks: 40 }, agents: 2, ticks: 40, attack: true });
    await sleep(300);

    const catalog = await (await fetch(`${base}/watch/catalog`)).json();
    expect(catalog.lobbies).toEqual([]);
    expect(catalog.matches).toHaveLength(1);
    expect(catalog.matches[0]).toMatchObject({ lobbyId: match.lobbyId, rated: false, delaySeconds: 0 });
    const seated = catalog.matches[0].colonies.flat();
    expect(seated).toHaveLength(match.state.agents.length);
    expect(seated.every((s: { displayName: string; rating: null }) => s.displayName.length > 0 && s.rating === null)).toBe(true);

    const status = await (await fetch(`${base}/watch/status/${match.lobbyId}`)).json();
    expect(status).toEqual({ lobbyId: match.lobbyId, started: true, playbackFinished: false, delaySeconds: 0 });
    expect((await fetch(`${base}/watch/status/00000000-0000-4000-8000-000000000000`)).status).toBe(404);

    const live = new AbortController();
    const stream = await fetch(`${base}/watch/live/${match.lobbyId}`, { signal: live.signal });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = stream.body!.getReader();
    let text = "";
    while (!text.includes("data: ")) text += new TextDecoder().decode((await reader.read()).value);
    live.abort();

    expect((await (await fetch(`${base}/matches`)).json()).matches).toEqual([]);
    let page: { matches: { id: string; status: string; winner: unknown; seats: unknown[] }[]; nextPageToken: null } = { matches: [], nextPageToken: null };
    for (let i = 0; i < 120 && page.matches.length === 0; i++) {
      await sleep(250);
      page = await (await fetch(`${base}/matches`)).json();
    }
    expect(match.finalTick).not.toBeNull();
    expect(page.nextPageToken).toBeNull();
    expect(page.matches).toHaveLength(1);
    const [row] = page.matches;
    expect(row!.status).toBe("complete");
    expect(row!.seats).toHaveLength(match.state.agents.length);
    expect(row!.winner).toBe(match.state.result!.winner);

    const record = await (await fetch(`${base}/matches/${row!.id}`)).json();
    expect(record).toMatchObject({ format: "antwar.match", version: 1, id: row!.id, source: "match-log", result: { tick: match.finalTick! - 1 } });
    const replay = await fetch(`${base}/replays/${row!.id}`);
    expect(replay.status).toBe(200);
    expect((await replay.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await (await fetch(`${base}/watch/ratings/${row!.id}`)).json()).ratings).toEqual([]);
    expect((await fetch(`${base}/watch/status/${match.lobbyId}`)).status).toBe(200);
  }, 60_000);
});
