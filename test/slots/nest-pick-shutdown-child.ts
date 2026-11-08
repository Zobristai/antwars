/// <reference types="node" />
// The process test/slots/nest-pick-handover.test.ts sends Cloud Run's shutdown signal: a
// slot server whose begun match is still in its nest-pick window, one seat queued and picked, with the
// production signal handling (src/main.ts) and the real save store over an in-memory store. It prints
// PICKING once the seat has picked, SAVED with the save as read back from the store once the save step
// has written it, and EXIT as the process exits.
import { createMatchSaves, type MatchSaves } from "../../src/handover/saveStore.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { exitOnShutdownSignal } from "../../src/main.ts";
import type { Game } from "../../src/mcp/game.ts";
import { startServer } from "../../src/server.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { memoryObjects } from "../handover/helpers.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

const w = retentionWorld(Date.now());
const a = value(await w.ids.claimUsername("SignalA")), b = value(await w.ids.claimUsername("SignalB"));
const lobbies = createLobbies(w.store, w.ids, { countdownMs: 300 });
await w.store.transaction(async (read) => {
  const paired = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, Date.now());
  return { result: paired.lobby, writes: paired.writes };
});
const store = createMatchSaves(w.store, memoryObjects());
const saves: MatchSaves = {
  async write(save) {
    await store.write(save);
    const read = (await store.read(save.lobbyId))!;
    const game = read.game;
    process.stdout.write(`SAVED ${JSON.stringify({ lobbyId: read.lobbyId, savedByRunId: read.savedByRunId, revision: read.revision, tick: read.tick,
      phase: game.phase, spectator: read.spectator, seed: game.seed, picks: game.phase === "start" ? game.start.picks.length : null,
      remainingMs: game.phase === "start" ? game.start.remainingMs : null })}\n`);
  },
  read: (lobbyId) => store.read(lobbyId),
};
const server = await startServer({
  port: 0, host: "127.0.0.1", dataDir: tempDir(), mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 60_000,
  simConfig: playable(shortConfig(600, { queenFounding: PUBLIC_CONFIG.queenFounding })),
  slot: { slot: "public-0", publicUrl: "http://nest-pick-shutdown.test", lobbies, identities: w.ids, pollMs: 20, revision: "r1", saves },
});
exitOnShutdownSignal(server);
const game = server.game as Game;
process.on("exit", (code) => process.stdout.write(`EXIT ${JSON.stringify({ code, match: server.game.match?.seq ?? null })}\n`));
while (game.openStart === null) await sleep(20);
const joined = (await game.joinSeated(a.identity.id, "test-model"))!;
const view = game.nestSelection(joined.agentId!, true)!;
const dy = view.terrain!.rows.findIndex((row) => row.includes("."));
const picked = game.pickNest(joined.agentId!, view.box.x + view.terrain!.rows[dy]!.indexOf("."), view.box.y + dy);
if (!picked.ok) throw new Error(`pick refused: ${JSON.stringify(picked)}`);
const holder = await lobbies.slotHolder("public-0");
process.stdout.write(`PICKING ${JSON.stringify({ lobbyId: holder?.lobbyId, matchRunId: holder?.matchRunId, seed: game.openStart!.seed })}\n`);
