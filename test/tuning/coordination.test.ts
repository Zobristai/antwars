// Tuning-harness coordination: local participant arguments, regen's saved states, whole-file publication in the
// noise check, and the load each participant holds until all have finished.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { participantArgs, participate, publishOnce, type Participation } from "../../scripts/tuning/noise.ts";
import { HARNESS_OPTIONS } from "../../scripts/tuning/options.ts";
import { pendingWork } from "../../scripts/tuning/plan.ts";
import { functionTimes, type CpuProfile } from "../../scripts/tuning/profile.ts";

// Record every file the noise coordination writes directly.
const written: string[] = [];
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeFileSync: (file: any, ...rest: any[]) => { written.push(String(file)); return (fs.writeFileSync as any)(file, ...rest); } };
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

describe("regen after exact", () => {
  it("still writes the missing saved states when the exactness reference exists", () => {
    expect(pendingWork(true, [0, 4500, 9000, 13500], () => false)).toEqual({ reference: false, states: [4500, 9000, 13500] });
    expect(pendingWork(true, [0, 4500, 9000], tick => tick === 4500)).toEqual({ reference: false, states: [9000] });
    expect(pendingWork(false, [], () => false)).toEqual({ reference: true, states: [] });
    expect(pendingWork(true, [0, 4500], () => true)).toEqual({ reference: false, states: [] });
  });
});

describe("noise coordination", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "noise-test-")); written.length = 0; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const events: [string, number][] = [];
  const at = (name: string) => events.find(([n]) => n === name)?.[1] ?? Number.NaN;
  function participant(me: string, prepareMs: number, measureMs: number): Participation {
    const mark = (what: string) => events.push([`${me}:${what}`, performance.now()]);
    return { dir, me, expect: 2, waitMs: 10_000, finishMs: 10_000, pollMs: 5,
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
    for (const file of written) expect(relative(dir, file).split("/")[0]).toBe("tmp");
    expect(readdirSync(join(dir, "results")).sort()).toEqual(["a.json", "b.json"]);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("lets only the first writer publish a first-writer-wins file", () => {
    expect(publishOnce(dir, join(dir, "admitted.json"), '{"admitted":["a"]}')).toBe(true);
    expect(publishOnce(dir, join(dir, "admitted.json"), '{"admitted":["a","b"]}')).toBe(false);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
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
