/// <reference types="node" />
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAME_SAVE_FORMAT, type GameSave } from "../../src/handover/matchSave.ts";
import { createMatchSaves, type MatchSave } from "../../src/handover/saveStore.ts";
import { createLobbies, type InstanceClaim, type Lobbies, type MatchOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import type { ColonyNamePair } from "../../src/sim/colonyNames.ts";
import { COLONY_NAMES } from "../../src/sim/config.ts";
import type { SimState } from "../../src/sim/types.ts";
import { HANDOVER_SAVE_WAIT_MS, startSlotRunner, type SlotHost, type SlotRunner } from "../../src/slots/slotServer.ts";
import type { Store } from "../../src/store/firestore.ts";
import { memoryObjects } from "../handover/helpers.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";

// Runner handover protocol: the slot runner hands a superseded owner's begun match
// over, and a successor of the same release waits for that save, adopts the match once and
// only then resumes it. Real lobby and rating services on the serialized in-memory store
// (as test/slots/live-owner.test.ts); each "server" is a slot runner driving a fake SlotHost.
// Saves go through the real handover save store (createMatchSaves) on that
// store, with bucket objects in memory.

/** What the runner judges in a save, plus the tick the match stopped at. */
type Saved = Pick<MatchSave, "lobbyId" | "revision" | "savedByRunId" | "tick">;

/**
 * A well-formed game save at a tick. The runner judges only a save's identity and the fake host
 * restores only its tick, so the game part is the least the real store encodes, digests and decodes.
 */
const gameAt = (tick: number): GameSave => ({
  format: GAME_SAVE_FORMAT, phase: "match", seed: 1, tick, holdBehaviour: "ant115", state: { tick } as unknown as SimState,
  startJoins: [], houseActivity: [], records: [], lobby: null, notPlayed: null,
});

/** The real MatchSaves, recording each committed save; reads can be held on a gate. */
function saveStore(store: Store) {
  const saves = createMatchSaves(store, memoryObjects());
  const writes: Saved[] = [];
  let held: Promise<void> | null = null;
  let heldReads = 0;
  return {
    writes,
    /** Every later read waits on opened before reading the latest save as it is then. */
    hold(opened: Promise<void>) { held = opened; },
    heldReads: () => heldReads,
    async write(save: MatchSave): Promise<void> {
      await saves.write(save);
      writes.push({ lobbyId: save.lobbyId, revision: save.revision, savedByRunId: save.savedByRunId, tick: save.tick });
    },
    async read(lobbyId: string): Promise<MatchSave | null> {
      if (held !== null) { heldReads++; await held; }
      return saves.read(lobbyId);
    },
  };
}
type Saves = ReturnType<typeof saveStore>;

/** Every endMatch and registerInstance call by run, through the real lobbies. */
function recorded(lobbies: Lobbies) {
  const ends: { readonly runId: string; readonly outcome: MatchOutcome; readonly ok: boolean }[] = [];
  const registrations: string[] = [];
  const wrapped: Lobbies = {
    ...lobbies,
    async endMatch(lobbyId, runId, outcome, thinkingLevels, serviceTiers) {
      const released = await lobbies.endMatch(lobbyId, runId, outcome, thinkingLevels, serviceTiers);
      ends.push({ runId, outcome, ok: released.ok });
      return released;
    },
    async registerInstance(slot, instance, claim?: InstanceClaim) {
      registrations.push(instance.runId);
      return lobbies.registerInstance(slot, instance, claim);
    },
  };
  return { lobbies: wrapped, ends, registrations };
}

/** One shared store; a rated 1v1 queue match already holding public-0, its countdown already over. */
async function world() {
  const w = retentionWorld(Date.now());
  const a = value(await w.ids.claimUsername("HandA")), b = value(await w.ids.claimUsername("HandB"));
  const real = createLobbies(w.store, w.ids, { countdownMs: 0, now: w.now });
  const ratings = createRatings(w.store, w.ids);
  const lobby = await w.store.transaction(async (read) => {
    const paired = await real.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, w.now());
    return { result: paired.lobby, writes: paired.writes };
  });
  expect(lobby.slot).toBe("public-0");
  const { lobbies, ends, registrations } = recorded(real);
  const saves = saveStore(w.store);
  const read = async () => value(await real.readLobby(lobby.id));
  const holder = async () => real.slotHolder("public-0");
  const rated = async () => Promise.all([a, b].map(async (key) => (await ratings.readRating(key.identity.id, "1v1")).ratedMatches));
  const marker = () => w.docs.has(`ratedMatches/${lobby.id}`);
  const markerWrites = () => w.commits.flat().filter((write) => write.path === `ratedMatches/${lobby.id}`).length;
  return { w, lobbies, ends, registrations, saves, lobby, read, holder, rated, marker, markerWrites };
}
type World = Awaited<ReturnType<typeof world>>;

