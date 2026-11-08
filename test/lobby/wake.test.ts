import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, LOBBY_TTL_MS, type LobbyKind, type LobbyOutcome, type LobbySettings, type LobbySize } from "../../src/lobby/lobbies.ts";
import { slotWakerFromEnv, wakingStore } from "../../src/slots/wake.ts";
import { createFirestore } from "../../src/store/firestore.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const RACE_TIMEOUT = 120_000; // the emulator reports a lock conflict after about 2 s

let counter = 0;
const freshNamespace = () => `w${process.pid}-${Date.now().toString(36)}-${counter++}`;
const storeFor = (namespace: string, request?: typeof fetch) => createFirestore({ projectId, namespace, emulatorHost: host, request });

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/**
 * One namespace standing in for the shared store, whose lobby servers assign slots
 * through a waking store. Each wake-up records its slot and the lobby the store holds
 * in that slot when the wake-up is sent, read at that moment: a wake-up before the
 * commit would see the slot empty or with its earlier holder.
 */
function world(settings: Omit<LobbySettings, "now"> = {}, wake?: (slot: string) => void) {
  const namespace = freshNamespace();
  const clock = { t: Date.UTC(2026, 9, 23, 8, 0, 0) };
  const raw = (path: string) => storeFor(namespace).get(path);
  const pending: Promise<{ slot: string; holder: string | null }>[] = [];
  const record = wake ?? ((slot: string) => void pending.push(raw(`slots/${slot}`).then((fields) => ({ slot, holder: fields?.lobbyId ?? null }))));
  const lobbies = (more: Omit<LobbySettings, "now"> = {}, request?: typeof fetch) => createLobbies(
    wakingStore(storeFor(namespace, request), record),
    createIdentities(storeFor(namespace, request)),
    { ...settings, ...more, now: () => clock.t },
  );
  const ids = createIdentities(storeFor(namespace));
  return {
    clock, ids, raw, lobbies, main: lobbies(),
    /** A waking store on the same namespace and wake-up record, for a caller's own transaction. */
    waking: () => wakingStore(storeFor(namespace), record),
    keys: (names: string[]) => Promise.all(names.map(async (name) => value(await ids.claimUsername(name)).key)),
    /** The wake-ups sent since the last call, in order. */
    woken: () => Promise.all(pending.splice(0)),
  };
}
type World = ReturnType<typeof world>;

/** A lobby of the kind with every seat but the last filled; returns it and its invite token. */
async function almostFull(w: World, kind: LobbyKind, size: LobbySize, creator: string, joiners: string[]) {
  const created = value(await w.main.createLobby(creator, kind, size));
  for (const key of joiners.slice(0, 2 * size - 1)) value(await w.main.join(created.lobby.id, key, created.inviteToken));
  return { id: created.lobby.id, inviteToken: created.inviteToken };
}

/** Forces n commits to overlap, as in lobbies.test.ts: each contender's first commit waits for all n. */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => { release = resolve; });
  return (): typeof fetch => {
    let held = false;
    return async (input, init) => {
      if (!held && init?.method === "POST" && String(input).endsWith(":commit")) {
        held = true;
        if (++arrived === n) release();
        await Promise.race([all, sleep(20_000, undefined, { ref: false }).then(() => {
          throw new Error(`barrier: ${n} contenders did not reach a commit within 20 s`);
        })]);
      }
      return fetch(input, init);
    };
  };
}

