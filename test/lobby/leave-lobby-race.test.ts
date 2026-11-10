import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type Lobbies, type Lobby, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createFirestore } from "../../src/store/firestore.ts";

/**
 * A leave racing the join that fills a lobby, or the creator's early start, against the Firestore emulator. Joins stop
 * when the lobby starts, and a leave is refused from then on, so the two outcomes exclude each other: either the lobby
 * starts with the leaver seated and the leave is refused "started", or the leave applies first and the leaver is never
 * seated in a started lobby. Each race runs in both forced orders, so both outcomes are asserted on every run, and then
 * concurrently, where only the exclusive outcome is asserted, whichever side wins.
 */

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const CONCURRENT_ROUNDS = 3;

let counter = 0;
const freshNamespace = () => `lr${process.pid}-${Date.now().toString(36)}-${counter++}`;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}
const reasonOf = (outcome: { ok: boolean; reason?: string }) => outcome.ok ? "ok" : outcome.reason;
const seatIdsOf = (lobby: Lobby) => lobby.colonies.flat().map((seat) => seat.id).sort();

interface Keyed { readonly id: string; readonly key: string }
type Op<T> = (lobbies: Lobbies) => Promise<T>;

/** One namespace standing in for the shared store; `lobbies(request)` is another server instance on it. */
function world() {
  const namespace = freshNamespace();
  const clock = { t: Date.UTC(2026, 10, 10, 9, 0, 0) };
  const storeFor = (request?: typeof fetch) => createFirestore({ projectId, namespace, emulatorHost: host, ...(request ? { request } : {}) });
  const lobbies = (request?: typeof fetch) => {
    const store = storeFor(request);
    return createLobbies(store, createIdentities(store), { publicSlots: 1, privateSlots: 1, now: () => clock.t });
  };
  const ids = createIdentities(storeFor());
  const main = lobbies();
  const claim = async (name: string): Promise<Keyed> => {
    const claimed = value(await ids.claimUsername(name));
    return { id: claimed.identity.id, key: claimed.key };
  };
  const raw = (lobbyId: string) => storeFor().get(`lobbies/${lobbyId}`);
  const stored = async (lobbyId: string) => {
    const fields = (await raw(lobbyId))!;
    return { state: fields.state, seatIds: (JSON.parse(fields.seats!) as { id: string }[]).map((seat) => seat.id).sort() };
  };
  return { lobbies, main, claim, raw, stored };
}
type World = ReturnType<typeof world>;

/**
 * Whether a request reads the lobby document: a transactional batchGet naming it, or a plain GET of it. The key lookup
 * each operation makes first (its own transaction) reads identity documents only, so this matches the operation's
 * lobby transaction, never the key lookup.
 */
function readsLobby(lobbyId: string, input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  const url = String(input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.endsWith(":batchGet")) return body.includes(`/lobbies/${lobbyId}"`);
  return (init?.method ?? "GET") === "GET" && url.endsWith(`/lobbies/${encodeURIComponent(lobbyId)}`);
}
const transactionOf = (init: Parameters<typeof fetch>[1]) => {
  try { return (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { transaction?: string }).transaction ?? null; } catch { return null; }
};

/**
 * Runs `first` to completion just before `second` first reads the lobby. By then `second` has resolved its key and
 * begun its lobby transaction, which has read nothing yet, so `first` commits unhindered and `second` then reads what
 * `first` wrote: the order of the two lobby transactions is forced and nothing else.
 */
async function inOrder<A, B>(w: World, lobbyId: string, first: Op<A>, second: Op<B>): Promise<[A, B]> {
  let firstResult: A | undefined;
  let fired = false;
  const after: typeof fetch = async (input, init) => {
    if (!fired && readsLobby(lobbyId, input, init)) {
      fired = true;
      firstResult = await first(w.main);
    }
    return fetch(input, init);
  };
  const secondResult = await second(w.lobbies(after));
  expect(fired, "the second operation never read the lobby").toBe(true);
  return [firstResult as A, secondResult];
}

