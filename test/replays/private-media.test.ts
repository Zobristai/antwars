import { describe, expect, it } from "vitest";
import { isReplayId } from "../../src/replays/access.js";
import { openPrivateMedia, privateMediaKey, privateMediaName, sealPrivateMedia, type PrivateMediaIdentity } from "../../src/replays/private-media.js";

const identity: PrivateMediaIdentity = { lobbyId: "private-lobby", replayId: "2026-10-20T08-00-00-000Z-1", kind: "recording" };
const key = Buffer.alloc(32, 42);

describe("private recording and match-record isolation", () => {
  it.each(["recording", "match-record"] as const)("authenticates and restores a %s", kind => {
    const ref = { ...identity, kind };
    const plain = Buffer.from("private match content with names and nest coordinates");
    const encrypted = sealPrivateMedia(ref, plain, key);
    expect(encrypted.includes(plain)).toBe(false);
    expect(openPrivateMedia(ref, encrypted, key)).toEqual(plain);
  });

  it("uses a fresh nonce even for identical objects", () => {
    const plain = Buffer.from("identical");
    const first = sealPrivateMedia(identity, plain, key);
    const second = sealPrivateMedia(identity, plain, key);
    expect(first.equals(second)).toBe(false);
    expect(openPrivateMedia(identity, second, key)).toEqual(plain);
  });

  it("rejects substitution across lobby, replay, or record kind", () => {
    const encrypted = sealPrivateMedia(identity, Buffer.from("secret"), key);
    for (const other of [
      { ...identity, lobbyId: "another-lobby" },
      { ...identity, replayId: "another-replay" },
      { ...identity, kind: "match-record" as const },
    ]) expect(() => openPrivateMedia(other, encrypted, key)).toThrow("Invalid private media");
  });

  it("rejects tampering, truncation and wrong keys without returning partial plaintext", () => {
    const encrypted = sealPrivateMedia(identity, Buffer.from("secret"), key);
    for (const offset of [0, 18, 32, encrypted.length - 1]) {
      const damaged = Buffer.from(encrypted);
      damaged[offset] = damaged[offset]! ^ 1;
      expect(() => openPrivateMedia(identity, damaged, key)).toThrow("Invalid private media");
    }
    expect(() => openPrivateMedia(identity, encrypted.subarray(0, 10), key)).toThrow("Invalid private media");
    expect(() => openPrivateMedia(identity, encrypted, Buffer.alloc(32, 43))).toThrow("Invalid private media");
  });

  it("does not expose a name accepted by legacy binary or JSON lookup/listing", () => {
    expect(isReplayId(identity.replayId)).toBe(true);
    const name = privateMediaName(identity);
    expect(name).toMatch(/^private\/v1\/[0-9a-f]{64}\.sealed$/);
    expect(isReplayId(name)).toBe(false);
    expect(name.endsWith(".json") || name.endsWith(".bin")).toBe(false);
    expect(name).not.toContain(identity.lobbyId);
    expect(privateMediaName({ ...identity, kind: "match-record" })).not.toBe(name);
  });

  it("cannot fall back to plaintext when encryption is unconfigured", () => {
    expect(privateMediaKey(undefined)).toBeUndefined();
    expect(privateMediaKey("")).toBeUndefined();
    expect(() => sealPrivateMedia(identity, Buffer.from("secret"), undefined)).toThrow("not configured");
    expect(() => sealPrivateMedia(identity, Buffer.from("secret"), Buffer.alloc(31))).toThrow("not configured");
    expect(() => privateMediaKey("not-a-key")).toThrow("32 bytes");
    expect(privateMediaKey("ab".repeat(32))).toEqual(Buffer.alloc(32, 0xab));
  });

  it("authenticates empty media too", () => {
    expect(openPrivateMedia(identity, sealPrivateMedia(identity, Buffer.alloc(0), key), key)).toEqual(Buffer.alloc(0));
  });
});
