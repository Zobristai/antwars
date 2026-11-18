// entry-read: one read-only entry call (read_lobby or queue_status) by key name, against the local fake.
// The key value must never appear in anything printed, and nothing may be written.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../lib/cli.mjs";
import { fakeClock, freshShell, startFake } from "./fake-server.mjs";

const KEY = "sk-antwars-entry-read-7d41c0b9e2a6";
const KEY_NAME = "ANTWARS_HOUSE_ENTRY_READ";
const BIN = fileURLToPath(new URL("../bin/antwars-seat", import.meta.url));
const run = promisify(execFile);

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

  it("a comment line containing = does not redact matching text in the reply", async () => {
    const h = await harness({
      keyLines: `# expected queue state=waiting\n  # indented note=open\nnot a key line=holding\n${KEY_NAME}=${JSON.stringify(KEY)}\n`,
      fakeOptions: { baseline: { state: "waiting", mode: "house-1v1", joinedAt: 1, expiresAt: 2 }, lobbies: { "lobby-9": "open" } },
    });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(0);
    expect(await h.cli("read_lobby", "--key-name", KEY_NAME, '{"lobbyId":"lobby-9"}')).toBe(0);
    const [queue, lobby] = h.output().trim().split("\n").map((line) => JSON.parse(line));
    expect(queue.queue.state).toBe("waiting");
    expect(lobby.lobby.state).toBe("open");
    expect(h.output()).not.toContain("[redacted]");
    expect(h.output()).not.toContain(KEY);
  });

  it("redacts another long key from the key file when a reply carries it", async () => {
    const other = "sk-other-1234";
    const h = await harness({ fakeOptions: { baseline: { state: "waiting", mode: other, joinedAt: 1, expiresAt: 2 } } });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(0);
    expect(h.fake.toolCalls("queue_status")[0].result.content[0].text).toContain(other);
    expect(JSON.parse(h.output()).queue.mode).toBe("[redacted]");
    expect(h.output()).not.toContain(other);
  });
});

