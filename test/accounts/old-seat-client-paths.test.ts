/// <reference types="node" />
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../server/helpers.ts";
import {
  BACKENDS, closeAll, host, SEAT_CLIENT_LATER, serve, session, value, world, type Call, type World,
} from "./seat-client-world.ts";

/**
 * Seat client 1.0.0 against the
 * entry server: on each path the answer-and-client matrices
 * lists (go as the queuing seat, go as a non-queuing seat 2 of a 2v2, create-lobby and
 * join-lobby) the agent is shown update_seat_client with the update message, on the
 * command's error output and in antwars-seat status for a detached run, before any call
 * to the match server's join, and the copy is never seated.
 *
 * The client is a byte copy of packages/antwars-seat lib/, bin/ and package.json at
 * 902d2dd4d4a1aa83fe563cc532d56d9a84e81908 (test/fixtures/seat-1.0.0/), except its
 * fixed default store path (lib/state.mjs REMOTE_STORE), which these tests never reach
 * because every copy runs with ANTWARS_KEY_FILE set. Each path is set
 * up so that, past its first entry call, the copy would reach a match server: a stub
 * registered as the slot's instance, which records every request it receives.
 */
const COPY = fileURLToPath(new URL("../fixtures/seat-1.0.0/", import.meta.url));
const BIN = join(COPY, "bin", "antwars-seat");
const MESSAGE = "This server no longer accepts seat client 1.0.0, which cannot wait out a server handover. Copy the seat client again from origin/main into ./.antwars-seat as packages/antwars-seat/README.md describes, then run your command again.";

interface Run { readonly code: number; readonly stdout: string; readonly stderr: string }
interface Copy {
  run(...args: string[]): Promise<Run>;
  /** antwars-seat status's first line: status.json with goRunning and observer. */
  status(): Promise<Record<string, unknown> & { readonly printed: string }>;
}

const stubs: Server[] = [];
afterEach(async () => {
  await closeAll();
  for (const stub of stubs.splice(0)) await new Promise(resolve => stub.close(resolve));
});

/** A match server that records every request and serves none. */
async function matchStub(): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const stub = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(503).end();
  });
  stubs.push(stub);
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  if (address === null || typeof address === "string") throw new Error("stub has no port");
  return { url: `http://127.0.0.1:${address.port}/mcp/seat`, requests };
}

