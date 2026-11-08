/// <reference types="node" />
import { createHash } from "node:crypto";
import { SPECTATOR_SAVE_META_BYTES, type SpectatorSave } from "../live/handover.js";
import { createGcsInputStore } from "../records/input-store.js";
import { createGcsReplayStore } from "../replays/store.js";
import type { Fields, Store } from "../store/firestore.js";
import { decodeGameSave, encodeGameSave, type GameSave } from "./matchSave.js";

/** One handover save of a lobby's begun match. */
export interface MatchSave {
  readonly format: 1;
  readonly lobbyId: string;
  readonly revision: string;        // K_REVISION of the saving server
  readonly savedByRunId: string;    // the runner that advanced the match last
  readonly tick: number;            // GameSave.tick
  readonly savedAt: number;
  readonly game: GameSave;
  readonly spectator: SpectatorSave | null;
}

/** Saves by lobby. The store does not judge whether a save is resumable; the runner does. */
export interface MatchSaves {
  write(save: MatchSave): Promise<void>;                 // all-or-nothing; rejects on any failure
  read(lobbyId: string): Promise<MatchSave | null>;      // latest complete save, digests verified, or null
}

/** The bulky parts of a save: objects in the private record-input bucket. */
export interface SaveObjects {
  /** Create-only: an existing object of that name is a failure. */
  put(name: string, body: Uint8Array): Promise<void>;
  /** null means the object is missing. */
  get(name: string): Promise<Uint8Array | null>;
}

/** One stored object as the manifest lists it. */
interface ObjectEntry {
  readonly object: string;
  readonly bytes: number;
  readonly sha256: string;
}

const PART_NAME = /^[a-z0-9-]{1,64}$/;
/** Lobby and run ids name a Firestore document and object folders. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

const manifestPath = (lobbyId: string) => `matchSaves/${lobbyId}`;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Every bulky part (the encoded game save and each spectator part) is an object under
 * handover/<lobbyId>/<savedByRunId>/, written first; the Firestore manifest matchSaves/<lobbyId>, written
 * last with the same fields every time, is the save's single validity marker. No bucket: write rejects.
 */
export function createMatchSaves(store: Store, objects: SaveObjects | undefined): MatchSaves {
  return {
    async write(save) {
      if (objects === undefined) throw new Error("match saves need ANTWAR_RECORD_INPUT_BUCKET");
      if (save.format !== 1 || !ID.test(save.lobbyId) || !ID.test(save.savedByRunId) || save.tick !== save.game.tick
        || !Number.isSafeInteger(save.savedAt)) throw new Error("invalid match save");
      const folder = `handover/${save.lobbyId}/${save.savedByRunId}/`;
      const bodies = new Map<string, Uint8Array>([[`${folder}game`, encodeGameSave(save.game)]]);
      const parts: (ObjectEntry & { readonly name: string })[] = [];
      if (save.spectator !== null) {
        if (Buffer.byteLength(save.spectator.meta, "utf8") > SPECTATOR_SAVE_META_BYTES) throw new Error("spectator save meta is too large");
        for (const [name, body] of save.spectator.parts) {
          if (!PART_NAME.test(name)) throw new Error(`invalid spectator save part name ${JSON.stringify(name)}`);
          bodies.set(`${folder}spectator/${name}`, body);
          parts.push({ name, object: `${folder}spectator/${name}`, bytes: body.byteLength, sha256: sha256(body) });
        }
      }
      await Promise.all([...bodies].map(([name, body]) => objects.put(name, body)));
      const game = bodies.get(`${folder}game`)!;
      const fields: Fields = {
        format: "1", lobbyId: save.lobbyId, revision: save.revision, savedByRunId: save.savedByRunId,
        tick: String(save.tick), savedAt: String(save.savedAt),
        game: JSON.stringify({ object: `${folder}game`, bytes: game.byteLength, sha256: sha256(game) } satisfies ObjectEntry),
        // Empty for a save without a spectator side; otherwise the JSON list of its parts.
        spectatorParts: save.spectator === null ? "" : JSON.stringify(parts),
        spectatorMeta: save.spectator?.meta ?? "",
      };
      const path = manifestPath(save.lobbyId);
      await store.transaction(async read => {
        const existing = (await read([path])).get(path) ?? null;
        return { result: undefined, writes: [{ op: existing === null ? "create" : "update", path, fields }] };
      });
    },

    async read(lobbyId) {
      if (!ID.test(lobbyId)) return null;
      const fields = await store.get(manifestPath(lobbyId));
      if (fields === null || fields.format !== "1") return null;
      if (objects === undefined) throw new Error("match saves need ANTWAR_RECORD_INPUT_BUCKET");
      const game = JSON.parse(fields.game ?? "null") as ObjectEntry;
      const parts = fields.spectatorParts ? JSON.parse(fields.spectatorParts) as (ObjectEntry & { name: string })[] : null;
      const entries = [game, ...(parts ?? [])];
      const bodies = await Promise.all(entries.map(async entry => {
        const body = await objects.get(entry.object);
        return body !== null && body.byteLength === entry.bytes && sha256(body) === entry.sha256 ? body : null;
      }));
      if (bodies.some(body => body === null)) return null;
      return {
        format: 1, lobbyId: fields.lobbyId!, revision: fields.revision!, savedByRunId: fields.savedByRunId!,
        tick: Number(fields.tick), savedAt: Number(fields.savedAt), game: decodeGameSave(bodies[0]!),
        spectator: parts === null ? null : { meta: fields.spectatorMeta ?? "", parts: new Map(parts.map((part, i) => [part.name, bodies[i + 1]!])) },
      };
    },
  };
}

/** The private record-input bucket, through the Cloud Run service identity. */
export function gcsSaveObjects(bucket: string, request: typeof fetch = fetch): SaveObjects {
  const writer = createGcsReplayStore(bucket, request);
  const reader = createGcsInputStore(bucket, request);
  return {
    put: (name, body) => writer.create({ name, body, contentType: "application/octet-stream", ifGenerationMatch: 0 }),
    get: name => reader.get(name),
  };
}

export function matchSavesFromEnv(env: Readonly<Record<string, string | undefined>>, store: Store): MatchSaves {
  const bucket = env.ANTWAR_RECORD_INPUT_BUCKET;
  return createMatchSaves(store, bucket ? gcsSaveObjects(bucket) : undefined);
}
