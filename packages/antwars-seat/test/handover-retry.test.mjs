// During a server handover the match client keeps a
// seat call retrying for up to 60 s through 503, 429, timeouts and refused
// connections, including on a reconnect's initialize and re-join, then
// completes it in the same seat. Past 60 s, and for other HTTP 4xx answers,
// the error is reported as today: lib/mcp.mjs throws `${method} failed: HTTP
// ${status}` for a non-OK answer and lets fetch's own timeout and network
// errors through, and
// the CLI prints `antwars-seat <command>: <message>` and exits 1.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { fakeClock, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-test-5b21c7d09e44";
const KEY_NAME = "ANTWARS_HOUSE_TEST_SEAT";

// Every case runs on fake time and takes well under a second here; on a heavily loaded machine
// vitest's default 5 s per case was too short.
vi.setConfig({ testTimeout: 60_000 });

const seats = [];
const commands = [];
afterEach(async () => {
  // Vitest does not stop a case's command when the case fails or runs past its timeout, so it can
  // still be running here. Closing the case's fake makes it fail at once on fake time; waiting for
  // it while this case's output capture is still installed keeps whatever it prints out of a later
  // case's capture.
  for (const seat of seats) await seat.fake.close();
  await Promise.allSettled(commands.splice(0));
  for (const seat of seats.splice(0)) rmSync(seat.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A seat that has run go against the fake and holds its seat on the fake match server. */
async function joinedSeat(fakeOptions = {}) {
  const clock = fakeClock();
  const fake = await startFake({ key: KEY, clock, pairAfterMs: 0, ...fakeOptions });
  const dir = mkdtempSync(join(tmpdir(), "antwars-handover-"));
  writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(KEY)}\n`);
  const env = { ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: fake.url,
    ANTWARS_MIN_CALL_MS: "600", ANTWARS_POLL_MS: "3000" };
  seats.push({ fake, dir });
  const printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  const cli = (...argv) => {
    const command = main(argv, { env, clock });
    commands.push(command);
    return command;
  };
  expect(await cli("setup", "--handle", "antwars/test", "--key-name", KEY_NAME, "--mode", "house-1v1",
    "--model-label", "claude-opus-5-5", "--thinking-level", "max")).toBe(0);
  expect(await cli("go")).toBe(0);
  const state = (name) => JSON.parse(readFileSync(join(dir, "state", name), "utf8"));
  return { clock, fake, cli, printed, state };
}

/** One agent command: exit code, fake time taken, everything printed, and the requests the fake answered normally. */
async function run(s, ...argv) {
  s.printed.length = 0;
  const before = s.fake.calls.length;
  const start = s.clock.now();
  const exit = await s.cli(...argv);
  return { exit, elapsedMs: s.clock.now() - start, output: s.printed.join(""), calls: s.fake.calls.slice(before).map((c) => c.tool ?? c.method) };
}

/** The observe view as the fake's joined session answers it; a session that has not joined is answered not_joined. */
function expectSeatView(output) {
  expect(JSON.parse(output)).toMatchObject({ view: { colony: 0, squad: [{ antId: 7 }] } });
}

// [what the server does, fake outage, today's error message when a tools/call meets it]
const OUTAGES = [
  ["answers HTTP 503", { status: 503 }, "tools/call failed: HTTP 503"],
  ["answers HTTP 429", { status: 429 }, "tools/call failed: HTTP 429"],
  ["times out", { hold: true }, "The operation was aborted due to timeout"],
  ["refuses connections", { refuse: true }, "fetch failed"],
];

describe.each(OUTAGES)("while the match server %s", (_label, outage, todayError) => {
  it("a seat call keeps retrying and, once the server answers within 60 s, completes in the same seat with no error", async () => {
    const s = await joinedSeat();
    s.fake.outage({ ...outage, ms: 45_000 });
    const r = await run(s, "observe", "--raw");
    expect(r.exit).toBe(0);
    expectSeatView(r.output);
    expect(r.calls).toEqual(["observe"]);
    expect(s.fake.outageHits.length).toBeGreaterThanOrEqual(outage.refuse ? 1 : 2);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(45_000);
    expect(r.elapsedMs).toBeLessThan(60_000);
  });

  it.each(["initialize", "join"])("a reconnect whose %s meets it keeps retrying, re-joins the same seat by key and completes the call", async (on) => {
    const s = await joinedSeat();
    s.fake.expireSessions();
    s.fake.outage({ ...outage, ms: 45_000, on });
    const r = await run(s, "observe", "--raw");
    expect(r.exit).toBe(0);
    expectSeatView(r.output);
    expect(r.calls).toEqual(["initialize", "join", "observe"]);
    expect(s.fake.toolCalls("join").at(-1).args.key).toBe(KEY);
    expect(s.fake.outageHits.map((hit) => hit.tool ?? hit.method)).toContain(on);
    expect(s.state("status.json").step).toBe("rejoined");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(45_000);
    expect(r.elapsedMs).toBeLessThan(60_000);
  });

  it("past 60 s the call reports the error as today", async () => {
    const s = await joinedSeat();
    s.fake.outage({ ...outage, ms: 120_000 });
    const r = await run(s, "observe", "--raw");
    expect(r.exit).toBe(1);
    expect(r.output).toBe(`antwars-seat observe: ${todayError}\n`);
    expect(r.calls).toEqual([]);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(59_000);
    expect(r.elapsedMs).toBeLessThanOrEqual(61_000);
  });
});

describe("the 60 s window is one per command", () => {
  it("a reconnect's initialize still failing past 60 s reports the error as today", async () => {
    const s = await joinedSeat();
    s.fake.expireSessions();
    s.fake.outage({ status: 503, ms: 120_000, on: "initialize" });
    const r = await run(s, "observe");
    expect(r.exit).toBe(1);
    expect(r.output).toBe("antwars-seat observe: initialize failed: HTTP 503\n");
    expect(r.elapsedMs).toBeLessThanOrEqual(61_000);
  });

  it("the re-join shares the call's deadline: 35 s on initialize and then 35 s on join is past 60 s", async () => {
    const s = await joinedSeat();
    s.fake.expireSessions();
    s.fake.outage({ status: 503, ms: 35_000, on: "initialize" });
    s.fake.outage({ status: 503, ms: 35_000, on: "join" });
    const r = await run(s, "observe");
    expect(r.exit).toBe(1);
    expect(r.output).toBe("antwars-seat observe: tools/call failed: HTTP 503\n");
    expect(r.calls).toEqual(["initialize"]);
    expect(r.elapsedMs).toBeLessThanOrEqual(61_000);
  });

  it("nothing is sent once the deadline has passed: a re-join due after a 59 s initialize outage is not sent and the call reports the timeout", async () => {
    const s = await joinedSeat();
    s.fake.expireSessions();
    s.fake.outage({ hold: true, ms: 59_000, on: "initialize" });
    s.fake.outage({ hold: true, ms: 120_000, on: "join" });
    const r = await run(s, "observe");
    expect(r.exit).toBe(1);
    expect(r.output).toBe("antwars-seat observe: The operation was aborted due to timeout\n");
    expect(r.calls).toEqual(["initialize"]);
    expect(s.fake.outageHits.filter((hit) => hit.tool === "join")).toEqual([]);
    // First send after 600 ms call spacing, deadline 60 s later; the re-join's turn comes one spacing after initialize.
    expect(r.elapsedMs).toBeLessThan(600 + 60_000 + 600);
  });

  it("a resend the server asked for earlier does not lift the deadline for a later reconnect: its call is not sent past it", async () => {
    const s = await joinedSeat({ notApplied: { tool: "rules", times: 1, retryAfterMs: 1_000 } });
    const before = s.fake.calls.length;
    let armed = false;
    // On the wait after the not_applied answer: the server forgets the session, then holds initialize and the call.
    s.clock.onAdvance(async () => {
      if (armed || !s.fake.calls.slice(before).some((call) => call.tool === "rules")) return;
      armed = true;
      s.fake.expireSessions();
      s.fake.outage({ hold: true, ms: 57_400, on: "initialize" });
      s.fake.outage({ hold: true, ms: 120_000, on: "rules" });
    });
    const r = await run(s, "rules");
    expect(armed).toBe(true);
    expect(r.exit).toBe(1);
    expect(r.output).toBe("antwars-seat rules: The operation was aborted due to timeout\n");
    expect(s.fake.outageHits.filter((hit) => hit.tool === "rules")).toEqual([]);
    expect(r.elapsedMs).toBeLessThan(600 + 60_000 + 600);
  });

  it("lobby_loading in a re-join keeps its own bound past 60 s, then the call completes", async () => {
    const s = await joinedSeat();
    s.fake.expireSessions();
    s.fake.setLobbyLoading(70);
    const r = await run(s, "observe", "--raw");
    expect(r.exit).toBe(0);
    expectSeatView(r.output);
    expect(r.calls.filter((call) => call === "join")).toHaveLength(71);
    expect(r.elapsedMs).toBeGreaterThan(70_000);
  });

  it("a tools listing also rides out a 503", async () => {
    const s = await joinedSeat();
    s.fake.outage({ status: 503, ms: 20_000 });
    const r = await run(s, "tools");
    expect(r.exit).toBe(0);
    expect(r.output).toContain("order --ants --tileX? --tileY?");
  });
});

// Once a command has met a 503, 429, timeout or
// refused connection, a re-join's lobby_loading answer no longer lifts its 60 s deadline. Before, a lobby_loading resend
// due after the deadline was still sent with a fresh 30 s timeout, so an unanswered send reported at about 90 s.
describe("a reconnect that meets both a transient failure and lobby_loading keeps the 60 s deadline", () => {
  it("503 on the re-join, then three lobby_loading answers, then a re-join with no answer: nothing is sent past 60 s and the call reports the timeout", async () => {
    const s = await joinedSeat();
    const before = s.fake.calls.length;
    s.fake.expireSessions();
    // From the call's first send: the re-join starts at 1.8 s and meets HTTP 503 until 57.8 s, then lobby_loading at
    // 57.8 s, 58.8 s and 59.8 s; any later join is held unanswered.
    s.fake.outage({ status: 503, ms: 56_000, on: "join" });
    s.fake.setLobbyLoading(3);
    let armed = false;
    s.clock.onAdvance(async () => {
      if (armed || s.fake.calls.slice(before).filter((call) => call.tool === "join").length < 3) return;
      armed = true;
      s.fake.outage({ hold: true, ms: 120_000, on: "join" });
    });
    const r = await run(s, "observe");
    expect(armed).toBe(true);
    expect(r.exit).toBe(1);
    expect(r.output).toBe("antwars-seat observe: The operation was aborted due to timeout\n");
    expect(r.calls).toEqual(["initialize", "join", "join", "join"]);
    expect(s.fake.toolCalls("join").slice(-3).map((call) => call.result.structuredContent.error.code)).toEqual(Array(3).fill("lobby_loading"));
    expect(s.fake.outageHits.filter((hit) => hit.kind === 503).length).toBeGreaterThanOrEqual(2);
    expect(s.fake.outageHits.filter((hit) => hit.kind === "hold")).toEqual([]);
    expect(r.elapsedMs).toBeLessThan(600 + 60_000 + 600);
  });

  it("lobby_loading on the re-join, then 503 until just before 60 s, then the call: the call is not sent past 60 s and reports the timeout", async () => {
    const s = await joinedSeat();
    const before = s.fake.calls.length;
    s.fake.expireSessions();
    s.fake.setLobbyLoading(1);
    let armed = false;
    // After the re-join's lobby_loading answer (1.8 s from the call's first send): HTTP 503 on join until 59.8 s, when
    // the re-join succeeds; the call that completes the reconnect is due after 60 s and would be held unanswered.
    s.clock.onAdvance(async () => {
      if (armed || !s.fake.calls.slice(before).some((call) => call.tool === "join")) return;
      armed = true;
      s.fake.outage({ status: 503, ms: 57_000, on: "join" });
      s.fake.outage({ hold: true, ms: 120_000, on: "observe" });
    });
    const r = await run(s, "observe");
    expect(armed).toBe(true);
    expect(r.exit).toBe(1);
    expect(r.output).toBe("antwars-seat observe: The operation was aborted due to timeout\n");
    expect(r.calls).toEqual(["initialize", "join", "join"]);
    expect(s.fake.toolCalls("join").at(-1).args.key).toBe(KEY);
    expect(s.fake.outageHits.filter((hit) => hit.kind === 503).length).toBeGreaterThanOrEqual(2);
    expect(s.fake.outageHits.filter((hit) => hit.kind === "hold")).toEqual([]);
    expect(r.elapsedMs).toBeLessThan(600 + 60_000 + 600);
  });
});

describe("other HTTP 4xx answers", () => {
  it.each([400, 401, 403, 405, 409, 413])("HTTP %i is reported as today and not retried", async (status) => {
    const s = await joinedSeat();
    s.fake.outage({ status, ms: 60_000 });
    const r = await run(s, "observe");
    expect(r.exit).toBe(1);
    expect(r.output).toBe(`antwars-seat observe: tools/call failed: HTTP ${status}\n`);
    expect(s.fake.outageHits).toHaveLength(1);
    expect(r.elapsedMs).toBeLessThan(1_000);
  });
});

describe("the entry client keeps today's behaviour", () => {
  it("an entry call answered HTTP 503 is reported at once, not retried", async () => {
    const s = await joinedSeat();
    s.fake.outage({ status: 503, ms: 60_000, on: "queue_status" });
    const r = await run(s, "leave");
    expect(r.exit).toBe(1);
    expect(r.output).toBe("antwars-seat leave: tools/call failed: HTTP 503\n");
    expect(s.fake.outageHits).toHaveLength(1);
  });
});
