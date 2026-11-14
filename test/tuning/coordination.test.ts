// Tuning-harness coordination: local participant arguments, whole-file publication in the noise check, and the load
// each participant holds until all have finished. (regen after exact is covered in store-safety.test.ts.)
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { participantArgs, participate, type Participation } from "../../scripts/tuning/noise.ts";
import { HARNESS_OPTIONS } from "../../scripts/tuning/options.ts";
import { functionTimes, type CpuProfile } from "../../scripts/tuning/profile.ts";
import { storeWriteOnce } from "../../scripts/tuning/store.ts";

// Record every file the noise coordination creates for writing.
const written: string[] = [];
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: (file: any, flags: any, ...rest: any[]) => {
    if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) written.push(String(file));
    return (fs.openSync as any)(file, flags, ...rest);
  } };
});

const parse = (args: string[]) => parseArgs({ args, options: HARNESS_OPTIONS, allowPositionals: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("local noise participants", () => {
  for (const form of [["--local=3"], ["--local", "3"]]) {
    it(`are started as participants, not coordinators, with ${form.join(" ")}`, () => {
      const { values } = parse(["noise", "--base=410ad39", ...form, "--rounds", "2", "--whole", "--session=old", "--store=/elsewhere"]);
      const child = parse(participantArgs(values, "noise", { session: "s", participant: "local-2", expect: 3, store: "/store" }));
      expect(child.positionals).toEqual(["noise"]);
      expect(child.values).toEqual({ base: "410ad39", rounds: "2", whole: true, session: "s", participant: "local-2", expect: "3", store: "/store" });
      expect(child.values.local).toBeUndefined();
    });
  }
});

describe("noise coordination", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "noise-test-")); written.length = 0; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const events: [string, number][] = [];
  const at = (name: string) => events.find(([n]) => n === name)?.[1] ?? Number.NaN;
  function participant(me: string, prepareMs: number, measureMs: number): Participation {
    const mark = (what: string) => events.push([`${me}:${what}`, performance.now()]);
    return { root: dir, dir: join(dir, "session"), me, expect: 2, waitMs: 10_000, finishMs: 10_000, pollMs: 5,
      prepare: async () => { await sleep(prepareMs); mark("ready"); },
      measure: async () => { mark("measure"); await sleep(measureMs); mark("measured"); return { participant: me, medians: [0] }; },
      // A load that runs until it is aborted.
      load: signal => new Promise(done => { mark("load"); signal.addEventListener("abort", () => { mark("stopped"); done(); }); }) };
  }

  it("starts measuring once every participant is ready, and holds the load until every participant has finished", async () => {
    events.length = 0;
    const [fast, slow] = await Promise.all([participate(participant("fast", 0, 20)), participate(participant("slow", 150, 200))]);
    expect(fast).toMatchObject({ admitted: ["fast", "slow"], results: [{ participant: "fast" }, { participant: "slow" }] });
    expect(slow).toMatchObject({ admitted: ["fast", "slow"] });
    expect(at("fast:measure")).toBeGreaterThanOrEqual(at("slow:ready"));
    expect(at("fast:load")).toBeGreaterThanOrEqual(at("fast:measured"));
    expect(at("fast:stopped")).toBeGreaterThanOrEqual(at("slow:measured"));
    expect("heldLoadMs" in fast && fast.heldLoadMs).toBeGreaterThan(100);
  });

  it("writes every file under a temporary name first, so no participant reads a partial file", async () => {
    await Promise.all([participate(participant("a", 0, 10)), participate(participant("b", 0, 10))]);
    expect(written.length).toBeGreaterThan(0);
    for (const file of written) expect(basename(file)).toMatch(/^\.tmp-/);
    expect(readdirSync(join(dir, "session")).sort()).toEqual(["admitted.json", "arrival-a.json", "arrival-b.json", "ready-a.json", "ready-b.json", "result-a.json", "result-b.json"]);
  });

  it("lets only the first writer publish a first-writer-wins file", () => {
    expect(storeWriteOnce(dir, join(dir, "admitted.json"), '{"admitted":["a"]}')).toBe(true);
    expect(storeWriteOnce(dir, join(dir, "admitted.json"), '{"admitted":["a","b"]}')).toBe(false);
    expect(readdirSync(dir)).toEqual(["admitted.json"]);
  });
});

describe("profile aggregation", () => {
  it("keeps functions of the same name on one line apart by column", () => {
    const frame = (column: number) => ({ functionName: "", url: "file:///tree/src/sim/x.ts", lineNumber: 4, columnNumber: column });
    const profile: CpuProfile = {
      nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 3] }, { id: 2, callFrame: frame(10) }, { id: 3, callFrame: frame(40) }],
      samples: [2, 3, 3], timeDeltas: [1000, 1000, 1000],
    };
    const by = Object.fromEntries(functionTimes(profile, "/tree/").functions.map(f => [f.function, f.selfMs]));
    expect(by).toMatchObject({ "(anonymous) src/sim/x.ts:5:11": 1, "(anonymous) src/sim/x.ts:5:41": 2 });
  });
});
