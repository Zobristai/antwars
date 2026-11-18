// entry-read: one read-only entry call (read_lobby or queue_status) by key name, against the local fake.
// The key value must never appear in anything printed, and nothing may be written.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { fakeClock, freshShell, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-entry-read-7d41c0b9e2a6";
const KEY_NAME = "ANTWARS_HOUSE_ENTRY_READ";

vi.setConfig({ testTimeout: 60_000 });

const fakes = [];
const dirs = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A key file holding `keyLines`, a fake entry server and a captured cli; no setup is run. */
async function harness({ keyLines = `OTHER_KEY="sk-other-1234"\n${KEY_NAME}=${JSON.stringify(KEY)}\n`, fakeOptions = {}, entryUrl } = {}) {
  const clock = fakeClock();
  const fake = await startFake({ key: KEY, clock, ...fakeOptions });
  fakes.push(fake);
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-entry-read-"));
  dirs.push(dir);
  writeFileSync(join(dir, "keys.env"), keyLines);
  const env = { ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: entryUrl ?? fake.url };
  const printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  const cli = (...argv) => main(["entry-read", ...argv], { env, clock, readStat: freshShell() });
  const output = () => printed.join("");
  /** Nothing but the key file is left in the folder: no state dir, no file. */
  const wroteNothing = () => {
    expect(existsSync(env.ANTWARS_SEAT_STATE)).toBe(false);
    expect(readdirSync(dir)).toEqual(["keys.env"]);
  };
  return { fake, cli, output, wroteNothing };
}

describe("entry-read allowed tools", () => {
  it("queue_status returns the server's reply for the named key and writes nothing", async () => {
    const h = await harness({ fakeOptions: { baseline: { state: "waiting", mode: "house-1v1", joinedAt: 1, expiresAt: 2 } } });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(0);
    expect(h.fake.toolCalls("queue_status")).toHaveLength(1);
    expect(h.fake.toolCalls("queue_status")[0].args).toEqual({ key: KEY });
    expect(JSON.parse(h.output())).toEqual({ queue: { state: "waiting", mode: "house-1v1", joinedAt: 1, expiresAt: 2 } });
    expect(h.output()).not.toContain(KEY);
    h.wroteNothing();
  });

  it("read_lobby passes its JSON arguments with the named key and returns the lobby state", async () => {
    const h = await harness({ fakeOptions: { lobbies: { "lobby-7": "open" } } });
    expect(await h.cli("read_lobby", "--key-name", KEY_NAME, '{"lobbyId":"lobby-7"}')).toBe(0);
    expect(h.fake.toolCalls("read_lobby")[0].args).toEqual({ lobbyId: "lobby-7", key: KEY });
    expect(JSON.parse(h.output())).toEqual({ lobby: { id: "lobby-7", state: "open" } });
    expect(h.output()).not.toContain(KEY);
    h.wroteNothing();
  });

  it("sends the named key even when the arguments carry another key", async () => {
    const h = await harness();
    expect(await h.cli("queue_status", "--key-name", KEY_NAME, '{"key":"sk-typed-on-the-line"}')).toBe(0);
    expect(h.fake.toolCalls("queue_status")[0].args.key).toBe(KEY);
  });

  it("accepts a raw (unquoted) key line and still never prints it", async () => {
    const h = await harness({ keyLines: `${KEY_NAME}=${KEY}\n` });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(0);
    expect(h.fake.toolCalls("queue_status")[0].args.key).toBe(KEY);
    expect(h.output()).not.toContain(KEY);
  });

  it("redacts the key from a successful reply that carries it", async () => {
    const h = await harness({ fakeOptions: { lobbies: { [KEY]: "open" } } });
    expect(await h.cli("read_lobby", "--key-name", KEY_NAME, JSON.stringify({ lobbyId: KEY }))).toBe(0);
    expect(h.fake.toolCalls("read_lobby")[0].result.content[0].text).toContain(KEY);
    expect(h.output()).toContain("[redacted]");
    expect(h.output()).not.toContain(KEY);
  });
});

describe("entry-read refusals", () => {
  for (const tool of ["join_queue", "leave_queue", "create_lobby", "join_lobby", "locate_match", "join", "observe", "pick_nest"]) {
    it(`refuses ${tool} without reading a key or sending anything`, async () => {
      const h = await harness();
      expect(await h.cli(tool, "--key-name", KEY_NAME, "{}")).toBe(1);
      expect(h.output()).toContain(`${tool} is refused and nothing was sent`);
      expect(h.fake.calls).toEqual([]);
      expect(h.output()).not.toContain(KEY);
      h.wroteNothing();
    });
  }

  it("prints its usage without a tool or a key name", async () => {
    const h = await harness();
    expect(await h.cli()).toBe(1);
    expect(await h.cli("queue_status")).toBe(1);
    expect(h.output()).toContain("usage: antwars-seat entry-read <read_lobby|queue_status> --key-name NAME");
    expect(h.fake.calls).toEqual([]);
  });
});

describe("entry-read key presence and failures never print the key", () => {
  it("a key name absent from the key file fails naming it, with nothing sent", async () => {
    const h = await harness();
    expect(await h.cli("queue_status", "--key-name", "ANTWARS_HOUSE_ABSENT")).toBe(1);
    expect(h.output()).toContain("Key ANTWARS_HOUSE_ABSENT not found");
    expect(h.output()).not.toContain(KEY);
    expect(h.output()).not.toContain("sk-other-1234");
    expect(h.fake.calls).toEqual([]);
    h.wroteNothing();
  });

  it("a malformed (non-JSON) quoted key line fails by key name without its content", async () => {
    const broken = "sk-antwars-broken-5a1e9c";
    const h = await harness({ keyLines: `${KEY_NAME}="${broken}\n` });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(1);
    expect(h.output()).toContain(`Key ${KEY_NAME}`);
    expect(h.output()).toContain("is not a JSON string");
    expect(h.output()).not.toContain(broken);
    expect(h.fake.calls).toEqual([]);
    h.wroteNothing();
  });

  it("an empty key line fails by key name", async () => {
    const h = await harness({ keyLines: `${KEY_NAME}=""\n` });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(1);
    expect(h.output()).toContain(`Key ${KEY_NAME}`);
    expect(h.output()).toContain("is empty");
    expect(h.fake.calls).toEqual([]);
  });

  it("malformed JSON arguments fail without printing the key or sending", async () => {
    const h = await harness();
    expect(await h.cli("read_lobby", "--key-name", KEY_NAME, `{"lobbyId":"${KEY}"`)).toBe(1);
    expect(h.output()).toContain("entry-read arguments are not valid JSON");
    expect(h.output()).not.toContain(KEY);
    expect(h.fake.calls).toEqual([]);
  });

  it("a server refusal exits 2 and prints the refusal without the key", async () => {
    const h = await harness({ fakeOptions: { key: "sk-antwars-server-only-key" } });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(2);
    expect(JSON.parse(h.output()).error).toBe("invalid_key");
    expect(h.output()).not.toContain(KEY);
    h.wroteNothing();
  });

  it("an HTTP failure exits 1 without the key", async () => {
    const h = await harness();
    h.fake.outage({ status: 503, ms: 60_000 });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(1);
    expect(h.output()).toContain("HTTP 503");
    expect(h.output()).not.toContain(KEY);
    h.wroteNothing();
  });

  it("an unreachable entry server exits 1 without the key", async () => {
    const h = await harness({ entryUrl: "http://127.0.0.1:1/mcp" });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(1);
    expect(h.output()).toContain("antwars-seat entry-read:");
    expect(h.output()).not.toContain(KEY);
    h.wroteNothing();
  });
});
