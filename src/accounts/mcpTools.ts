import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { payload } from "../mcp/replies.js";
import { accountRefusal, refusesSeatClient, SEAT_CLIENT_ENTRY_TOOLS } from "./seatClientAdmission.js";
import { KEY_ISSUING_TOOLS, type KeyIssuingHold, type LostKey, type SessionAccess } from "../mcp/http.js";
import {
  ACCOUNT_OPERATIONS, nothingToRecover, RECOVER_KEY_DESCRIPTION, RECOVER_KEY_INPUT, RECOVERED_KEY_WARNING, serverBusy,
  type AccountStores, type Reply,
} from "./service.js";

/** SHA-256 of a key, lowercase hex: the store's verifier form. A key is never held, only this. */
const digest = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");
/** The key argument a call presented, as its digest; null when it presented none. */
const proofOf = (key: unknown): string | null => (typeof key === "string" && key !== "" ? digest(key) : null);
/** Whether two presented-key digests are the same proof, compared in constant time. */
const sameProof = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/**
 * The account operations as MCP tools on one session's server, beside the match
 * tools. A reply's JSON is the same object POST /api/<name> answers with; a
 * refusal is that object as an error result. A store failure thrown here becomes
 * the SDK's error result, never a log line. On the entry server (seatClientAdmission),
 * a seat client 1.0.0 session is refused its entry calls before the operation runs.
 *
 * recover_key is served here only, never at POST /api: when a key-issuing call commits but its reply never
 * finishes writing, the session keeps that key's verifier and a digest of the key the call presented
 * (KeyIssuingHold.issued); recover_key in the same session, presenting the same key, replaces the lost key with a
 * fresh one. Any other call gets the one nothing_to_recover refusal, which reads no store.
 */
export function registerAccountTools(server: McpServer, stores: AccountStores, options: { seatClientAdmission?: boolean; session?: SessionAccess } = {}): void {
  const session = options.session;
  /** This session's last resolved key, as a digest so no key is held, and the identity it proved. */
  let resolved: { readonly digest: string; readonly identityId: string } | undefined;
  /**
   * A call that succeeded with a key proved an identity: protect its session from eviction at the
   * cap, counted against that account identity. The key is resolved only when protection
   * could still be granted, and once per key per session. A failure to resolve leaves the session
   * unprotected; it never fails the reply. Key-issuing operations name the identity they proved
   * instead (protectProven), so nothing is awaited between their commit and their reply.
   */
  async function protectFor(key: string): Promise<void> {
    if (session === undefined || !session.mayProtect()) return;
    const keyDigest = digest(key);
    if (resolved?.digest !== keyDigest) {
      const found = await stores.identities.resolveKey(key).catch(() => undefined);
      if (found === undefined || !found.ok) return;
      resolved = { digest: keyDigest, identityId: found.value.id };
    }
    session.protect(resolved.identityId);
  }
  /** Protect with an identity the call already proved: synchronous, no store read. */
  function protectProven(identityId: string): void {
    if (session !== undefined && session.mayProtect()) session.protect(identityId);
  }
  const refused = (reply: Reply) => payload({ ...(reply.ok ? {} : reply.body) }, true);
  for (const op of ACCOUNT_OPERATIONS) {
    const gated = options.seatClientAdmission === true && SEAT_CLIENT_ENTRY_TOOLS.has(op.name);
    const issuing = KEY_ISSUING_TOOLS.has(op.name);
    server.registerTool(op.name, { description: op.description, inputSchema: op.input }, async (args, extra) => {
      if (gated && refusesSeatClient(server)) return accountRefusal();
      const input = args as Record<string, unknown>;
      // No hold, no key: a key-issuing call whose own request holds no place for its reply is
      // refused before anything is read or committed (resolveKey included); its commit is aborted if that
      // hold has ended first, and otherwise pins the hold until the reply's response closes.
      let guard: KeyIssuingHold | undefined;
      if (issuing && session !== undefined) {
        const hold = session.keyIssuingHold();
        if (hold === undefined) return refused(serverBusy());
        guard = hold;
        // One key-issuing call at a time per session, each settled delivered or lost before the next (turn).
        await guard.turn();
      }
      let reply: Reply;
      try {
        reply = await op.run(stores, input, extra.requestInfo?.headers ?? {}, guard);
        // A newly issued key, by verifier only, kept by the session if its reply is not delivered. A key the call
        // presented and kept (claim_username for a released account) was delivered before: it is never recorded as
        // lost, but its delivered reply still clears any pending lost key, like every key-issuing reply.
        if (reply.ok && guard !== undefined && typeof reply.body.key === "string") {
          const issued = { verifier: digest(reply.body.key), proof: proofOf(input.key) };
          guard.issued(sameProof(issued.verifier, issued.proof) ? null : issued);
        }
      } finally {
        guard?.finish();
      }
      if (reply.ok && typeof input.key === "string" && input.key !== "") {
        // A proven identity is used as is, so a key-issuing commit is followed directly by its reply.
        if (reply.identityId !== undefined) protectProven(reply.identityId);
        else await protectFor(input.key);
      }
      return reply.ok ? payload(reply.body) : refused(reply);
    });
  }
  server.registerTool("recover_key", { description: RECOVER_KEY_DESCRIPTION, inputSchema: RECOVER_KEY_INPUT }, async (args) => {
    const proof = proofOf((args as Record<string, unknown>).key);
    // Nothing read from the store unless this session holds a lost key and this call presents the same proof.
    const pending = (): LostKey | undefined => {
      const lost = session?.lostKey();
      return lost !== undefined && sameProof(lost.proof, proof) ? lost : undefined;
    };
    if (session === undefined) return refused(nothingToRecover());
    // Decide only after any key-issuing call already in this session has settled: a call whose client dropped
    // mid-commit records its lost key once its commit completes, which may be after this call arrives.
    await session.keyTurnsSettled();
    if (pending() === undefined) return refused(nothingToRecover());
    const hold = session.keyIssuingHold();
    if (hold === undefined) return refused(serverBusy());
    // Read again in this session's key-issuing turn: a reply delivered before it has cleared the lost key.
    await hold.turn();
    try {
      const lost = pending();
      if (lost === undefined) return refused(nothingToRecover());
      const reissued = await stores.identities.reissueLostKey(lost.verifier, hold);
      if (!reissued.ok && reissued.reason === "server_busy") return refused(serverBusy());
      // One-shot: recovered, or no longer the identity's current key (replaced since, or expired).
      session.clearLostKey(lost);
      if (!reissued.ok) return refused(nothingToRecover());
      hold.issued({ verifier: digest(reissued.value.key), proof });
      protectProven(reissued.value.identityId);
      return payload({ key: reissued.value.key, warning: RECOVERED_KEY_WARNING });
    } finally {
      hold.finish();
    }
  });
}
