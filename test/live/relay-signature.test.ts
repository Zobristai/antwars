import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { relayKey, RELAY_SIGNATURE_MAX_AGE_MS, signRelay, verifyRelay } from "../../src/live/relay-signature.ts";

// Test-only keys.
const REPLAY_KEY = Buffer.alloc(32, 7);
const OTHER_REPLAY_KEY = Buffer.alloc(32, 9);
const LOBBY = "00000000-0000-4000-8000-000000000001";
const OTHER_LOBBY = "00000000-0000-4000-8000-000000000002";
const NOW = 1_800_000_000_000;

describe("relay signature", () => {
  it("derives the relay key as the HKDF subkey antwar-relay-v1 of the replay key, distinct from it", () => {
    const key = relayKey(REPLAY_KEY)!;
    expect(key).toEqual(Buffer.from(hkdfSync("sha256", REPLAY_KEY, Buffer.alloc(0), "antwar-relay-v1", 32)));
    expect(key).toHaveLength(32);
    expect(key.equals(REPLAY_KEY)).toBe(false);
    expect(relayKey(undefined)).toBeUndefined();
  });

  it("verifies a signature made under the same key for the same lobby within the age bound", () => {
    const key = relayKey(REPLAY_KEY)!;
    const header = signRelay(key, LOBBY, NOW);
    expect(header).toMatch(/^1800000000000\.[A-Za-z0-9_-]{43}$/);
    expect(verifyRelay(key, LOBBY, header, NOW)).toBe(true);
    expect(verifyRelay(key, LOBBY, header, NOW + RELAY_SIGNATURE_MAX_AGE_MS - 1)).toBe(true);
  });

  it("rejects a stale, forged, malformed, other-lobby or other-key signature, and any signature when no key is configured", () => {
    const key = relayKey(REPLAY_KEY)!;
    const header = signRelay(key, LOBBY, NOW);
    expect(verifyRelay(key, LOBBY, header, NOW + RELAY_SIGNATURE_MAX_AGE_MS)).toBe(false);
    expect(verifyRelay(key, LOBBY, header, NOW - RELAY_SIGNATURE_MAX_AGE_MS)).toBe(false);
    expect(verifyRelay(key, OTHER_LOBBY, header, NOW)).toBe(false);
    // Signed under another replay key's subkey, as during a rolling swap of the replay key.
    expect(verifyRelay(key, LOBBY, signRelay(relayKey(OTHER_REPLAY_KEY)!, LOBBY, NOW), NOW)).toBe(false);
    // Signed directly with the replay key: the subkey keeps the two uses apart.
    const direct = createHmac("sha256", REPLAY_KEY).update(`${LOBBY}.${NOW}`).digest("base64url");
    expect(verifyRelay(key, LOBBY, `${NOW}.${direct}`, NOW)).toBe(false);
    // A later timestamp under the old MAC.
    expect(verifyRelay(key, LOBBY, header.replace(/^\d+/, String(NOW + 1)), NOW)).toBe(false);
    for (const bad of ["", "1", "x.y", `${NOW}.`, `${NOW}.${"A".repeat(43)}`, `${header}=`, ` ${header}`]) {
      expect(verifyRelay(key, LOBBY, bad, NOW)).toBe(false);
    }
    expect(verifyRelay(key, LOBBY, [header, header], NOW)).toBe(false);
    expect(verifyRelay(key, LOBBY, undefined, NOW)).toBe(false);
    expect(verifyRelay(undefined, LOBBY, header, NOW)).toBe(false);
  });
});