const instance = (runId: string) => ({ runId, mcpUrl: `https://${runId}.example/mcp`, spectatorUrl: `https://${runId}.example/` });

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!host)("slot wake-ups against the Firestore emulator", { timeout: 60_000 }, () => {
  for (const kind of ["public", "private"] as const) {
    it(`wakes a ${kind} slot's server after the join filling the last seat commits, whether or not a server is registered`, async () => {
      const w = world();
      const [c, a, b, d, e] = await w.keys(["Cre", "Ann", "Bob", "Dee", "Eve"]);
      // No server has ever registered for the slot.
      const created = value(await w.main.createLobby(c!, kind, 1));
      expect(await w.woken()).toEqual([]);
      value(await w.main.join(created.lobby.id, a!, created.inviteToken));
      expect(await w.woken()).toEqual([]);
      expect(value(await w.main.join(created.lobby.id, b!, created.inviteToken))).toMatchObject({ state: "holding", slot: `${kind}-0` });
      expect(await w.woken()).toEqual([{ slot: `${kind}-0`, holder: created.lobby.id }]);

      // A server is registered and running for the slot: the next assignment wakes it too.
      await w.main.registerInstance(`${kind}-0`, instance("running"));
      value(await w.main.endMatch(created.lobby.id, "running", "not_played"));
      expect(await w.woken()).toEqual([]);
      const next = await almostFull(w, kind, 1, c!, [d!]);
      value(await w.main.join(next.id, e!, next.inviteToken));
      expect(await w.woken()).toEqual([{ slot: `${kind}-0`, holder: next.id }]);
    });

    it(`wakes a ${kind} slot's server after an early start commits`, async () => {
      const w = world();
      const [c, a, b] = await w.keys(["Cre", "Ann", "Bob"]);
      const lobby = await almostFull(w, kind, 2, c!, [a!, b!]);
      expect(await w.woken()).toEqual([]);
      expect(value(await w.main.startEarly(lobby.id, c!))).toMatchObject({ state: "holding", slot: `${kind}-0` });
      expect(await w.woken()).toEqual([{ slot: `${kind}-0`, holder: lobby.id }]);
    });

    it(`wakes a ${kind} slot's server after a release hands the slot to the next waiter, and not for a release with none`, async () => {
      const w = world();
      const [c, a, b, d, e, f, g] = await w.keys(["Cre", "Ann", "Bob", "Dee", "Eve", "Fay", "Gus"]);
      const first = await almostFull(w, kind, 1, c!, [a!]);
      value(await w.main.join(first.id, b!, first.inviteToken));
      const second = await almostFull(w, kind, 1, c!, [d!]);
      const third = await almostFull(w, kind, 1, c!, [f!]);
      await w.woken();
      // Both wait: no slot is taken, so nothing is woken.
      expect(value(await w.main.join(second.id, e!, second.inviteToken)).state).toBe("waiting");
      expect(value(await w.main.join(third.id, g!, third.inviteToken)).state).toBe("waiting");
      expect(await w.woken()).toEqual([]);

      // An operator release hands the slot on.
      expect(value(await w.main.releaseSlot(first.id))).toEqual({ next: second.id });
      expect(await w.woken()).toEqual([{ slot: `${kind}-0`, holder: second.id }]);
      // The slot's server ends its match, handing the slot on again.
      await w.main.registerInstance(`${kind}-0`, instance("run"));
      expect(value(await w.main.endMatch(second.id, "run", "not_played"))).toEqual({ next: third.id });
      expect(await w.woken()).toEqual([{ slot: `${kind}-0`, holder: third.id }]);
      // Nobody waits: the slot is freed and nothing is woken.
      expect(value(await w.main.endMatch(third.id, "run", "not_played"))).toEqual({ next: null });
      expect(await w.raw(`slots/${kind}-0`)).toBeNull();
      expect(await w.woken()).toEqual([]);
    });
  }

  it("wakes nothing for a refused transaction", async () => {
    const w = world();
    const [c, a, b, d] = await w.keys(["Cre", "Ann", "Bob", "Dee"]);
    const priv = await almostFull(w, "private", 1, c!, [a!]);
    expect(await w.main.join(priv.id, b!)).toEqual({ ok: false, reason: "invalid_invite" });
    expect(await w.main.join(priv.id, a!, priv.inviteToken)).toEqual({ ok: false, reason: "already_seated" });
    const early = value(await w.main.createLobby(c!, "public", 2)).lobby;
    expect(await w.main.startEarly(early.id, c!)).toEqual({ ok: false, reason: "colony_empty" });
    value(await w.main.join(early.id, a!));
    value(await w.main.join(early.id, b!));
    expect(await w.main.startEarly(early.id, a!)).toEqual({ ok: false, reason: "not_creator" });
    expect(await w.main.releaseSlot(early.id)).toEqual({ ok: false, reason: "not_holding" });
    await w.woken();

    value(await w.main.startEarly(early.id, c!));
    expect(await w.woken()).toEqual([{ slot: "public-0", holder: early.id }]);
    expect(await w.main.startEarly(early.id, c!)).toEqual({ ok: false, reason: "started" });
    expect(await w.main.join(early.id, d!)).toEqual({ ok: false, reason: "started" });
    await w.main.registerInstance("public-0", instance("new"));
    expect(await w.main.endMatch(early.id, "old", "not_played")).toEqual({ ok: false, reason: "superseded" });
    const late = await almostFull(w, "public", 1, c!, [a!]);
    w.clock.t += LOBBY_TTL_MS;
    expect(await w.main.join(late.id, b!)).toEqual({ ok: false, reason: "expired" });
    expect(await w.woken()).toEqual([]);
  });

  it("wakes every slot one settlement hands out in a single transaction", async () => {
    // Raising the slot count (the 8 public and 8 private declaration) frees slots
    // while lobbies still wait: the next settlement hands several out at once.
    const w = world({ publicSlots: 1 });
    const [c, ...p] = await w.keys(["Cre", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]);
    const lobbies = [];
    for (let i = 0; i < 4; i++) lobbies.push(await almostFull(w, "public", 1, c!, [p[2 * i]!]));
    for (const [i, lobby] of lobbies.slice(0, 3).entries()) value(await w.main.join(lobby.id, p[2 * i + 1]!));
    expect(await w.woken()).toEqual([{ slot: "public-0", holder: lobbies[0]!.id }]);

    const wider = w.lobbies({ publicSlots: 4 });
    expect(value(await wider.join(lobbies[3]!.id, p[7]!))).toMatchObject({ state: "holding", slot: "public-3" });
    expect(await w.woken()).toEqual([
      { slot: "public-1", holder: lobbies[1]!.id },
      { slot: "public-2", holder: lobbies[2]!.id },
      { slot: "public-3", holder: lobbies[3]!.id },
    ]);
  });

  it("wakes the slot a queue-made lobby takes once the transaction making it commits, and nothing for one rolled back or left waiting", async () => {
    const w = world({ publicSlots: 2 });
    // The ranked queue pairing two players makes its lobby through queuedMatchWrites.
    const [a, b] = await w.keys(["Ann", "Bob"]);
    expect(value(await w.main.joinQueue(a!, "1v1")).state).toBe("waiting");
    expect(await w.woken()).toEqual([]);
    const matched = value(await w.main.joinQueue(b!, "1v1"));
    if (matched.state !== "matched") throw new Error(`expected a pairing, got ${matched.state}`);
    expect(await w.woken()).toEqual([{ slot: "public-0", holder: matched.lobbyId }]);

    // queuedMatchWrites itself, in a transaction on the waking store.
    const colonies = [[{ id: "s1", displayName: "S1" }], [{ id: "s2", displayName: "S2" }]] as const;
    const make = (commit: boolean) => w.waking().transaction(async (read) => {
      const made = await w.main.queuedMatchWrites(read, { mode: "1v1", colonies }, w.clock.t);
      return { result: made.lobby, writes: commit ? made.writes : [] };
    });
    expect((await make(false)).slot).toBe("public-1");
    expect(await w.raw("slots/public-1")).toBeNull();
    expect(await w.woken()).toEqual([]);
    const made = await make(true);
    expect(made).toMatchObject({ state: "holding", slot: "public-1", mode: "1v1" });
    expect(await w.woken()).toEqual([{ slot: "public-1", holder: made.id }]);
    // Both slots are held: the next queue-made lobby waits, and nothing is woken.
    expect(await make(true)).toMatchObject({ state: "waiting", slot: null });
    expect(await w.woken()).toEqual([]);
  });

  it("wakes only the slot the committing attempts took when two lobbies race for one slot", { timeout: RACE_TIMEOUT }, async () => {
    const w = world();
    const [c, a, b, d, e] = await w.keys(["Cre", "Ann", "Bob", "Dee", "Eve"]);
    const one = await almostFull(w, "public", 1, c!, [a!]);
    const two = await almostFull(w, "public", 1, c!, [d!]);
    const wrap = barrier(2);
    // Both first attempts take public-0; the one aborted reruns and waits instead.
    const results = await Promise.all([w.lobbies({}, wrap()).join(one.id, b!), w.lobbies({}, wrap()).join(two.id, e!)]);
    expect(results.map((result) => value(result).state).sort()).toEqual(["holding", "waiting"]);
    const holder = results.map(value).find((lobby) => lobby.state === "holding")!.id;
    expect(await w.woken()).toEqual([{ slot: "public-0", holder }]);
  });

  it("sends the slot's server the wake-up request when no server listens on its address, leaving the assignment unchanged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const sent: string[] = [];
    const waker = slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: `https://127.0.0.1:${port}/{slot}` }, (input, init) => {
      sent.push(String(input));
      return fetch(input, init);
    })!;
    const w = world({}, waker);
    const [c, a, b] = await w.keys(["Cre", "Ann", "Bob"]);
    const lobby = await almostFull(w, "private", 1, c!, [a!]);
    expect(sent).toEqual([]);
    expect(value(await w.main.join(lobby.id, b!, lobby.inviteToken))).toMatchObject({ state: "holding", slot: "private-0" });
    expect(sent).toEqual([`https://127.0.0.1:${port}/private-0/wake`]);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("antwar wake for slot private-0 failed")));
    expect(await w.raw("slots/private-0")).toEqual({ lobbyId: lobby.id });
  });
});
