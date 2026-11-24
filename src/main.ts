/// <reference types="node" />
import { currentRosterSeats } from "./replays/roster-ownership.js";
import { DEFAULT_MCP_CONFIG, houseIdleSecondsFromEnv } from "./mcp/config.js";
import { damagePerTick, firstHatchTicks, hatchIntervalOf, rulesVersionOf, type SimConfig } from "./sim/config.js";
import { comparisonOptions, lobbySlotOptions, SHUTDOWN_SAVE_MS, slotOptions, type GameServer, type SlotWiring } from "./server.js";
import { startSpectatedServer } from "./spectator.js";
import { replayStoreFromEnv } from "./replays/store.js";
import { replaySourceFromEnv } from "./replays/access.js";
import { historySourceFromEnv } from "./replays/history-source.js";
import { firestoreFromEnv } from "./store/firestore.js";
import { createIdentities } from "./identity/identities.js";
import { createPublicVisibility, publicExcludedOwnerIdsFromEnv, usersOwnerPolicy } from "./identity/publicVisibility.js";
import { testClaimOwnerIdsFromEnv } from "./identity/testClaimAuthorization.js";
import { createLobbies, STALE_HOLD_GRACE_MS } from "./lobby/lobbies.js";
import { ffaSettingsFromEnv } from "./rating/ffaSettings.js";
import { createRatings, startRecordFill } from "./rating/ratings.js";
import { correctedHistorySource, correctedReplaySource } from "./replays/correctedRecordings.js";
import type { AccountStores } from "./accounts/service.js";
import { usernameClaimLimitRuleFromEnv } from "./accounts/caller.js";
import { configureClientSource } from "./server/clientSource.js";
import { createWatchRegistry } from "./live/watch-registry.js";
import { createTestRecordings } from "./replays/test-recordings.js";
import { startTestBackfill } from "./replays/testBackfill.js";
import { privateArchiveFromEnv } from "./replays/private-archive.js";
import { recordHandoffFromEnv } from "./records/handoff.js";
import { slotActivity } from "./slots/activity.js";
import { slotWakerFromEnv, wakingStore } from "./slots/wake.js";
import { matchSavesFromEnv } from "./handover/saveStore.js";
import { privateMediaKey } from "./replays/private-media.js";
import { relayKey as deriveRelayKey } from "./live/relay-signature.js";
import { createVersionSource, httpUploadPack } from "./accounts/postMortemVersion.js";

/**
 * `npm start`: operator configuration is PORT and DATA_DIR,
 * ANTWAR_HOUSE_IDLE_SECONDS sets the rated-house accepted-call timeout (default 300 s),
 * optional ANTWAR_REPLAY_BUCKET for finished public recordings,
 * optional ANTWAR_RECORD_INPUT_BUCKET, with ANTWAR_CODE_VERSION (the full commit
 * deployed), to hand each recorded match to the record service,
 * ANTWAR_OPERATOR_TOKEN for slot-only header-authenticated stop (disabled when unset),
 * optional ANTWARS_TEST_CLAIM_OWNER_IDS, a comma-separated allowlist of existing non-house
 * username identity UUIDs whose current keys may authorise test username claims without
 * spending the per-address budget. Unset or blank grants no allowance. It is not a secret;
 * the corresponding keys stay in the test caller's private store, never in configuration.
 * ANTWAR_LOAD_BALANCER_ADDRESS, the comma list of this deployment's load-balancer
 * addresses that clientSource looks past (unset on match slots), and,
 * for private antwar-preview comparison runs only, ANTWAR_RULES and
 * ANTWAR_PLAYERS. The public service never sets them.
 * A deployed slot server sets ANTWAR_SLOT, ANTWAR_PUBLIC_URL and
 * ANTWAR_STORE_NAMESPACE, and plays only its lobbies' matches; once another instance
 * takes its slot it closes and the process exits. ANTWAR_PUBLIC_SLOTS
 * and ANTWAR_PRIVATE_SLOTS set the match slots per lobby kind, 1 each when unset.
 * ANTWAR_SLOT_URL_TEMPLATE, an https URL containing {slot}, names each
 * slot server's address so a server that assigns a slot wakes it. With
 * ANTWAR_STORE_NAMESPACE set, any server also serves usernames, handles, lobbies
 * and the leaderboard as MCP tools and POST /api/<operation>.
 * Every match the server plays logs its tick reports to stdout: one per 60-second stretch
 * as it runs, and one for the whole match when it ends.
 */