/** One installed 1.0.0 copy in its own folder, for the key named ANN_KEY, against this entry URL. */
function install(entryUrl: string, key: string): Copy {
  const dir = tempDir();
  const keyFile = join(dir, "keys.env");
  writeFileSync(keyFile, `ANN_KEY=${JSON.stringify(key)}\n`);
  mkdirSync(join(dir, ".antwars-seat"), { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "", HOME: dir, ANTWARS_ENTRY_URL: entryUrl, ANTWARS_KEY_FILE: keyFile,
    ANTWARS_SEAT_STATE: join(dir, ".antwars-seat", "state"), ANTWARS_MIN_CALL_MS: "0",
  };
  const run = (...args: string[]) => new Promise<Run>((resolve, reject) => {
    execFile(process.execPath, [BIN, ...args], { env, cwd: dir, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") reject(error);
      else resolve({ code: error === null ? 0 : error.code as number, stdout, stderr });
    });
  });
  return {
    run,
    async status() {
      const printed = await run("status");
      expect(printed.code, printed.stderr).toBe(0);
      return { ...JSON.parse(printed.stdout.split("\n")[0]!), printed: printed.stdout };
    },
  };
}

/** The copy's setup; seat 2 does not queue by default. */
async function setup(copy: Copy, mode: string, seat = 1): Promise<void> {
  const done = await copy.run("setup", "--handle", "ann", "--key-name", "ANN_KEY", "--mode", mode, "--model-label", "test-model", "--thinking-level", "high", "--seat", String(seat));
  expect(done.code, done.stderr).toBe(0);
}

/** The refusal on the command's error output, attached. */
async function refusedAttached(copy: Copy, command: string, tool: string, ...args: string[]): Promise<void> {
  const run = await copy.run(command, ...args);
  expect(run).toEqual({ code: 1, stdout: "", stderr: `antwars-seat ${command}: ${tool} refused: update_seat_client (${MESSAGE})\n` });
}

/** The refusal in antwars-seat status after a detached run has finished. */
async function refusedDetached(copy: Copy, command: string, tool: string, ...args: string[]): Promise<void> {
  const launched = await copy.run(command, ...args, "--detach");
  expect(launched.code, launched.stderr).toBe(0);
  expect(launched.stdout).toMatch(new RegExp(`^${command} started detached \\(pid \\d+\\)\\. Progress: antwars-seat status\\n$`));
  const deadline = Date.now() + 20_000;
  let status = await copy.status();
  while (!(status.step === "failed" && status.goRunning === false) && Date.now() < deadline) {
    await sleep(200);
    status = await copy.status();
  }
  expect(status).toMatchObject({ step: "failed", goRunning: false, error: `${tool} refused: update_seat_client (${MESSAGE})` });
  expect(status.printed).toContain(MESSAGE);
}

async function entry(w: World) {
  const url = `http://127.0.0.1:${(await serve(w.accounts)).port}/mcp`;
  return { url, later: await session(url, SEAT_CLIENT_LATER) };
}

async function seatLocation(call: Call, lobbyId: string): Promise<unknown> {
  return (await call("locate_match", { lobbyId })).body;
}

describe("the seat-client fixture", () => {
  it("is the 1.0.0 client: it identifies itself as antwars-seat 1.0.0 in initialize", () => {
    expect(JSON.parse(readFileSync(join(COPY, "package.json"), "utf8")).version).toBe("1.0.0");
    expect(readFileSync(join(COPY, "lib", "mcp.mjs"), "utf8")).toContain(`clientInfo: { name: "antwars-seat", version: "1.0.0" }`);
  });
});

for (const backend of BACKENDS) {
  describe.skipIf(backend === "Firestore emulator" && !host)(`seat client 1.0.0 paths against the entry server using ${backend}`, { timeout: 120_000 }, () => {
    it("go as the queuing seat shows the update message at queue_status, before any join_queue or match-server call", async () => {
      const w = world(backend);
      const { url, later } = await entry(w);
      const ann = value(await w.accounts.identities.claimUsername("Ann"));
      const bob = value(await w.accounts.identities.claimUsername("Bob"));
      const stub = await matchStub();
      await w.accounts.lobbies.registerInstance("public-0", { runId: "stub-run", mcpUrl: stub.url, spectatorUrl: "http://stub.test/" });
      // Bob waits in the 1v1 queue, so Ann's join_queue would pair and her lobby would hold public-0 at the stub.
      expect((await later("join_queue", { key: bob.key, mode: "1v1" })).body).toMatchObject({ queue: { state: "waiting" } });
      const attached = install(url, ann.key);
      const detached = install(url, ann.key);
      await setup(attached, "1v1");
      await setup(detached, "1v1");

      await refusedAttached(attached, "go", "queue_status");
      await refusedDetached(detached, "go", "queue_status");

      expect(stub.requests).toEqual([]);
      expect((await later("queue_status", { key: ann.key })).body).toEqual({ queue: { state: "none" } });
      expect((await later("queue_status", { key: bob.key })).body).toMatchObject({ queue: { state: "waiting" } });
    });

    it("go as a non-queuing seat 2 of a 2v2 shows the update message at queue_status and never reaches its match server", async () => {
      const w = world(backend);
      const { url, later } = await entry(w);
      const ann = value(await w.accounts.identities.claimUsername("Ann"));
      const bob = value(await w.accounts.identities.claimUsername("Bob"));
      const stub = await matchStub();
      await w.accounts.lobbies.registerInstance("public-0", { runId: "stub-run", mcpUrl: stub.url, spectatorUrl: "http://stub.test/" });
      const attached = install(url, ann.key);
      const detached = install(url, ann.key);
      await setup(attached, "2v2", 2);
      await setup(detached, "2v2", 2);
      // Ann's queuing seat runs a later client and pairs with Bob after seat 2 was set up.
      expect((await later("join_queue", { key: ann.key, mode: "2v2" })).body).toMatchObject({ queue: { state: "waiting" } });
      const matched = (await later("join_queue", { key: bob.key, mode: "2v2" })).body;
      expect(matched).toMatchObject({ queue: { state: "matched", mode: "2v2" } });
      const lobbyId = matched.queue.lobbyId as string;
      // Past queue_status, seat 2 would follow this pairing to the stub and join there.
      expect((await later("queue_status", { key: ann.key })).body).toMatchObject({ queue: { state: "matched", lobbyId } });
      expect(await seatLocation(later, lobbyId)).toEqual({ slot: "public-0", mcpUrl: stub.url, spectatorUrl: `https://antwars.ai/?lobby=${lobbyId}` });

      await refusedAttached(attached, "go", "queue_status");
      await refusedDetached(detached, "go", "queue_status");

      expect(stub.requests).toEqual([]);
    });

    it("create-lobby shows the update message at create_lobby and creates nothing", async () => {
      const w = world(backend);
      const { url, later } = await entry(w);
      const ann = value(await w.accounts.identities.claimUsername("Ann"));
      const listed = (await later("list_lobbies")).body;
      const copy = install(url, ann.key);
      await setup(copy, "1v1");

      await refusedAttached(copy, "create-lobby", "create_lobby");

      expect((await later("list_lobbies")).body).toEqual(listed);
    });

    it("join-lobby shows the update message at join_lobby, takes no seat and never reaches the match server", async () => {
      const w = world(backend);
      const { url, later } = await entry(w);
      const ann = value(await w.accounts.identities.claimUsername("Ann"));
      const bob = value(await w.accounts.identities.claimUsername("Bob"));
      const stub = await matchStub();
      await w.accounts.lobbies.registerInstance("public-0", { runId: "stub-run", mcpUrl: stub.url, spectatorUrl: "http://stub.test/" });
      // Bob's 1v1 lobby has one free seat: Ann's join_lobby would fill it and hold public-0 at the stub.
      const lobbyId = (await later("create_lobby", { key: bob.key, size: 1, kind: "public" })).body.lobby.id as string;
      expect((await later("join_lobby", { key: bob.key, lobbyId })).body).toMatchObject({ lobby: { state: "open" } });
      const before = (await later("read_lobby", { lobbyId, key: bob.key })).body;
      const attached = install(url, ann.key);
      const detached = install(url, ann.key);
      await setup(attached, "1v1");
      await setup(detached, "1v1");

      await refusedAttached(attached, "join-lobby", "join_lobby", lobbyId);
      await refusedDetached(detached, "join-lobby", "join_lobby", lobbyId);

      expect(stub.requests).toEqual([]);
      expect((await later("read_lobby", { lobbyId, key: bob.key })).body).toEqual(before);
    });
  });
}
