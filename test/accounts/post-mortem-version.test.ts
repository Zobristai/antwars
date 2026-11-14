/// <reference types="node" />
// The post-mortem's game-version check against the repository's main history (src/accounts/postMortemVersion.ts).
// Packs are built here from readable commit text with a neutral fixture author; the expected commit ids are
// literals computed by git itself (git commit-tree), and real git checks the packs (git index-pack, verify-pack) and
// serves the protocol (git upload-pack), so the parser is never checked only against itself.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  createVersionSource, fetchRequest, FETCH_INTERVAL_MS, HistoryReadError, historyFrom, lsRefsRequest, OBJECT_CAP_BYTES, packfileOf, packObjects, readMainHistory,
  TOTAL_CAP_BYTES, type UploadPackPost,
} from "../../src/accounts/postMortemVersion.ts";

const AUTHOR = "Fixture Author <fixture@example.invalid> 1700000000 +0000";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const commitText = (parents: string[], message: string) =>
  `tree ${EMPTY_TREE}\n${parents.map(p => `parent ${p}\n`).join("")}author ${AUTHOR}\ncommitter ${AUTHOR}\n\n${message}\n`;
// Computed by git commit-tree from the texts below.
const ROOT = "9bf1a6f43f940037e89e1e9e96181fcc42623caa";
const SECOND = "75d245c475d224d0e30a10605d777c22d952632a";
const SIDE = "f1ae3b9d2cc8c6f004bc90ab78c559eb1cb65193";
const MERGE = "10e17dcaf212982ddc50969a538997f7125b2aff";
const TEXTS: Record<string, string> = {
  [ROOT]: commitText([], "root"), [SECOND]: commitText([ROOT], "second"), [SIDE]: commitText([ROOT], "side"), [MERGE]: commitText([SECOND, SIDE], "merge"),
};

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "antwar-pm-version-")); dirs.push(dir); return dir; };

function entryHeader(type: number, size: number): Buffer {
  const bytes = [((size > 15 ? 0x80 : 0) | (type << 4) | (size & 15))];
  let rest = size >> 4;
  while (rest > 0) { bytes.push((rest > 127 ? 0x80 : 0) | (rest & 127)); rest >>= 7; }
  return Buffer.from(bytes);
}
const varint = (n: number) => { const out: number[] = []; do { out.push((n > 127 ? 0x80 : 0) | (n & 127)); n >>= 7; } while (n > 0); return Buffer.from(out); };

type Entry = { kind: "whole"; id: string } | { kind: "ref-delta"; id: string; base: string } | { kind: "ofs-delta"; id: string };
/** A version 2 pack of the given entries, in order. A REF_DELTA copies its base's common prefix and inserts the rest. */
function pack(entries: Entry[]): Buffer {
  const parts: Buffer[] = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2]!.writeUInt32BE(entries.length);
  for (const entry of entries) {
    const target = Buffer.from(TEXTS[entry.id]!);
    if (entry.kind === "whole") { parts.push(entryHeader(1, target.length), deflateSync(target)); continue; }
    const base = Buffer.from(TEXTS[entry.kind === "ref-delta" ? entry.base : ROOT]!);
    let common = 0;
    while (common < base.length && common < target.length && common < 0x10000 && base[common] === target[common]) common++;
    const insert = target.subarray(common);
    const ops: Buffer[] = [];
    if (common > 0) ops.push(Buffer.from([0x80 | 0x10 | (common > 255 ? 0x20 : 0), common & 255, ...(common > 255 ? [common >> 8] : [])]));
    for (let i = 0; i < insert.length; i += 127) { const piece = insert.subarray(i, i + 127); ops.push(Buffer.from([piece.length]), piece); }
    const delta = Buffer.concat([varint(base.length), varint(target.length), ...ops]);
    if (entry.kind === "ref-delta") parts.push(entryHeader(7, delta.length), Buffer.from(entry.base, "hex"), deflateSync(delta));
    else parts.push(entryHeader(6, delta.length), Buffer.from([1]), deflateSync(delta));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
const ALL_WHOLE: Entry[] = [MERGE, SIDE, SECOND, ROOT].map(id => ({ kind: "whole", id }));
// Each delta placed before its base, so resolution must wait for the whole pack.
const WITH_REF_DELTAS: Entry[] = [{ kind: "whole", id: MERGE }, { kind: "ref-delta", id: SIDE, base: ROOT }, { kind: "ref-delta", id: SECOND, base: ROOT }, { kind: "whole", id: ROOT }];

const pkt = (text: string | Buffer) => { const data = Buffer.from(text); return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, "0")), data]); };
// The framing of a GitHub protocol-v2 response, as captured from github.com: ls-refs lines then a flush; a fetch's
// packfile section with the pack on band 1 then a flush; a shallow-info section; an ERR line.
const lsRefs = (tip: string, ref = "refs/heads/main") => Buffer.concat([pkt(`${tip} ${ref}\n`), Buffer.from("0000")]);
const fetchReply = (bytes: Buffer) => Buffer.concat([pkt("packfile\n"), pkt(Buffer.concat([Buffer.from([1]), bytes])), Buffer.from("0000")]);
const shallowReply = (tip: string, bytes: Buffer) => Buffer.concat([pkt("shallow-info\n"), pkt(`shallow ${tip}`), Buffer.from("0001"), fetchReply(bytes)]);
const notOurRef = (sha: string) => Buffer.concat([pkt(`ERR upload-pack: not our ref ${sha}`)]);

