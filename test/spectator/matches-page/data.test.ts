// The Matches page data: real endpoint projection and cursor/error semantics.
import { describe, expect, it, vi } from "vitest";
import { createMatchesData, type Recording } from "../../../web/src/matches-page/data.ts";
import { recordingRows, recordingsState } from "../../../web/src/ui/format.ts";

const saved = (minute: number): Recording => ({
  id: `2026-10-25T00-${String(minute).padStart(2, "0")}-00-000Z-1`, startedAt: `2026-10-25T00:${String(minute).padStart(2, "0")}:00.000Z`,
  endedAt: null, simulationEndedAt: null, winner: 1, reason: "queens_killed", decidedBy: "queens_killed",
  seats: [{ seat: 0, colony: 0, modelLabel: "saved model", thinkingLevel: null, serviceTier: null, handle: null },
    { seat: 1, colony: 1, modelLabel: "other model", thinkingLevel: null, serviceTier: null, handle: null }], status: "complete", unavailable: [],
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
describe("matches page data", () => {
  it("retains empty-page continuation, reads catalog independently and closes outstanding work", async () => {
    const request = vi.fn(async (path: RequestInfo | URL) => new Response(JSON.stringify(
      path === "/watch/catalog" ? { matches: [] } : { matches: [], nextPageToken: path === "/matches" ? "next" : null },
    )));
    const publish = vi.fn(); const data = createMatchesData(request, publish); data.refresh();
    await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready"));
    expect(data.view.next).toBe("next"); expect(data.view.live).toEqual({ status: "ready", rows: [] });
    data.more(); await vi.waitFor(() => expect(data.view.next).toBeNull());
    expect(request.mock.calls.map(call => call[0])).toContain("/matches?pageToken=next");
    expect(request.mock.calls.map(call => call[0])).toEqual(["/watch/catalog", "/matches", "/matches?pageToken=next"]);
    data.destroy(); const count = publish.mock.calls.length; data.refresh(); expect(publish.mock.calls.length).toBe(count);
  });
  it("loads a catalog mixing house matches (no delay, as the server sends them) with 60 and 300 second rows", async () => {
    const matches = [
      { lobbyId: "house", startedAt: 1, rated: false, delaySeconds: 0, colonies: [[{ displayName: "antwars/gpt-6-luna", rating: 1550, rd: 60, ratedMatches: 30 }], [{ displayName: "antwars/glm-5-3", rating: 1500, rd: 90, ratedMatches: 3 }]] },
      { lobbyId: "unrated", startedAt: 2, rated: false, delaySeconds: 60, colonies: [[{ displayName: "alice", rating: null, rd: null, ratedMatches: null }], []] },
      { lobbyId: "rated", startedAt: 3, rated: true, delaySeconds: 300, colonies: [[], []] },
      // Each seat's self-reported model label, null where it reported none.
      { lobbyId: "labelled", startedAt: 4, rated: false, delaySeconds: 60, colonies: [[{ displayName: "antwarsos-harness", modelLabel: "openai/gpt-6.1-terra", rating: null, rd: null, ratedMatches: null }],
        [{ displayName: "omp-dolphin", modelLabel: null, rating: null, rd: null, ratedMatches: null }]] },
    ];
    const request = async (path: RequestInfo | URL) => new Response(JSON.stringify(
      path === "/watch/catalog" ? { matches } : { matches: [], nextPageToken: null },
    ));
    const data = createMatchesData(request, () => {}); data.refresh();
    await vi.waitFor(() => expect(data.view.live.status).toBe("ready"));
    expect(data.view.live.rows.map(row => row.lobbyId)).toEqual(["house", "unrated", "rated", "labelled"]);
    expect(data.view.live.rows[1]!.colonies).toEqual([[{ displayName: "alice", rating: null, rd: null, ratedMatches: null }], []]);
    expect(data.view.live.rows[3]!.colonies.map(colony => colony.map(seat => seat.modelLabel))).toEqual([["openai/gpt-6.1-terra"], [null]]);
    data.destroy();
  });
  it("refuses a live row without its players, or a seat with a partial rating", async () => {
    for (const row of [{ lobbyId: "a", startedAt: 1, rated: true, delaySeconds: 300 },
      { lobbyId: "a", startedAt: 1, rated: true, delaySeconds: 300, colonies: [[{ displayName: "x", rating: 1500, rd: null, ratedMatches: 1 }], []] }]) {
      const data = createMatchesData(async (path: RequestInfo | URL) => new Response(JSON.stringify(path === "/watch/catalog" ? { matches: [row] } : { matches: [], nextPageToken: null })), () => {});
      data.refresh();
      await vi.waitFor(() => expect(data.view.live.status).toBe("error"));
      data.destroy();
    }
  });
  it("does not turn failed requests or malformed responses into empty success", async () => {
    const data = createMatchesData(async () => new Response("{}"), () => {}); data.refresh();
    await vi.waitFor(() => expect(data.view.recordings.status).toBe("error")); expect(data.view.live.status).toBe("error"); data.destroy();
  });
});

describe("newest saved history without recent-upload discovery", () => {
  it("loads the newest stored page with saved metadata, then leaves older history to Load more", async () => {
    const records = Array.from({ length: 45 }, (_, minute) => saved(minute)).reverse();
    const calls: string[] = [];
    const data = createMatchesData(async input => {
      const path = String(input); calls.push(path);
      if (path === "/watch/catalog") return Response.json({ matches: [] });
      expect(path.startsWith("/matches")).toBe(true);
      const offset = Number(new URL(path, "http://fixture").searchParams.get("pageToken") ?? 0);
      return Response.json({ matches: records.slice(offset, offset + 20), nextPageToken: offset + 20 < records.length ? String(offset + 20) : null });
    }, () => {});
    data.refresh();
    await vi.waitFor(() => expect(data.view.recordings.rows).toHaveLength(20));
    expect(calls).toEqual(["/watch/catalog", "/matches"]);
    const first = recordingRows(data.view, "");
    expect(first.map(row => row.id)).toEqual(records.slice(0, 20).map(row => row.id));
    for (const row of first) expect(row).toMatchObject({ result: "Lake Hodges Colony won", models: "Very Large Colony: saved model · Lake Hodges Colony: other model", record: "Record complete" });
    expect(recordingsState(data.view, first.length).text).toBe("20 recordings loaded, newest first · more remain");
    data.more(); await vi.waitFor(() => expect(data.view.recordings.rows).toHaveLength(40));
    data.more(); await vi.waitFor(() => expect(data.view.next).toBeNull());
    expect(recordingRows(data.view, "").map(row => row.id)).toEqual(records.map(row => row.id));
    expect(calls.filter(path => path.startsWith("/matches"))).toEqual(["/matches", "/matches?pageToken=20", "/matches?pageToken=40"]);
    data.destroy();
  });

  it.each(["history first", "catalog first"])("publishes independent lists regardless of arrival order: %s", async order => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const data = createMatchesData(async input => {
      const path = String(input); calls.push(path);
      if (path === "/watch/catalog") {
        if (order === "history first") await held;
        return Response.json({ matches: [] });
      }
      expect(path).toBe("/matches");
      if (order === "catalog first") await held;
      return Response.json({ matches: [saved(40)], nextPageToken: "older" });
    }, () => {});
    data.refresh();
    await vi.waitFor(() => expect(order === "history first" ? data.view.recordings.status : data.view.live.status).toBe("ready"));
    release();
    await vi.waitFor(() => expect(data.view.recordings.status === "ready" && data.view.live.status === "ready").toBe(true));
    expect(calls).toEqual(["/watch/catalog", "/matches"]);
    expect(data.view.next).toBe("older"); data.destroy();
  });

  it("keeps each seat's recorded thinking level, service tier and handle, and reads a row from before them as null", async () => {
    const { seats: _seats, ...row } = saved(40);
    const data = createMatchesData(async input => {
      const path = String(input);
      if (path === "/watch/catalog") return Response.json({ matches: [] });
      return Response.json({ matches: [{ ...row, seats: [
        { seat: 0, colony: 0, modelLabel: "openai/gpt-6.1-sol", thinkingLevel: "xhigh", serviceTier: "fast", handle: "antwars/gpt-6-1-sol-xhigh-fast" },
        { seat: 1, colony: 1, modelLabel: "openai/gpt-6.1-sol", thinkingLevel: "high" },
        { seat: 2, colony: 1, modelLabel: "older", thinkingLevel: null, serviceTier: null, handle: null },
        { seat: 3, colony: 0, modelLabel: "oldest" },
      ] }], nextPageToken: null });
    }, () => {});
    data.refresh(); await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready"));
    expect(data.view.recordings.rows[0]!.seats.map(({ thinkingLevel, serviceTier, handle }) => [thinkingLevel, serviceTier, handle]))
      .toEqual([["xhigh", "fast", "antwars/gpt-6-1-sol-xhigh-fast"], ["high", null, null], [null, null, null], [null, null, null]]);
    data.destroy();
  });

  it("keeps each recording's match type, reads a row without one as untyped, and a type it does not know as null", async () => {
    const data = createMatchesData(async input => {
      const path = String(input);
      if (path === "/watch/catalog") return Response.json({ matches: [] });
      return Response.json({ matches: [
        { ...saved(44), matchType: { kind: "challenge", size: 1 } },
        { ...saved(43), matchType: null },
        saved(42),
        { ...saved(41), matchType: { kind: "house-2v2", size: 2 } },
      ], nextPageToken: null });
    }, () => {});
    data.refresh(); await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready"));
    expect(data.view.recordings.rows.map(row => row.matchType ?? null)).toEqual([{ kind: "challenge", size: 1 }, null, null, null]);
    expect(recordingRows(data.view, "").map(row => row.type)).toEqual(["Challenge · 1v1", null, null, null]);
    data.destroy();
  });

  it.each(["failure", "repeated cursor"])("retains successful stored rows and reports pagination %s", async mode => {
    const calls: string[] = [];
    const data = createMatchesData(async input => {
      const path = String(input); calls.push(path);
      if (path === "/watch/catalog") return Response.json({ matches: [] });
      if (path === "/matches") return Response.json({ matches: [saved(40)], nextPageToken: "older" });
      expect(path).toBe("/matches?pageToken=older");
      return mode === "failure" ? new Response("", { status: 503 }) : Response.json({ matches: [], nextPageToken: "older" });
    }, () => {});
    data.refresh(); await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready"));
    await turn(); data.more();
    await vi.waitFor(() => expect(data.view.recordings.status).toBe("error"));
    expect(data.view.recordings.rows.map(row => row.id)).toEqual([saved(40).id]);
    expect(calls.filter(path => path.startsWith("/matches"))).toHaveLength(2); data.destroy();
  });

  it("preserves refresh/pagination serialization and cancels an outstanding stored page", async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const calls: string[] = []; let canceled = false;
    const publish = vi.fn();
    const data = createMatchesData(async (input, init) => {
      const path = String(input); calls.push(path);
      if (path === "/watch/catalog") return Response.json({ matches: [] });
      if (path === "/matches") return Response.json({ matches: [saved(40)], nextPageToken: "older" });
      expect(path).toBe("/matches?pageToken=older"); entered();
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => { canceled = true; reject(init!.signal!.reason); }, { once: true }));
    }, publish);
    data.refresh(); await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready")); await turn();
    data.more(); await ready; data.more(); data.refresh();
    expect(calls.filter(path => path.startsWith("/matches"))).toHaveLength(2);
    data.destroy(); const emissions = publish.mock.calls.length; await turn();
    expect(canceled).toBe(true); expect(publish).toHaveBeenCalledTimes(emissions);
  });
});

