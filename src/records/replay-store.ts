import { createGcsObjectReader, isReplayId, type ReplayGet } from "../replays/access.js";
import { createPrivateArchive, type PrivateArchive } from "../replays/private-archive.js";
import { createGcsReplayStore, ReplayCreateError, type ReplayStore } from "../replays/store.js";
import { collect } from "../store/gcs.js";

export interface RecordReplayTarget {
  /** Return the existing normal replay, or create the checkpoint only when fallback is allowed. */
  resolve(checkpoint: Uint8Array, allowFallback: boolean): Promise<Uint8Array | null>;
}
export interface RecordReplayStore {
  /** No private encryption means no private publication, never a public substitute. */
  forMatch(id: string, lobbyId: string | null): RecordReplayTarget | undefined;
}

/** Explicit adapters keep arbitration identical for public objects and authenticated private media. */
export function createRecordReplayStore(deps: {
  publicStore: ReplayStore;
  readPublic: (id: string) => Promise<Uint8Array | null>;
  privateArchive?: PrivateArchive;
}): RecordReplayStore {
  return {
    forMatch(id, lobbyId) {
      if (!isReplayId(id)) throw new Error("invalid replay id");
      if (lobbyId !== null && !lobbyId) throw new Error("Invalid private lobby");
      const store = lobbyId === null ? deps.publicStore : deps.privateArchive?.forLobby(lobbyId);
      if (store === undefined) return undefined;
      const read = () => lobbyId === null ? deps.readPublic(id) : deps.privateArchive!.open(
        { lobbyId, replayId: id, kind: "recording" }, AbortSignal.timeout(300_000)).then(collect);
      return {
        async resolve(checkpoint, allowFallback) {
          const existing = await read();
          if (existing !== null || !allowFallback) return existing;
          try {
            await store.create({ name: `${id}.bin`, body: checkpoint, contentType: "application/octet-stream", contentEncoding: "gzip", ifGenerationMatch: 0 });
            return checkpoint;
          } catch (error) {
            if (!(error instanceof ReplayCreateError && error.status === 412)) throw error;
            // A normal final release (or another recovery worker) won. Verify those exact bytes.
            const winner = await read();
            if (winner === null) throw new Error("replay create collided but the winning replay is missing; input retained");
            return winner;
          }
        },
      };
    },
  };
}

export function createGcsRecordReplayStore(bucket: string, key: Uint8Array | undefined, request: typeof fetch = fetch, get?: ReplayGet): RecordReplayStore {
  const publicStore = createGcsReplayStore(bucket, request), read = createGcsObjectReader(bucket, request, get);
  return createRecordReplayStore({ publicStore,
    readPublic: id => read(`${id}.bin`, AbortSignal.timeout(300_000)).then(collect),
    privateArchive: key === undefined ? undefined : createPrivateArchive(publicStore, read, key),
  });
}
