/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractMatchLog } from "../tools/summary.js";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { COMPARISON_SEED, comparisonOptions, lobbySlotOptions, MATCH_LOG_PREFIX, slotOptions, startServer, type GameServer } from "../../src/server.js";
import { PUBLIC_CONFIG, rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { replay, stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { startHarness, type Harness } from "../mcp/harness.js";
import { connect, matchLogs, tempDir, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

const randomSeed = vi.hoisted(() => vi.fn<(max: number) => number>(() => 12345));
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomInt: randomSeed }));

const ROOT = join(import.meta.dirname, "..", "..");

describe("ANTWAR_RULES and ANTWAR_PLAYERS, read once at start-up", () => {
  it("unset selects only public redesign and never reads ANTWAR_PLAYERS", () => {
    const expected = { simConfig: newMatchConfig(rulesConfig("redesign")) };
    expect(comparisonOptions({}, DEFAULT_MCP_CONFIG)).toEqual(expected);
    expect(comparisonOptions({ ANTWAR_PLAYERS: "nonsense" }, DEFAULT_MCP_CONFIG)).toEqual(expected);
  });

  it("set, it selects the rules and holds one seeded match for exactly that many players", () => {
    for (const rules of ["redesign"] as const) {
      for (const players of [2, 4] as const) {
        const o = comparisonOptions({ ANTWAR_RULES: rules, ANTWAR_PLAYERS: String(players) }, DEFAULT_MCP_CONFIG);
        expect(o).toMatchObject({ match: "held", expectedPlayers: players, seed: COMPARISON_SEED, matchLogStdout: true, includeComparisonSetup: true });
        expect(o.mcpConfig).toEqual({ ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players });
        expect(o.simConfig).toEqual({ ...newMatchConfig(rulesConfig(rules)), players });
      }
    }
  });

  it("refuses a bad rules value, and a missing or bad player count when rules are set", () => {
    expect(() => comparisonOptions({ ANTWAR_RULES: "v5", ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG)).toThrow(/ANTWAR_RULES/);
    for (const players of [undefined, "", "3", "02", "four"]) {
      expect(() => comparisonOptions({ ANTWAR_RULES: "redesign", ...(players === undefined ? {} : { ANTWAR_PLAYERS: players }) }, DEFAULT_MCP_CONFIG)).toThrow(/ANTWAR_PLAYERS must be 2 or 4/);
    }
  });

  // Under v4 and count-marks the house bot moves for a player's colony, so no new match starts on them;
  // their recordings still re-simulate as recorded.
  it("refuses v4 and count-marks, whatever the player count", () => {
    for (const rules of ["v4", "count-marks"]) {
      for (const players of [undefined, "2", "4"]) {
        expect(() => comparisonOptions({ ANTWAR_RULES: rules, ...(players === undefined ? {} : { ANTWAR_PLAYERS: players }) }, DEFAULT_MCP_CONFIG))
          .toThrow(`ANTWAR_RULES=${rules} no longer starts a match: under those rules the house bot moves for a player's colony. New matches play redesign; ${rules} recordings still re-simulate as recorded`);
      }
    }
  });

  it("the server refuses to start, with a clear message, on a bad value", () => {
    for (const env of [{ ANTWAR_RULES: "bogus", ANTWAR_PLAYERS: "2" }, { ANTWAR_RULES: "redesign" }, { ANTWAR_RULES: "v4", ANTWAR_PLAYERS: "2" }, { ANTWAR_RULES: "count-marks", ANTWAR_PLAYERS: "4" }]) {
      const base: NodeJS.ProcessEnv = { ...process.env };
      delete base.ANTWAR_RULES;
      delete base.ANTWAR_PLAYERS;
      const r = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "src/main.ts"], {
        cwd: ROOT,
        env: { ...base, ...env, PORT: "0", DATA_DIR: tempDir() },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/antwar refused to start: ANTWAR_(RULES|PLAYERS)/);
      if (env.ANTWAR_RULES === "v4" || env.ANTWAR_RULES === "count-marks") expect(r.stderr).toContain(`ANTWAR_RULES=${env.ANTWAR_RULES} no longer starts a match`);
    }
  }, 45_000);
});

