import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { decodeMessage } from "../../src/live/format.js";
import { recordLog } from "../../src/live/record.js";
import { loadReplayFile } from "../../src/live/replayOptions.js";
import { unpackMessages } from "../../src/live/snapshot.js";
import { headerLine, replay } from "../../src/sim/log.js";
import { matchEnd } from "../../web/capture/watch.ts";
import { recordMatchFile, territoryMessages } from "../../web/capture/capture.ts";
import { summarizeLog, summarizeMatch } from "../tools/summary.js";
import { logLines } from "../server/helpers.js";
import { DEFAULT_CONFIG } from "../../src/sim/config.js";
import { playable } from "../playable.ts";

// Every match plays the ant115 hold behaviour. A log header names it, and every log reader refuses a
// header without it, at the shared loader before any simulation or browser work, instead of choosing one for it.
const root = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);
const cli = (script: string, args: string[]) => run(process.execPath, ["--import", "./src/ts-resolve.mjs", script, ...args], { cwd: root, timeout: 20_000 });
const REFUSAL = "holdBehaviour must be ant115";

function fixture(marked: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "replay-tools-"));
  const log = join(dir, "match-2026-10-19T05-00-00-000Z-1.jsonl");
  const header = JSON.parse(headerLine(141, playable({ ...DEFAULT_CONFIG, startAnts: 4, matchTicks: 2 })));
  if (!marked) delete header.holdBehaviour;
  const text = JSON.stringify(header) + "\n";
  writeFileSync(log, text);
  return { dir, log, text, digest: createHash("sha256").update(text).digest("hex") };
}