/** A gate a fake step waits on until the test opens it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

interface ServerOptions {
  readonly revision?: string;
  /** The successor's staleness window: 1 ms takes the slot from an owner whose heartbeat the frozen clock left behind. */
  readonly staleMs?: number;
  /** handOver writes nothing and reports a failed save. */
  readonly failSave?: boolean;
  /** handOver waits on this before writing its save. */
  readonly saveGate?: Promise<void>;
  /** resume waits on this before restoring (a successor still loading the save). */
  readonly loadGate?: Promise<void>;
  /** resume reports a failed restore. */
  readonly failRestore?: boolean;
  /** The names the host's match plays under; omitted, the host reports none. */
  readonly colonyNames?: ColonyNamePair;
}

/**
 * A slot server stand-in: its fake match is at `tick` while running here; handOver stops it
 * and saves it as this run, resume restores a save without running, startResumed runs it.
 */
interface FakeServer {
  readonly name: string;
  readonly runner: SlotRunner;
  /** Every host call, in order. */
  readonly events: string[];
  /** The save this server restored, if any. */
  readonly resumed: () => MatchSave | null;
  /** Advances the running match by n ticks; refused unless it runs here. */
  advance(n: number): void;
  readonly running: () => boolean;
  readonly tick: () => number;
  /** Cloud Run's shutdown signal: the save step writes this run's save, then the server closes (no outcome is published). */
  shutDown(): Promise<void>;
}

const servers: FakeServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.runner.close();
  vi.restoreAllMocks();
});

async function server(world: World, name: string, options: ServerOptions = {}): Promise<FakeServer> {
  const revision = options.revision ?? "r1";
  const events: string[] = [];
  let lobbyId: string | null = null;
  let tick = 0;
  let running = false;
  let resumed: MatchSave | null = null;
  let runner: SlotRunner | null = null;
  const saveAs = async (): Promise<MatchSave> => {
    const save: MatchSave = {
      format: 1, lobbyId: lobbyId!, revision, savedByRunId: runner!.runId, tick, savedAt: world.w.now(), game: gameAt(tick), spectator: null,
    };
    await world.saves.write(save);
    return save;
  };
  const host: SlotHost<MatchSave> = {
    seat(id) { events.push("seat"); lobbyId = id; },
    start() { events.push("start"); running = true; return true; },
    async handOver() {
      events.push("handOver");
      running = false;
      await options.saveGate;
      if (options.failSave) return false;
      await saveAs();
      return true;
    },
    async resume(save) {
      events.push(`resume ${save.savedByRunId}@${save.tick}`);
      await options.loadGate;
      if (options.failRestore) return false;
      resumed = save;
      lobbyId = save.lobbyId;
      tick = save.tick;
      return true;
    },
    startResumed() { events.push("startResumed"); running = true; },
    abandon() { events.push("abandon"); running = false; },
    notPlayed() { events.push("notPlayed"); running = false; },
    ...(options.colonyNames === undefined ? {} : { colonyNames: () => options.colonyNames! }),
  };
  runner = await startSlotRunner<MatchSave>({
    slot: "public-0", lobbies: world.lobbies, host, saves: world.saves, revision, now: world.w.now, pollMs: 5,
    mcpUrl: `http://${name}.test/mcp`, spectatorUrl: `http://${name}.test/`,
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
  });
  const fake: FakeServer = {
    name, runner, events, resumed: () => resumed, running: () => running, tick: () => tick,
    advance(n) { expect(running, `${name} runs the match`).toBe(true); tick += n; },
    async shutDown() {
      running = false;
      await saveAs();
      runner!.close();
    },
  };
  servers.push(fake);
  return fake;
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(5);
  }
}