// Comparison and local runs never become slot servers, so they never reach live lobby data.
describe("slot settings: ANTWAR_SLOT, read once at start-up", () => {
  const slotEnv = { ANTWAR_SLOT: "public-0", ANTWAR_PUBLIC_URL: "https://slot.example/", ANTWAR_STORE_NAMESPACE: "live" };

  it("unset or empty is not a slot server; set, it names the slot and this instance's origin", () => {
    expect(slotOptions({})).toBeUndefined();
    expect(slotOptions({ ANTWAR_SLOT: "", ANTWAR_RULES: "v4", ANTWAR_PLAYERS: "2" })).toBeUndefined();
    expect(slotOptions(slotEnv)).toEqual({ slot: "public-0", publicUrl: "https://slot.example" });
    // Cloud Run's revision, when set, is the one a starting instance compares with the slot owner's.
    expect(slotOptions({ ...slotEnv, K_REVISION: "antwar-public-0-00031-abc" })).toEqual({ slot: "public-0", publicUrl: "https://slot.example", revision: "antwar-public-0-00031-abc" });
    expect(slotOptions({ ...slotEnv, K_REVISION: "" })).toEqual({ slot: "public-0", publicUrl: "https://slot.example" });
    expect(slotOptions({ ...slotEnv, ANTWAR_SLOT: "private-1" })?.slot).toBe("private-1");
  });

  it("refuses comparison settings, a bad slot, and a missing store or public origin", () => {
    expect(() => slotOptions({ ...slotEnv, ANTWAR_RULES: "v4", ANTWAR_PLAYERS: "2" })).toThrow(/ANTWAR_SLOT cannot be combined/);
    expect(() => slotOptions({ ...slotEnv, ANTWAR_PLAYERS: "2" })).toThrow(/ANTWAR_SLOT cannot be combined/);
    expect(() => slotOptions({ ...slotEnv, ANTWAR_SLOT: "public" })).toThrow(/ANTWAR_SLOT must be/);
    expect(() => slotOptions({ ...slotEnv, ANTWAR_STORE_NAMESPACE: "" })).toThrow(/ANTWAR_STORE_NAMESPACE/);
    expect(() => slotOptions({ ...slotEnv, ANTWAR_PUBLIC_URL: undefined })).toThrow(/ANTWAR_PUBLIC_URL/);
    expect(() => slotOptions({ ...slotEnv, ANTWAR_PUBLIC_URL: "ftp://slot.example" })).toThrow(/ANTWAR_PUBLIC_URL/);
  });

  it("npm start refuses a valid comparison run combined with ANTWAR_SLOT", () => {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["ANTWAR_RULES", "ANTWAR_PLAYERS", "ANTWAR_SLOT", "ANTWAR_PUBLIC_URL", "ANTWAR_STORE_NAMESPACE"]) delete base[name];
    const r = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "src/main.ts"], {
      cwd: ROOT,
      env: { ...base, ANTWAR_RULES: "v4", ANTWAR_PLAYERS: "2", ...slotEnv, PORT: "0", DATA_DIR: tempDir() },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/antwar refused to start: ANTWAR_SLOT/);
  }, 30_000);
});

describe("ANTWAR_PUBLIC_SLOTS and ANTWAR_PRIVATE_SLOTS, read once at start-up", () => {
  it("unset or empty is one public and one private slot, as before; set, each is that many", () => {
    expect(lobbySlotOptions({})).toEqual({ publicSlots: 1, privateSlots: 1 });
    expect(lobbySlotOptions({ ANTWAR_PUBLIC_SLOTS: "", ANTWAR_PRIVATE_SLOTS: "" })).toEqual({ publicSlots: 1, privateSlots: 1 });
    expect(lobbySlotOptions({ ANTWAR_PUBLIC_SLOTS: "3", ANTWAR_PRIVATE_SLOTS: "2" })).toEqual({ publicSlots: 3, privateSlots: 2 });
    expect(lobbySlotOptions({ ANTWAR_PRIVATE_SLOTS: "12" })).toEqual({ publicSlots: 1, privateSlots: 12 });
  });

  it("refuses anything but a positive whole number, and npm start refuses to start", () => {
    for (const bad of ["0", "-1", "1.5", "two", " 2", "02"]) {
      expect(() => lobbySlotOptions({ ANTWAR_PUBLIC_SLOTS: bad })).toThrow(/ANTWAR_PUBLIC_SLOTS must be/);
      expect(() => lobbySlotOptions({ ANTWAR_PRIVATE_SLOTS: bad })).toThrow(/ANTWAR_PRIVATE_SLOTS must be/);
    }
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["ANTWAR_RULES", "ANTWAR_PLAYERS", "ANTWAR_SLOT", "ANTWAR_PUBLIC_URL", "ANTWAR_STORE_NAMESPACE", "ANTWAR_PUBLIC_SLOTS", "ANTWAR_PRIVATE_SLOTS"]) delete base[name];
    const r = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "src/main.ts"], {
      cwd: ROOT,
      env: { ...base, ANTWAR_PUBLIC_SLOTS: "0", PORT: "0", DATA_DIR: tempDir() },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/antwar refused to start: ANTWAR_PUBLIC_SLOTS/);
  }, 30_000);
});

