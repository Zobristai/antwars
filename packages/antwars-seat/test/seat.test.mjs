import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { rpcReply } from "../lib/mcp.mjs";
import { DEFAULT_MAX_WAIT_MS, WAIT_URL_NEXT } from "../lib/seat.mjs";
import { fakeClock, freshShell, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-test-0f3c9a7e51d2";
const KEY_NAME = "ANTWARS_HOUSE_TEST_SEAT";
const BIN = fileURLToPath(new URL("../bin/antwars-seat", import.meta.url));
const run = promisify(execFile);

// Every case except the two real-clock ones, which set their own limits, runs on fake time and takes
// well under a second here; on a heavily loaded machine vitest's default 5 s per case was too short.
vi.setConfig({ testTimeout: 60_000 });

const seats = [];
const commands = [];
afterEach(async () => {
  // Vitest does not stop a case's command when the case fails or runs past its timeout, so it can
  // still be running here. Closing the case's fake makes it fail at once on fake time; waiting for
  // it while this case's output capture is still installed keeps whatever it prints out of a later
  // case's capture (as handover-retry.test.mjs does).
  for (const seat of seats) await seat.fake.close();
  await Promise.allSettled(commands.splice(0));
  for (const seat of seats.splice(0)) rmSync(seat.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function seat(fakeOptions = {}, { setup = [] } = {}) {
  const clock = fakeClock();
  const fake = await startFake({ key: KEY, clock, ...fakeOptions, baseline: typeof fakeOptions.baseline === "function" ? fakeOptions.baseline(clock) : fakeOptions.baseline });
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-"));
  writeFileSync(join(dir, "keys.env"), `OTHER_KEY="sk-other"\n${KEY_NAME}=${JSON.stringify(KEY)}\n`);
  const env = { ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: fake.url,
    ANTWARS_MIN_CALL_MS: "600", ANTWARS_POLL_MS: "3000" };
  seats.push({ fake, dir });
  const printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  const cli = (...argv) => {
    const command = main(argv, { env, clock, readStat: freshShell() });
    commands.push(command);
    return command;
  };
  expect(await cli("setup", "--handle", "antwars/test", "--key-name", KEY_NAME, "--mode", "house-1v1",
    "--model-label", "claude-opus-5-5", "--thinking-level", "max", ...setup)).toBe(0);
  const state = (name) => JSON.parse(readFileSync(join(dir, "state", name), "utf8"));
  return { clock, fake, dir, env, cli, printed, state };
}

/** go stopped with step failed and "handle in use", before any join_queue, locate_match or join. */
function expectHandleInUse(s) {
  expect(s.printed.join("")).toContain("handle in use");
  const status = s.state("status.json");
  expect(status.step).toBe("failed");
  expect(status.error).toContain("handle in use");
  for (const tool of ["join_queue", "locate_match", "join"]) expect(s.fake.toolCalls(tool)).toHaveLength(0);
}

/** go or join-lobby finished in the open nest window: step joined with closesAt and box, and no pick_nest call. */
function expectStoppedInNestWindow(s) {
  expect(s.fake.toolCalls("pick_nest")).toHaveLength(0);
  expect(s.fake.picked()).toBeNull();
  const status = s.state("status.json");
  expect(status).toMatchObject({ step: "joined", box: { x: 2, y: 0, width: 3, height: 3 } });
  expect(Number.isFinite(Date.parse(status.closesAt))).toBe(true);
  expect(status.next).toContain("pick_nest --json");
}

function stateText(dir) {
  const root = join(dir, "state");
  return readdirSync(root).map((name) => readFileSync(join(root, name), "utf8")).join("\n");
}

describe("go: queue, pair, join, stop in the nest window", () => {
  it("waits a little past the server's 12-hour queue expiry by default, so the server ends an unpaired wait", () => {
    expect(DEFAULT_MAX_WAIT_MS).toBeGreaterThan(12 * 60 * 60 * 1000);
    expect(DEFAULT_MAX_WAIT_MS).toBeLessThanOrEqual(12.5 * 60 * 60 * 1000);
  });

  it("with no ANTWARS_MAX_WAIT_MS, waits almost 12 hours for a pairing on one join, with no rejoin", async () => {
    const s = await seat({ pairAfterMs: 12 * 60 * 60 * 1000 - 60_000 });
    s.env.ANTWARS_POLL_MS = "600000";
    const start = s.clock.now();
    expect(await s.cli("go")).toBe(0);
    expect(s.clock.now() - start).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000 - 60_000);
    expect(s.fake.toolCalls("join_queue")).toHaveLength(1);
    expect(s.state("match.json").lobbyId).toBe("fresh-lobby");
    expectStoppedInNestWindow(s);
  });

  it("waits for a pairing that arrives after 118 s, compares numeric matchedAt and joins the queue once", async () => {
    const s = await seat({ pairAfterMs: 130_000 });
    const start = s.clock.now();
    expect(await s.cli("go")).toBe(0);
    expect(s.clock.now() - start).toBeGreaterThanOrEqual(130_000);
    expect(s.fake.toolCalls("join_queue")).toHaveLength(1);
    const match = s.state("match.json");
    expect(match.lobbyId).toBe("fresh-lobby");
    expect(typeof match.matchedAt).toBe("number");
    const join = s.fake.toolCalls("join")[0].args;
    expect(join).toEqual({ key: KEY, seat: 1, modelLabel: "claude-opus-5-5", thinkingLevel: "max" });
    expectStoppedInNestWindow(s);
  });

  it("finishes at joined with closesAt and box, never calls pick_nest, and status shows it finished", async () => {
    const s = await seat({ pairAfterMs: 0 });
    s.printed.length = 0;
    expect(await s.cli("go")).toBe(0);
    // The wait link is printed when it is saved, then the final result last.
    const result = JSON.parse(s.printed.join("").trim().split("\n").at(-1));
    expect(result).toMatchObject({ step: "joined", box: { x: 2, y: 0, width: 3, height: 3 } });
    expect(typeof result.closesAt).toBe("string");
    expectStoppedInNestWindow(s);
    // The join itself also writes step joined, but with closesAt and box null: only the final status carries them.
    const joinedLines = readFileSync(join(s.dir, "state", "progress.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.step === "joined");
    expect(joinedLines).toHaveLength(2);
    expect(joinedLines[0]).toMatchObject({ closesAt: null, box: null, agentId: "agent-1" });
    expect(joinedLines[1].closesAt).toBe(result.closesAt);
    s.printed.length = 0;
    expect(await s.cli("status")).toBe(0);
    expect(JSON.parse(s.printed[0])).toMatchObject({ step: "joined", closesAt: result.closesAt, box: result.box, goRunning: false });
  });

  it("the agent picks its own nest after go with pick_nest --json, and the call is accepted", async () => {
    const s = await seat({ pairAfterMs: 0 });
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("pick_nest")).toHaveLength(0);
    s.printed.length = 0;
    expect(await s.cli("pick_nest", "--json", "{\"tileX\":3,\"tileY\":1}")).toBe(0);
    expect(s.fake.toolCalls("pick_nest").map((c) => c.args)).toEqual([{ tileX: 3, tileY: 1 }]);
    expect(s.fake.picked()).toEqual({ tileX: 3, tileY: 1 });
    expect(s.printed.join("")).toContain("\"accepted\":true");
  });

  it("a match that starts with no open nest window is reported as before, with no pick", async () => {
    const s = await seat({ pairAfterMs: 0, noNestWindow: true });
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("pick_nest")).toHaveLength(0);
    expect(s.state("status.json")).toMatchObject({ step: "ready", nest: null, note: "match started without an open nest window" });
  });

  it("stops with \"handle in use\" over a waiting entry it did not create, and calls nothing else", async () => {
    const s = await seat({ pairAfterMs: 60_000, baseline: (clock) => ({ state: "waiting", mode: "house-1v1", joinedAt: clock.now() - 10_000, expiresAt: clock.now() + 890_000 }) });
    expect(await s.cli("go")).toBe(1);
    expectHandleInUse(s);
  });

  it("stops with \"handle in use\" over another run's live pairing, and calls nothing else", async () => {
    const s = await seat({ baseline: (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "live", matchedAt: clock.now() - 5000 }), lobbies: { live: "holding" } });
    expect(await s.cli("go")).toBe(1);
    expectHandleInUse(s);
    expect(s.fake.toolCalls("read_lobby")).toHaveLength(1);
  });

  it("re-running go over a waiting entry it created itself waits on that entry without queuing again", async () => {
    const s = await seat({ pairAfterMs: 120_000 });
    s.env.ANTWARS_MAX_WAIT_MS = "30000";
    expect(await s.cli("go")).toBe(1);
    expect(s.printed.join("")).toContain("No pairing after");
    delete s.env.ANTWARS_MAX_WAIT_MS;
    s.printed.length = 0;
    expect(await s.cli("go")).toBe(0);
    expect(s.printed.join("")).not.toContain("handle in use");
    expect(s.fake.toolCalls("join_queue")).toHaveLength(1);
    expect(s.state("match.json").lobbyId).toBe("fresh-lobby");
  });

  it("re-running go after its own entry was matched joins that pairing without queuing again", async () => {
    const s = await seat({ pairAfterMs: 120_000 });
    s.env.ANTWARS_MAX_WAIT_MS = "30000";
    expect(await s.cli("go")).toBe(1);
    delete s.env.ANTWARS_MAX_WAIT_MS;
    await s.clock.sleep(200_000);
    s.printed.length = 0;
    expect(await s.cli("go")).toBe(0);
    expect(s.printed.join("")).not.toContain("handle in use");
    expect(s.fake.toolCalls("join_queue")).toHaveLength(1);
    expect(s.state("match.json").lobbyId).toBe("fresh-lobby");
    expect(s.fake.toolCalls("join")).toHaveLength(1);
  });

  it("ignores a stale matched entry whose lobby has ended, queues once and joins the new pairing", async () => {
    const s = await seat({ pairAfterMs: 20_000, baseline: (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "old", matchedAt: clock.now() - 3_600_000 }), lobbies: { old: "ended" } });
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("join_queue")).toHaveLength(1);
    expect(s.state("match.json").lobbyId).toBe("fresh-lobby");
    expect(s.fake.toolCalls("locate_match").map((c) => c.args.lobbyId)).toEqual(["fresh-lobby"]);
  });

  it("a refused read_lobby on a pairing that arrives while waiting is checked again, not ignored, and the lobby is joined", async () => {
    const s = await seat({ pairAfterMs: 30_000, refuseReadLobby: 1 });
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("join_queue")).toHaveLength(1);
    expect(s.fake.toolCalls("read_lobby").length).toBeGreaterThanOrEqual(2);
    expect(s.state("match.json").lobbyId).toBe("fresh-lobby");
    const log = readFileSync(join(s.dir, "state", "progress.log"), "utf8");
    expect(log).toContain("lobby_read_failed");
    expect(log).not.toContain("stale_pairing_ignored");
  });

  it.each([
    ["refused", { refuseReadLobby: 1 }],
    ["failed over HTTP", { failReadLobbyHttp: 1 }],
  ])("a matched baseline it did not pair for, whose read_lobby is %s, stops with \"handle in use\"", async (_, readFailure) => {
    const s = await seat({ baseline: (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "old", matchedAt: clock.now() - 3_600_000 }), lobbies: { old: "ended" }, pairAfterMs: 10_000, ...readFailure });
    expect(await s.cli("go")).toBe(1);
    expectHandleInUse(s);
    expect(s.state("status.json").error).toContain("not readable");
  });

  it("a non-queuing seat stops with \"handle in use\" over a live pairing matched before its ready time", async () => {
    const s = await seat({ baseline: (clock) => ({ state: "matched", mode: "house-2v2", lobbyId: "live", matchedAt: clock.now() - 5000 }), lobbies: { live: "holding" } },
      { setup: ["--seat", "2"] });
    expect(s.state("config.json").queuing).toBe(false);
    expect(await s.cli("go")).toBe(1);
    expectHandleInUse(s);
  });

  it("a non-queuing seat joins a pairing matched exactly at its ready time, recorded once at setup", async () => {
    const s = await seat({ baseline: (clock) => ({ state: "matched", mode: "house-2v2", lobbyId: "live", matchedAt: clock.now() }), lobbies: { live: "holding" } },
      { setup: ["--seat", "2"] });
    const readyAt = s.state("seat.json").readyAt;
    expect(typeof readyAt).toBe("number");
    await s.clock.sleep(60_000);
    expect(await s.cli("go")).toBe(0);
    expect(s.state("seat.json").readyAt).toBe(readyAt);
    expect(s.state("match.json")).toMatchObject({ lobbyId: "live", matchedAt: readyAt });
    expect(s.fake.toolCalls("join_queue")).toHaveLength(0);
    expect(s.fake.toolCalls("join")[0].args).toMatchObject({ seat: 2 });
  });

  it("refuses a second concurrent go for the same seat, so it cannot queue again", async () => {
    const s = await seat({ pairAfterMs: 0 });
    writeFileSync(join(s.dir, "state", "go.lock"), JSON.stringify({ pid: process.ppid }));
    expect(await s.cli("go")).toBe(1);
    expect(s.printed.join("")).toContain("go is already running");
    expect(s.fake.toolCalls("join_queue")).toHaveLength(0);
  });

  it("a non-queuing seat waits for its handle's pairing and joins its own seat without queuing", async () => {
    const s = await seat({ pairAfterMs: 45_000, baseline: (clock) => ({ state: "waiting", mode: "house-2v2", joinedAt: clock.now(), expiresAt: clock.now() + 900_000 }) },
      { setup: ["--seat", "2", "--service-tier", "fast"] });
    expect(s.state("config.json").queuing).toBe(false);
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("join_queue")).toHaveLength(0);
    expect(s.fake.toolCalls("join")[0].args).toMatchObject({ seat: 2, serviceTier: "fast" });
  });

  it("seat 1 of a key holding several seats (house-4v4) joins with seat 1 instead of being refused seat_required", async () => {
    const s = await seat({ pairAfterMs: 0, seatsHeld: 4 }, { setup: ["--mode", "house-4v4"] });
    expect(s.state("config.json")).toMatchObject({ mode: "house-4v4", seat: 1, queuing: true });
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("join").map((c) => c.args.seat)).toEqual([1]);
    expectStoppedInNestWindow(s);
  });

  it("retries lobby_loading after retryAfterMs and handles SSE replies", async () => {
    const s = await seat({ pairAfterMs: 0, lobbyLoading: 2, sse: true });
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("join")).toHaveLength(3);
    expectStoppedInNestWindow(s);
  });

  it("spaces calls at least 600 ms apart", async () => {
    const s = await seat({ pairAfterMs: 0 });
    expect(await s.cli("go")).toBe(0);
    const times = s.fake.calls.filter((c) => c.tool).map((c) => c.at);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(600);
  });
});

