/** The site favicon: derived from the approved emblem, declared on every served page, served by the real server. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSpectatedServer, WEB_DIST, type SpectatedServer } from "../../src/spectator.ts";
import { renderRules } from "../../web/rules.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { buildFavicon, decodePng, EMBLEM_PATH, FAVICON_PATH, FAVICON_SIZES } from "../../scripts/favicon.ts";

const ICON_LINK = /<link rel="icon" href="\.?\/favicon\.ico" sizes="16x16 32x32 48x48"\s*\/?>/;

let server: SpectatedServer | undefined;
let dataDir: string | undefined;
let committed: Buffer;

beforeAll(async () => {
  committed = await readFile(FAVICON_PATH);
  dataDir = await mkdtemp(join(tmpdir(), "antwar-favicon-"));
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

describe("the favicon", () => {
  it("is exactly what scripts/favicon.ts derives from the approved emblem bytes", async () => {
    expect(buildFavicon(await readFile(EMBLEM_PATH)).equals(committed)).toBe(true);
  });

  it("refuses any source other than the approved emblem", () => {
    expect(() => buildFavicon(Buffer.from("not the emblem"))).toThrow(/not the approved/);
  });

  it("holds one square PNG entry per standard size", () => {
    expect(committed.readUInt16LE(2)).toBe(1);
    expect(committed.readUInt16LE(4)).toBe(FAVICON_SIZES.length);
    FAVICON_SIZES.forEach((size, i) => {
      const at = 6 + 16 * i, length = committed.readUInt32LE(at + 8), offset = committed.readUInt32LE(at + 12);
      expect([committed[at], committed[at + 1]]).toEqual([size, size]);
      const image = decodePng(committed.subarray(offset, offset + length));
      expect([image.width, image.height]).toEqual([size, size]);
    });
  });

  it("is declared by the built page (game, Matches, Leaderboard and landing views)", async () => {
    expect(await readFile(join(WEB_DIST, "index.html"), "utf8")).toMatch(ICON_LINK);
    const page = await fetch(`http://127.0.0.1:${server!.port}/`);
    expect(await page.text()).toMatch(ICON_LINK);
  });

  it("is declared by the Rules page", async () => {
    expect(renderRules(newMatchConfig(PUBLIC_CONFIG))).toMatch(ICON_LINK);
    const page = await fetch(`http://127.0.0.1:${server!.port}/rules`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(ICON_LINK);
  });

  it("is served at /favicon.ico as an icon, not a 404", async () => {
    const response = await fetch(`http://127.0.0.1:${server!.port}/favicon.ico`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    expect(Buffer.from(await response.arrayBuffer()).equals(committed)).toBe(true);
  });
});