describe("entry-read refuses arguments carrying a key-file value", () => {
  const SHORT = "x9Q";
  const ODD = "sk-antwars-odd-name-31c8a0";
  const KEY_LINES = `SHORT_KEY="${SHORT}"\nmy-key=${JSON.stringify(ODD)}\nhouse key=${ODD}-raw\n${KEY_NAME}=${JSON.stringify(KEY)}\n`;
  // Each value is a lobby the fake would show, echoing its id, were the call sent.
  const lobbies = { [SHORT]: "open", [ODD]: "open", [`${ODD}-raw`]: "open", [KEY]: "open", [`lobby-${SHORT}`]: "open" };

  for (const [label, value] of [["a short key", SHORT], ["a key under a non-identifier name", ODD], ["a raw key under a name with a space", `${ODD}-raw`], ["the named key itself", KEY], ["a short key inside a longer string", `lobby-${SHORT}`]]) {
    it(`${label} passed in the arguments is refused unsent and never printed`, async () => {
      const h = await harness({ keyLines: KEY_LINES, fakeOptions: { lobbies } });
      expect(await h.cli("read_lobby", "--key-name", KEY_NAME, JSON.stringify({ lobbyId: value }))).toBe(1);
      expect(h.output()).toContain("entry-read arguments contain a value from the house key file; nothing was sent");
      expect(h.fake.calls).toEqual([]);
      for (const secret of [SHORT, ODD, KEY]) expect(h.output()).not.toContain(secret);
      h.wroteNothing();
    });
  }

  it("a key-file value as a property name, nested value or number is refused unsent", async () => {
    const h = await harness({ keyLines: `NUM_KEY=4711\n${KEY_LINES}` });
    for (const args of [{ [SHORT]: 1 }, { filter: { ids: ["a", SHORT] } }, { lobbyId: 4711 }]) {
      expect(await h.cli("read_lobby", "--key-name", KEY_NAME, JSON.stringify(args))).toBe(1);
    }
    expect(h.fake.calls).toEqual([]);
    expect(h.output()).not.toContain(SHORT);
    expect(h.output()).not.toContain("4711");
  });

  it("a comment line's text does not block an ordinary read", async () => {
    const h = await harness({ keyLines: `# resource=lobby\n  # note=lobby-9\n${KEY_NAME}=${JSON.stringify(KEY)}\n`, fakeOptions: { lobbies: { "lobby-9": "open" } } });
    expect(await h.cli("read_lobby", "--key-name", KEY_NAME, '{"lobbyId":"lobby-9"}')).toBe(0);
    expect(h.fake.toolCalls("read_lobby")[0].args).toEqual({ lobbyId: "lobby-9", key: KEY });
    expect(JSON.parse(h.output())).toEqual({ lobby: { id: "lobby-9", state: "open" } });
  });

  it("an empty key line blocks no argument", async () => {
    const h = await harness({ keyLines: `EMPTY_RAW=\nEMPTY_QUOTED=""\nEMPTY_SPACED=   \n${KEY_NAME}=${JSON.stringify(KEY)}\n`, fakeOptions: { lobbies: { 'lobby-""-9': "open" } } });
    expect(await h.cli("read_lobby", "--key-name", KEY_NAME, JSON.stringify({ lobbyId: 'lobby-""-9' }))).toBe(0);
    expect(h.fake.toolCalls("read_lobby")).toHaveLength(1);
    expect(JSON.parse(h.output()).lobby.id).toBe('lobby-""-9');
  });

  it("the fake echoes a lobby id it is sent, so an unrefused short key would print", async () => {
    const h = await harness({ fakeOptions: { lobbies: { [SHORT]: "open" } } });
    expect(await h.cli("read_lobby", "--key-name", KEY_NAME, JSON.stringify({ lobbyId: SHORT }))).toBe(0);
    expect(JSON.parse(h.output()).lobby.id).toBe(SHORT);
  });

  it("a short key and a non-identifier key in the arguments are refused (separate process)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "antwars-seat-entry-read-bin-"));
    dirs.push(dir);
    writeFileSync(join(dir, "keys.env"), KEY_LINES);
    const env = { PATH: process.env.PATH, ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: "http://127.0.0.1:1/mcp" };
    for (const value of [SHORT, ODD]) {
      const result = await run(process.execPath, [BIN, "entry-read", "read_lobby", "--key-name", KEY_NAME, JSON.stringify({ lobbyId: value })], { env, cwd: dir }).then(
        () => ({ code: 0, stdout: "", stderr: "" }), (error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("nothing was sent");
      for (const secret of [SHORT, ODD, KEY]) expect(result.stdout + result.stderr).not.toContain(secret);
    }
    expect(readdirSync(dir)).toEqual(["keys.env"]);
  });
});

describe("entry-read refusals", () => {
  for (const tool of ["join_queue", "leave_queue", "create_lobby", "join_lobby", "locate_match", "join", "observe", "pick_nest"]) {
    it(`refuses ${tool} without reading a key or sending anything`, async () => {
      const h = await harness();
      expect(await h.cli(tool, "--key-name", KEY_NAME, "{}")).toBe(1);
      expect(h.output()).toContain("that tool is refused and nothing was sent");
      expect(h.output()).not.toContain(tool);
      expect(h.fake.calls).toEqual([]);
      expect(h.output()).not.toContain(KEY);
      h.wroteNothing();
    });
  }

  it("a key value typed in the tool position is refused without printing it (separate process)", async () => {
    const value = "sk-antwars-misplaced-3e8b1f72";
    const dir = mkdtempSync(join(tmpdir(), "antwars-seat-entry-read-bin-"));
    dirs.push(dir);
    writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(value)}\n`);
    const env = { PATH: process.env.PATH, ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: "http://127.0.0.1:1/mcp" };
    const result = await run(process.execPath, [BIN, "entry-read", value, "--key-name", KEY_NAME], { env, cwd: dir }).then(
      () => ({ code: 0, stdout: "", stderr: "" }), (error) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("that tool is refused and nothing was sent");
    expect(result.stdout + result.stderr).not.toContain(value);
    expect(readdirSync(dir)).toEqual(["keys.env"]);
  });

  it("a key value typed as --key-name is never echoed (separate process)", async () => {
    const value = "sk-antwars-as-name-9c2d4e61";
    const dir = mkdtempSync(join(tmpdir(), "antwars-seat-entry-read-bin-"));
    dirs.push(dir);
    writeFileSync(join(dir, "keys.env"), `OTHER_KEY=sk-antwars-raw-other-41aa\n${KEY_NAME}=${JSON.stringify(value)}\n`);
    const env = { PATH: process.env.PATH, ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: "http://127.0.0.1:1/mcp" };
    for (const typed of [value, "sk-antwars-raw-other-41aa"]) {
      const result = await run(process.execPath, [BIN, "entry-read", "queue_status", "--key-name", typed], { env, cwd: dir }).then(
        () => ({ code: 0, stdout: "", stderr: "" }), (error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("nothing was sent");
      expect(result.stdout + result.stderr).not.toContain(typed);
    }
    expect(readdirSync(dir)).toEqual(["keys.env"]);
  });

  it("a key shorter than four characters is refused unsent, and is never printed (separate process)", async () => {
    const short = "q7Z";
    const dir = mkdtempSync(join(tmpdir(), "antwars-seat-entry-read-bin-"));
    dirs.push(dir);
    writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(short)}\nRAW_SHORT=Wq9\n`);
    const env = { PATH: process.env.PATH, ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: "http://127.0.0.1:1/mcp" };
    const cases = [
      [["--key-name", KEY_NAME], "shorter than 4 characters, too short to keep out of output; nothing was sent"],
      [["--key-name", "RAW_SHORT"], "shorter than 4 characters"],
      // A short value typed where its name belongs is not a key name in the file, and is not echoed.
      [["--key-name", "Wq9"], "the named key is not in the house key file"],
    ];
    for (const [flags, message] of cases) {
      const result = await run(process.execPath, [BIN, "entry-read", "queue_status", ...flags], { env, cwd: dir }).then(
        () => ({ code: 0, stdout: "", stderr: "" }), (error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout + result.stderr).not.toContain(short);
      expect(result.stdout + result.stderr).not.toContain("Wq9");
    }
    expect(readdirSync(dir)).toEqual(["keys.env"]);
  });

  it("a short key is refused before anything is sent", async () => {
    const h = await harness({ keyLines: `${KEY_NAME}="q7Z"\n` });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(1);
    expect(h.fake.calls).toEqual([]);
    expect(h.output()).not.toContain("q7Z");
    h.wroteNothing();
  });

  it("a key name that is not a plain identifier is refused without echoing it (separate process)", async () => {
    const value = "sk-antwars-odd-name-6f0b2d";
    const dir = mkdtempSync(join(tmpdir(), "antwars-seat-entry-read-bin-"));
    dirs.push(dir);
    // readKey would accept "my-key" and "house key" as names; entry-read takes neither, so neither value can be sent.
    writeFileSync(join(dir, "keys.env"), `my-key=${JSON.stringify(value)}\nhouse key=${value}-raw\n${KEY_NAME}=${JSON.stringify(KEY)}\n`);
    const env = { PATH: process.env.PATH, ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_SEAT_STATE: join(dir, "state"), ANTWARS_ENTRY_URL: "http://127.0.0.1:1/mcp" };
    for (const typed of ["my-key", "house key", value, `${value}-raw`, `"${value}"`]) {
      const result = await run(process.execPath, [BIN, "entry-read", "queue_status", "--key-name", typed], { env, cwd: dir }).then(
        () => ({ code: 0, stdout: "", stderr: "" }), (error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("a key name is letters, digits and _ only");
      expect(result.stdout + result.stderr).not.toContain(typed);
      expect(result.stdout + result.stderr).not.toContain(value);
    }
    expect(readdirSync(dir)).toEqual(["keys.env"]);
  });

  it("prints its usage without a tool or a key name", async () => {
    const h = await harness();
    expect(await h.cli()).toBe(1);
    expect(await h.cli("queue_status")).toBe(1);
    expect(h.output()).toContain("usage: antwars-seat entry-read <read_lobby|queue_status> --key-name NAME");
    expect(h.fake.calls).toEqual([]);
  });
});

describe("entry-read key presence and failures never print the key", () => {
  it("a key name absent from the key file fails without echoing the name, with nothing sent", async () => {
    const h = await harness();
    expect(await h.cli("queue_status", "--key-name", "ANTWARS_HOUSE_ABSENT")).toBe(1);
    expect(h.output()).toContain("the named key is not in the house key file; nothing was sent");
    expect(h.output()).not.toContain("ANTWARS_HOUSE_ABSENT");
    expect(h.output()).not.toContain(KEY);
    expect(h.output()).not.toContain("sk-other-1234");
    expect(h.fake.calls).toEqual([]);
    h.wroteNothing();
  });

  it("a malformed (non-JSON) quoted key line fails without its content or name", async () => {
    const broken = "sk-antwars-broken-5a1e9c";
    const h = await harness({ keyLines: `${KEY_NAME}="${broken}\n` });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(1);
    expect(h.output()).toContain("the named key's line is not a JSON string");
    expect(h.output()).not.toContain(KEY_NAME);
    expect(h.output()).not.toContain(broken);
    expect(h.fake.calls).toEqual([]);
    h.wroteNothing();
  });

  it("an empty key line fails without the name", async () => {
    const h = await harness({ keyLines: `${KEY_NAME}=""\n` });
    expect(await h.cli("queue_status", "--key-name", KEY_NAME)).toBe(1);
    expect(h.output()).toContain("the named key is empty");
    expect(h.output()).not.toContain(KEY_NAME);
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
