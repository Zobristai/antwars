// The render check's replay excerpts are committed as readable text and packed at run time into the bytes the site
// serves (web/render-check/replay-text.ts, serve.ts readFixtures): those bytes match each excerpt's recorded sha256,
// and a fixture whose bytes do not match is refused before anything is served. Each excerpt can be read whole, and the
// grouped-seat replay's excerpt still shows grouped seats.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { decodeMessage } from "../../src/live/format.ts";
import { TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { TEST_BACKFILL_IDS } from "../../src/replays/testBackfillIds.ts";
import { shippedTopMatchList } from "../../src/replays/top-matches.ts";
import { ReplayEventScan } from "../../web/src/replay-events.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { SEAT } from "../../web/src/compose.ts";
import { resultView, teamPlayer } from "../../web/src/ui/deck/model.ts";
import { FREE_FOR_ALL_REPLAY, GROUPED_SEATS_REPLAY, HUD_PLAY_MS } from "../../web/render-check/check.ts";
import { MAX_FILE_BYTES, MAX_LINE_BYTES, joinReplayText, replayFromText, splitReplayText } from "../../web/render-check/replay-text.ts";
import { readFixtures } from "../../web/render-check/serve.ts";

const FIXTURES = resolve(import.meta.dirname, "../../web/render-check/fixtures.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("packs every committed replay excerpt into bytes with its recorded sha256", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  const replays = Object.entries(fixtures).filter(([key]) => key.startsWith("/replays/"));
  expect(replays.length).toBe(3);
  for (const [, fixture] of replays) {
    expect(fixture.files!.length).toBeGreaterThan(0);
    for (const file of fixture.files!) expect(file).toMatch(/\.replay\.jsonl$/);
    expect(fixture.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(fixture.bytes!)).toBe(fixture.sha256);
  }
});

it("the result surface plays a rated finish with a long house label, two badges and sample players", async () => {
  const fixtures = await readFixtures([resolve(FIXTURES, "..", "result-standings-fixture.json")]);
  const messages = unpackMessages(fixtures[`/replays/${GROUPED_SEATS_REPLAY}`]!.bytes!).map(decodeMessage);
  expect(messages[0]!.full!.setup.rated).toBe(true);
  expect(messages[0]!.full!.agents.map(a => a.identity?.displayName)).toEqual([
    "antwars/gpt-6-1-terra-max-fast #1", "antwars/k3-1-pro-highspeed #1", "sample-orbit", "sample-wren",
  ]);
  expect(messages.map(m => m.tick)).toEqual(messages.map((_, i) => messages[0]!.tick + i));
  const scan = new ReplayEventScan();
  messages.forEach(m => scan.push(m));
  expect(scan.events().map(e => [e.kind, e.colony, e.ms])).toEqual(Array(3).fill(["nest", 1, 500]));
  const end = messages.flatMap(m => m.events).find(e => e.kind === "end");
  expect(end?.result.ratingChanges).toHaveLength(4);
  const replay = new Playback(), frame = new Frame();
  messages.forEach((m, i) => replay.push(m, i * TICK_MS));
  replay.sample(HUD_PLAY_MS, frame);
  expect(resultView(frame)?.moments.map(m => m.what)).toEqual(["Queen 1 lost", "Queen 11 lost", "Queen 12 lost"]);
});

