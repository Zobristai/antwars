import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import type { Identities } from "../../src/identity/identities.ts";
import { LAUNCHABLE_HANDLES } from "../../src/lobby/houseLaunchable.ts";
import { createChallengeSteps, type ChallengeLobbyRules, type ChallengeOutcome, type LaunchOutcome } from "../../src/lobby/challenges.ts";
import { createLobbies, type LobbyOutcome, type LobbySettings } from "../../src/lobby/lobbies.ts";
import { HOUSE_LABELS } from "../../src/rating/house.ts";
import { createFirestore, type Store } from "../../src/store/firestore.ts";

/**
 * House challenges against the Firestore emulator: the 20 shared and 5 per-owner daily limits by match day
 * across UTC midnight and under overlapping admissions, one active challenge per owner, place release, launch reports,
 * mirror games and the seated-elsewhere scan's ordering. Every count is checked by an oracle defined here from the
 * stored request and lobby documents alone, never by the production derivation in src/lobby/challenges.ts.
 */

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const MINUTE = 60_000;
const TTL = 15 * MINUTE;
const COUNTDOWN = 10_000;
const HANDLES = ["glm-5-3", "grok-4-7", "k3-1-pro", "gpt-6-astra"] as const;

let counter = 0;
const freshNamespace = () => `ch${process.pid}-${Date.now().toString(36)}-${counter++}`;
const storeFor = (namespace: string, request?: typeof fetch) => createFirestore({ projectId, namespace, emulatorHost: host, request });

function value<T>(outcome: Outcome<T> | LobbyOutcome<T> | ChallengeOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}
const reasonOf = (outcome: { ok: boolean; reason?: string }) => outcome.ok ? "ok" : outcome.reason;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Keyed { readonly id: string; readonly key: string }

/** One namespace standing in for the shared store; `lobbies(request)` is another server instance on it, sharing the clock. */
async function world(start: number, settings: Omit<LobbySettings, "now"> = {}) {
  const namespace = freshNamespace();
  const clock = { t: start };
  const ids = createIdentities(storeFor(namespace));
  const lobbies = (request?: typeof fetch, extra: Omit<LobbySettings, "now"> = {}) =>
    createLobbies(storeFor(namespace, request), createIdentities(storeFor(namespace)), { publicSlots: 1, privateSlots: 1, ...settings, ...extra, now: () => clock.t });
  const main = lobbies();
  const claim = async (name: string): Promise<Keyed> => { const c = value(await ids.claimUsername(name)); return { id: c.identity.id, key: c.key }; };
  const handleOf = async (owner: Keyed, name: string): Promise<Keyed> => { const c = value(await ids.createHandle(owner.key, name)); return { id: c.identity.id, key: c.key }; };
  const house = await claim("antwars");
  const houseHandles: Record<string, Keyed> = {};
  for (const handle of HANDLES) houseHandles[handle] = await handleOf(house, handle);
  const raw = (path: string) => storeFor(namespace).get(path);
  const requests: string[] = [];
  /** Requests a challenge, remembering the id for the oracle. */
  const request = async (builder: Keyed, handle: string = HANDLES[0], via = main) => {
    const outcome = await via.requestChallenge(builder.key, `antwars/${handle}`);
    if (outcome.ok) requests.push(outcome.value.requestId);
    return outcome;
  };
  /** The house seat joins a request's lobby. */
  const houseJoins = async (requestId: string) => {
    const req = (await raw(`challengeRequests/${requestId}`))!;
    return value(await main.join(req.lobbyId!, houseHandles[req.handle!]!.key));
  };
  const report = (requestId: string, outcome: LaunchOutcome, reason?: string) => main.reportChallengeLaunch(house.key, requestId, outcome, reason);
  /** A whole game: request, the house seat joins and is reported launched, and the match ends; on the clock's day. */
  const play = async (builder: Keyed, handle: string = HANDLES[0]) => {
    const { requestId, lobbyId } = value(await request(builder, handle));
    await houseJoins(requestId);
    value(await report(requestId, "launched"));
    value(await main.releaseSlot(lobbyId));
    return requestId;
  };
  return { namespace, clock, ids, lobbies, main, claim, handleOf, house, houseHandles, raw, requests, request, houseJoins, report, play };
}
type World = Awaited<ReturnType<typeof world>>;
type Lobbies = ReturnType<World["lobbies"]>;
type Reported = Awaited<ReturnType<World["report"]>>;
type Requested = Awaited<ReturnType<World["request"]>>;
type Joined = Awaited<ReturnType<Lobbies["join"]>>;

/**
 * The independent oracle. First every challenge lobby is resolved: the clock passes each lobby's createdAt + TTL +
 * countdown and the lobby is read, settling any waiting lobby. A charged game (stored launch report "launched" and a
 * filled colony-0 seat) must then have a match day: its startsAt, or its createdAt when it expired full awaiting a slot;
 * a lobby closed by a failed or unavailable report before the held seat joined is ended and uncharged with no match day. Returns charged games per UTC day, shared and per owner.
 */
async function oracle(w: World) {
  const docs = await Promise.all(w.requests.map(async (id) => {
    const request = (await w.raw(`challengeRequests/${id}`))!;
    return { id, request, lobbyId: request.lobbyId! };
  }));
  const latest = Math.max(...await Promise.all(docs.map(async ({ lobbyId }) => Number((await w.raw(`lobbies/${lobbyId}`))!.createdAt))));
  w.clock.t = Math.max(w.clock.t, latest + TTL + COUNTDOWN + 1);
  const shared = new Map<string, number>();
  const perOwner = new Map<string, number>();
  for (const { id, request, lobbyId } of docs) {
    value(await w.main.readLobby(lobbyId));
    const lobby = (await w.raw(`lobbies/${lobbyId}`))!;
    const seats = JSON.parse(lobby.seats!) as { colony: number }[];
    const heldFilled = seats.some((seat) => seat.colony === 0);
    const expired = !lobby.startsAt && (lobby.state === "open" || lobby.state === "waiting") && w.clock.t >= Number(lobby.createdAt) + TTL;
    const failedClosed = (request.launchReport === "failed" || request.launchReport === "unavailable") && lobby.state === "ended" && !lobby.startsAt;
    expect(lobby.startsAt !== "" || expired || failedClosed, `request ${id} is unresolved: ${JSON.stringify(lobby)}`).toBe(true);
    if (!(request.launchReport === "launched" && heldFilled)) continue;
    const matchDay = lobby.startsAt ? day(Number(lobby.startsAt)) : lobby.state === "waiting" && expired ? day(Number(lobby.createdAt)) : undefined;
    expect(matchDay, `charged request ${id} has no match day`).toBeDefined();
    shared.set(matchDay!, (shared.get(matchDay!) ?? 0) + 1);
    const ownerDay = `${request.ownerId}@${matchDay}`;
    perOwner.set(ownerDay, (perOwner.get(ownerDay) ?? 0) + 1);
  }
  for (const count of shared.values()) expect(count).toBeLessThanOrEqual(20);
  for (const count of perOwner.values()) expect(count).toBeLessThanOrEqual(5);
  return { shared: Object.fromEntries(shared), owner: (ownerId: string, on: string) => perOwner.get(`${ownerId}@${on}`) ?? 0 };
}