describe("load more while the first load or a refresh is still in progress", () => {
  // 40 stored records, newest first, served 20 at a time. Each reset read mints a token
  // carrying its generation, so a stale pre-refresh token is distinguishable from the fresh one.
  const records = Array.from({ length: 40 }, (_, minute) => saved(minute)).reverse();
  function fixture() {
    const calls: string[] = [];
    let generation = 0;
    let holdCatalog: Promise<void> | null = null, holdReset: Promise<void> | null = null;
    const request = async (input: RequestInfo | URL) => {
      const path = String(input); calls.push(path);
      if (path === "/watch/catalog") { if (holdCatalog) await holdCatalog; return Response.json({ matches: [] }); }
      if (path === "/matches") {
        generation += 1;
        if (holdReset) await holdReset;
        return Response.json({ matches: records.slice(0, 20), nextPageToken: `gen${generation}-20` });
      }
      expect(path).toMatch(/^\/matches\?pageToken=gen\d+-20$/);
      return Response.json({ matches: records.slice(20, 40), nextPageToken: null });
    };
    const hold = () => { let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); return { held, release }; };
    return {
      calls, request,
      holdCatalog() { const h = hold(); holdCatalog = h.held; return () => { holdCatalog = null; h.release(); }; },
      holdReset() { const h = hold(); holdReset = h.held; return () => { holdReset = null; h.release(); }; },
    };
  }
  const ids = (rows: readonly Recording[]) => rows.map(row => row.id);

  it("loads the next older page on a click made after the first page arrives but before the catalog read finishes", async () => {
    const f = fixture(); const releaseCatalog = f.holdCatalog();
    const data = createMatchesData(f.request, () => {}); data.refresh();
    await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready"));
    expect(data.view.live.status).toBe("loading");
    data.more();
    await vi.waitFor(() => expect(data.view.next).toBeNull());
    expect(data.view.live.status).toBe("loading");
    releaseCatalog();
    await vi.waitFor(() => expect(data.view.live.status).toBe("ready"));
    expect(f.calls.filter(path => path.startsWith("/matches"))).toEqual(["/matches", "/matches?pageToken=gen1-20"]);
    expect(ids(data.view.recordings.rows)).toEqual(ids(records));
    data.destroy();
  });

  it("during a refresh, a click after the reset page arrives uses the reset page's token while the catalog is still pending", async () => {
    const f = fixture();
    const data = createMatchesData(f.request, () => {}); data.refresh();
    await vi.waitFor(() => expect(data.view.recordings.status === "ready" && data.view.live.status === "ready").toBe(true));
    expect(data.view.next).toBe("gen1-20");
    const releaseCatalog = f.holdCatalog();
    data.refresh();
    await vi.waitFor(() => expect(data.view.next).toBe("gen2-20"));
    expect(data.view.recordings.status).toBe("ready"); expect(data.view.live.status).toBe("loading");
    data.more();
    await vi.waitFor(() => expect(data.view.next).toBeNull());
    releaseCatalog();
    await vi.waitFor(() => expect(data.view.live.status).toBe("ready"));
    expect(f.calls.filter(path => path.startsWith("/matches"))).toEqual(["/matches", "/matches", "/matches?pageToken=gen2-20"]);
    expect(ids(data.view.recordings.rows)).toEqual(ids(records));
    data.destroy();
  });

  it("issues no request for a click while the refresh's history reset is in flight, when the list reads as loading", async () => {
    const f = fixture();
    const data = createMatchesData(f.request, () => {}); data.refresh();
    await vi.waitFor(() => expect(data.view.recordings.status === "ready" && data.view.live.status === "ready").toBe(true));
    const releaseReset = f.holdReset();
    data.refresh();
    await vi.waitFor(() => expect(f.calls.filter(path => path === "/matches")).toHaveLength(2));
    expect(data.view.recordings.status).toBe("loading");
    data.more(); await turn();
    expect(f.calls.filter(path => path.startsWith("/matches"))).toEqual(["/matches", "/matches"]);
    releaseReset();
    await vi.waitFor(() => expect(data.view.next).toBe("gen2-20"));
    data.more();
    await vi.waitFor(() => expect(data.view.next).toBeNull());
    expect(f.calls.filter(path => path.startsWith("/matches"))).toEqual(["/matches", "/matches", "/matches?pageToken=gen2-20"]);
    expect(ids(data.view.recordings.rows)).toEqual(ids(records));
    data.destroy();
  });
});

