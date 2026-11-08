// Exact comparison of one simulation tick — full state, events and results — as
// JSON with object keys sorted, reporting the first difference. Every save-reload check and the keep rule
// compare ticks through compareTicks; sortedJson is the same comparison's text. Key order must not count: a JSON round trip, or code that resets
// a field by assigning undefined and sets it again later, re-adds keys in a different order.
import type { StepOutput } from "../../src/sim/types.js";

/** Where two ticks first differ. `path` is a JSON Pointer (RFC 6901) into `part`; "" is the whole part. */
export interface TickMismatch {
  readonly tick: number;
  readonly part: "state" | "events" | "results";
  readonly path: string;
}

/**
 * JSON.stringify of `value` with every object's keys sorted, at every depth; arrays keep their order.
 * Everything else is JSON.stringify's: toJSON is honoured, undefined, functions and symbols are dropped
 * from objects and written as null in arrays, non-finite numbers are null. Integer-like keys keep
 * JavaScript's own order (ascending, ahead of the other keys), which is just as fixed.
 */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, sortKeys);
}

function sortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  // JSON.stringify unwraps these after the replacer; copying them would turn them into {}.
  if (value instanceof Number || value instanceof String || value instanceof Boolean) return value;
  const object = value as Record<string, unknown>;
  // No prototype, so an own "__proto__" key is copied as a key rather than setting the prototype.
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(object).sort()) sorted[key] = object[key];
  return sorted;
}

const PARTS = ["state", "events", "results"] as const;

/**
 * Compares one tick's outputs part by part — state, then events, then results — with keys sorted: a part
 * is equal exactly when its sortedJson texts are equal. Returns null when all three are equal, otherwise
 * the first difference: the tick it was computed for (the output state's tick - 1), the part, and the first
 * differing path in sorted key order.
 */
export function compareTicks(expected: StepOutput, actual: StepOutput): TickMismatch | null {
  for (const part of PARTS) {
    // Equal JSON text settles most ticks with the native serializer alone. Otherwise the two JSON values
    // are walked with each object's keys sorted, which is the sortedJson comparison without building its
    // text: on a 1,536-ant Wide Plain state, 40 ms against 53 ms for two sortedJson texts, per tick.
    const want = JSON.stringify(expected[part]);
    const got = JSON.stringify(actual[part]);
    if (want === got) continue;
    const path = firstDifference(JSON.parse(want), JSON.parse(got), "");
    if (path !== null) return { tick: expected.state.tick - 1, part, path };
  }
  return null;
}

/** First path where two parsed JSON values differ: object keys in sorted order, array items by index. */
function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (a === b) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    for (let i = 0; i < Math.max(a.length, other.length); i += 1) {
      const at = `${path}/${i}`;
      if (i >= a.length || i >= other.length) return at;
      const found = firstDifference(a[i], other[i], at);
      if (found !== null) return found;
    }
    return null;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const at = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return at;
    const found = firstDifference(left[key], right[key], at);
    if (found !== null) return found;
  }
  return null;
}