/** Every status.json the seat writes, as seen after each fake-clock advance (each poll and call spacing). */
function recordStatuses(s) {
  const seen = [];
  s.clock.onAdvance(() => {
    const file = join(s.dir, "state", "status.json");
    if (existsSync(file)) seen.push(JSON.parse(readFileSync(file, "utf8")));
  });
  return seen;
}

const IGNORED_TOP_LEVEL = ["lobbyId", "matchedAt", "lobbyState"];

describe("status: only this run's own progress", () => {
  it("after ignoring a stale ended pairing, joined_queue and waiting show it only as ignoredPairing; the own pairing fields reach the final status", async () => {
    const s = await seat({ pairAfterMs: 20_000, baseline: (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "old", matchedAt: clock.now() - 3_600_000 }), lobbies: { old: "ended" } });
    const seen = recordStatuses(s);
    expect(await s.cli("go")).toBe(0);
    const queuePhase = seen.filter((status) => status.step === "joined_queue" || status.step === "waiting");
    expect(queuePhase.filter((status) => status.step === "joined_queue").length).toBeGreaterThanOrEqual(1);
    expect(queuePhase.filter((status) => status.step === "waiting").length).toBeGreaterThanOrEqual(1);
    for (const status of queuePhase) {
      for (const field of IGNORED_TOP_LEVEL) expect(status).not.toHaveProperty(field);
      expect(status.ignoredPairing).toMatchObject({ lobbyId: "old", lobbyState: "ended" });
      expect(typeof status.ignoredPairing.matchedAt).toBe("number");
      expect(status).not.toHaveProperty("handle"); // setup's fields are not carried into a run
    }
    // The seat's own join: the queue object with its joinedAt at joined_queue; waiting reports the queue state.
    const joinedQueue = queuePhase.find((status) => status.step === "joined_queue");
    expect(joinedQueue.queue).toMatchObject({ state: "waiting" });
    expect(typeof joinedQueue.queue.joinedAt).toBe("number");
    expect(queuePhase.find((status) => status.step === "waiting")).toMatchObject({ queue: "waiting" });
    // From paired onward lobbyId and matchedAt are the seat's own pairing.
    const ownPhase = seen.slice(seen.findIndex((status) => status.step === "paired"));
    expect(ownPhase.length).toBeGreaterThanOrEqual(1);
    for (const status of ownPhase) {
      expect(status.lobbyId).toBe("fresh-lobby");
      expect(typeof status.matchedAt).toBe("number");
    }
    expectStoppedInNestWindow(s);
    const final = s.state("status.json");
    expect(final).toMatchObject({ step: "joined", lobbyId: "fresh-lobby", agentId: "agent-1", colony: "red" });
    expect(final.matchedAt).toBe(s.state("match.json").matchedAt);
  });

  it("a new go run carries none of an earlier join-lobby run's fields", async () => {
    const s = await seat();
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(0);
    expect(s.state("status.json")).toMatchObject({ step: "joined", lobbyId: "lobby-1", agentId: "agent-1" });
    s.env.ANTWARS_MAX_WAIT_MS = "10000"; // No pairing arrives: this go only queues and waits.
    const seen = recordStatuses(s);
    expect(await s.cli("go")).toBe(1);
    const run = seen.filter((status) => ["started", "baseline", "joined_queue", "waiting"].includes(status.step));
    expect(run.map((status) => status.step)).toEqual(expect.arrayContaining(["started", "joined_queue", "waiting"]));
    for (const status of [...run, s.state("status.json")]) {
      for (const field of ["lobbyId", "matchedAt", "lobbyState", "state", "mcpUrl", "spectatorUrl", "agentId", "colony", "closesAt", "box", "next"]) {
        expect(status).not.toHaveProperty(field);
      }
    }
    expect(s.state("status.json")).toMatchObject({ step: "failed", command: "go" });
  });

  it("a lobby that could not be read is recorded under lobbyReadFailed, so a pairing then found ended never appears as the seat's lobby", async () => {
    const s = await seat({ refuseReadLobby: 1, baseline: (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "old", matchedAt: clock.now() - 3_600_000 }), lobbies: { old: "ended" } });
    // The baseline is this seat's own earlier pairing (matched after its own join), so go checks it again instead of queuing.
    const seatFile = join(s.dir, "state", "seat.json");
    writeFileSync(seatFile, JSON.stringify({ ...s.state("seat.json"), ownJoinedAt: s.clock.now() - 3_700_000 }));
    const seen = recordStatuses(s);
    expect(await s.cli("go")).toBe(1);
    const failedRead = seen.find((status) => status.step === "lobby_read_failed");
    expect(failedRead.lobbyReadFailed).toMatchObject({ lobbyId: "old" });
    const ignored = readFileSync(join(s.dir, "state", "progress.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((line) => line.step === "stale_pairing_ignored");
    expect(ignored.ignoredPairing).toMatchObject({ lobbyId: "old", lobbyState: "ended" });
    const final = s.state("status.json");
    expect(final.step).toBe("failed");
    for (const field of IGNORED_TOP_LEVEL) expect(final).not.toHaveProperty(field);
  });
});