/** A fake upload-pack endpoint answering ls-refs and fetch from fixed bodies, counting requests. */
function endpoint(ls: Buffer | (() => Buffer), fetched: Buffer | (() => Buffer), status = 200, contentType = "application/x-git-upload-pack-result") {
  const requests: string[] = [];
  const post: UploadPackPost = async body => {
    const text = body.toString("latin1");
    requests.push(text);
    const answer = text.includes("command=ls-refs") ? ls : fetched;
    return { status, contentType, body: typeof answer === "function" ? answer() : answer };
  };
  return { post, requests };
}

describe("main history from a protocol v2 fetch", () => {
  it("builds packs that real git accepts, with the commit ids git computed", () => {
    for (const entries of [ALL_WHOLE, WITH_REF_DELTAS]) {
      const dir = tempDir();
      writeFileSync(join(dir, "fixture.pack"), pack(entries));
      execFileSync("git", ["index-pack", "fixture.pack"], { cwd: dir, stdio: "ignore" });
      const listed = execFileSync("git", ["verify-pack", "-v", "fixture.idx"], { cwd: dir, encoding: "utf8" })
        .split("\n").map(line => line.split(" ")[0]).filter(id => /^[0-9a-f]{40}$/.test(id ?? ""));
      expect(new Set(listed)).toEqual(new Set([ROOT, SECOND, SIDE, MERGE]));
      expect(new Set(packObjects(pack(entries)).keys())).toEqual(new Set([ROOT, SECOND, SIDE, MERGE]));
    }
  });

  it("reads the whole history from the tip, with whole objects and with deltas before their bases", async () => {
    for (const entries of [ALL_WHOLE, WITH_REF_DELTAS]) {
      const { post, requests } = endpoint(lsRefs(MERGE), fetchReply(pack(entries)));
      expect(await readMainHistory(post, new AbortController().signal)).toEqual(new Set([ROOT, SECOND, SIDE, MERGE]));
      expect(requests[0]).toBe(lsRefsRequest().toString("latin1"));
      expect(requests[1]).toBe(fetchRequest(MERGE).toString("latin1"));
    }
  });

  it("asks for neither ofs-delta nor thin-pack, only commit objects of main", () => {
    const text = fetchRequest(MERGE).toString("latin1");
    expect(text).not.toMatch(/ofs-delta|thin-pack/);
    expect(text).toContain("filter tree:0\n");
    expect(lsRefsRequest().toString("latin1")).toContain("ref-prefix refs/heads/main\n");
  });

  it("matches real git upload-pack serving protocol v2, with deltas, as git rev-list sees the same history", () => {
    const dir = tempDir();
    const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Fixture Author", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_COMMITTER_DATE: "1700000000 +0000" };
    const git = (args: string[], input?: string | Buffer) => execFileSync("git", args, { cwd: dir, env, input });
    git(["init", "-q"]);
    git(["config", "uploadpack.allowFilter", "true"]);
    const tree = git(["hash-object", "-t", "tree", "-w", "--stdin"], "").toString().trim();
    let tip = git(["commit-tree", tree], "first\n").toString().trim();
    for (let i = 1; i < 40; i++) tip = git(["commit-tree", tree, "-p", tip], `commit ${i}: a long enough message for the packer to send it as a delta\n`).toString().trim();
    git(["update-ref", "refs/heads/main", tip]);
    let pack: Buffer | undefined;
    const post: UploadPackPost = async body => {
      const out = execFileSync("git", ["upload-pack", "--stateless-rpc", "."], { cwd: dir, input: body, env: { ...env, GIT_PROTOCOL: "version=2" } });
      if (body.toString("latin1").includes("command=fetch")) pack = packfileOf(out);
      return { status: 200, contentType: "application/x-git-upload-pack-result", body: out };
    };
    return readMainHistory(post, new AbortController().signal).then(commits => {
      const listed = git(["rev-list", "main"]).toString().trim().split("\n");
      expect(commits).toEqual(new Set(listed));
      expect(commits.size).toBe(40);
      // Real git sent REF_DELTA (type 7) entries: the delta path ran.
      expect(entryTypes(pack!)).toContain(7);
    });
  });

  it.each([
    ["a missing interior commit", () => fetchReply(pack([{ kind: "whole", id: MERGE }, { kind: "whole", id: SIDE }, { kind: "whole", id: ROOT }]))],
    ["an OFS_DELTA entry, which was not asked for", () => fetchReply(pack([{ kind: "whole", id: MERGE }, { kind: "whole", id: ROOT }, { kind: "ofs-delta", id: SIDE }, { kind: "whole", id: SECOND }]))],
    ["a shallow-info section", () => shallowReply(MERGE, pack(ALL_WHOLE))],
    ["an ERR line", () => notOurRef(MERGE)],
    ["a flipped byte", () => { const reply = fetchReply(pack(ALL_WHOLE)); reply[60] ^= 0xff; return reply; }],
    ["truncation", () => fetchReply(pack(ALL_WHOLE)).subarray(0, 100)],
    ["a missing final flush", () => { const reply = fetchReply(pack(ALL_WHOLE)); return reply.subarray(0, reply.length - 4); }],
  ])("refuses %s", async (_name, reply) => {
    const { post } = endpoint(lsRefs(MERGE), reply());
    await expect(readMainHistory(post, new AbortController().signal)).rejects.toThrow();
  });

  it("refuses a tip other than the commits fetched, a ref other than main, and non-200 or non-git responses", async () => {
    const cases: [Buffer, Buffer, number, string][] = [
      [lsRefs(SECOND.replace("7", "8")), fetchReply(pack(ALL_WHOLE)), 200, "application/x-git-upload-pack-result"],
      [lsRefs(MERGE, "refs/heads/master"), fetchReply(pack(ALL_WHOLE)), 200, "application/x-git-upload-pack-result"],
      [lsRefs(MERGE), fetchReply(pack(ALL_WHOLE)), 429, "application/x-git-upload-pack-result"],
      [lsRefs(MERGE), fetchReply(pack(ALL_WHOLE)), 503, "application/x-git-upload-pack-result"],
      [lsRefs(MERGE), fetchReply(pack(ALL_WHOLE)), 200, "text/html; charset=utf-8"],
    ];
    for (const [ls, fetched, status, type] of cases) {
      await expect(readMainHistory(endpoint(ls, fetched, status, type).post, new AbortController().signal)).rejects.toThrow();
    }
    expect(() => historyFrom(MERGE, packObjects(pack([{ kind: "whole", id: MERGE }])))).toThrow("incomplete history");
  });
});