/**
 * Opens n contenders' transactions together. Each contender's
 * beginTransaction proceeds; its first transactional read is held until all n have their beginTransaction reply. Nothing is
 * held after a read or at commit, and retries pass unheld; lock waits the emulator imposes on the overlapping transactions are
 * its own. Every unsuccessful response's Firestore error-body status is read from a clone, so the store still receives the
 * response untouched. `check` asserts the transactions were open together and that every ABORTED response (error-body status
 * ABORTED, distinct from any other HTTP 409) was followed by a new attempt from the same contender, and prints each contender's
 * attempts and commit outcomes: a conflict and retry is reported when observed, never required, since a correctly serialized
 * run need not abort. It also prints the successful commits' client send and receive order and the emulator's commitTime;
 * only commitTime speaks to the emulator's own commit order, and tied or missing commitTimes leave that order unobserved.
 */
function startGate(n: number) {
  type Entry = { who: number; kind: string; status: number; error?: string; sent?: number; received?: number; commitTime?: string };
  const log: Entry[] = [];
  let begun = 0, sentCommits = 0, receivedCommits = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const errorStatusOf = (body: unknown) => {
    const error = (Array.isArray(body) ? body[0] : body as { error?: { status?: unknown } } | null)?.error;
    return typeof error?.status === "string" ? error.status : "no error status";
  };
  const contender = (who: number): typeof fetch => {
    let first = true, held = false;
    return async (input, init) => {
      const url = String(input);
      const kind = url.slice(url.lastIndexOf(":") + 1);
      if (!first && !held && (kind === "batchGet" || kind === "runQuery")) {
        held = true;
        await Promise.race([open, sleep(20_000, undefined, { ref: false }).then(() => {
          throw new Error(`startGate: ${n} contenders did not all begin a transaction within 20 s`);
        })]);
      }
      const sent = kind === "commit" ? ++sentCommits : undefined;
      const response = await fetch(input, init);
      const received = kind === "commit" ? ++receivedCommits : undefined;
      if (kind === "beginTransaction" || kind === "commit" || !response.ok) {
        const body: unknown = kind === "commit" || !response.ok ? await response.clone().json().catch(() => undefined) : undefined;
        log.push({
          who, kind, status: response.status, sent, received,
          ...(response.ok ? {} : { error: errorStatusOf(body) }),
          ...(kind === "commit" && response.ok ? { commitTime: (body as { commitTime?: string } | undefined)?.commitTime } : {}),
        });
      }
      if (kind === "beginTransaction" && first) {
        first = false;
        if (++begun === n) { log.push({ who: -1, kind: "release", status: 0 }); release(); }
      }
      return response;
    };
  };
  const check = (name: string) => {
    const released = log.findIndex((e) => e.kind === "release");
    expect(released, `${name}: the gate never opened`).toBeGreaterThan(-1);
    const summary = [...Array(n).keys()].map((who) => {
      const own = log.map((e, i) => ({ ...e, i })).filter((e) => e.who === who);
      const begins = own.filter((e) => e.kind === "beginTransaction");
      expect(begins[0]!.i, `${name}: contender ${who} began after the gate opened`).toBeLessThan(released);
      expect(own.some((e) => e.kind === "commit" && e.i < released), `${name}: contender ${who} committed before the gate opened`).toBe(false);
      for (const aborted of own.filter((e) => e.error === "ABORTED")) {
        expect(begins.some((b) => b.i > aborted.i), `${name}: contender ${who}'s ABORTED ${aborted.kind} was not followed by a new attempt`).toBe(true);
      }
      const aborts = own.filter((e) => e.error === "ABORTED").length;
      return {
        contender: who, attempts: begins.length, aborts, retried: aborts > 0 && begins.length > 1,
        commits: own.filter((e) => e.kind === "commit").map((e) => e.error ? `${e.status} ${e.error}` : String(e.status)),
        otherErrors: own.filter((e) => e.error && e.error !== "ABORTED").map((e) => `${e.kind} ${e.status} ${e.error}`),
      };
    });
    const retried = summary.filter((s) => s.retried).map((s) => s.contender);
    const committed = log.filter((e) => e.kind === "commit" && e.status === 200);
    const orderBy = (key: "sent" | "received") => [...committed].sort((a, b) => a[key]! - b[key]!).map((e) => e.who);
    const times = committed.map((e) => e.commitTime);
    const distinct = times.every(Boolean) && new Set(times).size === times.length;
    // RFC 3339 timestamps whose fractional seconds may be trimmed: pad to nanoseconds so they compare as text.
    const timeKey = (t: string) => t.replace(/(\.\d+)?Z$/, (tail) => (tail.length > 1 ? tail.slice(0, -1) : ".").padEnd(10, "0") + "Z");
    const emulatorOrder = distinct ? [...committed].sort((a, b) => timeKey(a.commitTime!).localeCompare(timeKey(b.commitTime!))).map((e) => e.who) : null;
    console.log(`[startGate] ${name}: ${JSON.stringify(summary)}; conflict and retry (ABORTED, then a new attempt) ${retried.length ? `observed for contender ${retried.join(", ")}` : "not observed"}`);
    console.log(`[startGate] ${name} successful commits: client send order ${JSON.stringify(orderBy("sent"))}, client receive order ${JSON.stringify(orderBy("received"))}, emulator commitTime ${JSON.stringify(committed.map((e) => ({ contender: e.who, commitTime: e.commitTime ?? null })))}; emulator commit order ${emulatorOrder ? JSON.stringify(emulatorOrder) : "not observed (commitTimes tied or missing)"}`);
    return { retried };
  };
  return { contender, check };
}