describe("matches page data: the Waiting card's queue read", () => {
  const waiting = [
    { displayName: "sam/first", mode: "1v1", waitingSeconds: 95 },
    { displayName: "antwars/agent0", mode: "house-2v2", waitingSeconds: 4 },
  ];
  it("reads /watch/queue on each refresh only when asked, beside the catalog and recordings", async () => {
    const answer = async (path: RequestInfo | URL) => new Response(JSON.stringify(
      path === "/watch/queue" ? { waiting } : path === "/watch/catalog" ? { matches: [] } : { matches: [], nextPageToken: null },
    ));
    const request = vi.fn(answer);
    const data = createMatchesData(request, () => {}, { waiting: true });
    expect(data.view.waiting).toEqual({ status: "loading", rows: [] });
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("ready"));
    expect(data.view.waiting.rows).toEqual(waiting);
    expect(request.mock.calls.map(call => call[0]).sort()).toEqual(["/matches", "/watch/catalog", "/watch/queue"]);
    data.destroy();

    const plain = vi.fn(answer);
    const other = createMatchesData(plain, () => {});
    other.refresh();
    await vi.waitFor(() => expect(other.view.recordings.status).toBe("ready"));
    expect(plain.mock.calls.map(call => call[0])).not.toContain("/watch/queue");
    other.destroy();
  });
  it("keeps a failed or malformed queue read to the Waiting card, keeping the last rows", async () => {
    let answer: unknown = { waiting };
    const request = async (path: RequestInfo | URL) => path === "/watch/queue"
      ? (answer === null ? new Response("", { status: 503 }) : new Response(JSON.stringify(answer)))
      : new Response(JSON.stringify(path === "/watch/catalog" ? { matches: [] } : { matches: [], nextPageToken: null }));
    const data = createMatchesData(request, () => {}, { waiting: true });
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("ready"));
    answer = null; data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("error"));
    expect(data.view.waiting.rows).toEqual(waiting);
    expect(data.view.live.status).toBe("ready");
    answer = { waiting: [{ ...waiting[0], ownerId: "x", mode: "5v5" }] }; data.refresh();
    await vi.waitFor(() => expect(data.view.live.status === "ready" && data.view.waiting.status !== "loading").toBe(true));
    expect(data.view.waiting.status).toBe("error");
    data.destroy();
  });
});

