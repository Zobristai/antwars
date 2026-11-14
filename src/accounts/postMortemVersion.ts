/**
 * Whether a match record's game version (its codeVersion, a full commit) is a commit in the history of the public
 * repository's main branch, read over git's smart HTTP protocol version 2: ls-refs for main's tip, then one fetch of
 * commit objects only (filter tree:0), with no git binary and no API. Every commit from the tip back to the roots must
 * arrive, each hashed and checked, so a partial history is never taken as the whole.
 *
 * "found" may come from any verified fetch. "absent" only from a verified fetch begun after the request, so a commit
 * that reached main later is not called absent from an older read. Anything else (a refused, partial, malformed or
 * slow response, the throttle) is "unavailable": try later, never absent, never cached as an answer.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const REPOSITORY_UPLOAD_PACK = "https://github.com/Zobristai/antwars.git/git-upload-pack";
export const MAIN_REF = "refs/heads/main";
/** At most one fetch begins per this interval. */
export const FETCH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const RESPONSE_CAP_BYTES = 64 * 1024 * 1024;
/**
 * Fixed allocation limits while unpacking, whatever sizes the response declares: each object, inflated or rebuilt from
 * a delta, and all of them together. Exceeding one is a read that failed (try later), never an absent version. main's
 * commits are a few KiB each and a few hundred KiB in all (2026-11).
 */
export const OBJECT_CAP_BYTES = 1024 * 1024;
export const TOTAL_CAP_BYTES = 64 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;

export type VersionAnswer = "found" | "absent" | "unavailable";

export interface VersionSource {
  /** requestedAt: when the asking request began, on the source's clock. */
  lookup(commit: string, requestedAt: number): Promise<VersionAnswer>;
}

/** One POST to the upload-pack endpoint. */
export type UploadPackPost = (body: Buffer, signal: AbortSignal) => Promise<{ status: number; contentType: string | null; body: Buffer }>;

export class HistoryReadError extends Error {}
const bad = (why: string): never => { throw new HistoryReadError(why); };

function pkt(line: string): Buffer {
  const data = Buffer.from(line);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, "0")), data]);
}
const FLUSH = Buffer.from("0000"), DELIM = Buffer.from("0001");

type Packet = { readonly special: number } | { readonly data: Buffer };
/** The response's pkt-lines; anything but whole packets (trailing bytes, a bad length) fails. */
export function packets(buffer: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) bad("truncated packet");
    const text = buffer.subarray(offset, offset + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/.test(text)) bad("bad packet length");
    const length = parseInt(text, 16);
    if (length < 4) { if (length === 3) bad("bad packet length"); out.push({ special: length }); offset += 4; continue; }
    if (offset + length > buffer.length) bad("truncated packet");
    const data = buffer.subarray(offset + 4, offset + length);
    if (data.subarray(0, 4).toString("latin1") === "ERR ") bad("remote error");
    out.push({ data });
    offset += length;
  }
  return out;
}

export function lsRefsRequest(): Buffer {
  return Buffer.concat([pkt("command=ls-refs\n"), DELIM, pkt(`ref-prefix ${MAIN_REF}\n`), FLUSH]);
}
/** Neither ofs-delta nor thin-pack is asked for, so a delta names its base by id and every base is in the pack. */
export function fetchRequest(tip: string): Buffer {
  return Buffer.concat([pkt("command=fetch\n"), DELIM, pkt("no-progress\n"), pkt("filter tree:0\n"), pkt(`want ${tip}\n`), pkt("done\n"), FLUSH]);
}

/** main's tip from an ls-refs response: exactly one line naming it, then a flush. */
export function mainTip(response: Buffer): string {
  const list = packets(response);
  if (list.length === 0 || !("special" in list.at(-1)!) || (list.at(-1) as { special: number }).special !== 0) bad("unterminated ref list");
  const tips = list.slice(0, -1).map(p => {
    if (!("data" in p)) return bad("unexpected packet");
    const [sha, ref] = p.data.toString("latin1").replace(/\n$/, "").split(" ");
    return ref === MAIN_REF && SHA.test(sha ?? "") ? sha! : bad("unexpected ref line");
  });
  if (tips.length !== 1) bad("main not listed once");
  return tips[0]!;
}

