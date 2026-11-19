/**
 * A recording as readable text: JSON Lines, every line a pair [path, value] and none longer than MAX_LINE_BYTES, so an
 * excerpt can be read whole, line by line. Each message of the recording, as src/live/format.ts decodes it, starts at
 * its ["tick", n] line; the lines after it set the message's fields by path ("full.setup", "ants.x"). A value too long
 * for one line is written over several lines with the same path, read one after another: an array's elements, or an
 * object's fields under their own paths.
 *
 * Arrays of numbers are written as { "<array type>": [values] } (Uint8Array, Uint16Array, Uint32Array, Int16Array,
 * Buffer), and the ants' flyers as { "Array": [values] }. In these, an item [v, n] stands for n copies of v. Two marks
 * say how the values are counted:
 * - "steps": true: each value is the step from the one before it (the first from 0). The ant ids are written so.
 * - "since": t: each value is the change in the same ant's value (the ant with the same id) since the message at tick
 *   t, the message before it; an ant that was not in that message counts from 0. An ant's other fields are written so
 *   after a recording's first message.
 * The text turns back into the same messages, which the repository's own encoder packs into the bytes /replays/<id>
 * serves; serve.ts checks those bytes against the excerpt's recorded sha256.
 */
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";

/** The longest line replayToText writes, in bytes. */
export const MAX_LINE_BYTES = 4000;

const ARRAYS = { Uint8Array, Uint16Array, Uint32Array, Int16Array, Buffer } as const;
type ArrayName = keyof typeof ARRAYS;
const isArrayName = (name: string): name is ArrayName => Object.hasOwn(ARRAYS, name);
type Numbers = ArrayLike<number> & ArrayBufferView;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** How a written array's values are counted (see the file's comment). */
interface Count { steps?: true; since?: number }

const bytes = (line: string) => Buffer.byteLength(line, "utf8");

function arrayName(a: ArrayBufferView): ArrayName {
  const name = Buffer.isBuffer(a) ? "Buffer" : a.constructor.name;
  if (!isArrayName(name)) throw new Error(`replay text cannot hold a ${name}`);
  return name;
}

/** Runs of three or more equal values written as [v, n]. Values are never arrays themselves. */
function runs(values: readonly Json[]): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < values.length;) {
    const v = JSON.stringify(values[i]);
    let j = i + 1;
    while (j < values.length && JSON.stringify(values[j]) === v) j++;
    if (j - i >= 3) out.push([values[i]!, j - i]);
    else for (let k = i; k < j; k++) out.push(values[k]!);
    i = j;
  }
  return out;
}

function expand(items: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    if (!Array.isArray(item)) { out.push(item); continue; }
    const [v, n] = item as [unknown, number];
    if (item.length !== 2 || !Number.isSafeInteger(n) || n < 1) throw new Error(`replay text: ${JSON.stringify(item)} is not a run [value, count]`);
    for (let k = 0; k < n; k++) out.push(v);
  }
  return out;
}

/** A decoded value as JSON: arrays of numbers as { "<array type>": runs }, undefined fields left out. */
function toJson(v: unknown): Json | undefined {
  if (v === undefined) return undefined;
  if (ArrayBuffer.isView(v)) return { [arrayName(v)]: runs(Array.from(v as Numbers)) };
  if (Array.isArray(v)) return v.map(e => toJson(e) ?? null);
  if (v !== null && typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, e] of Object.entries(v)) { const j = toJson(e); if (j !== undefined) o[k] = j; }
    return o;
  }
  return v as Json;
}

function makeArray(name: ArrayName | "Array", values: unknown[]): unknown {
  if (name === "Array") return values;
  return name === "Buffer" ? Buffer.from(values as number[]) : ARRAYS[name].from(values as number[]);
}

/** toJson's inverse, for a value written whole on one line. */
function revive(j: unknown): unknown {
  if (Array.isArray(j)) return j.map(revive);
  if (j === null || typeof j !== "object") return j;
  const keys = Object.keys(j);
  const only = keys[0];
  const values = only === undefined ? undefined : (j as Record<string, unknown>)[only];
  if (keys.length === 1 && isArrayName(only!) && Array.isArray(values)) return makeArray(only, expand(values));
  return Object.fromEntries(keys.map(k => [k, revive((j as Record<string, unknown>)[k])]));
}

