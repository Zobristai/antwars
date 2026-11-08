/// <reference types="node" />
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Proof that a /watch/live request reached a slot server through the entry service's relay.
 * Every relayed viewer arrives at the slot from the entry's egress address, so the
 * slot's per-source spectator bound would otherwise count them all as one source; the entry
 * bounds them per viewer source instead, and signs each relay so the slot can skip only its
 * per-source check for it. The relay still counts toward the slot's overall spectator cap.
 *
 * The header is `<timestamp ms>.<HMAC-SHA256(lobbyId.timestamp)>` under the relay key, an HKDF
 * subkey (info "antwar-relay-v1") of ANTWAR_PRIVATE_REPLAY_KEY, which the entry and every slot
 * already hold: no new secret, and HKDF keeps relay signing apart from replay encryption.
 *
 * A signature that does not verify (forged, stale, malformed, or made under another key, as during
 * a rolling swap of the replay key) is never itself a reason to refuse: the request is treated as
 * unsigned and meets the per-source bound like a direct viewer. During such a swap the relayed
 * viewers of a slot share the entry's egress address, so past that bound they get the retryable
 * 503 and reconnect until the keys match again.
 *
 * Never log or echo the header or the key.
 */

export const RELAY_HEADER = "x-antwar-relay";
/** How old a relay signature may be, either way, before it no longer counts. */
export const RELAY_SIGNATURE_MAX_AGE_MS = 60_000;
const RELAY_KEY_INFO = "antwar-relay-v1";
const SIGNATURE = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/;

/** The relay key derived from the private replay key; undefined when that key is not configured. */
export function relayKey(privateReplayKey: Uint8Array | undefined): Buffer | undefined {
  if (privateReplayKey === undefined) return undefined;
  return Buffer.from(hkdfSync("sha256", privateReplayKey, Buffer.alloc(0), RELAY_KEY_INFO, 32));
}

function mac(key: Uint8Array, lobbyId: string, timestamp: string): Buffer {
  return createHmac("sha256", key).update(`${lobbyId}.${timestamp}`).digest();
}

/** The header value the entry sends with a relay of lobbyId's live stream. */
export function signRelay(key: Uint8Array, lobbyId: string, now = Date.now()): string {
  const timestamp = String(Math.floor(now));
  return `${timestamp}.${mac(key, lobbyId, timestamp).toString("base64url")}`;
}

/** True only for a signature under key, for this lobby, made within RELAY_SIGNATURE_MAX_AGE_MS of now. */
export function verifyRelay(key: Uint8Array | undefined, lobbyId: string, header: string | string[] | undefined, now = Date.now()): boolean {
  if (key === undefined || typeof header !== "string") return false;
  const parsed = SIGNATURE.exec(header);
  if (parsed === null) return false;
  if (!(Math.abs(now - Number(parsed[1])) < RELAY_SIGNATURE_MAX_AGE_MS)) return false;
  const given = Buffer.from(parsed[2]!, "base64url");
  const expected = mac(key, lobbyId, parsed[1]!);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