/** The packfile bytes of a fetch response: the packfile section alone, band 1 data; any other section fails. */
export function packfileOf(response: Buffer): Buffer {
  const list = packets(response);
  const first = list[0];
  if (first === undefined || !("data" in first) || first.data.toString("latin1") !== "packfile\n") bad("no packfile section");
  const parts: Buffer[] = [];
  let ended = false;
  for (const p of list.slice(1)) {
    if (ended) bad("data after flush");
    if ("special" in p) { if (p.special !== 0) bad("unexpected section"); ended = true; continue; }
    const band = p.data[0];
    if (band === 1) parts.push(p.data.subarray(1));
    else if (band === 2) continue;
    else bad("remote error");
  }
  if (!ended) bad("unterminated packfile");
  return Buffer.concat(parts);
}

const TYPES: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const objectId = (type: string, body: Buffer) => createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");

/** Counts bytes about to be allocated against the per-object and total caps, refusing before allocating. */
function allocation(): (bytes: number) => void {
  let total = 0;
  return bytes => {
    if (bytes > OBJECT_CAP_BYTES) bad("object too large");
    total += bytes;
    if (total > TOTAL_CAP_BYTES) bad("pack too large");
  };
}

function applyDelta(base: Buffer, delta: Buffer, allocate: (bytes: number) => void): Buffer {
  let i = 0;
  const varint = () => {
    let value = 0, shift = 0, byte: number;
    do { if (i >= delta.length) bad("bad delta"); byte = delta[i++]!; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) bad("delta base size");
  const size = varint();
  allocate(size);
  const out = Buffer.alloc(size);
  let written = 0;
  while (i < delta.length) {
    const op = delta[i++]!;
    if (op & 0x80) {
      let offset = 0, size = 0;
      for (let k = 0; k < 4; k++) if (op & (1 << k)) offset += delta[i++]! * 2 ** (8 * k);
      for (let k = 0; k < 3; k++) if (op & (16 << k)) size += delta[i++]! * 2 ** (8 * k);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > out.length) bad("bad delta copy");
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op !== 0) {
      if (i + op > delta.length || written + op > out.length) bad("bad delta insert");
      delta.copy(out, written, i, i + op);
      written += op;
      i += op;
    } else bad("bad delta op");
  }
  if (written !== out.length) bad("delta size");
  return out;
}

/** Every object of a pack by id: whole objects and REF_DELTA, resolved once all entries are read; any other entry fails. */
export function packObjects(pack: Buffer): Map<string, { type: string; body: Buffer }> {
  if (pack.length < 32 || pack.subarray(0, 4).toString("latin1") !== "PACK" || pack.readUInt32BE(4) !== 2) bad("not a version 2 pack");
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, { type: string; body: Buffer }>();
  const deltas: { base: string; delta: Buffer }[] = [];
  const allocate = allocation();
  let o = 12;
  for (let k = 0; k < count; k++) {
    if (o >= pack.length - 20) bad("truncated pack");
    let byte = pack[o++]!;
    const type = (byte >> 4) & 7;
    let size = byte & 15, shift = 4;
    while (byte & 0x80) { if (o >= pack.length) bad("truncated pack"); byte = pack[o++]!; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
    let base: string | undefined;
    if (type === 7) { base = pack.subarray(o, o + 20).toString("hex"); o += 20; }
    else if (TYPES[type] === undefined) bad("unsupported pack entry");
    // The declared size is checked against the caps first, and inflating cannot write more than it.
    allocate(size);
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try { inflated = inflateSync(pack.subarray(o, pack.length - 20), { info: true, maxOutputLength: Math.max(1, size) }) as unknown as typeof inflated; }
    catch { return bad("bad compressed entry"); }
    o += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) bad("entry size");
    if (base !== undefined) deltas.push({ base, delta: inflated.buffer });
    else { const t = TYPES[type]!; objects.set(objectId(t, inflated.buffer), { type: t, body: inflated.buffer }); }
  }
  if (o !== pack.length - 20) bad("pack length");
  if (createHash("sha1").update(pack.subarray(0, o)).digest("hex") !== pack.subarray(o).toString("hex")) bad("pack checksum");
  // A delta's base may itself be a delta later in the pack: resolve until no progress.
  let pending = deltas;
  while (pending.length > 0) {
    const next = pending.filter(({ base, delta }) => {
      const found = objects.get(base);
      if (found === undefined) return true;
      const body = applyDelta(found.body, delta, allocate);
      objects.set(objectId(found.type, body), { type: found.type, body });
      return false;
    });
    if (next.length === pending.length) bad("delta base missing");
    pending = next;
  }
  return objects;
}