export async function startMain(options: { readonly startPickWindowMs?: number } = {}): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = process.env.DATA_DIR ?? "data";
  let comparison;
  let ffa;
  let houseIdleSeconds: number;
  let slotSettings;
  let lobbySlots;
  let recordHandoff;
  let usernameClaimLimitRule;
  let testClaimOwnerIds;
  let publicExcludedOwnerIds;
  let slotWaker;
  let relayKey;
  try {
    usernameClaimLimitRule = usernameClaimLimitRuleFromEnv(process.env);
    testClaimOwnerIds = testClaimOwnerIdsFromEnv(process.env);
    publicExcludedOwnerIds = publicExcludedOwnerIdsFromEnv(process.env);
    configureClientSource(process.env);
    relayKey = deriveRelayKey(privateMediaKey(process.env.ANTWAR_PRIVATE_REPLAY_KEY));
    slotSettings = slotOptions(process.env);
    lobbySlots = lobbySlotOptions(process.env);
    slotWaker = slotWakerFromEnv(process.env);
    comparison = comparisonOptions(process.env, DEFAULT_MCP_CONFIG);
    ffa = ffaSettingsFromEnv(process.env);
    if (comparison.simConfig !== undefined) comparison = { ...comparison, simConfig: { ...comparison.simConfig, ffaTerritoryWinnerFirst: true } };
    houseIdleSeconds = houseIdleSecondsFromEnv(process.env);
    // A slot server is not idle while a match's record inputs await storage.
    const handoffActivity = slotSettings === undefined ? undefined : slotActivity(slotSettings.slot);
    recordHandoff = slotSettings !== undefined && comparison.match === undefined ? recordHandoffFromEnv(process.env, fetch, handoffActivity) : undefined;
  } catch (err) {
    console.error(`antwar refused to start: ${(err as Error).message}`);
    process.exit(1);
  }
  // One configured store serves the slot runner and the account operations.
  const store = firestoreFromEnv(process.env);
  if (publicExcludedOwnerIds.length > 0 && store === undefined) throw new Error("Public visibility requires an account store");
  const watchRegistry = store === undefined ? undefined : createWatchRegistry(store);
  const publicVisibility = store && watchRegistry ? createPublicVisibility(store, watchRegistry, publicExcludedOwnerIds) : undefined;
  // Test matches' recordings: marked by the slot that records one, read by every public list.
  const testRecordings = store === undefined ? undefined : createTestRecordings(store);
  let slot: SlotWiring | undefined;
  let accounts: AccountStores | undefined;
  if (store !== undefined) {
    const identities = createIdentities(store, { testClaimOwnerIds });
    // Slots are assigned through the waking store, so each taken slot's server is woken after commit.
    const lobbyStore = slotWaker === undefined ? store : wakingStore(store, slotWaker);
    // A hold whose server never began its match is released after the stale grace.
    accounts = { identities, lobbies: createLobbies(lobbyStore, identities, { ...lobbySlots, staleHoldGraceMs: STALE_HOLD_GRACE_MS, ffaLiveEnabled: ffa.liveEnabled }), ratings: createRatings(store, identities, publicVisibility, testRecordings), publicVisibility, usernameClaimLimitRule };
    // In the background: rows rated before records existed get theirs; the fill runs
    // once and records completion, so later starts scan nothing.
    void startRecordFill(store);
    // In the background, once: test matches recorded before the test type existed are marked test (counts logged only).
    if (watchRegistry !== undefined) void startTestBackfill(store, watchRegistry);
    // Superseded by another instance of its slot, the server has saved any begun match it was
    // playing and closed itself: the process exits so Cloud Run retires this instance
    // and routes the slot only to its owner. Handover saves go to Firestore and the
    // record-input bucket; without ANTWAR_RECORD_INPUT_BUCKET a save fails and the match ends not played.
    if (slotSettings !== undefined) {
      slot = { ...slotSettings, identities, lobbies: accounts.lobbies, saves: matchSavesFromEnv(process.env, store), onRetired: () => process.exit(0) };
    }
  }
  const replayStore = slotSettings !== undefined && comparison.match === undefined ? replayStoreFromEnv(process.env) : undefined;
  // The matches the rating corrections changed are served corrected once each correction reads applied.
  const storedReplays = comparison.match === undefined ? replaySourceFromEnv(process.env) : undefined;
  const replaySource = storedReplays && store ? correctedReplaySource(storedReplays, store) : storedReplays;
  const storedHistory = comparison.match === undefined ? historySourceFromEnv(process.env) : undefined;
  const historySource = storedHistory && store ? correctedHistorySource(storedHistory, store) : storedHistory;
  const privateArchive = comparison.match === undefined ? privateArchiveFromEnv(process.env) : undefined;
  // The entry server's post-mortem checks a record's game version against the repository's main history; its own
  // build (ANTWAR_CODE_VERSION) must be in that history for any answer to be trusted.
  const ownVersion = process.env.ANTWAR_CODE_VERSION;
  const postMortemVersions = slotSettings === undefined && comparison.match === undefined && ownVersion
    ? createVersionSource({ post: httpUploadPack(), ownVersion, log: (line) => console.log(line) }) : undefined;
  const server = await startSpectatedServer({ port, dataDir, ...comparison, mcpConfig: { ...DEFAULT_MCP_CONFIG, ...comparison.mcpConfig, houseIdleSeconds }, replayStore, replaySource, historySource, storedHistorySource: storedHistory, privateArchive, recordHandoff, watchRegistry, publicVisibility, currentRosterSeats: store && currentRosterSeats(store), usersPolicy: usersOwnerPolicy(() => publicExcludedOwnerIdsFromEnv(process.env), store, watchRegistry), testRecordings, postMortemVersions, relayKey, operatorToken: process.env.ANTWAR_OPERATOR_TOKEN, slot, accounts, startPickWindowMs: options.startPickWindowMs,
    // Every match a deployed server plays reports its tick times to Cloud Run logs.
    tickReport: { log: (line) => console.log(line) } });
  console.log(`antwar listening on port ${server.port} (spectator at /, agents at /mcp)${slot !== undefined || comparison.match !== undefined ? `; match logs in ${dataDir}` : "; entry point does not host matches"}`);
  if (slot !== undefined) console.log(`antwar slot server for ${slot.slot} at ${slot.publicUrl}`);
  if (comparison.simConfig !== undefined) console.log(startupRulesLine(comparison.simConfig));
  if (comparison.match === "held") {
    console.log(`antwar comparison run: rules ${comparison.simConfig?.rules}, ${comparison.expectedPlayers} players, seed ${comparison.seed}; the match starts when every player has joined`);
  }
  exitOnShutdownSignal(server);
}

