import { rm } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { HistorySource } from "../../src/replays/history-source.ts";
import { startSpectatedServer, type SpectatedServerOptions } from "../../src/spectator.ts";
import { comparison, memorySlot, tempDir } from "../server/helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function start(scan: NonNullable<HistorySource["scan"]>, mode: "entry" | "slot" | "comparison", usersPolicy?: SpectatedServerOptions["usersPolicy"]) {
  const dataDir = tempDir();
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const { accounts, watchRegistry, slot } = memorySlot();
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, accounts, watchRegistry, usersPolicy,
    slot: mode === "slot" ? slot : undefined, ...(mode === "comparison" && comparison(2)),
    currentRosterSeats: async () => new Map(),
    historySource: { scan, list: async () => ({ matches: [], nextPageToken: null }), open: async () => null },
  });
  cleanup.push(() => server.close());
  return `http://127.0.0.1:${server.port}`;
}

it("starts one scan before any request, serves other routes, and shares the scan with a visitor", async () => {
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const scan = vi.fn(async function* () { await release.promise; yield []; });
  // The request reads its policy when it joins; the scanner is still blocked then.
  const policy = () => { if (scan.mock.calls.length) entered.resolve(); return { digest: "public" }; };
  const origin = await start(scan, "entry", policy);
  try {
    await nextTurn();
    expect(scan).toHaveBeenCalledTimes(1);
    expect((await fetch(origin + "/matches")).status).toBe(200);
    const first = fetch(origin + "/matches/users");
    await entered.promise; release.resolve();
    for (const response of [await first, await fetch(origin + "/matches/users")]) {
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ users: [] });
    }
    expect(scan).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); }
});

it.each(["slot", "comparison"] as const)("keeps the %s listing lazy", async mode => {
  const scan = vi.fn(async function* () { yield []; });
  const origin = await start(scan, mode);
  await nextTurn();
  expect(scan).not.toHaveBeenCalled();
  expect((await fetch(origin + "/matches/users")).status).toBe(200);
  expect(scan).toHaveBeenCalledTimes(1);
});

it("keeps serving if the startup policy cannot be read", async () => {
  const scan = vi.fn(async function* () { yield []; });
  const policy = vi.fn(() => ({ digest: "public" })).mockImplementationOnce(() => { throw Error("policy unavailable"); });
  const origin = await start(scan, "entry", policy);
  await nextTurn();
  expect(policy).toHaveBeenCalledTimes(1);
  expect(scan).not.toHaveBeenCalled();
  expect((await fetch(origin + "/matches/users")).status).toBe(200);
  expect(scan).toHaveBeenCalledTimes(1);
});