/** Lines of one message. */
function messageLines(m: StreamMessage, previous: StreamMessage | null): string[] {
  const lines: string[] = [JSON.stringify(["tick", m.tick])];
  /** items over as many lines as they need, each [path, {[name]: some items, ...count}]. */
  const chunked = (path: string, name: string, items: readonly Json[], count: Count = {}) => {
    const line = (part: readonly Json[]) => JSON.stringify([path, { [name]: part, ...count }]);
    let start = 0;
    let length = bytes(line([]));
    for (let i = 0; i < items.length; i++) {
      const add = bytes(JSON.stringify(items[i])) + (i > start ? 1 : 0);
      if (length + add > MAX_LINE_BYTES && i > start) {
        lines.push(line(items.slice(start, i)));
        start = i;
        length = bytes(line([])) + add - 1;
      } else length += add;
    }
    lines.push(line(items.slice(start)));
  };
  /** A value at path: on one line if it fits, else an array's elements over several lines, an object's fields under their own paths. */
  const write = (path: string, value: unknown) => {
    const json = toJson(value);
    if (json === undefined) return;
    const whole = JSON.stringify([path, json]);
    if (bytes(whole) <= MAX_LINE_BYTES) { lines.push(whole); return; }
    if (ArrayBuffer.isView(value)) return chunked(path, arrayName(value), runs(Array.from(value as Numbers)));
    if (Array.isArray(json)) {
      let part: Json[] = [];
      for (const element of json) {
        if (bytes(JSON.stringify([path, [element]])) > MAX_LINE_BYTES) throw new Error(`replay text: an element of ${path} is longer than a line`);
        if (part.length > 0 && bytes(JSON.stringify([path, [...part, element]])) > MAX_LINE_BYTES) { lines.push(JSON.stringify([path, part])); part = []; }
        part.push(element);
      }
      lines.push(JSON.stringify([path, part]));
      return;
    }
    if (json !== null && typeof json === "object") {
      for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
        if (key.includes(".")) throw new Error(`replay text: field ${path}.${key} has a dot in its name`);
        write(`${path}.${key}`, field);
      }
      return;
    }
    throw new Error(`replay text: ${path} is longer than a line`);
  };
  const before = previous ? new Map(Array.from(previous.ants.id, (id, i) => [id, i])) : null;
  const previousAnts = previous?.ants as unknown as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(m)) {
    if (key === "tick") continue;
    if (key !== "ants") { write(key, value); continue; }
    for (const [field, values] of Object.entries(m.ants)) {
      if (values === undefined) continue;
      const path = `ants.${field}`;
      const was = previousAnts?.[field];
      if (field === "id") {
        const ids = m.ants.id;
        chunked(path, arrayName(ids), runs(Array.from(ids, (id, i) => id - (i > 0 ? ids[i - 1]! : 0))), { steps: true });
      } else if (ArrayBuffer.isView(values) && was && ArrayBuffer.isView(was) && arrayName(was) === arrayName(values)) {
        const now = values as Numbers, then = was as Numbers;
        const change = Array.from(m.ants.id, (id, i) => now[i]! - (before!.has(id) ? then[before!.get(id)!]! : 0));
        chunked(path, arrayName(values), runs(change), { since: previous!.tick });
      } else if (field === "flyers" && Array.isArray(values)) {
        chunked(path, "Array", runs(values.map(f => toJson(f) ?? null)));
      } else write(path, values);
    }
  }
  return lines;
}

export function replayToText(recording: Uint8Array): string {
  const lines: string[] = [];
  let previous: StreamMessage | null = null;
  for (const message of unpackMessages(recording)) {
    const m = decodeMessage(message);
    lines.push(...messageLines(m, previous));
    previous = m;
  }
  return lines.join("\n") + "\n";
}

/** An array written over one or more lines, before its values are counted. */
interface Pending { name: ArrayName | "Array"; items: unknown[]; count: Count }

