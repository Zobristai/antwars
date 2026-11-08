import { rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createRecordHandoff, type MatchInputs } from "../../src/records/handoff.js";
import { ReplayCreateError, type ReplayStore } from "../../src/replays/store.js";
import { startSpectatedServer } from "../../src/spectator.js";
import { tempDir } from "./helpers.js";

// Cloud Run's shutdown signal arriving while a finished match's inputs wait
// for a retry. Shutdown drains them within its time: stored, or the loss logged by match id.
const ID = "2026-10-21T10-00-00-000Z-783";
const inputs: MatchInputs = { id: ID, endedAt: Date.parse("2026-10-21T10:01:00.000Z"), lobbyId: null, logLines: ["{\"header\":1}"], binary: new Uint8Array([1]) };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A server whose record handoff's first upload has failed, so its retry waits a second or more. */
async function serverWithFailedUpload(uploadsFail: boolean) {
  const dir = tempDir(); dirs.push(dir);
  const stored = new Set<string>(), logs: string[] = [];
  let attempts = 0;
  const store: ReplayStore = { create: async object => {
    attempts += 1;
    if (attempts === 1 || uploadsFail) throw new ReplayCreateError(503);
    stored.add(object.name);
  } };
  const recordHandoff = createRecordHandoff({ store, codeVersion: "d".repeat(40), log: line => logs.push(line) });
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, recordHandoff });
  recordHandoff.submit(inputs);
  await vi.waitFor(() => expect(attempts).toBe(1));
  return { server, stored, logs, attempts: () => attempts };
}

it("stores a pending input during shutdown instead of exiting with it unstored", async () => {
  const { server, stored, logs } = await serverWithFailedUpload(false);
  const started = Date.now();
  await server.shutdown(5_000);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(stored).toEqual(new Set([`${ID}.input`]));
  expect(logs.some(line => line.includes("not stored before shutdown"))).toBe(false);
});

it("logs the unstored input by match id when uploads keep failing, and closes within the shutdown time", async () => {
  const { server, stored, logs } = await serverWithFailedUpload(true);
  const started = Date.now();
  await server.shutdown(1_500);
  const took = Date.now() - started;
  expect(took).toBeGreaterThanOrEqual(1_400);
  expect(took).toBeLessThan(2_500);
  expect(stored.size).toBe(0);
  // The waiting retry ran at once and again a second later; both failed.
  expect(logs.filter(line => line.includes("not stored before shutdown"))).toEqual([
    `antwar record ${ID} input not stored before shutdown after 3 attempt(s), so its replay and public record will not appear: replay create failed: HTTP 503`]);
});
