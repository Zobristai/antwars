// Seat client version: this copy reports a version later than 1.0.0, so an
// entry server that refuses seat client 1.0.0 answers its
// go and join-lobby flows as today and its join, including the rejoin after a 404, seats it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { CLIENT_INFO, McpClient, errorCode } from "../lib/mcp.mjs";
import { SEAT_CLIENT_REFUSED_TOOLS, UPDATE_SEAT_CLIENT_FIX, UPDATE_SEAT_CLIENT_MESSAGE, fakeClock, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-test-0f3c9a7e51d2";
const KEY_NAME = "ANTWARS_HOUSE_TEST_SEAT";
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()();
});

/** True when dotted version a is later than b. */
function later(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** One seat set up against its own fake (shared fake clock), running the given CLI commands. */
async function seatRun(fakeOptions, { mode = "house-1v1", setup = [], commands }) {
  const clock = fakeClock();
  const fake = await startFake({ key: KEY, clock, ...fakeOptions, baseline: typeof fakeOptions.baseline === "function" ? fakeOptions.baseline(clock) : fakeOptions.baseline });
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-version-"));
  writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(KEY)}\n`);
  cleanups.push(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });
  const printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  const env = { ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: fake.url, ANTWARS_MIN_CALL_MS: "600", ANTWARS_POLL_MS: "3000" };
  const cli = (...argv) => main(argv, { env, clock });
  expect(await cli("setup", "--handle", "antwars/test", "--key-name", KEY_NAME, "--mode", mode, "--model-label", "claude-opus-5-5", "--thinking-level", "max", ...setup)).toBe(0);
  const exits = [];
  for (const command of commands) exits.push(await cli(...command));
  const state = (name) => JSON.parse(readFileSync(join(dir, "state", name), "utf8"));
  return { fake, cli, exits, printed, state, origin: new URL(fake.url).origin };
}

/** Every entry tool call with its arguments and the result it was answered with; the fake's own address made neutral. */
function entryAnswers(run) {
  return run.fake.calls.filter((c) => c.server === "entry" && c.tool)
    .map((c) => JSON.parse(JSON.stringify({ tool: c.tool, args: c.args, result: c.result }).replaceAll(run.origin, "http://fake")));
}

const FLOWS = [
  { name: "go as the queuing seat", fake: { pairAfterMs: 30_000 }, run: { commands: [["go"]] },
    tools: ["queue_status", "join_queue", "read_lobby", "locate_match"] },
  { name: "go as a non-queuing seat 2 of a 2v2",
    fake: { pairAfterMs: 45_000, baseline: (clock) => ({ state: "waiting", mode: "house-2v2", joinedAt: clock.now(), expiresAt: clock.now() + 900_000 }) },
    run: { mode: "house-2v2", setup: ["--seat", "2"], commands: [["go"]] },
    tools: ["queue_status", "read_lobby", "locate_match"] },
  { name: "create-lobby, then join-lobby", fake: { lobbyHoldsAfterLocates: 2 }, run: { commands: [["create-lobby"], ["join-lobby", "lobby-1"]] },
    tools: ["create_lobby", "join_lobby", "locate_match", "read_lobby"] },
];

describe("seat client version", () => {
  it("initialize reports clientInfo antwars-seat with the package.json version, later than 1.0.0, on the entry and match servers", async () => {
    expect(CLIENT_INFO).toEqual({ name: "antwars-seat", version: PACKAGE_VERSION });
    expect(later(PACKAGE_VERSION, "1.0.0")).toBe(true);
    const run = await seatRun({ pairAfterMs: 0, refuseOldSeatClient: true }, { commands: [["go"]] });
    expect(run.exits).toEqual([0]);
    const inits = run.fake.calls.filter((c) => c.method === "initialize");
    expect(new Set(inits.map((c) => c.server))).toEqual(new Set(["entry", "match"]));
    for (const init of inits) expect(init.clientInfo).toEqual({ name: "antwars-seat", version: PACKAGE_VERSION });
  });

  it("the flows below make all six entry calls the server refuses to seat client 1.0.0", () => {
    expect(new Set(FLOWS.flatMap((flow) => flow.tools))).toEqual(new Set(SEAT_CLIENT_REFUSED_TOOLS));
  });

  it.each(FLOWS)("$name: against a server refusing seat client 1.0.0, every entry call is answered as today and the seat is joined", async (flow) => {
    const today = await seatRun(flow.fake, flow.run);
    const refusing = await seatRun({ ...flow.fake, refuseOldSeatClient: true }, flow.run);
    expect(refusing.exits).toEqual(today.exits);
    expect(refusing.exits.every((code) => code === 0)).toBe(true);
    const answers = entryAnswers(refusing);
    expect(answers).toEqual(entryAnswers(today));
    expect(new Set(answers.map((a) => a.tool))).toEqual(new Set(flow.tools));
    expect(JSON.stringify(answers)).not.toContain("update_seat_client");
    const joins = refusing.fake.toolCalls("join");
    expect(joins).toHaveLength(1);
    expect(joins[0].result.isError).toBeUndefined();
    expect(refusing.state("status.json")).toMatchObject({ step: "joined", box: { x: 2, y: 0, width: 3, height: 3 } });
  });

  it("join, and the rejoin after a 404, are admitted to the seat by a server refusing seat client 1.0.0", async () => {
    const run = await seatRun({ pairAfterMs: 0, refuseOldSeatClient: true }, { commands: [["go"]] });
    expect(run.exits).toEqual([0]);
    expect(run.fake.toolCalls("join")[0].result.structuredContent).toMatchObject({ agentId: "agent-1", colony: "red" });
    run.fake.expireSessions();
    const before = run.fake.calls.length;
    expect(await run.cli("observe")).toBe(0);
    const after = run.fake.calls.slice(before);
    expect(after.map((c) => c.tool ?? c.method)).toEqual(["initialize", "join", "observe"]);
    expect(after[0]).toMatchObject({ server: "match", clientInfo: { name: "antwars-seat", version: PACKAGE_VERSION } });
    expect(after[1].result.isError).toBeUndefined();
    expect(after[1].result.structuredContent).toMatchObject({ agentId: "agent-1", colony: "red" });
    expect(after[2].result.isError).toBeUndefined();
    expect(run.state("status.json").step).toBe("rejoined");
  });

  it("control: that server refuses a session presenting 1.0.0 on each of the six calls, in each tool's reply family, and nothing is queued, seated or created", async () => {
    const clock = fakeClock();
    const fake = await startFake({ key: KEY, clock, refuseOldSeatClient: true, lobbies: { "open-lobby": "open" } });
    cleanups.push(() => fake.close());
    // The tree's client with only its initialize clientInfo rewritten to 1.0.0.
    const presenting = (version) => (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "initialize") body.params.clientInfo = { ...body.params.clientInfo, version };
      return fetch(url, { ...init, body: JSON.stringify(body) });
    };
    const old = new McpClient({ url: fake.url, clock, fetchImpl: presenting("1.0.0") });
    const calls = {
      queue_status: { key: KEY },
      join_queue: { key: KEY, mode: "house-1v1" },
      create_lobby: { key: KEY, size: 1, kind: "public" },
      join_lobby: { key: KEY, lobbyId: "open-lobby" },
      read_lobby: { key: KEY, lobbyId: "open-lobby" },
      locate_match: { lobbyId: "open-lobby" },
    };
    expect(Object.keys(calls).sort()).toEqual([...SEAT_CLIENT_REFUSED_TOOLS].sort());
    for (const [name, args] of Object.entries(calls)) {
      const reply = await old.callTool(name, args);
      expect(reply.ok).toBe(false);
      expect(errorCode(reply.data)).toBe("update_seat_client");
      if (name === "locate_match") expect(reply.data.error).toEqual({ code: "update_seat_client", message: UPDATE_SEAT_CLIENT_MESSAGE, howToFix: UPDATE_SEAT_CLIENT_FIX });
      else expect(reply.data).toEqual({ error: "update_seat_client", message: UPDATE_SEAT_CLIENT_MESSAGE });
    }
    expect(fake.calls.find((c) => c.method === "initialize").clientInfo).toEqual({ name: "antwars-seat", version: "1.0.0" });
    const current = new McpClient({ url: fake.url, clock });
    expect((await current.callTool("queue_status", { key: KEY })).data.queue).toEqual({ state: "none" });
    expect((await current.callTool("read_lobby", { key: KEY, lobbyId: "open-lobby" })).data.lobby.state).toBe("open");
    expect((await current.callTool("create_lobby", { key: KEY, size: 1, kind: "public" })).data.lobby.id).toBe("lobby-1");
  });
});