function arrayLine(v: unknown): Pending | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const names = Object.keys(o).filter(k => k !== "steps" && k !== "since");
  const name = names[0];
  if (names.length !== 1 || !(isArrayName(name!) || name === "Array") || !Array.isArray(o[name!])) return null;
  if (o.steps !== undefined && o.steps !== true) throw new Error(`replay text: steps is ${JSON.stringify(o.steps)}, not true`);
  if (o.since !== undefined && !Number.isSafeInteger(o.since)) throw new Error(`replay text: since is ${JSON.stringify(o.since)}, not a tick`);
  return { name: name as ArrayName | "Array", items: o[name!] as unknown[], count: { ...(o.steps ? { steps: true } : {}), ...(o.since !== undefined ? { since: o.since as number } : {}) } };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let at = target;
  for (const key of keys.slice(0, -1)) {
    if (at[key] === undefined) at[key] = {};
    const next = at[key];
    if (next === null || typeof next !== "object" || Array.isArray(next) || ArrayBuffer.isView(next)) throw new Error(`replay text: ${path} lies inside a value that is not an object`);
    at = next as Record<string, unknown>;
  }
  at[keys.at(-1)!] = value;
}

function getPath(target: Record<string, unknown>, path: string): unknown {
  let at: unknown = target;
  for (const key of path.split(".")) at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
  return at;
}

export function replayFromText(text: string): Uint8Array {
  const messages: StreamMessage[] = [];
  let current: Record<string, unknown> | null = null;
  let pending = new Map<string, Pending>();
  const finish = () => {
    if (!current) return;
    const previous = messages.at(-1) ?? null;
    // The ids first: an ant's other fields are counted by its id.
    const paths = [...pending.keys()].sort((a, b) => Number(b === "ants.id") - Number(a === "ants.id"));
    for (const path of paths) {
      const { name, items, count } = pending.get(path)!;
      let values = expand(items);
      if (count.steps) {
        let sum = 0;
        values = values.map(step => (sum += step as number));
      }
      if (count.since !== undefined) {
        const was = previous && getPath(previous as unknown as Record<string, unknown>, path);
        if (!previous || previous.tick !== count.since || !path.startsWith("ants.") || !ArrayBuffer.isView(was)) {
          throw new Error(`replay text: ${path} at tick ${String(current.tick)} counts since tick ${count.since}, which is not the message before it with that field`);
        }
        const ids = getPath(current, "ants.id") as ArrayLike<number> | undefined;
        if (!ids || ids.length !== values.length) throw new Error(`replay text: ${path} at tick ${String(current.tick)} does not have one value per ant id`);
        const before = new Map(Array.from(previous.ants.id, (id, i) => [id, i]));
        values = values.map((change, i) => (change as number) + (before.has(ids[i]!) ? (was as Numbers)[before.get(ids[i]!)!]! : 0));
      }
      setPath(current, path, makeArray(name, values));
    }
    messages.push(current as unknown as StreamMessage);
    current = null;
    pending = new Map();
  };
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const pair = JSON.parse(line) as unknown;
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") throw new Error(`replay text: ${line.slice(0, 80)} is not a [path, value] pair`);
    const [path, value] = pair as [string, unknown];
    if (path === "tick") { finish(); current = { tick: value }; continue; }
    if (!current) throw new Error(`replay text: ${path} comes before any ["tick", n] line`);
    const array = arrayLine(value);
    if (array) {
      const open = pending.get(path);
      if (!open) { pending.set(path, array); continue; }
      if (open.name !== array.name || JSON.stringify(open.count) !== JSON.stringify(array.count)) throw new Error(`replay text: the lines of ${path} do not agree on its type or count`);
      open.items.push(...array.items);
      continue;
    }
    const revived = revive(value);
    const existing = getPath(current, path);
    if (Array.isArray(existing) && Array.isArray(revived)) existing.push(...revived);
    else if (existing !== undefined) throw new Error(`replay text: ${path} is set twice at tick ${String(current.tick)}`);
    else setPath(current, path, revived);
  }
  finish();
  return packMessages(messages.map(encodeMessage));
}