/** Each entry's type in a pack, read independently of the parser. */
function entryTypes(bytes: Buffer): number[] {
  const types: number[] = [];
  const count = bytes.readUInt32BE(8);
  let o = 12;
  for (let k = 0; k < count; k++) {
    let byte = bytes[o++]!;
    const type = (byte >> 4) & 7;
    while (byte & 0x80) byte = bytes[o++]!;
    if (type === 7) o += 20;
    if (type === 6) { byte = bytes[o++]!; while (byte & 0x80) byte = bytes[o++]!; }
    const { engine } = inflateSync(bytes.subarray(o), { info: true }) as unknown as { engine: { bytesWritten: number } };
    o += engine.bytesWritten;
    types.push(type);
  }
  return types;
}

describe("game version answers", () => {
  const OWN = MERGE;
  function source(replies: { ls: Buffer; fetched: Buffer; status?: number }[]) {
    let clock = 1_000_000, call = 0;
    const requests: string[] = [];
    const post: UploadPackPost = async body => {
      const text = body.toString("latin1");
      requests.push(text);
      const reply = replies[Math.min(call, replies.length - 1)]!;
      if (text.includes("command=fetch")) call++;
      return { status: reply.status ?? 200, contentType: "application/x-git-upload-pack-result", body: text.includes("command=ls-refs") ? reply.ls : reply.fetched };
    };
    const lines: string[] = [];
    const versions = createVersionSource({ post, ownVersion: OWN, now: () => clock, log: line => lines.push(line) });
    return { versions, requests, lines, tick: (ms: number) => { clock += ms; }, now: () => clock };
  }
  const good = { ls: lsRefs(MERGE), fetched: fetchReply(pack(ALL_WHOLE)) };
  const broken = { ls: lsRefs(MERGE), fetched: notOurRef(MERGE) };

  it("finds a commit of main, and calls one absent only from a fetch begun after the request", async () => {
    const s = source([good]);
    const asked = s.now();
    expect(await s.versions.lookup(SIDE, asked)).toBe("found");
    expect(await s.versions.lookup("2".repeat(40), asked)).toBe("absent");
    // A later request is not answered absent from that older read, and within the interval no new fetch begins.
    s.tick(1);
    expect(await s.versions.lookup("2".repeat(40), s.now())).toBe("unavailable");
    expect(s.requests.filter(r => r.includes("command=fetch"))).toHaveLength(1);
    s.tick(FETCH_INTERVAL_MS);
    expect(await s.versions.lookup("2".repeat(40), s.now())).toBe("absent");
    expect(s.requests.filter(r => r.includes("command=fetch"))).toHaveLength(2);
  });

  it("answers try later on a failed read, caches nothing, and the next eligible call succeeds", async () => {
    const s = source([broken, good]);
    expect(await s.versions.lookup(SIDE, s.now())).toBe("unavailable");
    expect(s.lines.join("\n")).toContain("try later");
    s.tick(FETCH_INTERVAL_MS - 1);
    expect(await s.versions.lookup(SIDE, s.now())).toBe("unavailable");
    s.tick(1);
    expect(await s.versions.lookup(SIDE, s.now())).toBe("found");
  });

  it("distrusts a history without this build's own commit", async () => {
    const s = source([{ ls: lsRefs(SECOND), fetched: fetchReply(pack([{ kind: "whole", id: SECOND }, { kind: "whole", id: ROOT }])) }]);
    expect(await s.versions.lookup(ROOT, s.now())).toBe("unavailable");
  });

  it("makes one fetch for concurrent misses", async () => {
    const s = source([good]);
    const asked = s.now();
    const answers = await Promise.all([SIDE, SECOND, "3".repeat(40), ROOT].map(commit => s.versions.lookup(commit, asked)));
    expect(answers).toEqual(["found", "found", "absent", "found"]);
    expect(s.requests.filter(r => r.includes("command=fetch"))).toHaveLength(1);
  });

  it("calls a value that is not a full commit id absent without reading", async () => {
    const s = source([good]);
    expect(await s.versions.lookup("not-a-commit", s.now())).toBe("absent");
    expect(s.requests).toHaveLength(0);
  });
});