describe("the shared log loader", () => {
  it("returns the file's lines and refuses a changed digest, an empty file or a file without a header", () => {
    const f = fixture(true);
    try {
      expect(loadReplayFile(f.log, { expectedSha256: f.digest }).lines).toEqual(f.text.split("\n"));
      expect(() => loadReplayFile(f.log, { expectedSha256: "0".repeat(64) })).toThrow("log sha256");
      writeFileSync(f.log, "");
      expect(() => loadReplayFile(f.log)).toThrow(/empty/);
      writeFileSync(f.log, JSON.stringify({ tick: 0, inputs: [] }));
      expect(() => loadReplayFile(f.log)).toThrow(/header/);
      for (const holdBehaviour of [undefined, "legacy", "ant105", null]) {
        writeFileSync(f.log, JSON.stringify({ ...JSON.parse(f.text), holdBehaviour }));
        expect(() => loadReplayFile(f.log)).toThrow(REFUSAL);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("accepts only the ant115 holds option", () => {
    const f = fixture(true);
    try {
      expect(loadReplayFile(f.log, { holds: "ant115" }).lines).toEqual(f.text.split("\n"));
      for (const holds of ["legacy", "ant105", "guess"]) expect(() => loadReplayFile(f.log, { holds })).toThrow(REFUSAL);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe("real offline tool wiring", () => {
  it("every reader refuses a log without the ant115 marker, and reads a marked one", () => {
    const unmarked = fixture(false), marked = fixture(true);
    try {
      for (const [name, read] of [
        ["shared loader", () => loadReplayFile(unmarked.log)],
        ["server test logLines", () => logLines(unmarked.log)],
        ["watch matchEnd", () => matchEnd(unmarked.log)],
        ["capture --log", () => recordMatchFile("unmarked-refused", unmarked.log)],
        ["capture territoryProbe", () => territoryMessages({ log: unmarked.log })],
        ["summary summarizeLog", () => summarizeLog(unmarked.log)],
      ] as const) expect(read, name).toThrow(REFUSAL);
      const lines = loadReplayFile(marked.log).lines;
      expect(logLines(marked.log)).toEqual(lines.filter(line => line !== ""));
      expect(summarizeLog(marked.log)).toEqual(summarizeMatch(lines));
      expect(territoryMessages({ log: marked.log })).toEqual(recordLog(lines).map(decodeMessage));
      const truth = replay(lines, Infinity);
      expect(matchEnd(marked.log)).toEqual({ finalTick: truth.tick, winner: truth.result!.winner });
    } finally {
      rmSync(unmarked.dir, { recursive: true, force: true });
      rmSync(marked.dir, { recursive: true, force: true });
    }
  });

  it("record.ts --log refuses an unmarked log and records a marked one", async () => {
    const unmarked = fixture(false), marked = fixture(true);
    try {
      await expect(cli("src/live/record.ts", ["--log", unmarked.log, "--out", unmarked.dir])).rejects.toMatchObject({ stderr: expect.stringContaining(REFUSAL) });
      await cli("src/live/record.ts", ["--log", marked.log, "--out", marked.dir]);
      const out = join(marked.dir, "match-2026-10-19T05-00-00-000Z-1.bin");
      expect(unpackMessages(new Uint8Array(readFileSync(out)))).toEqual(recordLog(loadReplayFile(marked.log).lines));
      expect(readFileSync(marked.log, "utf8")).toBe(marked.text);
    } finally {
      rmSync(unmarked.dir, { recursive: true, force: true });
      rmSync(marked.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("excerpt.ts verifies the original bytes, refuses an unmarked log and excerpts a marked one", async () => {
    const unmarked = fixture(false), marked = fixture(true);
    const args = (f: typeof marked) => ["--log", f.log, "--out", join(f.dir, "excerpt.bin"), "--from", "0", "--to", "2", "--sha256", f.digest];
    try {
      await expect(cli("web/capture/excerpt.ts", args(unmarked))).rejects.toMatchObject({ stderr: expect.stringContaining(REFUSAL) });
      await expect(cli("web/capture/excerpt.ts", [...args(marked).slice(0, -1), "bad-digest"])).rejects.toMatchObject({ stderr: expect.stringContaining("log sha256") });
      await cli("web/capture/excerpt.ts", args(marked));
      const frames = unpackMessages(readFileSync(join(marked.dir, "excerpt.bin"))).map(decodeMessage);
      expect(frames.map(frame => frame.tick)).toEqual([0, 1, 2]);
      expect(frames.at(-1)!.events).toContainEqual(expect.objectContaining({ kind: "end" }));
    } finally {
      rmSync(unmarked.dir, { recursive: true, force: true });
      rmSync(marked.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("watch.ts --check refuses an unmarked log before browser startup", async () => {
    const f = fixture(false);
    const lobbyId = "00000000-0000-4000-8000-000000000001";
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      if (req.url === "/watch/catalog") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ matches: [{ lobbyId }] }));
      } else if (req.url === `/watch/live/${lobbyId}`) {
        res.writeHead(200, { "x-antwar-match": "1" });
        res.end();
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(cli("web/capture/watch.ts", ["--url", url, "--logs", f.dir, "--out", f.dir, "--check"])).rejects.toMatchObject({ stderr: expect.stringContaining(REFUSAL) });
      expect(paths).toEqual(["/watch/catalog", `/watch/live/${lobbyId}`]);
      expect(readFileSync(f.log, "utf8")).toBe(f.text);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps every replay entry point wired to the loader", () => {
    const source = (path: string) => readFileSync(join(root, path), "utf8");
    for (const path of ["src/live/record.ts", "web/capture/watch.ts", "web/capture/excerpt.ts",
      "web/capture/capture.ts", "test/tools/summary.ts", "test/marks-replay/replay.ts",
      "test/server/helpers.ts"]) {
      expect(source(path), path).toContain("loadReplayFile(");
    }
    for (const path of ["src/live/record.ts", "web/capture/watch.ts", "web/capture/excerpt.ts",
      "web/capture/capture.ts", "test/tools/summary.ts", "test/marks-replay/replay.ts", "test/server/helpers.ts"]) {
      expect(source(path), path).not.toMatch(/readFileSync\((?:values\.log|recording\.log|path|log),/);
    }
  });
});
