// One game command per shell command: a game command (any match tool other
// than observe and rules) started by the same shell command as an earlier one
// is refused without being sent; a game command in its own shell command is
// sent. Each shell command here is a real `bash -c` started in a new process
// session, as a seat's shell runs each command; the harness is the real bin.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claimGameCommand, isGameCommand, refusalMessage, shellCommandKey } from "../lib/guard.mjs";
import { startFake, statLine } from "./fake-server.mjs";

const KEY = "a".repeat(24); // a stand-in seat key
const KEY_NAME = "ANTWARS_HOUSE_TEST_SEAT";
const BIN = fileURLToPath(new URL("../bin/antwars-seat", import.meta.url));
const REFUSED = "refused, not sent: this shell command has already sent a game command";
const linux = existsSync("/proc/self/stat");

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A seat joined to a fake match through go; shell(script) runs one shell command in a new session. */
async function joinedSeat() {
  const fake = await startFake({ key: KEY, pairAfterMs: 0 });
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-one-"));
  cleanups.push(async () => {
    if (existsSync(join(dir, ".antwars-seat", "state"))) writeFileSync(join(dir, ".antwars-seat", "state", "observer.stop"), "stop\n");
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "keys.env"), `${KEY_NAME}=${JSON.stringify(KEY)}\n`);
  const env = { ...process.env, ANTWARS_KEY_FILE: join(dir, "keys.env"), ANTWARS_ENTRY_URL: fake.url, ANTWARS_MIN_CALL_MS: "0",
    ANTWARS_POLL_MS: "20", S: `${process.execPath} ${BIN}` };
  const shell = (script) => new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  const setup = await shell(`$S setup --handle antwars/test --key-name ${KEY_NAME} --mode house-1v1 --model-label m --thinking-level high && $S go`);
  expect(setup.code).toBe(0);
  const state = (name) => readFileSync(join(dir, ".antwars-seat", "state", name), "utf8");
  return { fake, dir, env, shell, state };
}

const ORDER = (n) => `$S order --ants '[${n}]'`;
const refusals = (output) => output.split(REFUSED).length - 1;