/** Some polls of every runner: long enough for any of them to act if it would. */
const settle = () => sleep(100);

/** The owner's match runs here: begun by its run and started. */
async function owner(world: World, name = "O", options: ServerOptions = {}): Promise<FakeServer> {
  const o = await server(world, name, options);
  await until(() => o.running());
  expect((await world.holder())?.matchRunId).toBe(o.runner.runId);
  return o;
}

/** A successor of the same release (unless given) taking the slot from a live owner whose heartbeat is behind the clock. */
async function successor(world: World, name: string, options: ServerOptions = {}): Promise<FakeServer> {
  world.w.advance(10);
  const s = await server(world, name, { staleMs: 1, ...options });
  expect((await world.lobbies.resolveSlot("public-0"))?.runId).toBe(s.runner.runId);
  return s;
}

const resumedHere = (s: FakeServer) => until(() => s.running() && s.events.includes("startResumed"));

/** The lobby ends once, with the natural result, rated once, recorded only by `by`. */
async function endsOnceRated(world: World, by: FakeServer, outcome: MatchOutcome) {
  by.runner.ended(outcome);
  expect(await until(async () => (await world.read()).outcome ?? undefined)).toBe(outcome);
  await settle();
  expect((await world.read()).state).toBe("ended");
  expect(world.ends).toEqual([{ runId: by.runner.runId, outcome, ok: true }]);
  expect(await world.rated()).toEqual([1, 1]);
  expect(world.marker()).toBe(true);
  expect(world.markerWrites()).toBe(1);
}

/** The lobby ends not played, unrated, with no rating marker, recorded by `by`. */
async function endsNotPlayed(world: World, by: FakeServer) {
  expect(await until(async () => (await world.read()).outcome ?? undefined)).toBe("not_played");
  await settle();
  expect(world.ends).toEqual([{ runId: by.runner.runId, outcome: "not_played", ok: true }]);
  expect(await world.rated()).toEqual([0, 0]);
  expect(world.marker()).toBe(false);
  expect(by.events).toContain("notPlayed");
}