/** The commit ids reachable from tip; any commit missing on the way fails, so the set is main's whole history. */
export function historyFrom(tip: string, objects: ReadonlyMap<string, { type: string; body: Buffer }>): Set<string> {
  const seen = new Set<string>(), stack = [tip];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const object = objects.get(id);
    if (object === undefined || object.type !== "commit") bad("incomplete history");
    seen.add(id);
    for (const line of object!.body.toString("latin1").split("\n")) {
      if (line === "") break;
      if (line.startsWith("parent ")) {
        const parent = line.slice(7);
        if (!SHA.test(parent)) bad("bad parent");
        stack.push(parent);
      }
    }
  }
  return seen;
}

export function httpUploadPack(url: string = REPOSITORY_UPLOAD_PACK, request: typeof fetch = fetch): UploadPackPost {
  return async (body, signal) => {
    const response = await request(url, { method: "POST", body: new Uint8Array(body), signal, redirect: "error", headers: { "Git-Protocol": "version=2",
      "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result" } });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > RESPONSE_CAP_BYTES) { await response.body?.cancel(); bad("response too large"); }
    const parts: Buffer[] = [];
    let length = 0;
    if (response.body) for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > RESPONSE_CAP_BYTES) bad("response too large");
      parts.push(Buffer.from(chunk));
    }
    return { status: response.status, contentType: response.headers.get("content-type"), body: Buffer.concat(parts) };
  };
}

/** main's whole commit history now; throws on anything but a complete, verified answer. */
export async function readMainHistory(post: UploadPackPost, signal: AbortSignal): Promise<Set<string>> {
  const call = async (body: Buffer) => {
    const reply = await post(body, signal);
    if (reply.status !== 200 || reply.contentType !== "application/x-git-upload-pack-result") bad(`unexpected response ${reply.status}`);
    return reply.body;
  };
  const tip = mainTip(await call(lsRefsRequest()));
  const objects = packObjects(packfileOf(await call(fetchRequest(tip))));
  return historyFrom(tip, objects);
}

export interface VersionSourceOptions {
  readonly post: UploadPackPost;
  /** This build's own commit: a history without it is not trusted. */
  readonly ownVersion: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export function createVersionSource(options: VersionSourceOptions): VersionSource {
  const now = options.now ?? Date.now;
  let known: { commits: Set<string>; begunAt: number } | null = null;
  let lastBegunAt = -Infinity;
  let inFlight: { begunAt: number; done: Promise<void> } | null = null;

  function begin(): { begunAt: number; done: Promise<void> } {
    const begunAt = now();
    lastBegunAt = begunAt;
    const done = (async () => {
      try {
        const commits = await readMainHistory(options.post, AbortSignal.timeout(FETCH_TIMEOUT_MS));
        if (!commits.has(options.ownVersion)) bad("own version not in history");
        known = { commits, begunAt };
      } catch (error) {
        options.log?.(`antwar post-mortem: game history read failed; versions answer try later: ${error instanceof HistoryReadError ? error.message : "request failed"}`);
      } finally {
        inFlight = null;
      }
    })();
    const flight = { begunAt, done };
    inFlight = flight;
    return flight;
  }

  function answer(commit: string, requestedAt: number): VersionAnswer | null {
    if (known?.commits.has(commit)) return "found";
    if (known !== null && known.begunAt >= requestedAt) return "absent";
    return null;
  }

  return {
    async lookup(commit, requestedAt) {
      if (!SHA.test(commit)) return "absent";
      const settled = answer(commit, requestedAt);
      if (settled !== null) return settled;
      if (inFlight !== null) {
        const flight = inFlight;
        await flight.done;
        const after = answer(commit, requestedAt);
        if (after !== null) return after;
      }
      if (inFlight === null && now() - lastBegunAt >= FETCH_INTERVAL_MS) {
        await begin().done;
        return answer(commit, requestedAt) ?? "unavailable";
      }
      return "unavailable";
    },
  };
}