describe("fixed unpacking limits, whatever sizes a response declares", () => {
  /** A version 2 pack of raw entries: [type, declared size, deflated body, REF_DELTA base id]. */
  function rawPack(entries: [number, number, Buffer, string?][]): Buffer {
    const parts: Buffer[] = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
    parts[2]!.writeUInt32BE(entries.length);
    for (const [type, size, body, base] of entries) parts.push(entryHeader(type, size), ...(base === undefined ? [] : [Buffer.from(base, "hex")]), body);
    const bytes = Buffer.concat(parts);
    return Buffer.concat([bytes, createHash("sha1").update(bytes).digest()]);
  }
  const failure = (bytes: Buffer) => { try { packObjects(bytes); return null; } catch (error) { return error instanceof HistoryReadError ? error.message : "other"; } };
  const root = Buffer.from(TEXTS[ROOT]!);

  // Credible regression: allocating whatever the response declares, or inflating past what it declared.
  it("refuses an object declared over the per-object limit, and one inflating past its declared size, before allocating it", () => {
    expect(failure(rawPack([[1, OBJECT_CAP_BYTES + 1, deflateSync(root)]]))).toBe("object too large");
    // 50 MiB of zeros declared as 10 bytes: inflating stops at the declared size.
    expect(failure(rawPack([[1, 10, deflateSync(Buffer.alloc(50 * 2 ** 20))]]))).toBe("bad compressed entry");
    expect(failure(rawPack([[1, root.length, deflateSync(root)]]))).toBeNull();
  });

  it("refuses a delta whose result is declared over the per-object limit", () => {
    const delta = Buffer.concat([varint(root.length), varint(OBJECT_CAP_BYTES + 1), Buffer.from([0x80 | 0x10, 1])]);
    expect(failure(rawPack([[1, root.length, deflateSync(root)], [7, delta.length, deflateSync(delta), ROOT]]))).toBe("object too large");
  });

  it("refuses a pack whose objects together pass the total limit", () => {
    const object = Buffer.alloc(OBJECT_CAP_BYTES, 0x61);
    const body = deflateSync(object);
    const n = Math.floor(TOTAL_CAP_BYTES / OBJECT_CAP_BYTES);
    expect(failure(rawPack(Array.from({ length: n + 1 }, () => [3, object.length, body] as [number, number, Buffer])))).toBe("pack too large");
    expect(failure(rawPack(Array.from({ length: n }, () => [3, object.length, body] as [number, number, Buffer])))).toBeNull();
  });

  // Credible regression: a limit reached taken as proof that a version is absent, or cached as an answer.
  it("answers a version check whose response passes a limit as try later, never absent, and checks afresh later", async () => {
    let clock = 1_000_000, fetches = 0;
    const oversized = rawPack([[1, OBJECT_CAP_BYTES + 1, deflateSync(root)]]);
    const post: UploadPackPost = async body => {
      const fetch = body.toString("latin1").includes("command=fetch");
      if (fetch) fetches++;
      return { status: 200, contentType: "application/x-git-upload-pack-result",
        body: !fetch ? lsRefs(MERGE) : fetchReply(fetches === 1 ? oversized : pack(ALL_WHOLE)) };
    };
    const versions = createVersionSource({ post, ownVersion: MERGE, now: () => clock, log: () => {} });
    expect(await versions.lookup("4".repeat(40), clock)).toBe("unavailable");
    clock += FETCH_INTERVAL_MS;
    expect(await versions.lookup("4".repeat(40), clock)).toBe("absent");
    expect(await versions.lookup(SIDE, clock)).toBe("found");
  });
});