/**
 * Runs two operations with their lobby transactions open together. Each contender's first read of the lobby document
 * is held at a barrier until both contenders have reached theirs, so both lobby transactions have begun and neither has
 * read the lobby, let alone committed, when either proceeds. The held transactions are tracked: every commit either
 * contender sends after reaching the barrier (the held transaction's, or a retry's after the emulator aborts it) must
 * come after both reached it. Retries pass unheld and rerun against fresh reads.
 */
async function together<A, B>(w: World, lobbyId: string, a: Op<A>, b: Op<B>): Promise<[A, B]> {
  type Event = { readonly who: string; readonly kind: "reach" | "commit"; readonly transaction: string | null; status?: number };
  const events: Event[] = [];
  const held = new Map<string, string | null>();
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  const contender = (who: string): typeof fetch => async (input, init) => {
    if (!held.has(who) && readsLobby(lobbyId, input, init)) {
      held.set(who, transactionOf(init));
      events.push({ who, kind: "reach", transaction: held.get(who)! });
      if (held.size === 2) release();
      await Promise.race([both, sleep(20_000, undefined, { ref: false }).then(() => {
        throw new Error("together: both lobby transactions did not reach the barrier within 20 s");
      })]);
    }
    const commit: Event | undefined = held.has(who) && String(input).endsWith(":commit") ? { who, kind: "commit", transaction: transactionOf(init) } : undefined;
    if (commit) events.push(commit);
    const response = await fetch(input, init);
    if (commit) commit.status = response.status;
    return response;
  };
  const results = await Promise.all([a(w.lobbies(contender("a"))), b(w.lobbies(contender("b")))]);
  const reaches = events.flatMap((event, i) => event.kind === "reach" ? [i] : []);
  const commits = events.flatMap((event, i) => event.kind === "commit" ? [i] : []);
  expect(reaches, "both lobby transactions reach the barrier").toHaveLength(2);
  expect(commits.every((i) => i > reaches[1]!), "a lobby transaction committed before both reached the barrier").toBe(true);
  console.log(`[together] held lobby transactions and commits: ${JSON.stringify(events.map((event) => ({
    who: event.who, kind: event.kind, heldTransaction: event.transaction !== null && event.transaction === held.get(event.who), status: event.status })))}`);
  return results;
}

/** Once a lobby has stopped accepting joins, every seated identity's leave is refused "started" and writes nothing. */
async function refusesEveryLeave(w: World, lobbyId: string, seated: readonly Keyed[]) {
  const before = await w.raw(lobbyId);
  expect(before!.state).not.toBe("open");
  for (const who of seated) {
    expect(reasonOf(await w.main.leave(lobbyId, who.key))).toBe("started");
    expect(await w.raw(lobbyId)).toEqual(before);
  }
}

