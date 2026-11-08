// The tuning loop's sorted-key tick comparison finds every difference in a tick's
// state, events and results, and accepts identical ticks whatever their key order.
import { describe, expect, it } from "vitest";
import { playScripted } from "../../src/live/record.js";
import { rulesConfig } from "../../src/sim/config.js";
import type { StepOutput } from "../../src/sim/types.js";
import { playable } from "../playable.js";
import { compareTicks, sortedJson, type TickMismatch } from "./equality.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Part = TickMismatch["part"];
const PARTS: readonly Part[] = ["state", "events", "results"];

// Real redesign ticks with seats: tick 0 (joins: six events, two results) and a later tick with an
// accepted order, after the ants have moved and fought.
const ticks: StepOutput[] = [];
playScripted({ seed: 692, config: playable(rulesConfig("redesign")), agents: 2, ticks: 180, attack: true }, (out) => {
  if (out.events.length > 0 && out.results.length > 0) ticks.push(out);
});
const CASES: readonly [string, StepOutput][] = [[`tick ${ticks[0]!.state.tick - 1}`, ticks[0]!], [`tick ${ticks.at(-1)!.state.tick - 1}`, ticks.at(-1)!]];

const json = (out: StepOutput): Record<Part, Json> => JSON.parse(JSON.stringify(out)) as Record<Part, Json>;
const asTick = (value: Record<Part, Json>): StepOutput => value as unknown as StepOutput;
const pointer = (path: string, key: string | number) => `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

/** Every object key, and the first, middle and last item of each array (each tile array alone has thousands). */
function leaves(value: Json, path: string, found: string[]): void {
  if (value === null || typeof value !== "object" || Object.keys(value).length === 0) {
    found.push(path);
  } else if (Array.isArray(value)) {
    const items = value.length <= 3 ? [...value.keys()] : [0, value.length >> 1, value.length - 1];
    for (const i of items) leaves(value[i]!, pointer(path, i), found);
  } else {
    for (const [key, item] of Object.entries(value)) leaves(item, pointer(path, key), found);
  }
}

function at(root: Json, path: string): { holder: Record<string, Json> | Json[]; key: string } {
  const keys = path.split("/").slice(1).map(k => k.replaceAll("~1", "/").replaceAll("~0", "~"));
  let holder = root as Record<string, Json>;
  for (const key of keys.slice(0, -1)) holder = holder[key] as Record<string, Json>;
  return { holder, key: keys.at(-1)! };
}

/** Changes the value at path in place: returns the path the change is first seen at, and its undo. */
function change(root: Json, path: string): { seenAt: string; undo: () => void } {
  const { holder, key } = at(root, path);
  const parent = holder as Record<string, Json>;
  const value = parent[key]!;
  if (Array.isArray(value)) { value.push(0); return { seenAt: pointer(path, 0), undo: () => value.pop() }; }
  if (value !== null && typeof value === "object") { value.added = 0; return { seenAt: pointer(path, "added"), undo: () => delete value.added }; }
  parent[key] = typeof value === "number" ? value + 1 : typeof value === "string" ? `${value}!` : typeof value === "boolean" ? !value : 0;
  return { seenAt: path, undo: () => { parent[key] = value; } };
}

function reverseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
}

describe("sortedJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(sortedJson({ b: 1, a: { d: [{ z: 1, y: [3, 1, 2] }], c: 2 } })).toBe('{"a":{"c":2,"d":[{"y":[3,1,2],"z":1}]},"b":1}');
    expect(sortedJson({ a: { c: 2, d: [{ y: [3, 1, 2], z: 1 }] }, b: 1 })).toBe(sortedJson({ b: 1, a: { d: [{ z: 1, y: [3, 1, 2] }], c: 2 } }));
    expect(sortedJson([2, 1])).not.toBe(sortedJson([1, 2]));
  });

  it("keeps an own __proto__ key, as JSON.stringify does, and compareTicks agrees", () => {
    const value = JSON.parse('{"b":1,"__proto__":{"y":1,"x":2}}') as unknown;
    expect(sortedJson(value)).toBe('{"__proto__":{"x":2,"y":1},"b":1}');
    const tick = (state: unknown) => ({ state, events: [], results: [] }) as unknown as StepOutput;
    expect(compareTicks(tick(JSON.parse('{"tick":1,"__proto__":0}')), tick({ tick: 1 }))).toEqual({ tick: 0, part: "state", path: "/__proto__" });
  });

  it("is JSON.stringify for anything already in key order", () => {
    const value = { a: undefined, b: [undefined, () => 1, Symbol("s"), Number.NaN, -Infinity, -0], c: new Date(0), d: { toJSON: () => ({ y: 1, x: 2 }) },
      e: [new Number(5), new String("s"), new Boolean(false)], f: () => 1, g: Symbol("s"), h: null, [Symbol("key")]: 1 };
    expect(sortedJson(value)).toBe(JSON.stringify(value).replace('{"y":1,"x":2}', '{"x":2,"y":1}'));
    expect(sortedJson(value)).toBe('{"b":[null,null,null,null,null,0],"c":"1970-01-01T00:00:00.000Z","d":{"x":2,"y":1},"e":[5,"s",false],"h":null}');
  });

  it("gives a real tick the same text whatever its key order", () => {
    for (const [, out] of CASES) {
      const reordered = reverseKeys(out);
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(out));
      expect(sortedJson(reordered)).toBe(sortedJson(out));
    }
  });
});

describe.each(CASES)("compareTicks, %s", (_name, out) => {
  const tick = out.state.tick - 1;

  it("accepts the same tick, its JSON round trip and every key order", () => {
    expect(compareTicks(out, out)).toBeNull();
    expect(compareTicks(out, asTick(json(out)))).toBeNull();
    expect(compareTicks(out, reverseKeys(out) as StepOutput)).toBeNull();
    expect(compareTicks(reverseKeys(out) as StepOutput, asTick(json(out)))).toBeNull();
  });

  it("treats a key set to undefined as absent, as JSON does", () => {
    const copy = json(out);
    ((copy.state as Record<string, Json[]>).ants![0] as Record<string, unknown>).added = undefined;
    expect(compareTicks(out, asTick(copy))).toBeNull();
  });

  it("reports a change to any value of the state, events or results at its tick, part and path", () => {
    const copy = json(out);
    let checked = 0;
    for (const part of PARTS) {
      const paths: string[] = [];
      leaves(copy[part], "", paths);
      for (const path of paths) {
        const { seenAt, undo } = change(copy[part], path);
        expect(compareTicks(out, asTick(copy))).toEqual({ tick, part, path: seenAt });
        undo();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(compareTicks(out, asTick(copy))).toBeNull();
  }, 120_000);

  it("finds a part equal exactly when its sortedJson texts are equal", () => {
    const same = [out, json(out), reverseKeys(out)] as StepOutput[];
    for (const a of same) for (const b of same) {
      expect(compareTicks(a, b)).toBeNull();
      for (const part of PARTS) expect(sortedJson(b[part])).toBe(sortedJson(a[part]));
    }
    const copy = json(out);
    for (const part of PARTS) {
      const paths: string[] = [];
      leaves(copy[part], "", paths);
      for (const path of paths.filter((_, i) => i % 10 === 0)) {
        const { undo } = change(copy[part], path);
        expect(compareTicks(out, asTick(copy))).not.toBeNull();
        expect(sortedJson(copy[part])).not.toBe(sortedJson(out[part]));
        undo();
      }
    }
  });

  it("reports a key one side lacks", () => {
    const missing = json(out);
    delete ((missing.state as Record<string, Json[]>).ants![0] as Record<string, Json>).x;
    expect(compareTicks(out, asTick(missing))).toEqual({ tick, part: "state", path: "/ants/0/x" });
    const extra = json(out);
    ((extra.results as Json[])[0] as Record<string, Json>).extra = 0;
    expect(compareTicks(out, asTick(extra))).toEqual({ tick, part: "results", path: "/0/extra" });
  });

  it("counts array order and length", () => {
    const swapped = json(out);
    const ants = (swapped.state as Record<string, Json[]>).ants!;
    [ants[0], ants[1]] = [ants[1]!, ants[0]!];
    expect(compareTicks(out, asTick(swapped))).toEqual({ tick, part: "state", path: expect.stringMatching(/^\/ants\/0\/[a-zA-Z]+$/) });
    const shorter = json(out);
    const events = shorter.events as Json[];
    events.pop();
    expect(compareTicks(out, asTick(shorter))).toEqual({ tick, part: "events", path: `/${events.length}` });
    expect(compareTicks(asTick(shorter), out)).toEqual({ tick, part: "events", path: `/${events.length}` });
  });

  it("reports the first difference: state before events before results, then sorted key order", () => {
    const changed = json(out);
    for (const [part, path] of [["results", "/0/ok"], ["events", "/0/tick"]] as const) change(changed[part], path);
    expect(compareTicks(out, asTick(changed))).toEqual({ tick, part: "events", path: "/0/tick" });
    for (const path of ["/tick", "/rngState"]) change(changed.state, path);
    expect(compareTicks(out, asTick(changed))).toEqual({ tick, part: "state", path: "/rngState" });
  });
});
