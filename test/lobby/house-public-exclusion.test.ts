import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { QUEUE_MODES } from "../../src/lobby/queue.ts";
import { createFirestore } from "../../src/store/firestore.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
let counter = 0;
const freshNamespace = () => `hp${process.pid}-${Date.now().toString(36)}-${counter++}`;
const storeFor = (namespace: string) => createFirestore({ projectId, namespace, emulatorHost: host });

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

function world() {
  const namespace = freshNamespace();
  const clock = { t: Date.UTC(2026, 9, 23, 8, 0, 0) };
  const ids = createIdentities(storeFor(namespace));
  const lobbies = createLobbies(storeFor(namespace), createIdentities(storeFor(namespace)), { now: () => clock.t });
  return { ids, lobbies };
}

/** Every public ranked mode the queue accepts: each row whose house flag is false. */
const publicModes = Object.entries(QUEUE_MODES).filter(([, row]) => row !== undefined && !row.house).map(([mode]) => mode).sort();

describe.skipIf(!host)("public ranked modes never pair two antwars-owned handles", { timeout: 60_000 }, () => {
  it("covers the public 1v1 mode", () => {
    expect(publicModes).toContain("1v1");
  });

  it.each(publicModes)("%s: antwars handles wait for each other; a different owner pairs with one of them", async (mode) => {
    const w = world();
    const antwars = value(await w.ids.claimUsername("antwars"));
    const handles = [];
    for (const name of ["alpha", "beta", "gamma"]) handles.push(value(await w.ids.createHandle(antwars.key, name)));
    for (const handle of handles) expect(value(await w.lobbies.joinQueue(handle.key, mode))).toMatchObject({ state: "waiting", mode });
    for (const handle of handles) expect(value(await w.lobbies.queueStatus(handle.key))).toMatchObject({ state: "waiting", mode });

    const outsider = value(await w.ids.claimUsername("Kite"));
    const matched = value(await w.lobbies.joinQueue(outsider.key, mode));
    expect(matched).toMatchObject({ state: "matched", mode });
    const lobbyId = (matched as { readonly lobbyId: string }).lobbyId;
    const statuses = await Promise.all(handles.map(async (handle) => value(await w.lobbies.queueStatus(handle.key))));
    const paired = handles.filter((_, i) => statuses[i]!.state === "matched");
    expect(paired).toHaveLength(1);
    expect(statuses.filter((status) => status.state === "waiting")).toHaveLength(2);
    expect(statuses.find((status) => status.state === "matched")).toMatchObject({ lobbyId });
    const lobby = value(await w.lobbies.readLobby(lobbyId));
    expect(new Set(lobby.colonies.flat().map((seat) => seat.id))).toEqual(new Set([outsider.identity.id, paired[0]!.identity.id]));
  });
});
