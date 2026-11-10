// A house challenge abandoned because the house colony never joined its match is not counted against the builder's
// daily allowances: the place it held while the match ran is never charged. A builder no-show, a match played to a
// result, and every other ending count exactly as before. Runs the real slot server on an in-memory store.
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { CHALLENGE_OWNER_DAILY_LIMIT, CHALLENGE_SHARED_DAILY_LIMIT } from "../../src/lobby/challenges.js";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { createRatings } from "../../src/rating/ratings.js";
import type { MatchInputs } from "../../src/records/handoff.js";
import { PUBLIC_CONFIG as TEMPLATE_PUBLIC_CONFIG } from "../../src/sim/config.js";
import { startSpectatedServer } from "../../src/spectator.js";
import { createWatchRegistry } from "../../src/live/watch-registry.js";
import { ManualClock } from "../live/helpers.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { playable } from "../playable.js";
import { connect, tempDir, waitFor, type Agent } from "./helpers.js";

// Every match plays at grid scale 2: main's template is built through the one constructor.
const PUBLIC_CONFIG = playable(TEMPLATE_PUBLIC_CONFIG);

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

/** Which seats of the challenge join the match: the house's colony 0, the builder's colony 1. */
type Joins = { readonly house: boolean; readonly builder: boolean };

/**
 * Plays one house challenge on a real slot server with a 1 s idle limit: the house handle takes its lobby seat and is
 * reported launched, then only the seats in `joins` join the match and make no further call. Returns the ended lobby,
 * its stored absent colonies, and the builder's allowances while the match was playing and after it ended.
 */
async function challenge(joins: Joins) {
  const { docs, store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 5, publicSlots: 1 });
  const ratings = createRatings(store, identities);
  // The house holds colony 0 for its handle; the builder sits in colony 1.
  const house = value(await identities.claimUsername("antwars"));
  const handle = value(await identities.createHandle(house.key, "glm-5-3"));
  const builder = value(await identities.claimUsername("builder-player"));
  const allowances = async () => {
    const list = value(await lobbies.listChallengeOpponentsFor(builder.key));
    return { shared: list.allowanceLeft, username: list.usernameAllowanceLeft };
  };
  const { requestId, lobbyId } = value(await lobbies.requestChallenge(builder.key, "antwars/glm-5-3"));
  value(await lobbies.join(lobbyId, handle.key));
  value(await lobbies.reportChallengeLaunch(house.key, requestId, "launched"));
  const config = { ...PUBLIC_CONFIG, startAnts: 0, commandIdleTicks: 1800 };
  const dir = tempDir(), clock = new ManualClock(), submitted: MatchInputs[] = [];
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, simConfig: config, seed: 433,
    startPickWindowMs: 200, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: 1 }, spectatorClock: clock,
    accounts: { identities, lobbies, ratings }, watchRegistry: createWatchRegistry(store),
    recordHandoff: { submit: inputs => { submitted.push(inputs); } }, replayStore: { create: async () => {} },
    slot: { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies, identities, pollMs: 10 } });
  const clients: Agent[] = [];
  try {
    await waitFor(() => server.game.nextStart?.kind === "scheduled");
    for (const [joined, key] of [[joins.house, handle.key], [joins.builder, builder.key]] as const) {
      if (!joined) continue;
      const client = await connect(server.port);
      clients.push(client);
      expect((await client.call("join", { key })).isError).toBe(false);
    }
    await waitFor(() => server.game.match !== null && server.game.match.state.tick > 0);
    const playing = await allowances();
    await waitFor(() => server.game.match?.state.result !== null && server.game.match?.state.result !== undefined);
    let ended: Lobby | undefined;
    for (let n = 0; n < 100; n++) {
      ended = value(await lobbies.readLobby(lobbyId));
      if (ended.state === "ended") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(ended!.state).toBe("ended");
    return { ended: ended!, absent: docs.get(`lobbies/${lobbyId}`)?.absent, result: server.game.match!.result, playing, after: await allowances() };
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const charged = { shared: CHALLENGE_SHARED_DAILY_LIMIT - 1, username: CHALLENGE_OWNER_DAILY_LIMIT - 1 };
const uncharged = { shared: CHALLENGE_SHARED_DAILY_LIMIT, username: CHALLENGE_OWNER_DAILY_LIMIT };

describe("a house challenge's daily allowances by who joined its match", () => {
  it("house no-show: the house colony never joins, the match is abandoned, and the builder is not charged", async () => {
    const run = await challenge({ house: false, builder: true });
    expect(run.result).toMatchObject({ winner: null, reason: "abandoned" });
    expect(run.ended).toMatchObject({ outcome: "abandoned", rated: false });
    expect(run.absent).toBe("0");
    // The place is held while the match plays, and never counted once it ends for the house's absence.
    expect(run.playing).toEqual(charged);
    expect(run.after).toEqual(uncharged);
  }, 20_000);

  it("neither colony joins: the house colony never joined, so the builder is not charged", async () => {
    const run = await challenge({ house: false, builder: false });
    expect(run.ended).toMatchObject({ outcome: "abandoned", rated: false });
    expect(run.absent).toBe("0 1");
    expect(run.after).toEqual(uncharged);
  }, 20_000);

  it("builder no-show: only the builder's colony never joins, the match is abandoned, and the builder stays charged", async () => {
    const run = await challenge({ house: true, builder: false });
    expect(run.ended).toMatchObject({ outcome: "abandoned", rated: false });
    expect(run.absent).toBe("1");
    expect(run.playing).toEqual(charged);
    expect(run.after).toEqual(charged);
  }, 20_000);

  it("normal match: both colonies join and it ends with a result, and the builder stays charged", async () => {
    const run = await challenge({ house: true, builder: true });
    expect(run.result!.reason).not.toBe("abandoned");
    expect(run.ended.outcome).not.toBe("abandoned");
    expect(run.absent).toBeUndefined();
    expect(run.playing).toEqual(charged);
    expect(run.after).toEqual(charged);
  }, 20_000);
});
