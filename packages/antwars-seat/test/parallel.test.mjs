// setup --parallel: several opted-in seats of one handle, each in its own state dir,
// each in its own live match. Seats that do not opt in are covered, unchanged, by seat.test.mjs.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { fakeClock, freshShell, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-test-0f3c9a7e51d2";
const KEY_NAME = "ANTWARS_HOUSE_TEST_SEAT";
const SETUP = ["setup", "--handle", "antwars/test", "--key-name", KEY_NAME, "--mode", "house-1v1", "--model-label", "gpt-6-1-terra-max-fast", "--thinking-level", "max"];

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()();
});

/** One fake server and clock shared by every seat of the handle; each seat gets its own state dir. */
async function handle(fakeOptions = {}) {
  const clock = fakeClock();
  const fake = await startFake({ key: KEY, clock, distinctLobbies: true, ...fakeOptions, baseline: typeof fakeOptions.baseline === "function" ? fakeOptions.baseline(clock) : fakeOptions.baseline });
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-parallel-"));
  writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(KEY)}\n`);
  cleanups.push(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });
  const printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  const seat = async (name, setup = ["--parallel"]) => {
    const env = { ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, name), ANTWARS_ENTRY_URL: fake.url, ANTWARS_MIN_CALL_MS: "600", ANTWARS_POLL_MS: "3000" };
    const cli = (...argv) => main(argv, { env, clock, readStat: freshShell() });
    const state = (file) => JSON.parse(readFileSync(join(dir, name, file), "utf8"));
    return { env, cli, state, setupExit: await cli(...SETUP, ...setup) };
  };
  return { clock, fake, printed, seat };
}

const matchPaths = (fake, tool) => fake.toolCalls(tool).filter((c) => c.server === "match").map((c) => c.path);

describe("setup --parallel", () => {
  it("two opted-in seats of one handle each join their own distinct match, and each seat's commands reach only its own", async () => {
    const h = await handle({ pairAfterMs: 30_000 });
    const a = await h.seat("a");
    expect(a.setupExit).toBe(0);
    expect(a.state("config.json").parallel).toBe(true);
    expect(await a.cli("go")).toBe(0);
    expect(a.state("match.json").lobbyId).toBe("fresh-lobby-1");

    // Started after a reports joined in the nest window: its first queue_status shows a's matched entry, whose lobby is live.
    const b = await h.seat("b");
    const bStatuses = [];
    h.clock.onAdvance(() => {
      const file = join(b.env.ANTWARS_SEAT_STATE, "status.json");
      if (existsSync(file)) bStatuses.push(JSON.parse(readFileSync(file, "utf8")));
    });
    expect(await b.cli("go")).toBe(0);
    expect(h.printed.join("")).not.toContain("handle in use");
    const bWaiting = bStatuses.filter((status) => status.step === "joined_queue" || status.step === "waiting");
    expect(bWaiting.length).toBeGreaterThanOrEqual(2);
    for (const status of bWaiting) for (const field of ["lobbyId", "matchedAt", "lobbyState"]) expect(status).not.toHaveProperty(field);
    expect(b.state("match.json").lobbyId).toBe("fresh-lobby-2");
    expect(h.fake.toolCalls("join_queue")).toHaveLength(2);
    expect(readFileSync(join(b.env.ANTWARS_SEAT_STATE, "progress.log"), "utf8")).toContain("other_run_pairing_ignored");
    // b's status never showed a's live lobby as its own: only as ignoredPairing.
    const bLog = readFileSync(join(b.env.ANTWARS_SEAT_STATE, "progress.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(bLog.find((line) => line.step === "other_run_pairing_ignored").ignoredPairing).toMatchObject({ lobbyId: "fresh-lobby-1", lobbyState: "holding" });
    expect(b.state("status.json")).toMatchObject({ lobbyId: "fresh-lobby-2", ignoredPairing: { lobbyId: "fresh-lobby-1" } });
    expect(a.state("status.json")).toMatchObject({ step: "joined", box: { x: 2, y: 0, width: 3, height: 3 } });
    expect(b.state("status.json")).toMatchObject({ step: "joined", box: { x: 2, y: 0, width: 3, height: 3 } });
    expect(matchPaths(h.fake, "join")).toEqual(["/match/fresh-lobby-1/mcp", "/match/fresh-lobby-2/mcp"]);
    expect(h.fake.toolCalls("pick_nest")).toHaveLength(0);

    expect(await a.cli("observe")).toBe(0);
    expect(await b.cli("observe")).toBe(0);
    expect(await a.cli("observe")).toBe(0);
    expect(matchPaths(h.fake, "observe")).toEqual(["/match/fresh-lobby-1/mcp", "/match/fresh-lobby-2/mcp", "/match/fresh-lobby-1/mcp"]);
  });

  it("without --parallel the second seat still stops with \"handle in use\" over the first seat's live match", async () => {
    const h = await handle({ pairAfterMs: 30_000 });
    const a = await h.seat("a");
    expect(await a.cli("go")).toBe(0);
    const b = await h.seat("b", []);
    expect(b.state("config.json").parallel).toBeUndefined();
    expect(await b.cli("go")).toBe(1);
    expect(b.state("status.json").error).toContain("handle in use");
    expect(h.fake.toolCalls("join_queue")).toHaveLength(1);
  });

  it("an opted-in seat over a waiting entry it did not create still stops with \"handle in use\" and calls nothing else", async () => {
    const h = await handle({ pairAfterMs: 60_000, baseline: (clock) => ({ state: "waiting", mode: "house-1v1", joinedAt: clock.now() - 10_000, expiresAt: clock.now() + 890_000 }) });
    const a = await h.seat("a");
    expect(await a.cli("go")).toBe(1);
    expect(a.state("status.json")).toMatchObject({ step: "failed" });
    expect(a.state("status.json").error).toContain("handle in use");
    for (const tool of ["join_queue", "locate_match", "join"]) expect(h.fake.toolCalls(tool)).toHaveLength(0);
  });

  it("an opted-in seat over another run's matched entry whose lobby cannot be read still stops with \"handle in use\"", async () => {
    const h = await handle({ refuseReadLobby: 1, baseline: (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "live", matchedAt: clock.now() - 5000 }), lobbies: { live: "holding" } });
    const a = await h.seat("a");
    expect(await a.cli("go")).toBe(1);
    expect(a.state("status.json").error).toContain("not readable");
    for (const tool of ["join_queue", "locate_match", "join"]) expect(h.fake.toolCalls(tool)).toHaveLength(0);
  });

  it("an opted-in seat's leave never removes another seat's waiting entry; the seat that created it can leave", async () => {
    const h = await handle({ pairAfterMs: 30_000 });
    const a = await h.seat("a");
    expect(await a.cli("go")).toBe(0);
    const b = await h.seat("b");
    b.env.ANTWARS_MAX_WAIT_MS = "10000"; // b's entry is still waiting when its go gives up.
    expect(await b.cli("go")).toBe(1);
    h.printed.length = 0;
    expect(await a.cli("leave")).toBe(0);
    expect(h.fake.toolCalls("leave_queue")).toHaveLength(0);
    expect(JSON.parse(h.printed.join(""))).toMatchObject({ left: false, queue: { state: "waiting" }, note: "nothing to leave: the waiting entry was not created by this seat" });
    h.printed.length = 0;
    expect(await b.cli("leave")).toBe(0);
    expect(h.fake.toolCalls("leave_queue")).toHaveLength(1);
    expect(JSON.parse(h.printed.join(""))).toMatchObject({ left: true, queue: { state: "none" } });
  });

  it("is refused on a non-queuing seat", async () => {
    const h = await handle();
    const s = await h.seat("s", ["--seat", "2", "--parallel"]);
    expect(s.setupExit).toBe(1);
    expect(h.printed.join("")).toContain("--parallel is for a queuing seat only");
  });
});