describe("matches page data: a stalled queue read never holds Refresh", () => {
  it("refreshes Live now and Recordings again while /watch/queue is still pending", async () => {
    const calls: string[] = [];
    let releaseQueue!: () => void;
    const stalled = new Promise<void>(resolve => { releaseQueue = resolve; });
    const request = async (path: RequestInfo | URL) => {
      calls.push(String(path));
      if (path === "/watch/queue") { await stalled; return new Response(JSON.stringify({ waiting: [] })); }
      return new Response(JSON.stringify(path === "/watch/catalog" ? { matches: [] } : { matches: [], nextPageToken: null }));
    };
    const data = createMatchesData(request, () => {}, { waiting: true });
    data.refresh();
    await vi.waitFor(() => expect(data.view.live.status === "ready" && data.view.recordings.status === "ready").toBe(true));
    expect(data.view.waiting.status).toBe("loading");
    data.refresh();
    await vi.waitFor(() => expect(calls.filter(path => path === "/watch/catalog")).toHaveLength(2));
    expect(calls.filter(path => path === "/matches")).toHaveLength(2);
    // The pending queue read is not repeated while it is outstanding.
    expect(calls.filter(path => path === "/watch/queue")).toHaveLength(1);
    releaseQueue();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("ready"));
    data.destroy();
  });
});

