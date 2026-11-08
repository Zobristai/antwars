// The Leaderboard's Challenge list: every house handle a builder can challenge, from the same POST
// /api/list_challenge_opponents its agent calls. Only the fields the page shows are kept; the allowance and any reason a
// handle is unavailable are not shown.
import { z } from "zod";

const opponent = z.object({
  handle: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  level: z.string().min(1).max(32).nullable(),
  tier: z.string().min(1).max(32).nullable(),
  available: z.boolean(),
});
const opponents = z.object({ opponents: z.array(opponent).max(500) });
/** One house handle as the Challenge list shows it: its full handle (antwars/<handle>), name, fixed level and tier, availability. */
export type Opponent = z.infer<typeof opponent>;

/** The house handles in the server's order; it throws on a failed or malformed read, as loadLeaderboard does. */
export async function loadChallengeOpponents(signal: AbortSignal, request: typeof fetch = fetch): Promise<readonly Opponent[]> {
  const response = await request("/api/list_challenge_opponents", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error("House handle list unavailable.");
  const read = opponents.safeParse(await response.json());
  if (!read.success) throw new Error("House handle list unavailable.");
  return read.data.opponents;
}
