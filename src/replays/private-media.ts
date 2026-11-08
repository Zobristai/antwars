import { createCipheriv, createDecipheriv, createHash, randomBytes, type DecipherGCM } from "node:crypto";

/** Private objects are ciphertext even if a bucket is accidentally public. */
const MAGIC = Buffer.from("antwar.private.v1\0", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const PRIVATE_MEDIA_HEADER_BYTES = MAGIC.length + NONCE_BYTES + TAG_BYTES;

export interface PrivateMediaIdentity {
  readonly lobbyId: string;
  readonly replayId: string;
  readonly kind: "recording" | "match-record";
}

function context(identity: PrivateMediaIdentity): Buffer {
  if (!identity.lobbyId || !identity.replayId || !["recording", "match-record"].includes(identity.kind)) {
    throw new Error("Invalid private media identity");
  }
  return Buffer.from(JSON.stringify(["antwar.private.v1", identity.lobbyId, identity.replayId, identity.kind]));
}

/**
 * No public timestamp-id .bin/.json alias. The legacy readers reject this name,
 * and the encrypted content itself protects against direct bucket access.
 */
export function privateMediaName(identity: PrivateMediaIdentity): string {
  return `private/v1/${createHash("sha256").update(context(identity)).digest("hex")}.sealed`;
}

/** The configured key is never inferred from an invite token (which can be revoked). */
export function privateMediaKey(value: string | undefined): Buffer | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("Private media key must be 32 bytes encoded as hexadecimal");
  return Buffer.from(value, "hex");
}

function requireKey(key: Uint8Array | undefined): Uint8Array {
  if (key?.byteLength !== 32) throw new Error("Private media encryption is not configured");
  return key;
}

/** Authenticate the complete identity as well as the bytes; objects cannot be swapped. */
export function sealPrivateMedia(identity: PrivateMediaIdentity, plaintext: Uint8Array, key: Uint8Array | undefined): Buffer {
  const secret = requireKey(key);
  const aad = context(identity);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

/** Internal streaming decoder: callers must spool privately until final() authenticates. */
export function privateMediaDecipher(identity: PrivateMediaIdentity, header: Uint8Array, key: Uint8Array | undefined): DecipherGCM {
  const secret = requireKey(key);
  const bytes = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  const nonceEnd = MAGIC.length + NONCE_BYTES;
  if (bytes.length !== PRIVATE_MEDIA_HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid private media");
  const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(MAGIC.length, nonceEnd));
  decipher.setAAD(context(identity));
  decipher.setAuthTag(bytes.subarray(nonceEnd));
  return decipher;
}

/** Return no plaintext unless its authentication tag and bound identity both verify. */
export function openPrivateMedia(identity: PrivateMediaIdentity, sealed: Uint8Array, key: Uint8Array | undefined): Buffer {
  const secret = requireKey(key);
  const aad = context(identity);
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const nonceEnd = MAGIC.length + NONCE_BYTES;
  const tagEnd = nonceEnd + TAG_BYTES;
  if (bytes.byteLength < tagEnd || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Invalid private media");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(MAGIC.length, nonceEnd));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(nonceEnd, tagEnd));
    return Buffer.concat([decipher.update(bytes.subarray(tagEnd)), decipher.final()]);
  } catch {
    // Do not expose provider messages, key material or unauthenticated plaintext.
    throw new Error("Invalid private media");
  }
}
