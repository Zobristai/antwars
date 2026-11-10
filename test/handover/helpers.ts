/**
 * Handover save tests: the store through the repository's own Firestore client, on the emulator
 * when FIRESTORE_EMULATOR_HOST is set (`firebase emulators:exec`) and otherwise on an in-memory stand-in
 * for the four REST calls the client makes; every request body is recorded either way. Bucket objects
 * are in memory. And a Wide Plain match at both colonies' 1,024-ant cap on a slot-server Game.
 */
import { Game, type LobbySeat } from "../../src/mcp/game.js";
import type { SaveObjects } from "../../src/handover/saveStore.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { mirrorX, newAnt } from "../../src/sim/map.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { ColonyId, SimState } from "../../src/sim/types.js";
import { createFirestore, type Store } from "../../src/store/firestore.js";

export const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
let counter = 0;

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** UTF-8 bytes of the request body as sent. */
  readonly bytes: number;
  readonly body: unknown;
}

export interface TestFirestore {
  readonly store: Store;
  readonly namespace: string;
  readonly requests: RecordedRequest[];
  readonly backend: "emulator" | "memory";
}

export function testFirestore(): TestFirestore {
  const namespace = `handover-${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const requests: RecordedRequest[] = [];
  const inner = emulatorHost === undefined ? memoryFirestore() : fetch;
  const request: typeof fetch = async (input, init) => {
    const text = typeof init?.body === "string" ? init.body : "";
    requests.push({ method: init?.method ?? "GET", url: String(input), bytes: Buffer.byteLength(text, "utf8"), body: text === "" ? undefined : JSON.parse(text) });
    return inner(input, init);
  };
  const store = createFirestore({ projectId, namespace, emulatorHost: emulatorHost ?? "memory:1", request });
  return { store, namespace, requests, backend: emulatorHost === undefined ? "memory" : "emulator" };
}

type Doc = Record<string, { stringValue: string }>;

/**
 * The REST calls src/store/firestore.ts makes, over one in-memory database: document GET,
 * beginTransaction, batchGet, commit (with its existence preconditions and update masks) and rollback.
 */
function memoryFirestore(): typeof fetch {
  const docs = new Map<string, Doc>();
  let transactions = 0;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const failure = (code: number, status: string) => reply(code, { error: { code, status } });
  return async (input, init) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\//, ""));
    if ((init?.method ?? "GET") === "GET") {
      const fields = docs.get(path);
      return fields === undefined ? failure(404, "NOT_FOUND") : reply(200, { name: path, fields });
    }
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    const method = path.slice(path.lastIndexOf(":") + 1);
    if (method === "beginTransaction") return reply(200, { transaction: `t${++transactions}` });
    if (method === "rollback") return reply(200, {});
    if (method === "batchGet") {
      return reply(200, (body.documents as string[]).map(name => docs.has(name) ? { found: { name, fields: docs.get(name) } } : { missing: name }));
    }
    if (method === "commit") {
      const writes = body.writes as { update?: { name: string; fields: Doc }; delete?: string; updateMask?: { fieldPaths: string[] }; currentDocument?: { exists: boolean } }[];
      for (const write of writes) {
        const name = write.update?.name ?? write.delete!;
        const exists = write.currentDocument?.exists;
        if (exists === false && docs.has(name)) return failure(409, "ALREADY_EXISTS");
        if (exists === true && !docs.has(name)) return failure(404, "NOT_FOUND");
      }
      for (const write of writes) {
        if (write.delete !== undefined) { docs.delete(write.delete); continue; }
        const { name, fields } = write.update!;
        const mask = write.updateMask?.fieldPaths;
        const next: Doc = mask === undefined ? {} : { ...docs.get(name) };
        for (const key of mask ?? Object.keys(fields)) {
          if (fields[key] === undefined) delete next[key]; else next[key] = fields[key]!;
        }
        docs.set(name, next);
      }
      return reply(200, { commitTime: new Date().toISOString(), writeResults: writes.map(() => ({})) });
    }
    return failure(400, "INVALID_ARGUMENT");
  };
}

/** Bucket objects in memory, create-only as GCS with ifGenerationMatch 0. */
export function memoryObjects(): SaveObjects & { readonly objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(name, body) {
      if (objects.has(name)) throw new Error(`object ${name} exists`);
      objects.set(name, body.slice());
    },
    async get(name) {
      return objects.get(name)?.slice() ?? null;
    },
  };
}

/**
 * Production's slot-server config (src/server.ts comparisonOptions without ANTWAR_RULES), on Wide Plain;
 * given `matchTicks`, its match is cut to that many ticks so that it reaches its natural result in a bounded test.
 */
export function widePlainConfig(matchTicks?: number): SimConfig {
  const base = newMatchConfig(rulesConfig("redesign"));
  const terrain = { ...base.terrain!, mapId: "wide-plain" };
  if (matchTicks === undefined) return { ...base, terrain };
  return { ...base, terrain: { ...terrain, maps: terrain.maps.map((map) => map.id === "wide-plain" ? { ...map, matchTicks } : map) } };
}

export const WIDE_SEATS: readonly LobbySeat[] = [
  { identityId: "west-a", displayName: "West A", colony: 0 },
  { identityId: "west-b", displayName: "West B", colony: 0 },
  { identityId: "east-a", displayName: "East A", colony: 1 },
  { identityId: "east-b", displayName: "East B", colony: 1 },
];

export interface WideMatch {
  readonly game: Game;
  /** The seats' agent ids, in WIDE_SEATS order; the last seat has not joined. */
  readonly agents: readonly string[];
  readonly clock: { now: number };
}

/**
 * A seated 2v2 slot-server Game on Wide Plain whose pick window has just finished: three seats joined
 * during the window (queued for the first tick), the fourth not yet. Both colonies are filled to their
 * 1,024-ant cap as the rated harness fills them (test/tuning/seated.ts), and, when `fromTick` is given,
 * the match is moved to that tick so that it reaches its natural time_up result in a bounded test. Moved
 * past the idle limit, a seat that has not joined ends this ranked match abandoned at its first tick, so a
 * test that needs the fourth seat to join after the start cuts the match with `matchTicks` instead.
 */
export async function wideMatch(options: { readonly seed: number; readonly fromTick?: number; readonly matchTicks?: number }): Promise<WideMatch> {
  const clock = { now: 1_000 };
  const game = new Game({ simConfig: widePlainConfig(options.matchTicks), startPickWindowMs: 1_000, now: () => clock.now,
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  game.seatLobby("lobby-wide", WIDE_SEATS, "2v2");
  const closesAt = game.beginLobbyStart(options.seed);
  const agents: string[] = [];
  for (const seat of WIDE_SEATS.slice(0, 3)) agents.push((await game.joinSeated(seat.identityId, "test-model"))!.agentId!);
  clock.now = closesAt;
  game.finishLobbyStart();
  const state = game.match!.state;
  fillToCap(state);
  if (options.fromTick !== undefined) state.tick = options.fromTick;
  return { game, agents, clock };
}

/** Each colony's back 40% band gets ants up to the colony cap, alternating castes, mirrored. */
export function fillToCap(state: SimState): void {
  const c = state.config;
  const count = (colony: ColonyId) => state.ants.filter(ant => ant.colony === colony).length;
  const perSide = c.colonyCap - Math.max(count(0), count(1));
  const band = Math.floor(c.mapWidth * 0.4), cols = Math.round(Math.sqrt((perSide * band) / c.mapHeight)), rows = Math.ceil(perSide / cols);
  const taken = new Set<number>();
  const land = (x: number, y: number) => {
    for (let r = 0; r < c.mapWidth; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || tx >= band || ty < 0 || ty >= c.mapHeight || taken.has(ty * c.mapWidth + tx)) continue;
      if (isBlockedTile(state.terrain, tx, ty) || isBlockedTile(state.terrain, c.mapWidth - 1 - tx, ty)) continue;
      return { x: tx, y: ty };
    }
    throw new Error("no land");
  };
  for (let i = 0; i < perSide; i++) {
    const t = land(Math.floor(((i % cols) + 0.5) * band / cols), Math.floor((Math.floor(i / cols) + 0.5) * c.mapHeight / rows));
    taken.add(t.y * c.mapWidth + t.x);
    const x = tileCentre(t.x), y = tileCentre(t.y), caste = i % 2 === 0 ? "worker" : "soldier";
    state.ants.push(newAnt(c, state.nextAntId++, 0, x, y, caste));
    state.ants.push(newAnt(c, state.nextAntId++, 1, mirrorX(c, x), y, caste));
  }
}
