import { recordStatus, type RecordStore } from "../../src/records/record-store.js";
import type { PrivateArchive } from "../../src/replays/private-archive.js";
import type { ReplayStore } from "../../src/replays/store.js";

/**
 * A test record target over plain replay stores: a public match's record is created once in publicStore and a
 * private one in its lobby's archive. A collision fails the save, so the service keeps the input.
 */
export function createOnlyRecords(publicStore?: ReplayStore, privateArchive?: PrivateArchive): RecordStore {
  return {
    forMatch(id, lobbyId) {
      const store = lobbyId === null ? publicStore : privateArchive?.forLobby(lobbyId);
      if (store === undefined) return undefined;
      return {
        async save(body) {
          const status = recordStatus(body, id);
          await store.create({ name: `${id}.json`, body, contentType: "application/json", ifGenerationMatch: 0 });
          return { complete: status === "complete", outcome: "record created" };
        },
      };
    },
  };
}