/** A fetch that, before its first request matching `when`, runs `competitor` to completion; nothing else is changed. */
function before(when: (url: string, body: string) => boolean, competitor: () => Promise<unknown>): typeof fetch {
  let fired = false;
  return async (input, init) => {
    if (!fired && when(String(input), typeof init?.body === "string" ? init.body : "")) {
      fired = true;
      await competitor();
    }
    return fetch(input, init);
  };
}
/** A fetch that runs `competitor` to completion before this server's first transaction begins, so before any read that would lock what it wrote. */
const committedFirst = (competitor: () => Promise<unknown>) => before((url) => url.endsWith(":beginTransaction"), competitor);
const isQuery = (url: string) => url.endsWith(":runQuery");
const readsQueueIndex = (url: string, body: string) => url.endsWith(":batchGet") && body.includes("/queues/public\"");

/** A public 1v1 player lobby between two fresh usernames, holding the one public slot. */
async function occupySlot(w: World, name: string) {
  const a = await w.claim(`${name}a`), b = await w.claim(`${name}b`);
  const { lobby } = value(await w.main.createLobby(a.key, "public", 1));
  value(await w.main.join(lobby.id, a.key));
  const started = value(await w.main.join(lobby.id, b.key));
  expect(started.state).toBe("holding");
  return lobby.id;
}

/** Whether an identity holds a seat in a lobby, read after the fact to confirm an injected competitor's write committed. */
const seatedIn = async (w: World, lobbyId: string, id: string) =>
  (JSON.parse((await w.raw(`lobbies/${lobbyId}`))!.seats!) as { id: string }[]).some((seat) => seat.id === id);

const D = Date.UTC(2026, 10, 2);
const at = (h: number, m: number, s = 0) => D + ((h * 60 + m) * 60 + s) * 1000;

