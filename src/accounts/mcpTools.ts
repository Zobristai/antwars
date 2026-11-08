import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { payload } from "../mcp/replies.js";
import { accountRefusal, refusesSeatClient, SEAT_CLIENT_ENTRY_TOOLS } from "./seatClientAdmission.js";
import type { CommitGuard } from "../identity/identities.js";
import { KEY_ISSUING_TOOLS, type SessionAccess } from "../mcp/http.js";
import { ACCOUNT_OPERATIONS, serverBusy, type AccountStores, type Reply } from "./service.js";

/**
 * The account operations as MCP tools on one session's server, beside the match
 * tools. A reply's JSON is the same object POST /api/<name> answers with; a
 * refusal is that object as an error result. A store failure thrown here becomes
 * the SDK's error result, never a log line. On the entry server (seatClientAdmission),
 * a seat client 1.0.0 session is refused its entry calls before the operation runs.
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
    const digest = createHash("sha256").update(key, "utf8").digest("hex");
    if (resolved?.digest !== digest) {
      const found = await stores.identities.resolveKey(key).catch(() => undefined);
      if (found === undefined || !found.ok) return;
      resolved = { digest, identityId: found.value.id };
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
      let guard: CommitGuard | undefined;
      if (issuing && session !== undefined) {
        const hold = session.keyIssuingHold();
        if (hold === undefined) return refused(serverBusy());
        guard = hold;
      }
      const reply = await op.run(stores, input, extra.requestInfo?.headers ?? {}, guard);
      if (reply.ok && typeof input.key === "string" && input.key !== "") {
        // A proven identity is used as is, so a key-issuing commit is followed directly by its reply.
        if (reply.identityId !== undefined) protectProven(reply.identityId);
        else await protectFor(input.key);
      }
      return reply.ok ? payload(reply.body) : refused(reply);
    });
  }
}