describe("handover between slot runners", { timeout: 30_000 }, () => {
  it("after one handover the successor resumes the save once and the lobby ends once with its natural, rated result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    o.advance(40);
    const n = await successor(world_, "N");

    await resumedHere(n);
    expect(o.events).toEqual(["seat", "start", "handOver"]);
    expect(world_.saves.writes).toEqual([{ lobbyId: world_.lobby.id, revision: "r1", savedByRunId: o.runner.runId, tick: 40 }]);
    // Restored without seating or starting anew, then resumed at the saved tick once adopted.
    expect(n.events).toEqual([`resume ${o.runner.runId}@40`, "startResumed"]);
    expect(n.tick()).toBe(40);
    expect((await world_.holder())?.matchRunId).toBe(n.runner.runId);
    expect((await world_.read()).outcome).toBeNull();

    n.advance(60);
    await endsOnceRated(world_, n, "colony_0_won");
    expect(n.events).toEqual([`resume ${o.runner.runId}@40`, "startResumed"]);
  });

  it("after two successive handovers across three servers the last resumes the latest save, and only it records the outcome", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    o.advance(40);
    const n1 = await successor(world_, "N1");
    await resumedHere(n1);
    n1.advance(50);
    const n2 = await successor(world_, "N2");
    await resumedHere(n2);

    expect(n1.events).toEqual([`resume ${o.runner.runId}@40`, "startResumed", "handOver"]);
    expect(world_.saves.writes.map((save) => [save.savedByRunId, save.tick])).toEqual([[o.runner.runId, 40], [n1.runner.runId, 90]]);
    // The latest save, by the run that advanced the match last; the first save is never resumed again.
    expect(n2.events).toEqual([`resume ${n1.runner.runId}@90`, "startResumed"]);
    expect((await world_.holder())?.matchRunId).toBe(n2.runner.runId);

    // The superseded servers keep running; their matches ending there record nothing.
    o.runner.ended("colony_1_won");
    n1.runner.ended("colony_1_won");
    await settle();
    expect(world_.ends).toEqual([]);
    n2.advance(10);
    await endsOnceRated(world_, n2, "draw");
    expect(world_.registrations).toEqual([o.runner.runId, n1.runner.runId, n2.runner.runId]);
  });

  it("resumes a save made on the shutdown signal; the shut-down server records nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    o.advance(25);
    await o.shutDown();
    const n = await successor(world_, "N");
    await resumedHere(n);
    expect(n.events).toEqual([`resume ${o.runner.runId}@25`, "startResumed"]);
    o.runner.ended("colony_1_won");
    await endsOnceRated(world_, n, "colony_1_won");
    expect(o.events).toEqual(["seat", "start"]);
  });

  it("when a successor is superseded while loading the save, the final eligible owner resumes it once; the superseded servers neither record an outcome nor take the slot back", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    o.advance(30);
    const loading = gate();
    const n1 = await successor(world_, "N1", { loadGate: loading.opened });
    await until(() => n1.events.includes(`resume ${o.runner.runId}@30`));

    // N1 is still loading when N2 takes the slot; N2 resumes the same save.
    const n2 = await successor(world_, "N2");
    await resumedHere(n2);
    expect(n2.events).toEqual([`resume ${o.runner.runId}@30`, "startResumed"]);
    expect((await world_.holder())?.matchRunId).toBe(n2.runner.runId);
    // Superseded while loading a valid save does not by itself end the match not played.
    expect((await world_.read())).toMatchObject({ state: "holding", outcome: null });

    // N1 finishes loading only now: refused the adoption, it drops the restored match and records nothing.
    loading.open();
    await until(() => n1.events.includes("abandon"));
    expect(n1.events).toEqual([`resume ${o.runner.runId}@30`, "abandon"]);
    expect(n1.running()).toBe(false);

    // Both superseded servers keep running; nothing they do records an outcome or takes the slot back.
    o.runner.ended("colony_0_won");
    n1.runner.ended("colony_0_won");
    await settle();
    expect(world_.ends).toEqual([]);
    expect((await world_.lobbies.resolveSlot("public-0"))?.runId).toBe(n2.runner.runId);
    expect((await world_.holder())?.matchRunId).toBe(n2.runner.runId);
    expect(world_.registrations).toEqual([o.runner.runId, n1.runner.runId, n2.runner.runId]);

    n2.advance(5);
    await endsOnceRated(world_, n2, "colony_1_won");
    expect((await world_.lobbies.resolveSlot("public-0"))?.runId).toBe(n2.runner.runId);
    expect(o.events).toEqual(["seat", "start", "handOver"]);
  });

  it("a successor superseded while waiting for the save leaves it to the next owner and records nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const saving = gate();
    const o = await owner(world_, "O", { saveGate: saving.opened });
    o.advance(12);
    const n1 = await successor(world_, "N1");
    await until(() => o.events.includes("handOver"));
    const n2 = await successor(world_, "N2");
    await until(() => n1.events.includes("abandon"));
    saving.open();
    await resumedHere(n2);
    expect(n1.events).toEqual(["abandon"]);
    expect(n2.events).toEqual([`resume ${o.runner.runId}@12`, "startResumed"]);
    await endsOnceRated(world_, n2, "colony_0_won");
  });
});

