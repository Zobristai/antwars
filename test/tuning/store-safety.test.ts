// The tuning harness treats other writers to the shared store as untrusted: exact always plays the candidate and checks
// the stored references against the digest regen printed, store files are never read or written through a link, and
// store directories another user could change are refused.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directoryProblem, openStore, storeHas, storeList, storeRead, storeReadText, storeSharedDir, storeWrite } from "../../scripts/tuning/store.ts";
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

// Every store directory must be owned by the harness's user and not writable by group or others, so no other user can
// replace one with a link between the harness's check and its use. A same-user swap cannot be told apart from the
// harness's own work, so these tests prove the refusal of any directory another user could change.
describe("store directories", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "store-dirs-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const asDir = (uid: number, mode: number) => ({ uid, mode: 0o040000 | mode, isDirectory: () => true, isSymbolicLink: () => false });
  const me = process.getuid!();

  it("are refused when owned by another user, writable by group or others, or a link", () => {
    expect(directoryProblem(asDir(me, 0o755), me)).toBeNull();
    expect(directoryProblem(asDir(me + 1, 0o755), me)).toContain("not owned");
    expect(directoryProblem(asDir(me, 0o775), me)).toContain("writable by group or others");
    expect(directoryProblem(asDir(me, 0o757), me)).toContain("writable by group or others");
    expect(directoryProblem({ ...asDir(me, 0o755), isSymbolicLink: () => true }, me)).toContain("not a plain directory");
    // The sticky shared mode is accepted only where a shared directory is expected, and only exactly.
    expect(directoryProblem(asDir(me, 0o1777), me, true)).toBeNull();
    expect(directoryProblem(asDir(me, 0o1777), me)).toContain("writable by group or others");
    expect(directoryProblem(asDir(me, 0o777), me, true)).toContain("writable by group or others");
    expect(directoryProblem(asDir(me + 1, 0o1777), me, true)).toContain("not owned");
  });

  it.skipIf(me === 0)("refuse a store root owned by another user before writing anything", () => {
    expect(() => openStore("/usr")).toThrow("not owned by the user running the harness");
  });

  it("refuse a group-writable directory before reading or writing through it", () => {
    mkdirSync(join(root, "runs"));
    writeFileSync(join(root, "runs", "report.json"), "{}");
    chmodSync(join(root, "runs"), 0o775);
    expect(() => storeRead(root, join(root, "runs", "report.json"))).toThrow("writable by group or others");
    expect(() => storeHas(root, join(root, "runs", "report.json"))).toThrow("writable by group or others");
    expect(() => storeWrite(root, join(root, "runs", "other.json"), "{}")).toThrow("writable by group or others");
    expect(readdirSync(join(root, "runs"))).toEqual(["report.json"]);
    chmodSync(root, 0o777);
    expect(() => openStore(root)).toThrow("writable by group or others");
  });

  it("are created by the harness with a mode only it can write, and the shared one sticky", () => {
    storeWrite(root, join(root, "a", "b", "c.json"), "{}");
    for (const dir of ["a", join("a", "b")]) expect(statSync(join(root, dir)).mode & 0o7777).toBe(0o755);
    storeSharedDir(root, join(root, "noise", "s"));
    expect(statSync(join(root, "noise")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(root, "noise", "s")).mode & 0o7777).toBe(0o1777);
    // Outside the noise check, a sticky world-writable directory is refused like any other writable one.
    expect(() => storeWrite(root, join(root, "noise", "s", "x.json"), "{}")).toThrow("writable by group or others");
    storeWrite(root, join(root, "noise", "s", "x.json"), "{}", { shared: true });
    expect(storeReadText(root, join(root, "noise", "s", "x.json"), { shared: true })).toBe("{}");
  });

  it("let the harness refuse a group-writable directory in a real store before playing anything", () => {
    const { referenceSha256 } = regen(store);
    chmodSync(join(store.dir, "references"), 0o775);
    const run = exact(store, referenceSha256);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("writable by group or others");
    expect(existsSync(store.marker)).toBe(false);
  }, 120_000);

  it("refuse a link planted in the shared noise directory", () => {
    const dir = storeSharedDir(root, join(root, "noise", "s"));
    writeFileSync(join(root, "elsewhere.json"), "{}");
    symlinkSync(join(root, "elsewhere.json"), join(dir, "result-a.json"));
    expect(() => storeRead(root, join(dir, "result-a.json"), { shared: true })).toThrow();
    expect(storeList(root, dir, { shared: true })).toEqual([]);
  });
});