/** The startup log's line naming the rules version this server plays and its unit numbers and hatch clock. */
export function startupRulesLine(config: SimConfig): string {
  const hp = (milli: number) => milli / 1000, perSecond = (perTick: number) => hp(perTick * config.ticksPerSecond);
  const units = [`worker ${hp(config.antHp)} HP, ${perSecond(damagePerTick(config))} HP/s, ${config.hatchCost} food`];
  if (config.castes !== undefined) {
    const { soldierCost, soldierHpPermille, soldierDamagePermille } = config.castes;
    units.push(`soldier ${hp(Math.trunc((config.antHp * soldierHpPermille) / 1000))} HP, ${perSecond(Math.trunc((damagePerTick(config) * soldierDamagePermille) / 1000))} HP/s, ${soldierCost} food`);
  }
  const queen = config.queenHp;
  if (queen !== undefined) {
    units.push("damagePerSecond" in queen ? `queen ${hp(queen.hp)} HP, ${hp(queen.damagePerSecond)} HP/s every tick` : `queen ${hp(queen.hp)} HP, bites ${hp(queen.biteDamage)} HP every ${queen.biteIntervalTicks} ticks`);
  }
  const worker = hatchIntervalOf(config, "worker"), soldier = hatchIntervalOf(config, "soldier");
  const first = firstHatchTicks(config);
  const hatch = config.hatchRate !== undefined
    ? `hatch ${config.hatchRate.foodPerSecond} food/s per queen: worker every ${worker} ticks, soldier every ${soldier}; starting queen's first worker at tick ${first.worker}, first soldier at tick ${first.soldier}`
    : `hatch: worker every ${worker} ticks${config.castes === undefined ? "" : `, soldier every ${soldier}`}`;
  return `antwar rules ${rulesVersionOf(config)}${config.rules === undefined ? "" : ` (${config.rules})`}: ${units.join("; ")}; ${hatch}`;
}

/**
 * Cloud Run's shutdown signal, SIGTERM (or SIGINT): a slot server running its begun match saves
 * it first with the handover's save step, within the 10 s Cloud Run allows; then the
 * server closes and the process exits. A failed shutdown is logged and the process exits 1.
 */
export function exitOnShutdownSignal(server: Pick<GameServer, "shutdown">, exit: (code: number) => void = process.exit): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () =>
      void server.shutdown(SHUTDOWN_SAVE_MS).then(
        () => exit(0),
        (err: unknown) => {
          console.error(`antwar shutdown failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          exit(1);
        },
      ),
    );
  }
}

// Importing the bootstrap for a subprocess test does not start a second server.
// Direct production startup supplies no test overrides.
if (import.meta.main) await startMain();