describe.skipIf(!host)("house challenge limits against the Firestore emulator", { timeout: 180_000 }, () => {
  it("admits exactly one of two concurrent requests after 19 charged games, counts exactly 20 charged games, then refuses shared_daily_limit", async () => {
    const w = await world(at(12, 0));
    for (let n = 0; n < 19; n++) await w.play(await w.claim(`b${n}`));
    const gate = startGate(2);
    const [x, y] = [await w.claim("xx"), await w.claim("yy")];
    const results = await Promise.all([w.request(x, HANDLES[0], w.lobbies(gate.contender(0))), w.request(y, HANDLES[0], w.lobbies(gate.contender(1)))]);
    gate.check("shared limit");
    expect(results.map(reasonOf).sort()).toEqual(["ok", "shared_daily_limit"]);
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(0);
    const winner = value(results.find((r) => r.ok)!);
    await w.houseJoins(winner.requestId);
    value(await w.report(winner.requestId, "launched"));
    value(await w.main.releaseSlot(winner.lobbyId));
    expect(reasonOf(await w.request(await w.claim("zz")))).toBe("shared_daily_limit");
    expect(w.requests).toHaveLength(20);
    expect((await oracle(w)).shared).toEqual({ [day(at(12, 0))]: 20 });
  });

  it("admits one of two concurrent requests from an owner at 4, then refuses owner_daily_limit; counts are exact", async () => {
    const w = await world(at(12, 0));
    const owner = await w.claim("owner");
    const handles = await Promise.all(["h1", "h2", "h3", "h4", "h5", "h6", "h7"].map((name) => w.handleOf(owner, name)));
    for (const handle of handles.slice(0, 4)) await w.play(handle);
    const gate = startGate(2);
    const results = await Promise.all([w.request(handles[4]!, HANDLES[0], w.lobbies(gate.contender(0))), w.request(handles[5]!, HANDLES[1], w.lobbies(gate.contender(1)))]);
    gate.check("owner limit");
    // In this fixture the winner's challenge is still active when the other contender's attempt decides, so the one-active rule refuses it.
    expect(results.map(reasonOf).sort()).toEqual(["active_challenge", "ok"]);
    const admitted = results.find((r) => r.ok)!;
    await w.houseJoins(value(admitted).requestId);
    value(await w.report(value(admitted).requestId, "launched"));
    value(await w.main.releaseSlot(value(admitted).lobbyId));
    expect(reasonOf(await w.request(handles[6]!))).toBe("owner_daily_limit");
    expect(reasonOf(await w.request(await w.claim("other")))).toBe("ok");
    const counts = await oracle(w);
    expect(counts.shared).toEqual({ [day(at(12, 0))]: 5 });
    expect(counts.owner(owner.id, day(at(12, 0)))).toBe(5);
  });

  it("lists a key's username's challenges left today across its handles, from places held, and refuses an unknown key", async () => {
    const w = await world(at(12, 0));
    const owner = await w.claim("owner");
    const handles = await Promise.all(["h1", "h2", "h3"].map((name) => w.handleOf(owner, name)));
    const left = async (who: Keyed) => value(await w.main.listChallengeOpponentsFor(who.key)).usernameAllowanceLeft;
    // Without a key the list is unchanged: no per-username field.
    expect(Object.keys(await w.main.listChallengeOpponents()).sort()).toEqual(["allowanceLeft", "opponents", "resetsAt"]);
    expect(await left(owner)).toBe(5);
    await w.play(handles[0]!);
    await w.play(handles[1]!);
    // The username's count is shared by its own key and every handle; another username's is its own.
    expect([await left(owner), await left(handles[2]!), await left(await w.claim("other"))]).toEqual([3, 3, 5]);
    // The keyed list carries the keyless list's fields and values.
    const { usernameAllowanceLeft, ...rest } = value(await w.main.listChallengeOpponentsFor(owner.key));
    expect([usernameAllowanceLeft, rest]).toEqual([3, await w.main.listChallengeOpponents()]);
    // A pending request holds a place; a failed close before the held seat joins releases it.
    const pending = value(await w.request(handles[2]!, HANDLES[1]));
    expect(await left(owner)).toBe(2);
    value(await w.report(pending.requestId, "failed", "could not launch"));
    expect(await left(owner)).toBe(3);
    await w.play(handles[2]!);
    await w.play(owner);
    expect(await left(owner)).toBe(1);
    await w.play(handles[0]!);
    expect(await left(handles[1]!)).toBe(0);
    expect(reasonOf(await w.request(handles[1]!))).toBe("owner_daily_limit");
    expect(reasonOf(await w.main.listChallengeOpponentsFor("not-a-key"))).toBe("unknown_key");
    expect((await oracle(w)).owner(owner.id, day(at(12, 0)))).toBe(5);
  });

  it("gives an owner one active challenge across its handles under concurrent requests", async () => {
    const w = await world(at(12, 0));
    const owner = await w.claim("owner");
    const handles = await Promise.all(["h1", "h2", "h3"].map((name) => w.handleOf(owner, name)));
    const gate = startGate(3);
    const results = await Promise.all(handles.map((handle, i) => w.request(handle, HANDLES[i], w.lobbies(gate.contender(i)))));
    gate.check("one active");
    expect(results.map(reasonOf).sort()).toEqual(["active_challenge", "active_challenge", "ok"]);
    expect(reasonOf(await w.request(owner))).toBe("active_challenge");
  });

  it("keeps 20 shared and 5 per owner by match day when games carried over midnight take their slots after it", async () => {
    const w = await world(at(23, 30));
    const D1 = day(at(24, 0));
    // Two games played wholly on day D.
    await w.play(await w.claim("p1"));
    await w.play(await w.claim("p2"));
    // The slot is busy; three challenges fill before midnight and wait for it.
    w.clock.t = at(23, 40);
    const blocker = await occupySlot(w, "blk");
    w.clock.t = at(23, 50);
    const x = await w.claim("ownerx");
    const xHandles = await Promise.all(["x1", "x2", "x3", "x4", "x5"].map((name) => w.handleOf(x, name)));
    const carried: { requestId: string; lobbyId: string }[] = [];
    for (const [i, builder] of [await w.claim("ca"), await w.claim("cb"), x].entries()) {
      const admitted = value(await w.request(builder, HANDLES[i]));
      expect((await w.houseJoins(admitted.requestId)).state).toBe("waiting");
      value(await w.report(admitted.requestId, "launched"));
      carried.push(admitted);
    }
    // After midnight the slot frees and the three take it one after another.
    w.clock.t = at(24, 0, 1);
    value(await w.main.releaseSlot(blocker));
    for (const { lobbyId } of carried) {
      const lobby = value(await w.main.readLobby(lobbyId));
      expect(lobby.state).toBe("holding");
      expect(day(lobby.startsAt!)).toBe(D1);
      value(await w.main.releaseSlot(lobbyId));
    }
    // Owner X has 1 carried game on D+1; four more reach its 5.
    for (const handle of xHandles.slice(0, 4)) await w.play(handle);
    expect(reasonOf(await w.request(xHandles[4]!))).toBe("owner_daily_limit");
    // 3 carried + 4 + 13 new = 20 on D+1; the next request is refused.
    for (let n = 0; n < 13; n++) await w.play(await w.claim(`n${n}`));
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(0);
    expect(reasonOf(await w.request(await w.claim("late")))).toBe("shared_daily_limit");
    const counts = await oracle(w);
    expect(counts.shared).toEqual({ [day(at(12, 0))]: 2, [D1]: 20 });
    expect(counts.owner(x.id, D1)).toBe(5);
  });

  it("charges an early launched report to the match day after midnight with no second report, and a late one to the day played", async () => {
    const w = await world(at(23, 40));
    const D1 = day(at(24, 0));
    const blocker = await occupySlot(w, "blk");
    // Early: launched while the house seat is still empty, then the seat joins and waits for the slot past midnight.
    w.clock.t = at(23, 50);
    const early = value(await w.request(await w.claim("early")));
    value(await w.report(early.requestId, "launched"));
    expect((await w.houseJoins(early.requestId)).state).toBe("waiting");
    w.clock.t = at(24, 0, 5);
    value(await w.main.releaseSlot(blocker));
    expect(day(value(await w.main.readLobby(early.lobbyId)).startsAt!)).toBe(D1);
    value(await w.main.releaseSlot(early.lobbyId));
    expect(reasonOf(await w.report(early.requestId, "launched"))).toBe("already_reported");
    // Late: played and finished on D+1 at 23:55; launched reported after it ended, after the next midnight.
    w.clock.t = at(47, 55);
    const late = value(await w.request(await w.claim("late")));
    expect((await w.houseJoins(late.requestId)).state).toBe("holding");
    value(await w.main.releaseSlot(late.lobbyId));
    w.clock.t = at(48, 30);
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(20);
    value(await w.report(late.requestId, "launched"));
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(20);
    // Missing: played on D+2 with no report; it keeps its place and is uncharged.
    const missing = value(await w.request(await w.claim("missing")));
    await w.houseJoins(missing.requestId);
    value(await w.main.releaseSlot(missing.lobbyId));
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(19);
    const counts = await oracle(w);
    expect(counts.shared).toEqual({ [D1]: 2 });
  });

  it("plays a mirror challenge: the held handle challenges itself, seat 2 is its builder seat, and the game is charged once", async () => {
    const w = await world(at(12, 0));
    const handle = w.houseHandles[HANDLES[0]]!;
    const admitted = value(await w.request(handle));
    expect(admitted.seat).toBe(2);
    const lobby = await w.houseJoins(admitted.requestId);
    expect(lobby.colonies.map((colony) => colony.map((seat) => seat.id))).toEqual([[handle.id], [handle.id]]);
    expect([lobby.state, lobby.rated]).toEqual(["holding", false]);
    value(await w.report(admitted.requestId, "launched"));
    expect(reasonOf(await w.main.join(admitted.lobbyId, handle.key))).toBe("already_seated");
    value(await w.main.releaseSlot(admitted.lobbyId));
    // A second mirror whose held colony-0 seat never fills: the builder's colony-1 seat alone never makes it charged.
    w.clock.t = at(12, 20);
    const lone = w.houseHandles[HANDLES[1]]!;
    const unfilled = value(await w.request(lone, HANDLES[1]));
    expect(unfilled.seat).toBe(2);
    value(await w.report(unfilled.requestId, "launched"));
    w.clock.t = at(12, 35);
    expect(value(await w.main.challengeStatus(w.house.key, unfilled.requestId))).toMatchObject({ state: "expired", reason: "house_did_not_join", launchReport: "launched" });
    const counts = await oracle(w);
    expect(counts.shared).toEqual({ [day(at(12, 0))]: 1 });
  });

  it("returns a place on a failed close and on an unfilled expiry, each after an early launched report, and re-admits", async () => {
    const w = await world(at(12, 0));
    const first = value(await w.request(await w.claim("first")));
    value(await w.report(first.requestId, "launched"));
    w.clock.t = at(12, 10);
    const second = value(await w.request(await w.claim("second")));
    value(await w.report(second.requestId, "launched"));
    for (let n = 0; n < 18; n++) value(await w.request(await w.claim(`b${n}`)));
    expect(reasonOf(await w.request(await w.claim("c1")))).toBe("shared_daily_limit");
    // Failed close: the house seat never joined, so the failed report after launched is accepted.
    expect(value(await w.report(second.requestId, "failed", "player could not join")).state).toBe("house_unavailable");
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(1);
    value(await w.main.setChallengeAvailability(w.house.key, HANDLES[0], true));
    value(await w.request(await w.claim("c2")));
    expect(reasonOf(await w.request(await w.claim("c3")))).toBe("shared_daily_limit");
    // Unfilled expiry of the first request, 15 minutes after its creation, releases its place.
    w.clock.t = at(12, 15);
    expect(value(await w.main.challengeStatus(w.house.key, first.requestId))).toMatchObject({ state: "expired", reason: "house_did_not_join", launchReport: "launched" });
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(1);
    value(await w.request(await w.claim("c4")));
    const counts = await oracle(w);
    expect(counts.shared).toEqual({});
  });

  it("ends a challenge reported unavailable before the seat joins: house_unavailable with its reason, uncharged, its place returned, no handle marked", async () => {
    const w = await world(at(12, 0));
    const REASON = "maintenance";
    const availabilityBefore = await w.raw(`challengeAvailability/${HANDLES[0]}`);
    const rowOf = async () => (await w.main.listChallengeOpponents()).opponents.find((o) => o.handle === `antwars/${HANDLES[0]}`)!;
    const rowBefore = await rowOf();
    expect([rowBefore.available, rowBefore.reason]).toEqual([true, null]);
    const builder = await w.claim("builder");
    const told = value(await w.request(builder));
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(19);
    expect(reasonOf(await w.report(told.requestId, "unavailable"))).toBe("reason_required");
    expect(reasonOf(await w.report(told.requestId, "unavailable", "   "))).toBe("reason_required");
    expect((await w.raw(`challengeRequests/${told.requestId}`))!.launchReport).toBe("");
    expect(value(await w.report(told.requestId, "unavailable", REASON))).toEqual({ requestId: told.requestId, launchReport: "unavailable", state: "house_unavailable" });
    expect(await w.raw(`lobbies/${told.lobbyId}`)).toMatchObject({ state: "ended", outcome: "not_played" });
    expect(value(await w.main.challengeStatus(builder.key, undefined))).toEqual({
      requestId: told.requestId, lobbyId: told.lobbyId, handle: `antwars/${HANDLES[0]}`, state: "house_unavailable", reason: "challenges are unavailable right now: maintenance" });
    expect(value(await w.main.challengeStatus(w.house.key, told.requestId)).launchReport).toBe("unavailable");
    // Its place is returned and nothing about the handle changed: no availability write, the same listing, admission open.
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(20);
    expect(await w.raw(`challengeAvailability/${HANDLES[0]}`)).toEqual(availabilityBefore);
    expect(await rowOf()).toEqual(rowBefore);
    // One report: every later one, of any outcome, is refused with nothing written.
    for (const outcome of ["launched", "failed", "unavailable"] as const) {
      expect(reasonOf(await w.report(told.requestId, outcome, "again")), outcome).toBe("already_reported");
    }
    expect(await w.raw(`challengeAvailability/${HANDLES[0]}`)).toEqual(availabilityBefore);
    expect((await w.raw(`challengeRequests/${told.requestId}`))).toMatchObject({ launchReport: "unavailable", reportReason: REASON, closedByFailure: "true" });
    // The same handle is challengeable at once, by the same builder and by another.
    value(await w.request(builder));
    value(await w.request(await w.claim("another"), HANDLES[0]));
    expect((await oracle(w)).shared).toEqual({});
  });

  it("refuses unavailable once the held seat has joined, and leaves an expired challenge expired with no handle marked", async () => {
    const w = await world(at(12, 0));
    const seated = value(await w.request(await w.claim("seated")));
    await w.houseJoins(seated.requestId);
    expect(reasonOf(await w.report(seated.requestId, "unavailable", "house challenges are unavailable right now"))).toBe("house_seated");
    expect((await w.raw(`challengeRequests/${seated.requestId}`))!.launchReport).toBe("");
    value(await w.report(seated.requestId, "launched"));
    expect(reasonOf(await w.report(seated.requestId, "unavailable", "late"))).toBe("already_reported");
    value(await w.main.releaseSlot(seated.lobbyId));

    const availabilityBefore = await w.raw(`challengeAvailability/${HANDLES[1]}`);
    const late = value(await w.request(await w.claim("late"), HANDLES[1]));
    w.clock.t = at(12, 15);
    expect(value(await w.report(late.requestId, "unavailable", "house challenges are unavailable right now")).state).toBe("expired");
    expect(value(await w.main.challengeStatus(w.house.key, late.requestId))).toMatchObject({ state: "expired", reason: "house_did_not_join", launchReport: "unavailable" });
    expect((await w.raw(`lobbies/${late.lobbyId}`))!.state).toBe("open");
    expect(await w.raw(`challengeAvailability/${HANDLES[1]}`)).toEqual(availabilityBefore);
    const row = (await w.main.listChallengeOpponents()).opponents.find((o) => o.handle === `antwars/${HANDLES[1]}`)!;
    expect([row.available, row.reason]).toEqual([true, null]);
    expect((await oracle(w)).shared).toEqual({ [day(at(12, 0))]: 1 });
  });

  it("charges a filled, launched lobby that expires awaiting a slot to its creation day, reason no_match_slot, freeing the next day", async () => {
    const w = await world(at(23, 40));
    const blocker = await occupySlot(w, "blk");
    w.clock.t = at(23, 50);
    const full = value(await w.request(await w.claim("full")));
    expect((await w.houseJoins(full.requestId)).state).toBe("waiting");
    value(await w.report(full.requestId, "launched"));
    // Its second candidate day is D+1 until it expires; it never takes the busy slot.
    w.clock.t = at(24, 4, 59);
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(19);
    w.clock.t = at(24, 5, 0);
    expect(value(await w.main.challengeStatus(w.house.key, full.requestId))).toMatchObject({ state: "expired", reason: "no_match_slot", launchReport: "launched" });
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(20);
    expect((await w.raw(`lobbies/${blocker}`))!.state).toBe("holding");
    const counts = await oracle(w);
    expect(counts.shared).toEqual({ [day(at(23, 50))]: 1 });
  });

  it("keeps an owner's challenge active across UTC midnight, refusing a second until it ends", async () => {
    const w = await world(at(23, 55));
    const owner = await w.claim("owner");
    const [h1, h2] = await Promise.all(["h1", "h2"].map((name) => w.handleOf(owner, name)));
    value(await w.request(h1!));
    w.clock.t = at(24, 2);
    expect(reasonOf(await w.request(h2!, HANDLES[1]))).toBe("active_challenge");
    w.clock.t = at(24, 10);
    expect(reasonOf(await w.request(h2!, HANDLES[1]))).toBe("ok");
  });

  // The report/admission, failed-report/join and report/expiry races below run in both deterministic orders, where the competitor commits before the subject's transaction begins
  // (sequential ordering checks), and once concurrently through startGate, where the winner is whatever the emulator serializes.
  it.each(["the reports commit before the admission reads", "the admission commits before the reports read", "concurrently"])("orders launched and failed reports racing an admission at 19 places: all commit and the bounds hold (%s)", async (order) => {
    const w = await world(at(12, 0));
    const joined = value(await w.request(await w.claim("joined")));
    expect((await w.houseJoins(joined.requestId)).state).toBe("holding");
    const open = value(await w.request(await w.claim("open"), HANDLES[1]));
    for (let n = 0; n < 17; n++) value(await w.request(await w.claim(`b${n}`)));
    const x = await w.claim("xx");
    const launch = (via: Lobbies) => via.reportChallengeLaunch(w.house.key, joined.requestId, "launched");
    const fail = (via: Lobbies) => via.reportChallengeLaunch(w.house.key, open.requestId, "failed", "launch refused");
    const admit = (via: Lobbies) => w.request(x, HANDLES[0], via);
    let launched!: Reported, failed!: Reported, admitted!: Requested;
    if (order === "concurrently") {
      const gate = startGate(3);
      [launched, failed, admitted] = await Promise.all([launch(w.lobbies(gate.contender(0))), fail(w.lobbies(gate.contender(1))), admit(w.lobbies(gate.contender(2)))]);
      gate.check("reports vs admission at 19");
    } else if (order.startsWith("the reports")) {
      admitted = await admit(w.lobbies(committedFirst(async () => { launched = await launch(w.main); failed = await fail(w.main); })));
    } else {
      launched = await launch(w.lobbies(committedFirst(async () => { admitted = await admit(w.main); })));
      failed = await fail(w.main);
    }
    expect([reasonOf(launched), reasonOf(failed), reasonOf(admitted)]).toEqual(["ok", "ok", "ok"]);
    expect(value(failed).state).toBe("house_unavailable");
    // 19 held, one closed by the failed report, one admitted: 19.
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(1);
    value(await w.request(await w.claim("yy")));
    expect(reasonOf(await w.request(await w.claim("zz")))).toBe("shared_daily_limit");
    value(await w.main.releaseSlot(joined.lobbyId));
    const counts = await oracle(w);
    expect(counts.shared).toEqual({ [day(at(12, 0))]: 1 });
  });

  it.each(["the held seat's join commits first", "the failed report commits first", "concurrently"])("lets exactly one of a failed report and the held seat's join take effect when they race (%s)", async (order) => {
    const w = await world(at(12, 0));
    const builder = await w.claim("builder");
    const { requestId, lobbyId } = value(await w.request(builder));
    value(await w.report(requestId, "launched"));
    const seat = w.houseHandles[HANDLES[0]]!.key;
    let join!: Joined, failed!: Reported;
    if (order === "concurrently") {
      const gate = startGate(2);
      [join, failed] = await Promise.all([
        w.lobbies(gate.contender(0)).join(lobbyId, seat),
        w.lobbies(gate.contender(1)).reportChallengeLaunch(w.house.key, requestId, "failed", "launch refused"),
      ]);
      gate.check("failed report vs held-seat join");
      // The emulator chooses the winner; it is recorded, and the branch below asserts the outcome that winner implies.
      console.log(`[race] failed report vs held-seat join, concurrently: ${join.ok ? "the join" : "the failed report"} took effect`);
    } else if (order.startsWith("the held seat")) {
      failed = await w.lobbies(committedFirst(async () => { join = await w.main.join(lobbyId, seat); })).reportChallengeLaunch(w.house.key, requestId, "failed", "launch refused");
    } else {
      join = await w.lobbies(committedFirst(async () => { failed = await w.report(requestId, "failed", "launch refused"); })).join(lobbyId, seat);
    }
    const status = value(await w.main.challengeStatus(w.house.key, requestId));
    const row = (await w.main.listChallengeOpponents()).opponents.find((o) => o.handle === `antwars/${HANDLES[0]}`)!;
    // Each deterministic order fixes its winner, and the case asserts that winner: one case exercises each.
    if (order !== "concurrently") expect(join.ok).toBe(order.startsWith("the held seat"));
    if (join.ok) {
      // The seat joined first: the failed report is refused and the game plays on, charged by its launched report.
      expect(reasonOf(failed)).toBe("house_seated");
      expect([join.value.state, status.state, row.available]).toEqual(["holding", "waiting_for_slot", true]);
      value(await w.main.releaseSlot(lobbyId));
      expect((await oracle(w)).shared).toEqual({ [day(at(12, 0))]: 1 });
    } else {
      // The failed report closed the lobby first: the join is refused and nothing is charged.
      expect(value(failed).state).toBe("house_unavailable");
      expect([status.state, (await w.raw(`lobbies/${lobbyId}`))!.state, row.available]).toEqual(["house_unavailable", "ended", false]);
      expect((await oracle(w)).shared).toEqual({});
    }
  });

  it.each(["the report commits before the admission reads", "the admission commits before the report reads", "concurrently"])("races a launched report with an admission at the instant of expiry: the expired request stays uncharged and its place is reused (%s)", async (order) => {
    const w = await world(at(12, 0));
    const first = value(await w.request(await w.claim("first")));
    w.clock.t = at(12, 5);
    for (let n = 0; n < 19; n++) value(await w.request(await w.claim(`b${n}`)));
    w.clock.t = at(12, 14, 59);
    expect(reasonOf(await w.request(await w.claim("early")))).toBe("shared_daily_limit");
    w.clock.t = at(12, 15);
    const x = await w.claim("xx");
    const launch = (via: Lobbies) => via.reportChallengeLaunch(w.house.key, first.requestId, "launched");
    const admit = (via: Lobbies) => w.request(x, HANDLES[0], via);
    let launched!: Reported, admitted!: Requested;
    if (order === "concurrently") {
      const gate = startGate(2);
      [launched, admitted] = await Promise.all([launch(w.lobbies(gate.contender(0))), admit(w.lobbies(gate.contender(1)))]);
      gate.check("report vs admission at expiry");
    } else if (order.startsWith("the report")) admitted = await admit(w.lobbies(committedFirst(async () => { launched = await launch(w.main); })));
    else launched = await launch(w.lobbies(committedFirst(async () => { admitted = await admit(w.main); })));
    expect([reasonOf(launched), reasonOf(admitted)]).toEqual(["ok", "ok"]);
    expect(value(launched).state).toBe("expired");
    expect((await w.main.listChallengeOpponents()).allowanceLeft).toBe(0);
    // A failed report after that expiry leaves it expired and uncharged, and marks the handle unavailable.
    expect(value(await w.report(first.requestId, "failed", "launch refused")).state).toBe("expired");
    expect(value(await w.main.challengeStatus(w.house.key, first.requestId))).toMatchObject({ state: "expired", reason: "house_did_not_join", launchReport: "failed" });
    const row = (await w.main.listChallengeOpponents()).opponents.find((o) => o.handle === `antwars/${HANDLES[0]}`)!;
    expect([row.available, row.reason]).toEqual([false, "launch refused"]);
    expect((await w.raw(`lobbies/${first.lobbyId}`))!.state).toBe("open");
    expect((await oracle(w)).shared).toEqual({});
  });
});