describe.skipIf(!host)("a leave racing the final join or an early start", { timeout: 120_000 }, () => {
  describe("leave against the join that fills the lobby", () => {
    /** A public 2v2 with three seats taken; Bea's join fills it. Ann is the leaver. */
    async function threeSeated() {
      const w = world();
      const [ann, bea, cat, dot] = [await w.claim("Ann"), await w.claim("Bea"), await w.claim("Cat"), await w.claim("Dot")];
      const { lobby } = value(await w.main.createLobby(cat.key, "public", 2));
      for (const who of [ann, cat, dot]) value(await w.main.join(lobby.id, who.key));
      const leave: Op<LobbyOutcome<Lobby>> = (lobbies) => lobbies.leave(lobby.id, ann.key);
      const join: Op<LobbyOutcome<Lobby>> = (lobbies) => lobbies.join(lobby.id, bea.key);
      return { w, lobbyId: lobby.id, ann, bea, cat, dot, leave, join };
    }

    /** Asserts exactly one outcome and that the stored lobby agrees with it; returns which side won. */
    async function settled(fixture: Awaited<ReturnType<typeof threeSeated>>, left: LobbyOutcome<Lobby>, joined: LobbyOutcome<Lobby>) {
      const { w, lobbyId, ann, bea, cat, dot } = fixture;
      const stored = await w.stored(lobbyId);
      const joinWon = joined.ok && joined.value.state !== "open" && seatIdsOf(joined.value).includes(ann.id) && reasonOf(left) === "started";
      const leaveWon = left.ok && joined.ok && joined.value.state === "open" && !seatIdsOf(joined.value).includes(ann.id);
      expect(joinWon !== leaveWon, `exactly one side wins: leave ${reasonOf(left)}, join ${joined.ok ? joined.value.state : joined.reason}`).toBe(true);
      // The leaver is never seated in a started lobby after a successful leave.
      expect(left.ok && stored.state !== "open" && stored.seatIds.includes(ann.id)).toBe(false);
      if (joinWon) {
        expect(["holding", "waiting"]).toContain(stored.state);
        expect(stored.seatIds).toEqual([ann.id, bea.id, cat.id, dot.id].sort());
        await refusesEveryLeave(w, lobbyId, [ann, bea, cat, dot]);
        return "join";
      }
      expect(stored).toEqual({ state: "open", seatIds: [bea.id, cat.id, dot.id].sort() });
      // A later join fills the lobby without the leaver, and from then on no leave succeeds.
      const eve = await w.claim("Eve");
      const filled = value(await w.main.join(lobbyId, eve.key));
      expect(filled.state).not.toBe("open");
      expect(seatIdsOf(filled)).not.toContain(ann.id);
      await refusesEveryLeave(w, lobbyId, [bea, cat, dot, eve]);
      expect(reasonOf(await w.main.leave(lobbyId, ann.key))).toBe("not_seated");
      return "leave";
    }

    it("join first: the lobby starts with the leaver seated and the leave is refused started, changing nothing", async () => {
      const fixture = await threeSeated();
      const [joined, left] = await inOrder(fixture.w, fixture.lobbyId, fixture.join, fixture.leave);
      expect(await settled(fixture, left, joined)).toBe("join");
    });

    it("leave first: the seat goes, the join succeeds without starting, and the leaver is never seated once it starts", async () => {
      const fixture = await threeSeated();
      const [left, joined] = await inOrder(fixture.w, fixture.lobbyId, fixture.leave, fixture.join);
      expect(await settled(fixture, left, joined)).toBe("leave");
    });

    it("concurrently: exactly one side wins and the stored lobby agrees", async () => {
      const winners: string[] = [];
      for (let round = 0; round < CONCURRENT_ROUNDS; round++) {
        const fixture = await threeSeated();
        const [left, joined] = await together(fixture.w, fixture.lobbyId, fixture.leave, fixture.join);
        winners.push(await settled(fixture, left, joined));
      }
      console.log(`[leave vs final join] winners per round: ${JSON.stringify(winners)}`);
    });
  });

  describe("leave against the creator's early start", () => {
    /**
     * A public 2v2 created by Ann with Ann and Cat in colony 0 and Bea in colony 1. Leaving Cat leaves both colonies
     * seated, so a later start still succeeds; leaving Bea empties colony 1, so a later start is refused colony_empty.
     */
    async function startable(leaverName: "Cat" | "Bea") {
      const w = world();
      const [ann, bea, cat] = [await w.claim("Ann"), await w.claim("Bea"), await w.claim("Cat")];
      const { lobby } = value(await w.main.createLobby(ann.key, "public", 2));
      value(await w.main.join(lobby.id, ann.key, undefined, 0));
      value(await w.main.join(lobby.id, bea.key, undefined, 1));
      value(await w.main.join(lobby.id, cat.key, undefined, 0));
      const leaver = leaverName === "Cat" ? cat : bea;
      const leave: Op<LobbyOutcome<Lobby>> = (lobbies) => lobbies.leave(lobby.id, leaver.key);
      const start: Op<LobbyOutcome<Lobby>> = (lobbies) => lobbies.startEarly(lobby.id, ann.key);
      return { w, lobbyId: lobby.id, leaverName, leaver, seated: [ann, bea, cat], leave, start };
    }

    async function settled(fixture: Awaited<ReturnType<typeof startable>>, left: LobbyOutcome<Lobby>, started: LobbyOutcome<Lobby>) {
      const { w, lobbyId, leaver, seated } = fixture;
      const stored = await w.stored(lobbyId);
      const startWon = started.ok && started.value.state !== "open" && seatIdsOf(started.value).includes(leaver.id) && reasonOf(left) === "started";
      const leaveWon = left.ok && (started.ok ? !seatIdsOf(started.value).includes(leaver.id) : started.reason === "colony_empty");
      expect(startWon !== leaveWon, `exactly one side wins: leave ${reasonOf(left)}, start ${started.ok ? started.value.state : started.reason}`).toBe(true);
      // The lobby never starts with the leaver seated after a successful leave.
      expect(left.ok && stored.state !== "open" && stored.seatIds.includes(leaver.id)).toBe(false);
      const rest = seated.filter((who) => who.id !== leaver.id);
      if (startWon) {
        expect(["holding", "waiting"]).toContain(stored.state);
        expect(stored.seatIds).toEqual(seated.map((who) => who.id).sort());
        await refusesEveryLeave(w, lobbyId, seated);
        return "start";
      }
      if (fixture.leaverName === "Cat") {
        // Both colonies still seated: the start goes ahead without the leaver.
        expect(started.ok).toBe(true);
        expect(["holding", "waiting"]).toContain(stored.state);
        expect(stored.seatIds).toEqual(rest.map((who) => who.id).sort());
      } else {
        // Colony 1 emptied: the start is refused and the lobby stays open without the leaver.
        expect(reasonOf(started)).toBe("colony_empty");
        expect(stored).toEqual({ state: "open", seatIds: rest.map((who) => who.id).sort() });
        const dot = await w.claim("Dot");
        value(await w.main.join(lobbyId, dot.key, undefined, 1));
        const later = value(await w.main.startEarly(lobbyId, rest[0]!.key));
        expect(seatIdsOf(later)).not.toContain(leaver.id);
        rest.push(dot);
      }
      await refusesEveryLeave(w, lobbyId, rest);
      expect(reasonOf(await w.main.leave(lobbyId, leaver.key))).toBe("not_seated");
      return "leave";
    }

    for (const leaverName of ["Cat", "Bea"] as const) {
      describe(`the leaver is ${leaverName === "Cat" ? "one of two in its colony" : "its colony's only seat"}`, () => {
        it("start first: the lobby starts with the leaver seated and the leave is refused started, changing nothing", async () => {
          const fixture = await startable(leaverName);
          const [started, left] = await inOrder(fixture.w, fixture.lobbyId, fixture.start, fixture.leave);
          expect(await settled(fixture, left, started)).toBe("start");
        });

        it("leave first: the leave applies and the lobby never starts with the leaver seated", async () => {
          const fixture = await startable(leaverName);
          const [left, started] = await inOrder(fixture.w, fixture.lobbyId, fixture.leave, fixture.start);
          expect(await settled(fixture, left, started)).toBe("leave");
        });

        it("concurrently: exactly one side wins and the stored lobby agrees", async () => {
          const winners: string[] = [];
          for (let round = 0; round < CONCURRENT_ROUNDS; round++) {
            const fixture = await startable(leaverName);
            const [left, started] = await together(fixture.w, fixture.lobbyId, fixture.leave, fixture.start);
            winners.push(await settled(fixture, left, started));
          }
          console.log(`[leave ${leaverName} vs early start] winners per round: ${JSON.stringify(winners)}`);
        });
      });
    }
  });
});