describe("the names a slot's match plays under", { timeout: 30_000 }, () => {
  it("are recorded on its lobby from the host when the match begins, and again from the successor's host when it adopts the match", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const stored = () => world_.w.docs.get(`lobbies/${world_.lobby.id}`)?.colonyNames;
    const drawn: ColonyNamePair = ["Sweetwater Colony", "Lake Skinner Colony"];
    const o = await owner(world_, "O", { colonyNames: drawn });
    expect(stored()).toBe(JSON.stringify(drawn));
    o.advance(10);
    const n = await successor(world_, "N", { colonyNames: COLONY_NAMES });
    await resumedHere(n);
    expect(stored()).toBe("");
  });
});

describe("a handover that cannot resume ends the match not played", { timeout: 30_000 }, () => {
  it("if the save fails, the successor ends the match not played once its 20 s wait from taking the slot is over", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_, "O", { failSave: true });
    const n = await successor(world_, "N");
    await until(() => o.events.includes("handOver"));
    world_.w.advance(HANDOVER_SAVE_WAIT_MS - 1);
    await settle();
    expect(await world_.read()).toMatchObject({ state: "holding", outcome: null });
    world_.w.advance(1);
    await endsNotPlayed(world_, n);
    expect(world_.saves.writes).toEqual([]);
    expect(n.events.some((event) => event.startsWith("resume"))).toBe(false);
  });

  it("a valid save reaching the successor after its 20 s wait is not resumed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const saving = gate();
    const o = await owner(world_, "O", { saveGate: saving.opened });
    const n = await successor(world_, "N");
    await until(() => o.events.includes("handOver"));
    world_.w.advance(HANDOVER_SAVE_WAIT_MS);
    await endsNotPlayed(world_, n);
    saving.open();
    await until(() => world_.saves.writes.length === 1);
    await settle();
    expect(n.events).toEqual(["notPlayed"]);
    expect((await world_.read()).outcome).toBe("not_played");
  });

  it("a valid save whose read returns only after the 20 s wait is not resumed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    const reading = gate();
    world_.saves.hold(reading.opened);
    const n = await successor(world_, "N");
    await until(() => o.events.includes("handOver") && world_.saves.writes.length === 1 && world_.saves.heldReads() > 0);
    // The read began inside the wait; it answers the valid save only once the wait is over.
    world_.w.advance(HANDOVER_SAVE_WAIT_MS);
    reading.open();
    await endsNotPlayed(world_, n);
    expect(n.events).toEqual(["notPlayed"]);
    expect((await world_.holder())).toBeNull();
  });

  it("a server shut down while restoring records nothing, even when its restore fails, and leaves the save to the next owner", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    o.advance(15);
    const loading = gate();
    const n1 = await successor(world_, "N1", { loadGate: loading.opened, failRestore: true });
    await until(() => n1.events.includes(`resume ${o.runner.runId}@15`));
    n1.runner.close();
    loading.open();
    await settle();
    expect(world_.ends).toEqual([]);
    expect(await world_.read()).toMatchObject({ state: "holding", outcome: null });
    expect((await world_.holder())?.matchRunId).toBe(o.runner.runId);
    expect(n1.events).toEqual([`resume ${o.runner.runId}@15`]);

    const n2 = await successor(world_, "N2");
    await resumedHere(n2);
    expect(n2.events).toEqual([`resume ${o.runner.runId}@15`, "startResumed"]);
    await endsOnceRated(world_, n2, "colony_1_won");
  });

  it("a save from an earlier server is not resumed when the last server that advanced the match saved nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    o.advance(20);
    const n1 = await successor(world_, "N1", { failSave: true });
    await resumedHere(n1);
    n1.advance(20);
    const n2 = await successor(world_, "N2");
    await until(() => n1.events.includes("handOver"));
    // Only O's save exists; the match's owner is now N1, so O's save is stale.
    expect(world_.saves.writes.map((save) => save.savedByRunId)).toEqual([o.runner.runId]);
    world_.w.advance(HANDOVER_SAVE_WAIT_MS);
    await endsNotPlayed(world_, n2);
    expect(n2.events).toEqual(["notPlayed"]);
  });

  it("a failed restore ends the match not played without waiting", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_);
    const n = await successor(world_, "N", { failRestore: true });
    await endsNotPlayed(world_, n);
    expect(n.events).toEqual([`resume ${o.runner.runId}@0`, "notPlayed"]);
  });

  it("a newcomer of a different release does not resume, even from a save the old release made on its shutdown signal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_, "O", { revision: "r1" });
    o.advance(30);
    await o.shutDown();
    expect(world_.saves.writes).toEqual([{ lobbyId: world_.lobby.id, revision: "r1", savedByRunId: o.runner.runId, tick: 30 }]);
    // A deploy: another revision registers at once, the owner's heartbeat still fresh.
    const n = await server(world_, "N", { revision: "r2" });
    expect((await world_.lobbies.resolveSlot("public-0"))?.runId).toBe(n.runner.runId);
    await endsNotPlayed(world_, n);
    expect(n.events).toEqual(["notPlayed"]);
  });

  it("a newcomer of a different release does not resume a supersession save either", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const world_ = await world();
    const o = await owner(world_, "O", { revision: "r1" });
    const n = await server(world_, "N", { revision: "r2" });
    await until(() => o.events.includes("handOver"));
    await endsNotPlayed(world_, n);
    expect(n.events).toEqual(["notPlayed"]);
  });
});

