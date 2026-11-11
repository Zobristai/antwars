// Each command takes effect once: every tools/call carries one call id
// (params._meta["antwars/callId"]) fixed for the command and sent unchanged on
// every send of it, so a send the server already applied is not applied again.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { fakeClock, freshShell, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-test-0f3c9a7e51d2";
const KEY_NAME = "ANTWARS_HOUSE_TEST_SEAT";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()();
});

/** A set-up seat that has run go against the fake: seated, in the nest window. */
async function seatedAgent(fakeOptions = {}) {
  const clock = fakeClock();
  const fake = await startFake({ key: KEY, clock, pairAfterMs: 0, ...fakeOptions });
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-"));
  writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(KEY)}\n`);
  const env = { ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: fake.url,
    ANTWARS_MIN_CALL_MS: "600", ANTWARS_POLL_MS: "3000" };
  cleanups.push(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });
  const stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const cli = (...argv) => main(argv, { env, clock, readStat: freshShell() });
  expect(await cli("setup", "--handle", "antwars/test", "--key-name", KEY_NAME, "--mode", "house-1v1",
    "--model-label", "claude-opus-5-5", "--thinking-level", "max")).toBe(0);
  expect(await cli("go")).toBe(0);
  stdout.length = 0;
  return { fake, cli, stdout };
}

const ORDER = ["order", "--ants", "[1,2]", "--tileX", "7", "--tileY", "1"];

describe("command takes effect once", () => {
  it("a mutating call the server applied before its reply was lost takes no second effect, and the agent gets its original result", async () => {
    const s = await seatedAgent({ loseReplyAfterApply: "order" });
    const before = s.fake.calls.length;
    expect(await s.cli(...ORDER)).toBe(0);

    // The order was applied, its reply lost with the session; the client re-joined and sent it again.
    const sent = s.fake.calls.slice(before);
    expect(sent.map((c) => c.tool ?? c.method)).toEqual(["order", "initialize", "join", "order"]);
    const [first, , rejoin, resent] = sent;
    expect(first.callId).toMatch(UUID);
    expect(resent.callId).toBe(first.callId);
    expect(rejoin.callId).toMatch(UUID);
    expect(rejoin.callId).not.toBe(first.callId);

    // One effect on the fake server, and the agent is shown the first send's result.
    expect(s.fake.orders()).toEqual([{ ants: [1, 2], tileX: 7, tileY: 1 }]);
    expect(JSON.parse(s.stdout.join("").trim())).toEqual({ accepted: true, echo: { ants: [1, 2], tileX: 7, tileY: 1 }, orderNo: 1 });
  });

  it("every tool call carries a call id, and separate commands carry their own, so the same order sent twice takes effect twice", async () => {
    const s = await seatedAgent();
    expect(await s.cli(...ORDER)).toBe(0);
    expect(await s.cli(...ORDER)).toBe(0);

    const toolCalls = s.fake.calls.filter((c) => c.tool !== undefined);
    for (const call of toolCalls) expect(call.callId).toMatch(UUID);
    expect(new Set(toolCalls.map((c) => c.callId)).size).toBe(toolCalls.length);
    expect(s.fake.orders()).toHaveLength(2);
  });
});
