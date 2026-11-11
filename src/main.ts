/// <reference types="node" />
import { DEFAULT_MCP_CONFIG, houseIdleSecondsFromEnv } from "./mcp/config.js";
import { comparisonOptions, lobbySlotOptions, SHUTDOWN_SAVE_MS, slotOptions, type GameServer, type SlotWiring } from "./server.js";
import { startSpectatedServer } from "./spectator.js";
import { replayStoreFromEnv } from "./replays/store.js";
import { replaySourceFromEnv } from "./replays/access.js";
import { historySourceFromEnv } from "./replays/history-source.js";
import { firestoreFromEnv } from "./store/firestore.js";
import { createIdentities } from "./identity/identities.js";
import { createLobbies, STALE_HOLD_GRACE_MS } from "./lobby/lobbies.js";
import { createRatings, startRecordFill } from "./rating/ratings.js";
import { PLAN_PATH, startCorrectionPlan } from "./rating/correctionPlan.js";
import { gcsRecordingObjects } from "./replays/abandonRecording.js";
import type { AccountStores } from "./accounts/service.js";
import { usernameClaimLimitRuleFromEnv } from "./accounts/caller.js";
import { configureClientSource } from "./server/clientSource.js";
import { createWatchRegistry } from "./live/watch-registry.js";
import { privateArchiveFromEnv } from "./replays/private-archive.js";
import { recordHandoffFromEnv } from "./records/handoff.js";
import { slotActivity } from "./slots/activity.js";
import { slotWakerFromEnv, wakingStore } from "./slots/wake.js";
import { matchSavesFromEnv } from "./handover/saveStore.js";
import { privateMediaKey } from "./replays/private-media.js";
import { relayKey as deriveRelayKey } from "./live/relay-signature.js";

/**
 * `npm start`: operator configuration is PORT and DATA_DIR,
 * ANTWAR_HOUSE_IDLE_SECONDS sets the rated-house accepted-call timeout (default 300 s),
 * optional ANTWAR_REPLAY_BUCKET for finished public recordings,
 * optional ANTWAR_RECORD_INPUT_BUCKET, with ANTWAR_CODE_VERSION (the full commit
 * deployed), to hand each recorded match to the record service,
 * ANTWAR_OPERATOR_TOKEN for slot-only header-authenticated stop (disabled when unset),
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
  let houseIdleSeconds: number;
  let slotSettings;
  let lobbySlots;
  let recordHandoff;
  let usernameClaimLimitRule;
  let slotWaker;
  let relayKey;
  try {
    usernameClaimLimitRule = usernameClaimLimitRuleFromEnv(process.env);
    configureClientSource(process.env);
    relayKey = deriveRelayKey(privateMediaKey(process.env.ANTWAR_PRIVATE_REPLAY_KEY));
    slotSettings = slotOptions(process.env);
    lobbySlots = lobbySlotOptions(process.env);
    slotWaker = slotWakerFromEnv(process.env);
    comparison = comparisonOptions(process.env, DEFAULT_MCP_CONFIG);
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
  let slot: SlotWiring | undefined;
  let accounts: AccountStores | undefined;
  let correction: ReturnType<typeof startCorrectionPlan> | undefined;
  if (store !== undefined) {
    const identities = createIdentities(store);
    // Slots are assigned through the waking store, so each taken slot's server is woken after commit.
    const lobbyStore = slotWaker === undefined ? store : wakingStore(store, slotWaker);
    // A hold whose server never began its match is released after the stale grace.
    accounts = { identities, lobbies: createLobbies(lobbyStore, identities, { ...lobbySlots, staleHoldGraceMs: STALE_HOLD_GRACE_MS }), ratings: createRatings(store, identities), usernameClaimLimitRule };
    // In the background: rows rated before records existed get theirs; the fill runs
    // once and records completion, so later starts scan nothing.
    void startRecordFill(store);
    // One-off, read-only: the entry point alone plans the owed rating corrections, logs them and serves them at PLAN_PATH.
    if (slotSettings === undefined && process.env.ANTWAR_REPLAY_BUCKET) correction = startCorrectionPlan(store, gcsRecordingObjects(process.env.ANTWAR_REPLAY_BUCKET));
    // Superseded by another instance of its slot, the server has saved any begun match it was
    // playing and closed itself: the process exits so Cloud Run retires this instance
    // and routes the slot only to its owner. Handover saves go to Firestore and the
    // record-input bucket; without ANTWAR_RECORD_INPUT_BUCKET a save fails and the match ends not played.
    if (slotSettings !== undefined) {
      slot = { ...slotSettings, identities, lobbies: accounts.lobbies, saves: matchSavesFromEnv(process.env, store), onRetired: () => process.exit(0) };
    }
  }
  const replayStore = slotSettings !== undefined && comparison.match === undefined ? replayStoreFromEnv(process.env) : undefined;
  const replaySource = comparison.match === undefined ? replaySourceFromEnv(process.env) : undefined;
  const historySource = comparison.match === undefined ? historySourceFromEnv(process.env) : undefined;
  const privateArchive = comparison.match === undefined ? privateArchiveFromEnv(process.env) : undefined;
  const watchRegistry = store === undefined ? undefined : createWatchRegistry(store);
  const server = await startSpectatedServer({ port, dataDir, ...comparison, mcpConfig: { ...DEFAULT_MCP_CONFIG, ...comparison.mcpConfig, houseIdleSeconds }, replayStore, replaySource, historySource, privateArchive, recordHandoff, watchRegistry, relayKey, operatorToken: process.env.ANTWAR_OPERATOR_TOKEN, slot, accounts, startPickWindowMs: options.startPickWindowMs,
    // Every match a deployed server plays reports its tick times to Cloud Run logs.
    tickReport: { log: (line) => console.log(line) } });
  if (correction !== undefined) server.mount(PLAN_PATH, correction.serve);
  console.log(`antwar listening on port ${server.port} (spectator at /, agents at /mcp)${slot !== undefined || comparison.match !== undefined ? `; match logs in ${dataDir}` : "; entry point does not host matches"}`);
  if (slot !== undefined) console.log(`antwar slot server for ${slot.slot} at ${slot.publicUrl}`);
  if (comparison.match === "held") {
    console.log(`antwar comparison run: rules ${comparison.simConfig?.rules}, ${comparison.expectedPlayers} players, seed ${comparison.seed}; the match starts when every player has joined`);
  }
  exitOnShutdownSignal(server);
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
