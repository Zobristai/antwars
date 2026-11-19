// The render check's replay excerpts are committed as readable text and packed at run time into the bytes the site
// serves (web/render-check/replay-text.ts, serve.ts readFixtures): those bytes match each excerpt's recorded sha256,
// and a fixture whose bytes do not match is refused before anything is served. Each excerpt can be read whole.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { decodeMessage } from "../../src/live/format.ts";
import { TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { FREE_FOR_ALL_REPLAY, HUD_PLAY_MS } from "../../web/render-check/check.ts";
import { MAX_LINE_BYTES } from "../../web/render-check/replay-text.ts";
import { readFixtures } from "../../web/render-check/serve.ts";

const FIXTURES = resolve(import.meta.dirname, "../../web/render-check/fixtures.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("packs every committed replay excerpt into bytes with its recorded sha256", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  const replays = Object.entries(fixtures).filter(([key]) => key.startsWith("/replays/"));
  expect(replays.length).toBe(2);
  for (const [, fixture] of replays) {
    expect(fixture.file).toMatch(/\.replay\.jsonl$/);
    expect(fixture.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(fixture.bytes!)).toBe(fixture.sha256);
  }
});

it("refuses a replay excerpt whose bytes differ from its recorded sha256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-check-fixtures-"));
  try {
    const committed = JSON.parse(await readFile(FIXTURES, "utf8")) as { fixtures: Record<string, { file?: string; sha256?: string }> };
    const [key, fixture] = Object.entries(committed.fixtures).find(([k]) => k.startsWith("/replays/"))!;
    const file = join(dir, "fixtures.json");
    const changed = { ...fixture, file: resolve(FIXTURES, "..", fixture.file!), sha256: "0".repeat(64) };
    await writeFile(file, JSON.stringify({ fixtures: { [key]: changed } }));
    await expect(readFixtures([file])).rejects.toThrow(/not the recorded 0{64}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps every committed replay excerpt readable whole and long enough to be judged while it plays", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  for (const [key, fixture] of Object.entries(fixtures).filter(([k]) => k.startsWith("/replays/"))) {
    const text = await readFile(fixture.file!, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    for (const line of text.split("\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const ticks = unpackMessages(fixture.bytes!).map(m => decodeMessage(m).tick);
    const span = (ticks.at(-1)! - ticks[0]!) * TICK_MS;
    // The replay's board shows its recording RENDER_DELAY_MS behind and must not reach its last tick, where its HUD
    // says the recording ended; Watch with no live match starts its stand-in recording again once the last message
    // arrives, so that must come after the judged moment.
    expect(span).toBeGreaterThan(key === `/replays/${FREE_FOR_ALL_REPLAY}` ? HUD_PLAY_MS - RENDER_DELAY_MS : HUD_PLAY_MS);
  }
});
