// The tuning harness treats other writers to the shared store as untrusted: exact always plays the candidate and checks
// the stored references against the digest regen printed, and store files are never read or written through a link.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeHas, storeRead, storeWrite } from "../../scripts/tuning/store.ts";
import { exact, harness, HEAD, makeStore, markerPatch, regen, SHORT, sha256, type Store } from "./fixtures.ts";

let store: Store;
beforeEach(() => { store = makeStore(); });
afterEach(() => store.remove());

const referencePath = (key: string) => join(store.dir, "references", key, "ticks-8", "advance", "open-field-0.json");

describe("exact", () => {
  it("plays the candidate even when a matching result for it is planted in the store", () => {
    const { referenceSha256 } = regen(store);
    const patch = join(store.outside, "candidate.diff"), text = markerPatch(), digest = sha256(text);
    writeFileSync(patch, text);
    // A copy of the reference wherever a cached candidate result could be looked for.
    for (const key of [`${HEAD}-${digest.slice(0, 16)}`, `${HEAD}-cand`]) {
      mkdirSync(join(referencePath(key), ".."), { recursive: true });
      writeFileSync(referencePath(key), readFileSync(referencePath(HEAD)));
    }
    const run = exact(store, referenceSha256, ["--patch", patch, "--patch-sha256", digest]);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(store.marker)).toBe(true);
    expect(run.json().reference).toEqual({ commit: HEAD, referenceSha256 });
  }, 120_000);

  it("refuses stored references that do not match the digest regen printed, before playing anything", () => {
    const { referenceSha256 } = regen(store);
    const patch = join(store.outside, "candidate.diff"), text = markerPatch();
    writeFileSync(patch, text);
    writeFileSync(referencePath(HEAD), `${readFileSync(referencePath(HEAD), "utf8")} `);
    const run = exact(store, referenceSha256, ["--patch", patch, "--patch-sha256", sha256(text)]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("refusing to compare");
    expect(existsSync(store.marker)).toBe(false);
    expect(harness(store, ["exact", "--reference", HEAD, "--candidate", HEAD, "--ticks", "8"]).status).not.toBe(0);
  }, 120_000);
});

describe("regen", () => {
  it("writes the saved states after an exact run", () => {
    const first = regen(store);
    expect(exact(store, first.referenceSha256).status).toBe(0);
    const second = regen(store, 4);
    expect(second.checkpoints).toEqual({ "open-field-0": [0, 2, 4, 6] });
    for (const tick of [2, 4, 6]) expect(existsSync(join(store.dir, "checkpoints", HEAD, "open-field-0", `${tick}.json`))).toBe(true);
    expect(exact(store, second.referenceSha256).status).toBe(0);
    // A short timing run starts from those saved states.
    expect(harness(store, ["time", "--reference", HEAD, "--candidate", HEAD, "--rounds", "1", "--window", "2", "--scenarios", "open-field-0"]).status).toBe(0);
  }, 180_000);

  it("replaces a link planted at the workload file instead of writing through it", () => {
    const victim = join(store.outside, "victim.txt");
    writeFileSync(victim, "unchanged");
    mkdirSync(join(store.dir, "workloads"), { recursive: true });
    symlinkSync(victim, join(store.dir, "workloads", `${HEAD}.json`));
    regen(store);
    expect(readFileSync(victim, "utf8")).toBe("unchanged");
    expect(lstatSync(join(store.dir, "workloads", `${HEAD}.json`)).isFile()).toBe(true);
  }, 120_000);

  it("refuses a linked store directory", () => {
    const elsewhere = join(store.outside, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(store.dir, { recursive: true });
    symlinkSync(elsewhere, join(store.dir, "references"));
    const run = harness(store, ["regen", "--commit", HEAD, ...SHORT, "--checkpoints", "0"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("not a plain directory");
    expect(existsSync(join(elsewhere, HEAD))).toBe(false);
  }, 120_000);

  it("is read by exact only through plain files", () => {
    const { referenceSha256 } = regen(store);
    const workload = join(store.dir, "workloads", `${HEAD}.json`), copy = join(store.outside, "workload.json");
    cpSync(workload, copy);
    rmSync(workload);
    symlinkSync(copy, workload);
    const run = exact(store, referenceSha256);
    expect(run.status).not.toBe(0);
    expect(existsSync(store.marker)).toBe(false);
  }, 120_000);
});

describe("store files", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "store-files-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("are written whole by rename, replacing a link rather than following it", () => {
    const victim = join(root, "..", `victim-${process.pid}.txt`);
    writeFileSync(victim, "unchanged");
    try {
      mkdirSync(join(root, "runs"));
      symlinkSync(victim, join(root, "runs", "report.json"));
      storeWrite(root, join(root, "runs", "report.json"), "{}");
      expect(readFileSync(victim, "utf8")).toBe("unchanged");
      expect(storeRead(root, join(root, "runs", "report.json")).toString()).toBe("{}");
    } finally { rmSync(victim, { force: true }); }
  });

  it("refuse links when read or checked", () => {
    writeFileSync(join(root, "real.json"), "{}");
    symlinkSync(join(root, "real.json"), join(root, "link.json"));
    expect(() => storeRead(root, join(root, "link.json"))).toThrow();
    expect(() => storeHas(root, join(root, "link.json"))).toThrow();
    expect(storeHas(root, join(root, "real.json"))).toBe(true);
    expect(storeHas(root, join(root, "missing.json"))).toBe(false);
  });
});