describe("lobbies.adoptMatch", () => {
  it("lets only the registered instance adopt the begun match of the run named, once, and repeats safely", async () => {
    const world_ = await world();
    const real = createLobbies(world_.w.store, world_.w.ids, { countdownMs: 0, now: world_.w.now });
    const instance = (runId: string) => ({ runId, mcpUrl: `http://${runId}.test/mcp`, spectatorUrl: `http://${runId}.test/` });
    const id = world_.lobby.id;
    expect(await real.registerInstance("public-0", instance("old"))).toEqual({ registered: true });
    // Not begun yet: nothing to adopt.
    expect(await real.adoptMatch(id, "public-0", "old", "")).toEqual({ ok: false, reason: "stale_save" });
    expect(await real.beginMatch(id, "public-0", "old")).toEqual({ ok: true, value: null });
    expect(await real.registerInstance("public-0", instance("new"))).toEqual({ registered: true });
    expect(await real.adoptMatch(id, "public-0", "old", "old")).toEqual({ ok: false, reason: "superseded" });
    expect(await real.adoptMatch(id, "public-0", "new", "other")).toEqual({ ok: false, reason: "stale_save" });
    expect((await real.slotHolder("public-0"))?.matchRunId).toBe("old");
    expect(await real.adoptMatch(id, "public-0", "new", "old")).toEqual({ ok: true, value: null });
    expect((await real.slotHolder("public-0"))?.matchRunId).toBe("new");
    // A lost reply's retry succeeds again; the old owner's save no longer names the match's owner.
    expect(await real.adoptMatch(id, "public-0", "new", "old")).toEqual({ ok: true, value: null });
    expect(await real.registerInstance("public-0", instance("third"))).toEqual({ registered: true });
    expect(await real.adoptMatch(id, "public-0", "third", "old")).toEqual({ ok: false, reason: "stale_save" });
    // Adopted, the match is the adopter's own: its natural result releases and rates.
    expect(await real.adoptMatch(id, "public-0", "third", "new")).toEqual({ ok: true, value: null });
    expect(await real.endMatch(id, "third", "draw")).toEqual({ ok: true, value: { next: null } });
    expect(await world_.rated()).toEqual([1, 1]);
    expect(await real.adoptMatch(id, "public-0", "third", "new")).toEqual({ ok: false, reason: "stale_save" });
  });
});