describe.runIf(linux)("one game command per shell command (real shells)", () => {
  it("a game command in each of two separate shell commands is sent both times", async () => {
    const s = await joinedSeat();
    expect((await s.shell(ORDER(1))).code).toBe(0);
    expect((await s.shell(ORDER(2))).code).toBe(0);
    expect(s.fake.orders()).toEqual([{ ants: [1] }, { ants: [2] }]);
  }, 30_000);

  const FORMS = [
    { name: "a ; chain", script: `${ORDER(1)}; ${ORDER(2)}`, refused: 1 },
    { name: "an && chain (order then pick_nest)", script: `${ORDER(1)} && $S pick_nest --tileX 3 --tileY 1`, refused: 1 },
    { name: "a for loop with sleep", script: `for i in 1 2 3; do ${ORDER("$i")}; sleep 0.2; done`, refused: 2 },
    { name: "a while loop", script: `i=0; while [ $i -lt 3 ]; do i=$((i+1)); ${ORDER("$i")}; done`, refused: 2 },
    { name: "background jobs started together", script: `${ORDER(1)} & ${ORDER(2)} & ${ORDER(3)} & wait`, refused: 2 },
    { name: "nohup background jobs", script: `nohup ${ORDER(1)} > n1.out 2>&1 & nohup ${ORDER(2)} > n2.out 2>&1 & wait; cat n1.out n2.out`, refused: 1 },
    { name: "wrapper shells (bash -c, sh -c)", script: `bash -c "${ORDER(1)}"; sh -c "${ORDER(2)}; :"`, refused: 1 },
    { name: "the generic call form", script: `$S call order '{"ants":[1]}'; $S call order '{"ants":[2]}'`, refused: 1 },
  ];

  it.each(FORMS)("$name: exactly one game command is sent and the rest are refused, saying why", async ({ script, refused }) => {
    const s = await joinedSeat();
    const run = await s.shell(script);
    expect(s.fake.orders().length + s.fake.toolCalls("pick_nest").length).toBe(1);
    expect(refusals(run.output)).toBe(refused);
    expect(run.output).toContain("one game command (any match tool other than observe and rules) per shell command");
  }, 30_000);

  it("a script file and a node script spawning the harness: one game command sent, the rest refused", async () => {
    const s = await joinedSeat();
    writeFileSync(join(s.dir, "play.sh"), `${ORDER(1)}\n${ORDER(2)}\n${ORDER(3)}\n`);
    writeFileSync(join(s.dir, "play.mjs"), `import { spawnSync } from "node:child_process";
for (const n of [4, 5]) {
  const r = spawnSync(process.execPath, [${JSON.stringify(BIN)}, "order", "--ants", "[" + n + "]"], { encoding: "utf8" });
  process.stdout.write(r.stdout + r.stderr);
}
`);
    const script = await s.shell("sh ./play.sh");
    expect(s.fake.orders()).toEqual([{ ants: [1] }]);
    expect(refusals(script.output)).toBe(2);
    const node = await s.shell("node ./play.mjs");
    expect(s.fake.orders()).toEqual([{ ants: [1] }, { ants: [4] }]);
    expect(refusals(node.output)).toBe(1);
  }, 30_000);

  it("observe and rules are never refused or counted, before or after the game command", async () => {
    const s = await joinedSeat();
    const run = await s.shell(`$S observe; echo "x:$?"; $S rules; echo "x:$?"; ${ORDER(1)}; echo "x:$?"; $S observe; echo "x:$?"; `
      + `$S board; echo "x:$?"; $S rules; echo "x:$?"; $S call observe; echo "x:$?"; $S call rules; echo "x:$?"`);
    expect(run.output.match(/x:\d+/g)).toEqual(Array(8).fill("x:0"));
    expect(s.fake.orders()).toHaveLength(1);
    expect(s.fake.toolCalls("observe").filter((c) => c.server === "match")).toHaveLength(4);
    expect(s.fake.toolCalls("rules")).toHaveLength(3);
  }, 30_000);

  it("a refused game command is logged in progress.log with the tool and reason only; nothing about the key is logged", async () => {
    const s = await joinedSeat();
    await s.shell(`${ORDER(1)}; $S pick_nest --tileX 3 --tileY 1`);
    const refused = s.state("progress.log").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.step === "game_command_refused");
    expect(refused).toHaveLength(1);
    expect(Object.keys(refused[0]).sort()).toEqual(["at", "reason", "step", "tool"]);
    expect(refused[0]).toMatchObject({ tool: "pick_nest", reason: "second_in_shell_command" });
    expect(s.state("progress.log")).not.toContain(KEY);
  }, 30_000);

  it("the observer's own calls are not counted: a game command in the shell command that started it is sent, and the observer sends only observe", async () => {
    const s = await joinedSeat();
    const before = s.fake.calls.length;
    const run = await s.shell(`$S observer start --interval 1; ${ORDER(1)}`);
    expect(run.code).toBe(0);
    expect(s.fake.orders()).toEqual([{ ants: [1] }]);
    for (let i = 0; i < 100 && s.fake.toolCalls("observe").filter((c) => c.server === "match").length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect((await s.shell(ORDER(2))).code).toBe(0);
    expect((await s.shell("$S observer stop")).code).toBe(0);
    const tools = s.fake.calls.slice(before).filter((c) => c.server === "match" && c.tool).map((c) => c.tool);
    expect(new Set(tools)).toEqual(new Set(["observe", "order"]));
    expect(tools.filter((t) => t === "order")).toHaveLength(2);
    expect(tools.filter((t) => t === "observe").length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("many processes of one shell command racing for the claim: exactly one game command is sent", async () => {
    const s = await joinedSeat();
    const run = await s.shell(`for i in 1 2 3 4 5 6 7 8; do ${ORDER("$i")} & done; wait`);
    expect(s.fake.orders()).toHaveLength(1);
    expect(refusals(run.output)).toBe(7);
  }, 30_000);

  it("commands typed one after another into one long-lived shell share its session: only its first game command is sent", async () => {
    const s = await joinedSeat();
    const shell = spawn("bash", ["-s"], { cwd: s.dir, env: s.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    shell.stdout.on("data", (chunk) => { output += chunk; });
    shell.stderr.on("data", (chunk) => { output += chunk; });
    const closed = new Promise((resolve) => shell.on("close", resolve));
    const typed = async (line, marker) => {
      shell.stdin.write(`${line}; echo ${marker}\n`);
      for (let i = 0; i < 200 && !output.includes(marker); i += 1) await new Promise((r) => setTimeout(r, 25));
    };
    await typed(ORDER(1), "done-1");
    await typed("$S observe", "done-2");
    await typed(ORDER(2), "done-3");
    shell.stdin.end();
    await closed;
    expect(s.fake.orders()).toEqual([{ ants: [1] }]);
    expect(refusals(output)).toBe(1);
    expect((await s.shell(ORDER(3))).code).toBe(0); // a new shell is a new session
    expect(s.fake.orders()).toEqual([{ ants: [1] }, { ants: [3] }]);
  }, 30_000);

  it("a game command whose shell command has already ended is refused, not sent", async () => {
    const s = await joinedSeat();
    const run = await s.shell(`(sleep 1; ${ORDER(1)} > late.out 2>&1) > /dev/null 2>&1 & exit 0`);
    expect(run.code).toBe(0);
    for (let i = 0; i < 100 && !(existsSync(join(s.dir, "late.out")) && readFileSync(join(s.dir, "late.out"), "utf8")); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(join(s.dir, "late.out"), "utf8")).toContain("refused, not sent: the shell command that started it has already ended");
    expect(s.fake.orders()).toHaveLength(0);
  }, 30_000);
});

describe("guard keys and records", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  const stateEnv = () => {
    const dir = mkdtempSync(join(tmpdir(), "antwars-seat-guard-"));
    dirs.push(dir);
    return { env: { ANTWARS_SEAT_STATE: dir }, dir };
  };
  /** readStat over a table pid -> stat line; "self" names the calling process's pid. */
  const procTable = (self, table) => (pid) => {
    const line = table[pid === "self" ? self : pid];
    if (!line) throw new Error("no such process");
    return line;
  };

  it("game commands are every tool but observe and rules", () => {
    for (const tool of ["order", "pick_nest", "count_mark", "set_brood", "anything"]) expect(isGameCommand(tool)).toBe(true);
    for (const tool of ["observe", "rules"]) expect(isGameCommand(tool)).toBe(false);
  });

  it("the key is the session id and its leader's start time; a process in that session shares it", () => {
    const table = { 500: statLine({ pid: 500, sid: 500, start: 4242 }), 507: statLine({ pid: 507, sid: 500, start: 4300 }) };
    expect(shellCommandKey(procTable(507, table))).toEqual({ status: "ok", sid: 500, start: "4242" });
    expect(shellCommandKey(procTable(500, table))).toEqual({ status: "ok", sid: 500, start: "4242" });
  });

  it("parses a command name holding spaces and parentheses", () => {
    const table = { 9: "9 (a b) c)) S 1 9 9 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 77 0 0\n" };
    expect(shellCommandKey(procTable(9, table))).toEqual({ status: "ok", sid: 9, start: "77" });
  });

  it("no /proc: the guard cannot key the command and allows it, writing no record", () => {
    const { env, dir } = stateEnv();
    const noProc = () => { throw new Error("ENOENT"); };
    expect(claimGameCommand(env, noProc)).toEqual({ allowed: true });
    expect(claimGameCommand(env, noProc)).toEqual({ allowed: true });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leader gone, a zombie leader, or its pid now held by a process that leads no session: refused as ended", () => {
    const { env } = stateEnv();
    const gone = { 601: statLine({ pid: 601, sid: 600, start: 10 }) };
    const zombie = { ...gone, 600: statLine({ pid: 600, sid: 600, start: 5 }).replace(" S ", " Z ") };
    const reused = { ...gone, 600: statLine({ pid: 600, sid: 1, start: 99 }) };
    for (const table of [gone, zombie, reused]) {
      expect(shellCommandKey(procTable(601, table))).toEqual({ status: "leader_gone" });
      expect(claimGameCommand(env, procTable(601, table))).toEqual({ allowed: false, reason: "shell_command_ended" });
    }
  });

  it("one claim per key; a record left by an ended session whose leader pid is reused does not refuse the new session", () => {
    const { env, dir } = stateEnv();
    const first = procTable(700, { 700: statLine({ pid: 700, sid: 700, start: 1 }) });
    expect(claimGameCommand(env, first)).toEqual({ allowed: true });
    expect(claimGameCommand(env, first)).toEqual({ allowed: false, reason: "second_in_shell_command" });
    const reusedPid = procTable(700, { 700: statLine({ pid: 700, sid: 700, start: 2 }) });
    expect(claimGameCommand(env, reusedPid)).toEqual({ allowed: true });
    expect(readdirSync(dir)).toEqual(["game-command.700.2"]);
    expect(claimGameCommand(env, reusedPid)).toEqual({ allowed: false, reason: "second_in_shell_command" });
  });

  it("a live session's record refuses by its name alone, whatever its content, even while its creator has not finished with it", () => {
    const { env, dir } = stateEnv();
    const table = { 710: statLine({ pid: 710, sid: 710, start: 3 }) };
    writeFileSync(join(dir, "game-command.710.3"), ""); // made by the exclusive create, nothing written yet
    expect(claimGameCommand(env, procTable(710, table))).toEqual({ allowed: false, reason: "second_in_shell_command" });
    writeFileSync(join(dir, "game-command.710.3"), "anything");
    expect(claimGameCommand(env, procTable(710, table))).toEqual({ allowed: false, reason: "second_in_shell_command" });
    expect(readdirSync(dir)).toEqual(["game-command.710.3"]);
  });

  it("another session's claim never drops a live session's record, so that session's next game command is still refused", () => {
    const { env, dir } = stateEnv();
    const table = { 720: statLine({ pid: 720, sid: 720, start: 4 }), 721: statLine({ pid: 721, sid: 721, start: 5 }) };
    expect(claimGameCommand(env, procTable(720, table))).toEqual({ allowed: true });
    expect(claimGameCommand(env, procTable(721, table))).toEqual({ allowed: true });
    expect(readdirSync(dir).sort()).toEqual(["game-command.720.4", "game-command.721.5"]);
    expect(claimGameCommand(env, procTable(720, table))).toEqual({ allowed: false, reason: "second_in_shell_command" });
  });

  it("a leader that exits after the key is read: the earlier claim is pruned, and the new claim is refused as ended", () => {
    const { env, dir } = stateEnv();
    const leader = statLine({ pid: 730, sid: 730, start: 8 });
    const first = procTable(731, { 730: leader, 731: statLine({ pid: 731, sid: 730, start: 9 }) });
    expect(claimGameCommand(env, first)).toEqual({ allowed: true });
    expect(readdirSync(dir)).toEqual(["game-command.730.8"]);
    // The second process of the same shell command sees the leader live when it reads its key,
    // and gone on every later read (the prune and the check after its record is made).
    let leaderReads = 0;
    const second = (pid) => {
      if (pid === "self") return statLine({ pid: 732, sid: 730, start: 10 });
      if (pid === 730 && leaderReads++ === 0) return leader;
      throw new Error("no such process");
    };
    expect(claimGameCommand(env, second)).toEqual({ allowed: false, reason: "shell_command_ended" });
    expect(leaderReads).toBe(3);
  });

  it("records of sessions whose leader has exited are dropped; a live session's record is kept", () => {
    const { env, dir } = stateEnv();
    writeFileSync(join(dir, "game-command.801.5"), ""); // leader gone
    writeFileSync(join(dir, "game-command.802.6"), ""); // pid reused by a later session
    writeFileSync(join(dir, "game-command.803.7"), ""); // still live
    writeFileSync(join(dir, "last-call"), "0");
    const table = { 802: statLine({ pid: 802, sid: 802, start: 60 }), 803: statLine({ pid: 803, sid: 803, start: 7 }),
      900: statLine({ pid: 900, sid: 900, start: 1 }) };
    expect(claimGameCommand(env, procTable(900, table))).toEqual({ allowed: true });
    expect(readdirSync(dir).sort()).toEqual(["game-command.803.7", "game-command.900.1", "last-call"]);
  });

  it("the refusal says what was refused and why", () => {
    expect(refusalMessage("order", "second_in_shell_command")).toBe("order refused, not sent: this shell command has already sent a game command. "
      + "The harness sends at most one game command (any match tool other than observe and rules) per shell command; send the next game command in its own shell command.");
  });
});