it("refuses a replay excerpt whose bytes differ from its recorded sha256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-check-fixtures-"));
  try {
    const committed = JSON.parse(await readFile(FIXTURES, "utf8")) as { fixtures: Record<string, { files?: string[]; sha256?: string }> };
    const [key, fixture] = Object.entries(committed.fixtures).find(([k]) => k.startsWith("/replays/"))!;
    const files = fixture.files!.map(f => resolve(FIXTURES, "..", f));
    const file = join(dir, "fixtures.json");
    await writeFile(file, JSON.stringify({ fixtures: { [key]: { ...fixture, files, sha256: "0".repeat(64) } } }));
    await expect(readFixtures([file])).rejects.toThrow(/not the recorded 0{64}/);
    // The files are one text, in the order named: read in another order, they are another recording or none.
    await writeFile(file, JSON.stringify({ fixtures: { [key]: { ...fixture, files: [...files].reverse() } } }));
    await expect(readFixtures([file])).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps every committed replay excerpt readable whole and long enough to be judged while it plays", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  for (const [key, fixture] of Object.entries(fixtures).filter(([k]) => k.startsWith("/replays/"))) {
    for (const file of fixture.files!) {
      const text = await readFile(file, "utf8");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_FILE_BYTES);
      for (const line of text.split("\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    }
    const ticks = unpackMessages(fixture.bytes!).map(m => decodeMessage(m).tick);
    const span = (ticks.at(-1)! - ticks[0]!) * TICK_MS;
    // The replay's board shows its recording RENDER_DELAY_MS behind and must not reach its last tick, where its HUD
    // says the recording ended; Watch with no live match starts its stand-in recording again once the last message
    // arrives, so that must come after the judged moment.
    const replaySurface = [FREE_FOR_ALL_REPLAY, GROUPED_SEATS_REPLAY].some(id => key === `/replays/${id}`);
    expect(span).toBeGreaterThan(replaySurface ? HUD_PLAY_MS - RENDER_DELAY_MS : HUD_PLAY_MS);
  }
});

it("gives each of the four colonies a distinct linked player in the free-for-all excerpt", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  const head = decodeMessage(unpackMessages(fixtures[`/replays/${FREE_FOR_ALL_REPLAY}`]!.bytes!)[0]!);
  const players = head.full!.agents.map(a => a.identity!.displayName);
  expect(new Set(head.full!.agents.map(a => a.colony)).size).toBe(4);
  expect(new Set(players).size).toBe(4);
  const links = fixtures[`/matches/users/links/replay/${FREE_FOR_ALL_REPLAY}`]!.body as { handles: [string, string][] };
  expect(new Map(links.handles)).toEqual(new Map(players.map(name => [name, name])));
});

it("plays a grouped-seat excerpt: a colony whose seats all belong to one player, joined out of seat order", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  const head = decodeMessage(unpackMessages(fixtures[`/replays/${GROUPED_SEATS_REPLAY}`]!.bytes!)[0]!);
  const colonies = Map.groupBy(head.full!.agents, a => a.colony);
  // The Score Band groups a colony's seats under one player (teamPlayer) only where they all belong to one player.
  const grouped = [...colonies.values()].filter(agents => teamPlayer(agents) !== null);
  expect(grouped.length).toBeGreaterThan(0);
  // In at least one, joining order is not seat order, so the badges' order is the Score Band's own seat sort.
  const seatNumbers = (agents: typeof grouped[number]) => agents.map(a => Number(SEAT.exec(a.identity!.displayName)![2]));
  expect(grouped.some(agents => seatNumbers(agents).some((n, i, all) => i > 0 && n < all[i - 1]!))).toBe(true);
});

it("splits replay text into files that read back as the same recording, each starting at a message where one fits", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  const fixture = fixtures[`/replays/${FREE_FOR_ALL_REPLAY}`]!;
  const text = joinReplayText(await Promise.all(fixture.files!.map(f => readFile(f, "utf8"))));
  for (const maxBytes of [MAX_FILE_BYTES, 20_000, MAX_LINE_BYTES + 1]) {
    const files = splitReplayText(text, maxBytes);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) expect(Buffer.byteLength(file)).toBeLessThanOrEqual(maxBytes);
    expect(sha256(replayFromText(joinReplayText(files)))).toBe(fixture.sha256);
  }
  for (const file of splitReplayText(text)) expect(file.startsWith('["tick",')).toBe(true);
});

it("serves Watch's top matches as the shipped list's own matches, with no test match among them", async () => {
  const fixtures = await readFixtures([FIXTURES]);
  const top = fixtures["/matches/top"]!;
  const { matches } = JSON.parse(top.bytes!.toString("utf8")) as { matches: { id: string; matchType: { kind: string } | null }[] };
  expect(matches.map(m => m.id)).toEqual(shippedTopMatchList().ids);
  for (const m of matches) {
    expect(m.matchType?.kind).not.toBe("test");
    expect(TEST_BACKFILL_IDS).not.toContain(m.id);
  }
});
