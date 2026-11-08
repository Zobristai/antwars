/**
 * The MCP adapter's own settings. Game rules and their numbers live in
 * src/sim/config.ts; these govern only the server around them.
 */
export interface McpConfig {
  /** Rated-house accepted-call inactivity limit; never a simulation rule. */
  readonly houseIdleSeconds?: number;
  /** Per-agent rate limit. */
  readonly callsPerSecond: number;
  /**
   * Per-match agent cap (as amended):
   * 8, 4 per colony, the
   * largest measured cap keeping seated agents holding ants at least 90% of
   * the time after the first minute.
   */
  readonly maxAgentsPerMatch: number;
  /** An MCP session with no request for this long is closed and removed (the SDK has no idle expiry). */
  readonly sessionIdleMs: number;
  /** How often idle sessions are swept. */
  readonly sessionSweepMs: number;
  /**
   * Most MCP sessions open at once, joined or not, counting initializes still
   * in flight. At the cap a new initialize evicts the oldest session (by
   * creation) that is neither joined nor shielded; only when none is
   * evictable is it refused.
   * Well above maxAgentsPerMatch because a reconnecting agent may hold its old
   * session until it expires.
   */
  readonly maxOpenSessions: number;
  /**
   * Most sessions shielded from that eviction at once. On the entry service a
   * session is protected when one of its account calls proves an identity key,
   * so a queued, lobby or challenge wait keeps its session. On a server hosting
   * matches a session is shielded only while a seat join it sent is in flight,
   * so a join awaiting the store completes. Keys are free to
   * obtain and anyone can send a join, so this share stays well below
   * maxOpenSessions: no one can take every place, and a new initialize always
   * finds one to evict.
   */
  readonly maxProtectedSessions: number;
  /**
   * Most sessions one account identity (username or handle) may protect at
   * once, within maxProtectedSessions, so one free identity cannot take every
   * shield. Counted by identity, not key, so a rotated key shares the count.
   * 8: one identity drives up to 4 team seats, each with its own entry session,
   * and a seat client that re-initializes (restart or 404 recovery) can briefly
   * hold its old session too until the idle expiry.
   */
  readonly maxProtectedSessionsPerIdentity: number;
  /**
   * Longest a request body may take to arrive: past it the request is answered 408 and its
   * connection closed. Real bodies are a few kilobytes and arrive in milliseconds.
   */
  readonly bodyReadMs: number;
  /**
   * Most request bodies read at once on this server for requests not from a joined seat.
   * Each may buffer up to MAX_BODY_BYTES, so 128 bounds that memory at 128 MiB. Past it a request
   * gets a retryable 503 before its body is read. A joined seat's requests are never counted.
   */
  readonly maxUnadmittedBodies: number;
  /** Most of those bodies one source (clientSource) has in flight at once, so one machine cannot take every place. */
  readonly maxUnadmittedBodiesPerSource: number;
  /**
   * On a match slot, how many initializes one client source (clientSource) may
   * have evict a session at the cap at once. An initialize below the
   * cap is never charged; one over the allowance is refused 429 and evicts
   * nothing. 8: 4 team seats from one address, each with one re-initialize.
   */
  readonly initializeBurstPerSource: number;
  /** One more such eviction is allowed per source every this many ms, up to the burst. */
  readonly initializeRefillMsPerSource: number;
  readonly displayNameMaxChars: number;
  readonly modelLabelMaxChars: number;
  /** Optional self-reported seat metadata, never inferred from the model. */
  readonly thinkingLevelMaxChars: number;
  /** Optional self-reported service tier of a lobby-slot seat (for example fast), never inferred. */
  readonly serviceTierMaxChars: number;
}

export const DEFAULT_MCP_CONFIG: McpConfig = {
  callsPerSecond: 2,
  maxAgentsPerMatch: 8,
  sessionIdleMs: 5 * 60 * 1000,
  sessionSweepMs: 30 * 1000,
  maxOpenSessions: 200,
  maxProtectedSessions: 100,
  maxProtectedSessionsPerIdentity: 8,
  bodyReadMs: 10_000,
  maxUnadmittedBodies: 128,
  maxUnadmittedBodiesPerSource: 4,
  initializeBurstPerSource: 8,
  initializeRefillMsPerSource: 15_000,
  displayNameMaxChars: 32,
  modelLabelMaxChars: 64,
  thinkingLevelMaxChars: 32,
  serviceTierMaxChars: 32,
};

/** Transport expiry is independent of the seat's simulation idle timer. */
export function sessionExpiryText(config: Pick<McpConfig, "sessionIdleMs">): string {
  return `An MCP session closes after ${config.sessionIdleMs / 60_000} minutes with no requests. From a new MCP session, call join with reconnectToken to restore the same seat.`;
}

/** Each colony has half the configured match capacity. */
export function agentsPerColony(config: Pick<McpConfig, "maxAgentsPerMatch">): number {
  return config.maxAgentsPerMatch / 2;
}

/** Shared seating rules for tool descriptions and briefings. */
export function agentLimitText(config: Pick<McpConfig, "maxAgentsPerMatch">): string {
  return `Agent limits: ${config.maxAgentsPerMatch} per match, ${agentsPerColony(config)} per colony. A named colony is honoured regardless of balance; if full, the join is refused, never moved to the other colony. Without a colony, join chooses the colony with fewer agents (colony 0 on a tie).`;
}

/** The longest observe may hold its reply. */
export const MAX_OBSERVE_WAIT_SECONDS = 10;

export const DEFAULT_HOUSE_IDLE_SECONDS = 300;

export function houseIdleSecondsOf(config: Pick<McpConfig, "houseIdleSeconds">): number {
  const seconds = config.houseIdleSeconds ?? DEFAULT_HOUSE_IDLE_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("houseIdleSeconds must be a positive finite number");
  return seconds;
}

/** Production startup validates the adapter setting independently of all rules recipes. */
export function houseIdleSecondsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.ANTWAR_HOUSE_IDLE_SECONDS;
  return houseIdleSecondsOf({ houseIdleSeconds: value === undefined || value === "" ? undefined : Number(value) });
}
