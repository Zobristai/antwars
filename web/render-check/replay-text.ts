/**
 * A recording as readable text: one decoded message per line (JSON Lines), as src/live/format.ts decodes it.
 * Typed arrays are written as { "<array type>": [numbers] } so the text turns back into the same messages, and the
 * repository's own encoder packs them into the bytes /replays/<id> serves. Excerpts are committed in this form so
 * they can be read and reviewed; serve.ts rebuilds the bytes at run time and checks them against the recorded hash.
 */
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";

const ARRAYS = { Uint8Array, Uint16Array, Uint32Array, Int16Array, Buffer } as const;
type ArrayName = keyof typeof ARRAYS;
const isArrayName = (name: string): name is ArrayName => Object.hasOwn(ARRAYS, name);

/** JSON.stringify replacer: reads the original value, since a Buffer has already been turned into { type, data }. */
function writeArrays(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this[key];
  if (!ArrayBuffer.isView(original)) return value;
  const name = original.constructor.name;
  if (!isArrayName(name)) throw new Error(`replay text cannot hold a ${name}`);
  return { [name]: Array.from(original as Uint8Array) };
}

function readArrays(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !isArrayName(keys[0]!)) return value;
  const values = (value as Record<string, unknown>)[keys[0]!];
  if (!Array.isArray(values)) return value;
  const name = keys[0]!;
  return name === "Buffer" ? Buffer.from(values as number[]) : ARRAYS[name].from(values as number[]);
}

export function replayToText(recording: Uint8Array): string {
  return unpackMessages(recording).map(m => JSON.stringify(decodeMessage(m), writeArrays)).join("\n") + "\n";
}

export function replayFromText(text: string): Uint8Array {
  const lines = text.split("\n").filter(line => line.length > 0);
  return packMessages(lines.map(line => encodeMessage(JSON.parse(line, readArrays))));
}
