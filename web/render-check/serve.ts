/**
 * Serves one built site (web/dist) to a browser context with no server and no network.
 * Built files come from disk. Every data request is answered from the committed snapshot
 * (recorded once from the public site with --record) or from a labelled fixture; anything
 * else is answered 404 and listed as an unanswered request, which fails the check.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { BrowserContext } from "playwright-core";
import { replayFromText } from "./replay-text.ts";

export const ORIGIN = "http://localhost:4718";
export const PUBLIC_SITE = "https://antwars.ai";
export const SNAPSHOT_DIR = resolve(import.meta.dirname, "snapshot");

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
  ".json": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json",
};

/** One recorded response. Bodies live in snapshot/bodies/<file>; .gz files are stored compressed. */
export interface Recorded { status: number; type: string | null; file: string }
export interface SnapshotIndex { recordedFrom: string; recordedAt: string; responses: Record<string, Recorded> }
/**
 * A response no public route can give yet (or a state the public site is not in), named for what it stands for.
 * A body may come from a file: a .replay.jsonl file is a recording as readable text (replay-text.ts), packed into the
 * bytes the site serves; sha256 is the digest those bytes must have, checked when the fixtures are read.
 */
export interface Fixture { label: string; status?: number; type?: string; body?: unknown; file?: string; sha256?: string }
/** A fixture as served: a file's body is read once and checked. */
export interface LoadedFixture extends Fixture { bytes?: Buffer }
export type LoadedFixtures = Record<string, LoadedFixture>;
export type Fixtures = Record<string, Fixture>;

/** The request key: path plus query, exactly as the page asked; a POST (a read with a JSON body) adds its body. */
export const requestKey = (url: URL, method = "GET", body: string | null = null): string =>
  method === "GET" || method === "HEAD" ? url.pathname + url.search : `${method} ${url.pathname}${url.search} ${body ?? ""}`;
/** The only POSTs record mode may send to the public site: anonymous reads. */
const RECORDABLE_POSTS = ["/api/leaderboard"];

/** The page markup the public server sends: index.html with its capability metadata (src/spectator.ts servePage). */
const PAGE_METADATA = '<meta name="antwar-lobbies" content="true"><meta name="antwar-public-matches" content="true"><meta name="antwar-local-match" content="false">';

/** A built file of the site, or null. */
async function builtFile(dist: string, pathname: string): Promise<Buffer | null> {
  const file = resolve(dist, "." + normalize(pathname));
  if (!file.startsWith(resolve(dist) + sep)) return null;
  try { return await readFile(file); } catch { return null; }
}

export async function readSnapshot(dir = SNAPSHOT_DIR): Promise<SnapshotIndex> {
  return JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as SnapshotIndex;
}

export async function readFixtures(files: readonly string[]): Promise<LoadedFixtures> {
  const all: LoadedFixtures = {};
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { fixtures: Fixtures };
    for (const [key, fixture] of Object.entries(parsed.fixtures)) {
      if (!fixture.label) throw new Error(`${file}: fixture ${key} has no label`);
      if (fixture.file === undefined) { all[key] = fixture; continue; }
      const path = resolve(file, "..", fixture.file);
      const bytes = await fixtureBytes(path);
      if (fixture.sha256 !== undefined) {
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== fixture.sha256) throw new Error(`${file}: fixture ${key} serves bytes with sha256 ${actual}, not the recorded ${fixture.sha256}`);
      }
      all[key] = { ...fixture, file: path, bytes };
    }
  }
  return all;
}

async function fixtureBytes(path: string): Promise<Buffer> {
  if (path.endsWith(".replay.jsonl")) return Buffer.from(replayFromText(await readFile(path, "utf8")));
  return unzip(path, await readFile(path));
}

export interface Served {
  /** Requests answered by neither the build, the snapshot nor a fixture, in order. */
  unanswered: string[];
  /** Fixture labels the page actually used. */
  fixturesUsed: Set<string>;
}

export interface ServeOptions {
  dist: string;
  snapshot: SnapshotIndex;
  fixtures: LoadedFixtures;
  snapshotDir?: string;
  /** The Rules page markup, which the server renders rather than the build. */
  rulesPage(): string;
  /** Record mode: answer data requests from the public site and add them to the snapshot. */
  record?: boolean;
}

/** Route every request of the context. Requests to any other origin are aborted and listed. */
export async function serveSite(context: BrowserContext, o: ServeOptions): Promise<Served> {
  const dir = o.snapshotDir ?? SNAPSHOT_DIR;
  const served: Served = { unanswered: [], fixturesUsed: new Set() };
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      served.unanswered.push(url.href);
      return route.abort("blockedbyclient");
    }
    const method = route.request().method();
    const key = requestKey(url, method, route.request().postData());
    const fixture = o.fixtures[key];
    if (fixture) {
      served.fixturesUsed.add(fixture.label);
      const body = fixture.bytes ?? Buffer.from(JSON.stringify(fixture.body ?? null));
      return route.fulfill({ status: fixture.status ?? 200, contentType: fixture.type ?? "application/json", body });
    }
    const kind = route.request().resourceType();
    if (kind === "document" && (url.pathname === "/rules" || url.pathname === "/rules/")) {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: o.rulesPage() });
    }
    if (kind === "document") {
      const page = (await readFile(join(o.dist, "index.html"), "utf8")).replace("<head>", `<head>${PAGE_METADATA}`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page });
    }
    if (kind !== "fetch" && kind !== "xhr" && kind !== "eventsource") {
      const body = await builtFile(o.dist, url.pathname);
      if (body) return route.fulfill({ status: 200, contentType: TYPES[extname(url.pathname)] ?? "application/octet-stream", body });
    }
    const recorded = o.snapshot.responses[key];
    if (recorded) {
      const body = await readFile(join(dir, "bodies", recorded.file));
      return route.fulfill({ status: recorded.status, contentType: recorded.type ?? undefined, body: unzip(recorded.file, body) });
    }
    if (o.record && kind !== "eventsource" && (method === "GET" || (method === "POST" && RECORDABLE_POSTS.includes(url.pathname)))) {
      const headers = route.request().headers();
      const res = await fetch(PUBLIC_SITE + url.pathname + url.search, { method, body: method === "POST" ? route.request().postData() : undefined,
        headers: { accept: headers["accept"] ?? "*/*", ...(headers["content-type"] ? { "content-type": headers["content-type"] } : {}) } });
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get("content-type");
      const file = createHash("sha256").update(key).digest("hex").slice(0, 20) + (body.length > 64 * 1024 ? ".gz" : ".body");
      await mkdir(join(dir, "bodies"), { recursive: true });
      await writeFile(join(dir, "bodies", file), file.endsWith(".gz") ? gzipSync(body, { level: 9 }) : body);
      o.snapshot.responses[key] = { status: res.status, type, file };
      return route.fulfill({ status: res.status, contentType: type ?? undefined, body });
    }
    served.unanswered.push(key);
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not in the render-check snapshot"}' });
  });
  return served;
}

const unzip = (file: string | undefined, body: Buffer): Buffer => (file?.endsWith(".gz") ? gunzipSync(body) : body);

export async function writeSnapshot(index: SnapshotIndex, dir = SNAPSHOT_DIR): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(index.responses).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(join(dir, "index.json"), JSON.stringify({ ...index, responses: sorted }, null, 1) + "\n");
}
