/// <reference types="node" />
// The process test/slots/handover-save.test.ts sends Cloud Run's shutdown signal: a slot
// server playing its begun match, with the production signal handling (src/main.ts). It
// prints RUNNING once the match runs, SAVED once the save step's write has committed (the
// save as read back from the store), and EXIT with the match's tick as the process exits.
// The save path is production code: Game.saveMatch and createMatchSaves, through the
// repository's Firestore client (on the emulator when FIRESTORE_EMULATOR_HOST is set) into an
// in-memory record-input bucket that takes SAVE_MS to write each object.
import { setTimeout as sleep } from "node:timers/promises";
import { createMatchSaves, type MatchSaves } from "../../src/handover/saveStore.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { exitOnShutdownSignal } from "../../src/main.ts";
import { startServer } from "../../src/server.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { memoryObjects, testFirestore } from "../handover/helpers.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

const SAVE_MS = Number(process.env.SAVE_MS ?? 500);

const w = retentionWorld(Date.now());
const a = value(await w.ids.claimUsername("ShutdownA")), b = value(await w.ids.claimUsername("ShutdownB"));
const lobbies = createLobbies(w.store, w.ids, { countdownMs: 300 });
await w.store.transaction(async (read) => {
  const paired = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, Date.now());
  return { result: paired.lobby, writes: paired.writes };
});
const bucket = memoryObjects();
const store = createMatchSaves(testFirestore().store, {
  async put(name, body) {
    await sleep(SAVE_MS);
    await bucket.put(name, body);
  },
  get: (name) => bucket.get(name),
});
const saves: MatchSaves = {
  read: (lobbyId) => store.read(lobbyId),
  async write(save) {
    await store.write(save);
    const stored = await store.read(save.lobbyId);
    if (stored === null) throw new Error("the committed save does not read back");
    const { lobbyId, revision, savedByRunId, tick } = stored;
    process.stdout.write(`SAVED ${JSON.stringify({ lobbyId, revision, savedByRunId, tick, gameTick: stored.game.tick })}\n`);
  },
};
const server = await startServer({
  port: 0, host: "127.0.0.1", dataDir: tempDir(), mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 100,
  simConfig: playable(shortConfig(60_000, { ticksPerSecond: 10, queenFounding: PUBLIC_CONFIG.queenFounding })),
  slot: { slot: "public-0", publicUrl: "http://shutdown.test", lobbies, identities: w.ids, pollMs: 20, revision: "r1", saves },
});
exitOnShutdownSignal(server);
process.on("exit", (code) => process.stdout.write(`EXIT ${JSON.stringify({ code, tick: server.game.match?.state.tick ?? null })}\n`));
while ((server.game.match?.state.tick ?? 0) < 5) await sleep(20);
process.stdout.write(`RUNNING ${JSON.stringify({ lobbyId: (await lobbies.slotHolder("public-0"))?.lobbyId, matchRunId: (await lobbies.slotHolder("public-0"))?.matchRunId })}\n`);