describe("the join barrier, the headers and the stdout recording", () => {
  let server: GameServer | null = null;
  const agents: Agent[] = [];
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close();
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  async function barrier(players: 2 | 4, rules: "v4" | "count-marks" | "redesign") {
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = String(chunk);
      if (text.startsWith(MATCH_LOG_PREFIX)) {
        printed.push(...text.split("\n").filter((l) => l !== ""));
        return true;
      }
      return write(chunk as string, ...(rest as []));
    }) as typeof process.stdout.write);
    const dataDir = tempDir();
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, ...comparisonOptions({ ANTWAR_RULES: rules, ANTWAR_PLAYERS: String(players) }, DEFAULT_MCP_CONFIG) });
    const joins = [];
    for (let i = 0; i < players; i++) {
      const agent = await connect(server.port);
      agents.push(agent);
      if (i < players - 1) {
        joins.push(await agent.call("join", { modelLabel: `model-${i}` }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(server.game.match).toBeNull();
      } else {
        joins.push(await agent.call("join", { modelLabel: `model-${i}` }));
      }
    }
    // Let the initial join-only tick settle before rules reads add observe inputs.
    await waitFor(() => (server!.game.match?.state.tick ?? 0) >= 3);
    const mcpConfig = { ...DEFAULT_MCP_CONFIG, maxAgentsPerMatch: players };
    for (const [index, j] of joins.entries()) {
      expect(j.isError, j.text).toBe(false);
      expect(j.data.reconnectToken).toMatch(/\S/);
      // Joined at the barrier, before the seed draws the map.
      expect(j.data.briefing).toBe(joinBriefing({ ...newMatchConfig(rulesConfig(rules)), players }, mcpConfig, false, { house: false, undrawn: true, local: true }));
      const full = await agents[index]!.call("rules", {});
      expect(full.isError, full.text).toBe(false);
      expect(full.data.rules).toBe(briefing(createMatch(COMPARISON_SEED, { ...newMatchConfig(rulesConfig(rules)), players }).config, mcpConfig, { house: false, local: true }));
    }
    return { dataDir, printed };
  }

  it("holds tick 0 until both players of a 1v1 have joined, then starts one match with seed 6006 and refuses a third", async () => {
    const { dataDir, printed } = await barrier(2, "redesign");
    const match = server!.game.match!;
    expect(match.seed).toBe(COMPARISON_SEED);
    expect(match.state.agents).toHaveLength(2);
    const extra = await connect(server!.port);
    agents.push(extra);
    const refused = await extra.call("join", {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/agent_cap/);

    const file = readFileSync([...matchLogs(dataDir).values()][0]!, "utf8").split("\n").filter((l) => l !== "");
    const header = JSON.parse(file[0]!);
    expect(header).toMatchObject({ type: "header", seed: COMPARISON_SEED, rulesVersion: 27, config: { rules: "redesign", players: 2 } });
    const first = JSON.parse(file[1]!);
    expect(first.tick).toBe(0);
    expect(first.inputs.map((i: { type: string; modelLabel?: string }) => [i.type, i.modelLabel])).toEqual([["join", "model-0"], ["join", "model-1"]]);

    // The stdout copy is the same log, indexed, so a capture in any order rebuilds it exactly.
    const shuffled = [...printed].reverse().map((l) => `2026-10-17T08:00:00Z ${l}`);
    expect(extractMatchLog(shuffled)).toEqual(file.slice(0, printed.length));
  }, 30_000);

  it("holds tick 0 for all four players of a 2v2", async () => {
    await barrier(4, "redesign");
    const state = server!.game.match!.state;
    expect(state.agents).toHaveLength(4);
    expect(state.agents.map((a) => a.colony).sort()).toEqual([0, 0, 1, 1]);
    expect(state.config).toMatchObject({ rules: "redesign", players: 4 });
  }, 30_000);

  it("a captured stdout log replays to the live state, and a capture with a gap is refused", async () => {
    const { printed } = await barrier(2, "redesign");
    const agent = agents[0]!;
    await agent.call("observe", {});
    await server!.close();
    const live = server!.game.match!.state;
    server = null;
    const lines = extractMatchLog(printed);
    expect(stateHash(replay(lines, live.tick))).toBe(stateHash(live));
    expect(JSON.parse(lines[0]!).config).toMatchObject({ rules: "redesign", players: 2 });
    expect(() => extractMatchLog(printed.filter((_, i) => i !== 1))).toThrow(/missing line 1/);
  }, 60_000);
});

