// A call the match server answers not_applied (a handover stopped it
// before it applied the call) is sent again after the answer's retryAfterMs,
// and the agent gets the resent call's result.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { fakeClock, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-test-0f3c9a7e51d2";
const KEY_NAME = "ANTWARS_HOUSE_TEST_SEAT";
const ORDER = ["order", "--ants", "[1,2]", "--tileX", "7", "--tileY", "1"];

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()();
});

/** A seat joined to the fake match server through go, with the given not_applied option. */
async function joinedSeat(notApplied) {
  const clock = fakeClock();
  const fake = await startFake({ key: KEY, clock, pairAfterMs: 0, notApplied });
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-"));
  writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(KEY)}\n`);
  const env = { ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: fake.url, ANTWARS_MIN_CALL_MS: "600" };
  cleanups.push(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });
  const printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  const cli = (...argv) => main(argv, { env, clock });
  expect(await cli("setup", "--handle", "antwars/test", "--key-name", KEY_NAME, "--mode", "house-1v1",
    "--model-label", "claude-opus-5-5", "--thinking-level", "max")).toBe(0);
  expect(await cli("go")).toBe(0);
  printed.length = 0;
  return { fake, cli, printed };
}

const gaps = (calls) => calls.slice(1).map((call, i) => call.at - calls[i].at);

describe("not_applied answers", () => {
  it("resends the call after its retryAfterMs and returns the resent call's result", async () => {
    const s = await joinedSeat({ tool: "order", times: 2, retryAfterMs: 2500 });
    expect(await s.cli(...ORDER)).toBe(0);
    const orders = s.fake.toolCalls("order");
    expect(orders.map((c) => c.args)).toEqual(Array(3).fill({ ants: [1, 2], tileX: 7, tileY: 1 }));
    for (const gap of gaps(orders)) expect(gap).toBeGreaterThanOrEqual(2500);
    expect(new Set(orders.map((c) => c.callId)).size).toBe(1); // one command: the same call id on every send
    expect(s.fake.orders()).toHaveLength(1); // applied once, by the last send
    const out = s.printed.join("");
    expect(out).toContain("\"accepted\":true");
    expect(out).not.toContain("not_applied");
  });

  it("waits 1 s before resending when the answer carries no retryAfterMs", async () => {
    const s = await joinedSeat({ tool: "order", times: 1, retryAfterMs: null });
    expect(await s.cli(...ORDER)).toBe(0);
    const orders = s.fake.toolCalls("order");
    expect(orders).toHaveLength(2);
    expect(gaps(orders)[0]).toBeGreaterThanOrEqual(1000);
    expect(s.printed.join("")).toContain("\"accepted\":true");
  });

  it("resends at most 5 times, then reports the not_applied answer", async () => {
    const s = await joinedSeat({ tool: "order", times: 6, retryAfterMs: 1000 });
    expect(await s.cli(...ORDER)).toBe(2);
    expect(s.fake.toolCalls("order")).toHaveLength(6);
    expect(s.printed.join("")).toContain("not_applied");
  });
});