describe.skipIf(!host)("house challenge seated-elsewhere scan against the Firestore emulator", { timeout: 120_000 }, () => {
  it("refuses a caller who joins a private lobby after the locked reads and before the recent-lobby query", async () => {
    const w = await world(at(12, 0));
    const caller = await w.claim("caller"), host1 = await w.claim("host1");
    const { lobby, inviteToken } = value(await w.main.createLobby(host1.key, "private", 1));
    let joined = false;
    const via = w.lobbies(before(isQuery, async () => { value(await w.main.join(lobby.id, caller.key, inviteToken)); joined = true; }));
    expect(reasonOf(await w.request(caller, HANDLES[0], via))).toBe("seated_elsewhere");
    // The injected join committed: it resolved ok and its seat is stored.
    expect([joined, await seatedIn(w, lobby.id, caller.id)]).toEqual([true, true]);
    expect(await w.raw(`challengeOwners/${caller.id}`)).toBeNull();
  });

  it("refuses a caller who joins a private lobby before the recent-lobby query while a held place was released before the locked reads", async () => {
    const w = await world(at(12, 0));
    const releasable = value(await w.request(await w.claim("rel"), HANDLES[1]));
    for (let n = 0; n < 19; n++) value(await w.request(await w.claim(`b${n}`)));
    const caller = await w.claim("caller"), host1 = await w.claim("host1");
    const { lobby, inviteToken } = value(await w.main.createLobby(host1.key, "private", 1));
    const today = `challengeAllowance/${day(at(12, 0))}`;
    let releaseFired = false, joinFired = false, released = false, joined = false;
    const via: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!releaseFired && url.endsWith(":batchGet")) {
        releaseFired = true;
        expect(value(await w.report(releasable.requestId, "failed", "launch refused")).state).toBe("house_unavailable");
        released = true;
      }
      if (!joinFired && isQuery(url)) {
        joinFired = true;
        value(await w.main.join(lobby.id, caller.key, inviteToken));
        joined = true;
      }
      return fetch(input, init);
    };
    const before = await w.raw(today);
    expect(reasonOf(await w.request(caller, HANDLES[0], w.lobbies(via)))).toBe("seated_elsewhere");
    // Both injected competitors committed: each resolved ok and its write is stored.
    expect([released, joined]).toEqual([true, true]);
    expect([(await w.raw(`challengeRequests/${releasable.requestId}`))!.launchReport, (await w.raw(`lobbies/${releasable.lobbyId}`))!.state]).toEqual(["failed", "ended"]);
    expect(await seatedIn(w, lobby.id, caller.id)).toBe(true);
    expect(await w.raw(`challengeOwners/${caller.id}`)).toBeNull();
    expect(await w.raw(today)).toEqual(before);
    // The released place was free: an unseated caller takes it.
    expect(reasonOf(await w.request(await w.claim("free")))).toBe("ok");
  });

  it("finds the caller in each of the seven places a seat can be, and admits an unseated caller", async () => {
    const w = await world(at(11, 30), { publicSlots: 2 });
    const fill = async (name: string, kind: "public" | "private", size: 1 | 2 = 1) => {
      const made = value(await w.main.createLobby((await w.claim(`${name}c`)).key, kind, size));
      return { id: made.lobby.id, join: (who: Keyed) => w.main.join(made.lobby.id, who.key, made.inviteToken) };
    };
    const seat = async (name: string) => w.claim(name);
    // Older than the recent-lobby cutoff by 12:00, found through the slot and queue indexes.
    const publicHolder = await seat("pubhold"), privateHolder = await seat("privhold"), slotPair = await seat("slotpair"), queuedPair = await seat("queuedpair");
    const pub = await fill("pub", "public");
    value(await pub.join(publicHolder));
    expect(value(await pub.join(await seat("pubfill"))).state).toBe("holding");
    value(await w.main.joinQueue((await seat("slotpartner")).key, "1v1"));
    expect(value(await w.main.joinQueue(slotPair.key, "1v1")).state).toBe("matched");
    const priv = await fill("priv", "private");
    value(await priv.join(privateHolder));
    expect(value(await priv.join(await seat("privfill"))).state).toBe("holding");
    value(await w.main.joinQueue((await seat("queuedpartner")).key, "1v1"));
    expect(value(await w.main.joinQueue(queuedPair.key, "1v1")).state).toBe("matched");
    // Recent, found by the recent-lobby query.
    w.clock.t = at(12, 0);
    const waitingSeat = await seat("waiting"), openPublic = await seat("openpub"), openPrivate = await seat("openpriv");
    const waiting = await fill("wait", "public");
    value(await waiting.join(waitingSeat));
    expect(value(await waiting.join(await seat("waitfill"))).state).toBe("waiting");
    value(await (await fill("op", "public", 2)).join(openPublic));
    value(await (await fill("opp", "private")).join(openPrivate));
    const slotLobbies = await Promise.all(["slots/public-0", "slots/public-1", "slots/private-0"].map(async (path) => (await w.raw(path))?.lobbyId));
    expect(slotLobbies.every(Boolean)).toBe(true);
    expect((await w.raw("queues/public"))?.lobbies?.trim()).toBeTruthy();
    for (const who of [publicHolder, privateHolder, slotPair, queuedPair, waitingSeat, openPublic, openPrivate]) {
      expect(reasonOf(await w.request(who)), who.id).toBe("seated_elsewhere");
    }
    expect(reasonOf(await w.request(await seat("unseated")))).toBe("ok");
  });

  it("refuses a caller who leaves an old slot-holding lobby for a recent one before the slot read", async () => {
    const w = await world(at(11, 0));
    const caller = await w.claim("caller"), rival = await w.claim("rival");
    const { lobby: old } = value(await w.main.createLobby(caller.key, "public", 1));
    value(await w.main.join(old.id, caller.key));
    expect(value(await w.main.join(old.id, rival.key)).state).toBe("holding");
    w.clock.t = at(12, 0);
    const { lobby: recent } = value(await w.main.createLobby(rival.key, "public", 1));
    let moved = false;
    const via = w.lobbies(before(readsQueueIndex, async () => {
      value(await w.main.releaseSlot(old.id));
      value(await w.main.join(recent.id, caller.key));
      moved = true;
    }));
    expect(reasonOf(await w.request(caller, HANDLES[0], via))).toBe("seated_elsewhere");
    // The injected release and join committed: both resolved ok, the old lobby no longer holds the slot and the new seat is stored.
    expect([moved, (await w.raw("slots/public-0"))?.lobbyId === old.id, await seatedIn(w, recent.id, caller.id)]).toEqual([true, false, true]);
  });

  it("refuses a caller whose old queue pairing has already moved from the queue to the slot (sequential moved-state check)", async () => {
    const w = await world(at(11, 0));
    const blocker = await occupySlot(w, "blk");
    const caller = await w.claim("caller"), partner = await w.claim("partner");
    value(await w.main.joinQueue(partner.key, "1v1"));
    const matched = value(await w.main.joinQueue(caller.key, "1v1"));
    expect(matched.state).toBe("matched");
    const pairing = (await w.raw(`queueEntries/${caller.id}`))!.lobbyId!;
    expect((await w.raw("queues/public"))!.lobbies).toContain(pairing);
    w.clock.t = at(12, 0);
    // The move completes before the request starts: this checks the moved state, not a move overlapping the admission.
    value(await w.main.releaseSlot(blocker));
    expect((await w.raw("queues/public"))?.lobbies ?? "").not.toContain(pairing);
    expect([(await w.raw("slots/public-0"))?.lobbyId, (await w.raw(`lobbies/${pairing}`))!.state]).toEqual([pairing, "holding"]);
    expect(reasonOf(await w.request(caller))).toBe("seated_elsewhere");
    // The same pairing, still waiting in the queue, is found there too.
    const w2 = await world(at(11, 0));
    await occupySlot(w2, "blk");
    const caller2 = await w2.claim("caller"), partner2 = await w2.claim("partner");
    value(await w2.main.joinQueue(partner2.key, "1v1"));
    value(await w2.main.joinQueue(caller2.key, "1v1"));
    w2.clock.t = at(12, 0);
    expect(reasonOf(await w2.request(caller2))).toBe("seated_elsewhere");
  });

  it("finds a seat on the last page of recent lobbies, and admits an unseated caller while others join between pages", async () => {
    const w = await world(at(12, 0), { challengeScanPageSize: 2 });
    const caller = await w.claim("caller"), other = await w.claim("other");
    const made: string[] = [];
    for (let n = 0; n < 5; n++) {
      made.push(value(await w.main.createLobby((await w.claim(`c${n}`)).key, "public", 2)).lobby.id);
      w.clock.t += 1_000;
    }
    value(await w.main.join(made[0]!, caller.key)); // the oldest recent lobby: page 3 of 3
    expect(reasonOf(await w.request(caller))).toBe("seated_elsewhere");
    let pages = 0, joinedBetween = false;
    const third = await w.claim("third");
    const between: typeof fetch = async (input, init) => {
      if (isQuery(String(input)) && pages++ === 1) {
        value(await w.main.join(made[1]!, other.key));
        value(await w.main.join(made[2]!, third.key));
        joinedBetween = true;
      }
      return fetch(input, init);
    };
    expect(reasonOf(await w.request(await w.claim("free"), HANDLES[0], w.lobbies(between)))).toBe("ok");
    expect(pages).toBe(3);
    // The injected joins committed: both resolved ok and their seats are stored.
    expect([joinedBetween, await seatedIn(w, made[1]!, other.id), await seatedIn(w, made[2]!, third.id)]).toEqual([true, true, true]);
  });
});