describe("unrated lobby: create-lobby, join-lobby", () => {
  const QUEUE_TOOLS = ["queue_status", "join_queue", "leave_queue"];

  it("create-lobby calls create_lobby once with the seat's key, size 1, public, prints the id and makes no queue call", async () => {
    const s = await seat();
    expect(await s.cli("create-lobby")).toBe(0);
    expect(s.fake.toolCalls("create_lobby").map((c) => c.args)).toEqual([{ key: KEY, size: 1, kind: "public" }]);
    expect(s.printed.join("")).toContain("\"lobbyId\":\"lobby-1\"");
    for (const tool of [...QUEUE_TOOLS, "join_lobby", "join"]) expect(s.fake.toolCalls(tool)).toHaveLength(0);
  });

  it("join-lobby calls join_lobby once, then locate_match and join as go, stops in the nest window without pick_nest, with no queue call; match commands then work", async () => {
    const s = await seat({ lobbyHoldsAfterLocates: 2, matchOverAfterObserves: 3 });
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(0);
    expect(s.fake.toolCalls("join_lobby").map((c) => c.args)).toEqual([{ key: KEY, lobbyId: "lobby-1" }]);
    expect(s.fake.toolCalls("locate_match").length).toBeGreaterThanOrEqual(3); // null mcpUrl until the lobby holds a slot
    expect(s.fake.toolCalls("join")[0].args).toEqual({ key: KEY, seat: 1, modelLabel: "claude-opus-5-5", thinkingLevel: "max" });
    const match = s.state("match.json");
    expect(match.lobbyId).toBe("lobby-1");
    expect(match.mcpUrl).toMatch(/\/match\/mcp$/);
    expectStoppedInNestWindow(s);
    const steps = readFileSync(join(s.dir, "state", "progress.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l).step);
    expect(steps).toContain("joined_lobby");
    expect(steps.indexOf("joined_lobby")).toBeLessThan(steps.indexOf("located"));
    expect(await s.cli("observe")).toBe(0);
    expect(await s.cli("order", "--ants", "[1]", "--tileX", "3", "--tileY", "1")).toBe(0);
    expect(s.fake.toolCalls("order")[0].args).toEqual({ ants: [1], tileX: 3, tileY: 1 });
    s.env.ANTWARS_DETACHED = "1";
    expect(await s.cli("observer", "start", "--interval", "60")).toBe(0);
    expect(s.state("observer.json").state).toBe("match_over");
    for (const tool of QUEUE_TOOLS) expect(s.fake.toolCalls(tool)).toHaveLength(0);
  });

  it("a refused join_lobby exits non-zero with its code and calls nothing after it", async () => {
    const s = await seat({ refuseJoinLobby: "full" });
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(1);
    expect(s.printed.join("")).toContain("join_lobby refused: full");
    expect(s.state("status.json").step).toBe("failed");
    for (const tool of [...QUEUE_TOOLS, "locate_match", "join", "pick_nest"]) expect(s.fake.toolCalls(tool)).toHaveLength(0);
    expect(existsSync(join(s.dir, "state", "match.json"))).toBe(false);
  });

  it("a join_lobby answered already_seated counts as seated: locate_match and join run with the same key and seat, and it stops in the nest window", async () => {
    const s = await seat({ refuseJoinLobby: "already_seated" });
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(0);
    expect(s.fake.toolCalls("join_lobby").map((c) => c.args)).toEqual([{ key: KEY, lobbyId: "lobby-1" }]);
    expect(s.fake.toolCalls("locate_match").map((c) => c.args)[0]).toEqual({ lobbyId: "lobby-1" });
    expect(s.fake.toolCalls("join").map((c) => c.args)).toEqual([{ key: KEY, seat: 1, modelLabel: "claude-opus-5-5", thinkingLevel: "max" }]);
    expect(s.state("match.json").lobbyId).toBe("lobby-1");
    expectStoppedInNestWindow(s);
    const joinedLobby = readFileSync(join(s.dir, "state", "progress.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.step === "joined_lobby");
    expect(joinedLobby).toMatchObject({ lobbyId: "lobby-1", alreadySeated: true });
    for (const tool of QUEUE_TOOLS) expect(s.fake.toolCalls(tool)).toHaveLength(0);
  });

  it("any other join_lobby refusal still fails with its code and calls nothing after it", async () => {
    const s = await seat({ refuseJoinLobby: "lobby_closed" });
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(1);
    expect(s.printed.join("")).toContain("join_lobby refused: lobby_closed");
    expect(s.state("status.json").step).toBe("failed");
    for (const tool of [...QUEUE_TOOLS, "locate_match", "join", "pick_nest"]) expect(s.fake.toolCalls(tool)).toHaveLength(0);
    expect(existsSync(join(s.dir, "state", "match.json"))).toBe(false);
  });

  it("join-lobby without a lobby id is a usage error", async () => {
    const s = await seat();
    expect(await s.cli("join-lobby")).toBe(1);
    expect(s.printed.join("")).toContain("usage: antwars-seat join-lobby <lobbyId>");
    expect(s.fake.toolCalls("join_lobby")).toHaveLength(0);
  });

  it("join-lobby --detach runs in the background and status follows it to joined in the nest window", async () => {
    const s = await seat();
    await s.cli("create-lobby");
    s.env.ANTWARS_MIN_CALL_MS = "50";
    expect(await s.cli("join-lobby", "lobby-1", "--detach")).toBe(0);
    expect(s.printed.join("")).toContain("join-lobby started detached");
    const deadline = Date.now() + 15_000;
    const finished = () => {
      if (!existsSync(join(s.dir, "state", "status.json"))) return false;
      const status = s.state("status.json");
      return status.step === "failed" || (status.step === "joined" && status.box !== null && status.box !== undefined && !existsSync(join(s.dir, "state", "go.lock")));
    };
    while (Date.now() < deadline && !finished()) await new Promise((resolve) => setTimeout(resolve, 100));
    expectStoppedInNestWindow(s);
    expect(s.state("match.json").lobbyId).toBe("lobby-1");
    for (const tool of QUEUE_TOOLS) expect(s.fake.toolCalls(tool)).toHaveLength(0);
  }, 20_000);
});

describe("leave", () => {
  it("leaves a waiting entry with one leave_queue call", async () => {
    const s = await seat({ baseline: (clock) => ({ state: "waiting", mode: "house-1v1", joinedAt: clock.now(), expiresAt: clock.now() + 900_000 }) });
    s.printed.length = 0;
    expect(await s.cli("leave")).toBe(0);
    expect(s.fake.toolCalls("queue_status")).toHaveLength(1);
    expect(s.fake.toolCalls("leave_queue")).toHaveLength(1);
    expect(JSON.parse(s.printed.join(""))).toMatchObject({ left: true, queue: { state: "none" } });
  });

  it.each([
    ["matched", (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "live", matchedAt: clock.now() })],
    ["expired", (clock) => ({ state: "expired", mode: "house-1v1", expiresAt: clock.now() })],
    ["none", undefined],
  ])("calls nothing and says so when the entry is %s", async (state, baseline) => {
    const s = await seat({ baseline, lobbies: { live: "holding" } });
    s.printed.length = 0;
    expect(await s.cli("leave")).toBe(0);
    expect(s.fake.toolCalls("leave_queue")).toHaveLength(0);
    expect(s.fake.calls.filter((c) => c.tool).map((c) => c.tool)).toEqual(["queue_status"]);
    expect(JSON.parse(s.printed.join(""))).toMatchObject({ left: false, queue: { state }, note: `nothing to leave: queue entry is ${state}` });
  });

  it("exits non-zero when queue_status is refused", async () => {
    const s = await seat();
    writeFileSync(join(s.dir, "keys.env"), `${KEY_NAME}="sk-wrong"\n`);
    expect(await s.cli("leave")).toBe(1);
    expect(s.fake.toolCalls("leave_queue")).toHaveLength(0);
    expect(s.printed.join("")).toContain("queue_status refused: invalid_key");
  });
});

describe("match commands", () => {
  it("observe prints the decoded map from one observe call with map:true; --raw prints the reply unchanged", async () => {
    const s = await seat({ pairAfterMs: 0 });
    await s.cli("go");
    s.printed.length = 0;
    const before = s.fake.calls.length;
    expect(await s.cli("observe")).toBe(0);
    expect(s.fake.calls.slice(before).map((c) => c.tool ?? c.method)).toEqual(["observe"]);
    expect(s.fake.toolCalls("observe").at(-1).args).toEqual({ map: true });
    const text = s.printed.join("");
    expect(text).toContain("cells tick 11: 3 tiles (complete)\nkey: ");
    expect(text).toContain("\ny0: 1-2f3\ny1: 5Qown30:7w4,8S2.5\n");
    expect(text).toContain("\ny0: 0-1\ny1: 4-6\n");
    expect(text).toContain('squad (1):\n{"antId":7,"tileX":5,"tileY":1,"hp":4000}');
    expect(text).toContain('marks (1):\n{"markId":3,"tileX":5,"tileY":1}');
    s.printed.length = 0;
    expect(await s.cli("observe", "--raw")).toBe(0);
    expect(s.fake.toolCalls("observe").at(-1).args).toEqual({});
    const raw = JSON.parse(s.printed.join(""));
    expect(raw.view.cells.data).toBe("7*2;18,0,n5c:7.iiq/8.bkt");
    expect(raw.view.territory).toBeUndefined();
    s.printed.length = 0;
    expect(await s.cli("observe", "--raw", "--map")).toBe(0);
    expect(JSON.parse(s.printed.join("")).view.territory.data).toBe("A3A=");
  });

  it("board makes exactly one observe call and no other game call, and prints the same view", async () => {
    const s = await seat({ pairAfterMs: 0 });
    await s.cli("go");
    expect(await s.cli("observe")).toBe(0);
    s.printed.length = 0;
    const before = s.fake.calls.length;
    expect(await s.cli("board")).toBe(0);
    expect(s.fake.calls.slice(before).map((c) => c.tool ?? c.method)).toEqual(["observe"]);
    expect(s.fake.toolCalls("observe").at(-1).args).toEqual({ map: true });
    expect(s.printed.join("")).toContain("\ny0: 1-2f3\ny1: 5Qown30:7w4,8S2.5\n");
  });

  it("observe says when more cells follow", async () => {
    const s = await seat({ pairAfterMs: 0, cellsMore: true });
    await s.cli("go");
    s.printed.length = 0;
    expect(await s.cli("board")).toBe(0);
    expect(s.printed.join("")).toContain("3 tiles shown; MORE CELLS FOLLOW, not shown: observe --cellsCursor snap:2");
  });

  it("tools, rules and per-tool calls make one call each", async () => {
    const s = await seat({ pairAfterMs: 0 });
    await s.cli("go");
    s.printed.length = 0;
    expect(await s.cli("order", "--ants", "[1,2]", "--tileX", "7", "--tileY", "1")).toBe(0);
    expect(s.fake.toolCalls("order").at(-1).args).toEqual({ ants: [1, 2], tileX: 7, tileY: 1 });
    expect(await s.cli("call", "order", '{"ants":[3]}')).toBe(0);
    expect(s.fake.toolCalls("order").at(-1).args).toEqual({ ants: [3] });
    expect(await s.cli("rules")).toBe(0);
    s.printed.length = 0;
    expect(await s.cli("tools")).toBe(0);
    expect(s.printed.join("")).toContain("order --ants --tileX? --tileY?");
  });

  it("re-initializes and re-joins when the MCP session is gone, then makes the call", async () => {
    const s = await seat({ pairAfterMs: 0 });
    await s.cli("go");
    s.fake.expireSessions();
    const before = s.fake.calls.length;
    expect(await s.cli("observe")).toBe(0);
    const after = s.fake.calls.slice(before).map((c) => c.tool ?? c.method);
    expect(after).toEqual(["initialize", "join", "observe"]);
    expect(s.state("status.json").step).toBe("rejoined");
  });

  it("re-joins seat 1 of a key holding several seats with seat 1 when the MCP session is gone", async () => {
    const s = await seat({ pairAfterMs: 0, seatsHeld: 4 }, { setup: ["--mode", "house-4v4"] });
    expect(await s.cli("go")).toBe(0);
    s.fake.expireSessions();
    expect(await s.cli("observe")).toBe(0);
    expect(s.fake.toolCalls("join").map((c) => c.args.seat)).toEqual([1, 1]);
    expect(s.state("status.json").step).toBe("rejoined");
  });
});

describe("observer", () => {
  it("observes every interval and exits on matchOver", async () => {
    const s = await seat({ pairAfterMs: 0, matchOverAfterObserves: 4 });
    await s.cli("go");
    const observesBefore = s.fake.toolCalls("observe").length;
    s.env.ANTWARS_DETACHED = "1";
    expect(await s.cli("observer", "start", "--interval", "60")).toBe(0);
    const observes = s.fake.toolCalls("observe").slice(observesBefore);
    expect(s.state("observer.json").state).toBe("match_over");
    for (let i = 1; i < observes.length; i++) expect(observes[i].at - observes[i - 1].at).toBeLessThanOrEqual(61_000);
  });

  it("retries a failed observe sooner, survives session expiry, and stops when told", async () => {
    const s = await seat({ pairAfterMs: 0, failObserves: 1 });
    await s.cli("go");
    s.env.ANTWARS_DETACHED = "1";
    let sleeps = 0;
    const sleep = s.clock.sleep;
    s.clock.sleep = async (ms) => {
      await sleep(ms);
      sleeps += 1;
      if (sleeps === 15) s.fake.expireSessions();
      if (sleeps === 200) await s.cli("observer", "stop");
    };
    const observesBefore = s.fake.toolCalls("observe").length;
    expect(await s.cli("observer", "start", "--interval", "60", "--retry", "10")).toBe(0);
    const observes = s.fake.toolCalls("observe").slice(observesBefore);
    expect(observes[1].at - observes[0].at).toBeLessThan(11_000);
    expect(observes[2].at - observes[1].at).toBeGreaterThanOrEqual(60_000);
    const status = s.state("observer.json");
    expect(status.state).toBe("stopped");
    expect(status.lastError).toBeNull();
    expect(s.fake.toolCalls("join").length).toBeGreaterThanOrEqual(2);
  });
});

describe("protocol and secrecy", () => {
  it("parses JSON and SSE replies", () => {
    const reply = { jsonrpc: "2.0", id: 7, result: { ok: true } };
    expect(rpcReply("application/json", JSON.stringify(reply), 7)).toEqual(reply);
    expect(rpcReply("text/event-stream", `: ping\r\n\r\nevent: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`, 7)).toEqual(reply);
  });

  it("never prints, logs or stores the key (real bin, real clock)", async () => {
    const fake = await startFake({ key: KEY, pairAfterMs: 0 });
    const dir = mkdtempSync(join(tmpdir(), "antwars-seat-bin-"));
    seats.push({ fake, dir });
    writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(KEY)}\n`);
    const env = { ...process.env, ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_ENTRY_URL: fake.url, ANTWARS_MIN_CALL_MS: "0", ANTWARS_POLL_MS: "20" };
    let output = "";
    const bin = async (...args) => {
      const result = await run(process.execPath, [BIN, ...args], { cwd: dir, env }).catch((error) => error);
      output += `${result.stdout}${result.stderr}`;
      return result;
    };
    await bin("setup", "--handle", "antwars/test", "--key-name", KEY_NAME, "--mode", "house-1v1", "--model-label", "m", "--thinking-level", "high");
    await bin("go");
    await bin("observe", "--raw");
    await bin("order", "--ants", "[1]");
    await bin("status");
    await bin("leave");
    expect(fake.toolCalls("order")).toHaveLength(1);
    expect(fake.toolCalls("queue_status").at(-1).args).toEqual({ key: KEY });
    expect(output).toContain("nothing to leave");
    expect(existsSync(join(dir, ".antwars-seat", "state", "status.json"))).toBe(true);
    expect(output).toContain("\"step\":\"joined\"");
    expect(fake.toolCalls("pick_nest")).toHaveLength(0);
    expect(output).not.toContain(KEY);
    expect(stateText(join(dir, ".antwars-seat"))).not.toContain(KEY);
  }, 30_000);
});

describe("wait link: go and join-lobby save and print the waitUrl, wait-url reads it back", () => {
  const printedLines = (s) => s.printed.join("").trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  async function waitUrlCommand(s) {
    s.printed.length = 0;
    const code = await s.cli("wait-url");
    return { code, printed: s.printed.join("") };
  }

  it("go saves join_queue's waitUrl in seat.json, prints it at once and in its result, and wait-url prints it", async () => {
    const s = await seat({ pairAfterMs: 130_000 });
    s.printed.length = 0;
    expect(await s.cli("go")).toBe(0);
    const waitUrl = `${s.fake.url.replace(/\/mcp$/, "")}/wait/queue-wait-1`;
    const lines = printedLines(s);
    expect(lines[0]).toEqual({ step: "wait_link", waitUrl, waitFrom: "join_queue", next: WAIT_URL_NEXT });
    expect(lines.at(-1)).toMatchObject({ step: "joined", waitUrl });
    expect(s.state("seat.json")).toMatchObject({ waitUrl, waitToken: "queue-wait-1", waitFrom: "join_queue" });
    expect(typeof s.state("seat.json").waitSavedAt).toBe("string");
    // Printed once: the later queue_status polls carry the same link.
    expect(lines.filter((line) => line.step === "wait_link")).toHaveLength(1);
    const read = await waitUrlCommand(s);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.printed)).toEqual({ waitUrl, waitToken: "queue-wait-1", waitFrom: "join_queue", waitSavedAt: s.state("seat.json").waitSavedAt, next: WAIT_URL_NEXT });
  });

  it("go adopting this seat's own waiting entry takes the link from queue_status", async () => {
    const s = await seat({ pairAfterMs: 60_000, baseline: (clock) => ({ state: "waiting", mode: "house-1v1", joinedAt: clock.now() - 1000, expiresAt: clock.now() + 899_000, waitToken: "queue-wait-adopted" }) });
    const seatFile = join(s.dir, "state", "seat.json");
    writeFileSync(seatFile, JSON.stringify({ ...s.state("seat.json"), ownJoinedAt: s.clock.now() - 1000 }));
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("join_queue")).toHaveLength(0);
    expect(s.state("seat.json")).toMatchObject({ waitToken: "queue-wait-adopted", waitFrom: "queue_status" });
    expect(JSON.parse((await waitUrlCommand(s)).printed).waitUrl).toMatch(/\/wait\/queue-wait-adopted$/);
  });

  it("a non-queuing seat, which never joins, takes its handle's link from queue_status", async () => {
    const s = await seat({ baseline: (clock) => ({ state: "matched", mode: "house-2v2", lobbyId: "live", matchedAt: clock.now(), waitToken: "queue-wait-partner" }), lobbies: { live: "holding" } },
      { setup: ["--seat", "2"] });
    expect(await s.cli("go")).toBe(0);
    expect(s.fake.toolCalls("join_queue")).toHaveLength(0);
    expect(s.state("seat.json")).toMatchObject({ waitToken: "queue-wait-partner", waitFrom: "queue_status" });
  });

  it("go never saves or prints a stale baseline's link: only the link of the entry it queued and was paired on", async () => {
    const s = await seat({ pairAfterMs: 20_000, lobbies: { old: "ended" },
      baseline: (clock) => ({ state: "matched", mode: "house-1v1", lobbyId: "old", matchedAt: clock.now() - 3_600_000, waitToken: "queue-wait-stale" }) });
    s.printed.length = 0;
    expect(await s.cli("go")).toBe(0);
    expect(s.state("match.json").lobbyId).toBe("fresh-lobby");
    expect(s.printed.join("")).not.toContain("queue-wait-stale");
    const saved = readFileSync(join(s.dir, "state", "progress.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.step === "wait_link");
    expect(saved.map((line) => line.waitUrl)).toEqual([expect.stringMatching(/\/wait\/queue-wait-1$/)]);
    expect(s.state("seat.json")).toMatchObject({ waitToken: "queue-wait-1", waitFrom: "join_queue" });
  });

  it.each([
    ["refused", { refuseReadLobby: 1 }],
    ["failed over HTTP", { failReadLobbyHttp: 1 }],
  ])("already_seated, a first read_lobby that %s is retried until one returns the link, which wait-url then reads", async (_, readFailure) => {
    const s = await seat({ refuseJoinLobby: "already_seated", ...readFailure });
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(0);
    expect(s.fake.toolCalls("read_lobby").length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(s.dir, "state", "progress.log"), "utf8")).toContain("wait_link_read_failed");
    expect(s.state("seat.json")).toMatchObject({ waitToken: "lobby-wait-lobby-1", waitFrom: "read_lobby" });
    expect(s.state("status.json")).toMatchObject({ step: "joined" });
    const read = await waitUrlCommand(s);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.printed).waitUrl).toMatch(/\/wait\/lobby-wait-lobby-1$/);
  });

  it("join-lobby saves join_lobby's link; answered already_seated, it takes the seat's link from read_lobby", async () => {
    const s = await seat();
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(0);
    expect(s.state("seat.json")).toMatchObject({ waitToken: "lobby-wait-lobby-1", waitFrom: "join_lobby" });
    expect(printedLines(s).find((line) => line.step === "wait_link")).toMatchObject({ waitFrom: "join_lobby" });

    const seated = await seat({ refuseJoinLobby: "already_seated" });
    await seated.cli("create-lobby");
    expect(await seated.cli("join-lobby", "lobby-1")).toBe(0);
    expect(seated.fake.toolCalls("read_lobby").map((c) => c.args)[0]).toEqual({ lobbyId: "lobby-1", key: KEY });
    expect(seated.state("seat.json")).toMatchObject({ waitToken: "lobby-wait-lobby-1", waitFrom: "read_lobby" });
    expect(JSON.parse((await waitUrlCommand(seated)).printed)).toMatchObject({ waitToken: "lobby-wait-lobby-1", waitFrom: "read_lobby" });
  });

  it("wait-url with no saved link exits non-zero and says how to get one; a new run replaces an earlier run's link", async () => {
    const s = await seat({ pairAfterMs: 0 });
    const none = await waitUrlCommand(s);
    expect(none.code).toBe(1);
    expect(none.printed).toContain("No wait link saved: run go or join-lobby first");
    await s.cli("create-lobby");
    expect(await s.cli("join-lobby", "lobby-1")).toBe(0);
    expect(s.state("seat.json").waitFrom).toBe("join_lobby");
    expect(await s.cli("go")).toBe(0);
    expect(s.state("seat.json")).toMatchObject({ waitToken: "queue-wait-1", waitFrom: "join_queue" });
    expect(s.state("seat.json").readyAt).toEqual(expect.any(Number));
  });

  it("help names wait-url", async () => {
    const s = await seat();
    s.printed.length = 0;
    expect(await s.cli("help")).toBe(0);
    expect(s.printed.join("")).toMatch(/wait-url +the waitUrl go or join-lobby saved/);
  });
});
