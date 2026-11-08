/// <reference types="node" />
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type GameServer } from "../../src/server.js";
import { matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("a fixed cap on finished match logs", () => {
  it("keeps only the newest finished logs up to the cap, deleting the oldest when a new match starts", async () => {
    const dataDir = tempDir();
    // A log left by an earlier run counts as the oldest finished log.
    writeFileSync(join(dataDir, "match-2000-01-01T00-00-00-000Z-7.jsonl"), "{}\n");
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, breakMs: 50, maxMatchLogs: 2, simConfig: playable(shortConfig(3)), mcpConfig: TEST_MCP_CONFIG });
    const s = server;

    const seqs = (): number[] => [...matchLogs(dataDir).keys()].sort((a, b) => a - b);
    // Just after match n starts: its own log plus the newest finished ones, at most the cap.
    const expected: Record<number, number[]> = { 1: [1, 7], 2: [1, 2, 7], 3: [1, 2, 3], 4: [2, 3, 4], 5: [3, 4, 5] };
    for (const [seq, logs] of Object.entries(expected)) {
      await waitFor(() => s.game.match?.seq === Number(seq));
      expect(s.game.match!.result).toBeNull();
      expect(seqs(), `just after match ${seq} started`).toEqual(logs);
    }
  }, 20_000);
});