describe("over MCP: count_mark, the briefing and observe", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it("offers count_mark, explains count marks and queen HP, and shows the rules in observe, only in the variant", async () => {
    h = await startHarness({ simConfig: { ...rulesConfig("redesign"), commandFloorTicks: 1 } });
    const a = await h.connect();
    const joined = await a.call("join", {});
    const rules = await a.call("rules", {});
    expect(rules.isError, rules.text).toBe(false);
    expect(rules.data.rules).toContain("count_mark {verb,count,caste,tileX,tileY,toTileX,toTileY}");
    expect(rules.data.rules).toContain("Queens with HP: 40 HP");
    expect(rules.data.rules).not.toMatch(/Queen overrun:/);
    expect((await a.client.listTools()).tools.map((t) => t.name)).toContain("count_mark");
    const observed = await a.call("observe", {});
    expect(observed.data.view.rules).toBe("redesign");
    expect(observed.data.view.queens[0]).toMatchObject({ hp: 40_000, maxHp: 40_000 });
    const laid = await a.call("count_mark", { verb: "DEFEND", count: 3 });
    expect(laid.isError, laid.text).toBe(false);
    const bad = await a.call("count_mark", { verb: "HOLD", count: 3 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/bad_count_mark/);
    const after = await a.call("observe", {});
    expect(after.data.view.myMarks[0]).toMatchObject({ verb: "DEFEND", count: 3 });

    const v4 = await startHarness({ simConfig: rulesConfig("v4") });
    const b = await v4.connect();
    const v4Join = await b.call("join", {});
    expect(v4Join.data.briefing).toBe(joinBriefing(playable(rulesConfig("v4")), v4.game.mcpConfig));
    expect((await b.call("rules", {})).data.rules).toBe(briefing(playable(PUBLIC_CONFIG), v4.game.mcpConfig));
    expect((await b.client.listTools()).tools.map((t) => t.name)).not.toContain("count_mark");
    expect((await b.call("observe", {})).data.view.rules).toBe("v4");
    await v4.close();
  }, 30_000);
});

describe("public redesign without the comparison settings", () => {
  let server: GameServer | null = null;
  const agents: Agent[] = [];
  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.close();
    await server?.close();
    server = null;
    randomSeed.mockReset().mockReturnValue(12345);
  });

  it("keeps all eight public seats and returns the redesign briefing", async () => {
    // Held until all eight have joined, so the ninth meets the full match.
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(),
      ...comparisonOptions({}, DEFAULT_MCP_CONFIG), match: "held", expectedPlayers: 8 });
    for (let i = 0; i < 8; i++) {
      const agent = await connect(server.port);
      agents.push(agent);
      const joined = await agent.call("join", {});
      expect(joined.isError, joined.text).toBe(false);
      expect(joined.data.briefing).toContain("order, count_mark and found_queen share one allowance");
      const rules = await agent.call("rules", {});
      expect(rules.isError, rules.text).toBe(false);
      expect(rules.data.rules).toContain("Free ants follow these defaults until a count mark claims them");
      expect(rules.data.rules).toContain("Queens with HP");
      expect(rules.data.rules).not.toContain("A house bot runs every ant outside");
      expect(rules.data.rules).not.toContain("Marks move no other ants");
      expect(rules.data.rules).not.toContain("House guards:");
    }
    const extra = await connect(server.port);
    agents.push(extra);
    expect((await extra.call("join", {})).text).toContain("agent_cap");
    await waitFor(() => (server!.game.match?.state.tick ?? 0) >= 1);
    expect(server.game.match!.state.agents).toHaveLength(8);
  }, 20_000);
});
