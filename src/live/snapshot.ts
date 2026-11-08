/**
 * Constants the live stream format (src/live/format.ts) shares with the spectator
 * client, and the recording container: a recorded match is its stream messages
 * concatenated, each prefixed with its byte length. Ant positions are sub-tile
 * scaled integers.
 */

export const SNAPSHOT_MAGIC = 0x5741;
/** Sub-tile units per tile: a position of 256 is the left edge of tile 1. */
export const SUB_TILE = 256;
/** Ticks per second of the match clock. */
export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;

export const OWNER_NONE = 0;

export type Colony = 0 | 1;

/** A recorded match: messages concatenated, each prefixed with its u32 byte length. */
export function packMessages(messages: Uint8Array[]): Uint8Array {
  const total = messages.reduce((s, m) => s + 4 + m.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const m of messages) {
    dv.setUint32(o, m.length, true);
    out.set(m, o + 4);
    o += 4 + m.length;
  }
  return out;
}

export function unpackMessages(bytes: Uint8Array): Uint8Array[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let o = 0;
  while (o < bytes.byteLength) {
    const len = dv.getUint32(o, true);
    out.push(bytes.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return out;
}