describe("the house handle list", () => {
  it("lists every HOUSE_LABELS handle in its order except antwars/gpt-6-1-terra, a recording label and not a seat", async () => {
    // A store with no documents: every handle available, no places held.
    const store = { transaction: async (step: (read: (paths: readonly string[]) => Promise<Map<string, null>>) => Promise<{ result: unknown }>) =>
      (await step(async paths => new Map(paths.map(path => [path, null])))).result } as unknown as Store;
    const steps = createChallengeSteps(store, {} as Identities, { now: () => Date.UTC(2026, 10, 4) } as ChallengeLobbyRules);
    const handles = (await steps.listOpponents()).opponents.map(entry => entry.handle);
    expect(Object.keys(HOUSE_LABELS)).toContain("gpt-6-1-terra");
    expect(handles).not.toContain("antwars/gpt-6-1-terra");
    expect(handles).toEqual(Object.keys(HOUSE_LABELS).filter(handle => handle !== "gpt-6-1-terra").map(handle => `antwars/${handle}`));
  });

  it("with no records, lists exactly the 23 launch-table handles available and every off-table seat closed", async () => {
    const store = { transaction: async (step: (read: (paths: readonly string[]) => Promise<Map<string, null>>) => Promise<{ result: unknown }>) =>
      (await step(async paths => new Map(paths.map(path => [path, null])))).result } as unknown as Store;
    const steps = createChallengeSteps(store, {} as Identities, { now: () => Date.UTC(2026, 10, 4) } as ChallengeLobbyRules);
    const opponents = (await steps.listOpponents()).opponents;
    const onTable = new Set(LAUNCHABLE_HANDLES.map(handle => `antwars/${handle}`));
    expect(LAUNCHABLE_HANDLES).toHaveLength(23);
    expect(opponents.filter(o => o.available).map(o => o.handle).sort()).toEqual([...onTable].sort());
    for (const o of opponents) {
      expect([o.handle, o.available, o.reason]).toEqual(onTable.has(o.handle) ? [o.handle, true, null] : [o.handle, false, "not on the house launch table"]);
    }
    // antwars/mistral-large-latest, the reported case: on the House table, off the launch table, closed with no record.
    expect(opponents.find(o => o.handle === "antwars/mistral-large-latest")).toMatchObject({ available: false, reason: "not on the house launch table" });
  });
});
