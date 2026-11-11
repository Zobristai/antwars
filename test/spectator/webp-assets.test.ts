/** The real antwar server serves the built WebP page images as image/webp. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSpectatedServer, WEB_DIST, type SpectatedServer } from "../../src/spectator.ts";

const images = ["pages/hero-battle.webp", "landing-page/hero/hero-phone-702.webp"];
let server: SpectatedServer | undefined;
let dataDir: string | undefined;
let builtFiles: string[];

beforeAll(async () => {
  builtFiles = await readdir(join(WEB_DIST, "assets"));
  dataDir = await mkdtemp(join(tmpdir(), "antwar-webp-assets-"));
  // No match starts and no agent joins. Only static HTTP responses are exercised.
  server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, match: "held", expectedPlayers: 2 });
});

afterAll(async () => {
  try {
    await server?.close();
  } finally {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});

describe("real-server bundled WebP responses", () => {
  it.each(images)("serves %s as image/webp with byte-identical source bytes", async (source) => {
    const file = source.slice(source.lastIndexOf("/") + 1);
    const stem = file.slice(0, -".webp".length);
    const matches = builtFiles.filter((name) => name.startsWith(`${stem}-`) && name.endsWith(".webp"));
    expect(matches, `built ${file}`).toHaveLength(1);
    const response = await fetch(`http://127.0.0.1:${server!.port}/assets/${matches[0]}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    const body = Buffer.from(await response.arrayBuffer());
    const original = await readFile(new URL(`../../web/src/${source}`, import.meta.url));
    expect(response.headers.get("content-length")).toBe(String(original.length));
    expect(body).toEqual(original);
  });
});