describe("matches page data: the Waiting card's lobby rows", () => {
  const waiting = [{ displayName: "sam/first", mode: "1v1", waitingSeconds: 95 }];
  const lobbies = [
    { mode: null, size: 2, seated: 3, colonies: [["ann", "cat"], ["bob"]], waitingSeconds: 250 },
    { mode: "2v2", size: 2, seated: 4, colonies: [["fay"], ["gus"]], waitingSeconds: 3 },
  ];
  const serve = (queue: () => unknown) => async (path: RequestInfo | URL) => new Response(JSON.stringify(
    path === "/watch/queue" ? queue() : path === "/watch/catalog" ? { matches: [] } : { matches: [], nextPageToken: null },
  ));
  it("lists the unstarted lobbies after the queue's agents, and none when the read carries none", async () => {
    let answer: unknown = { waiting, lobbies };
    const data = createMatchesData(serve(() => answer), () => {}, { waiting: true });
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("ready"));
    expect(data.view.waiting.rows).toEqual([...waiting, ...lobbies]);
    answer = { waiting };
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.rows).toEqual(waiting));
    data.destroy();
  });
  it("refuses a malformed lobby row as a failed read, keeping the last rows", async () => {
    let answer: unknown = { waiting, lobbies };
    const data = createMatchesData(serve(() => answer), () => {}, { waiting: true });
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("ready"));
    answer = { waiting, lobbies: [{ ...lobbies[0], size: 5 }] };
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("error"));
    expect(data.view.waiting.rows).toEqual([...waiting, ...lobbies]);
    data.destroy();
  });
  it("keeps a house challenge's tag, and refuses any other tag value", async () => {
    const challenge = { mode: null, size: 1, seated: 1, colonies: [[], ["player-7"]], waitingSeconds: 269, challenge: "house" };
    let answer: unknown = { waiting: [], lobbies: [challenge, lobbies[0]] };
    const data = createMatchesData(serve(() => answer), () => {}, { waiting: true });
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("ready"));
    expect(data.view.waiting.rows).toEqual([challenge, lobbies[0]]);
    answer = { waiting: [], lobbies: [{ ...challenge, challenge: "rated" }] };
    data.refresh();
    await vi.waitFor(() => expect(data.view.waiting.status).toBe("error"));
    data.destroy();
  });
});
