import { afterEach, describe, expect, it } from "vitest";
import { balanceRuleLines, briefing, joinBriefing, softSpacingLines } from "../../src/mcp/briefing.js";
import { BALANCED_LOCAL_ANT_RULES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

// Rules-27 worker text. Every text generation the worker clauses have.
// Every match plays at grid scale 2, so each generation is built from the
// reference template at grid scale 2 (playable); the scale-1 renderings are retired.
const template = rulesConfig("redesign");
const redesign = playable(template);
const CONFIGS: Record<string, SimConfig> = {
  live: newMatchConfig(template),
  redesign,
  noPointArrival: playable({ ...template, pointArrival: undefined }),
  noCombatTotals: playable({ ...template, countMarks: { ...template.countMarks!, combatTotals: undefined } }),
  unheldGuard: playable({ ...template, localAnts: { ...BALANCED_LOCAL_ANT_RULES, workerHomeGuardHold: undefined, workerHomeGuardSharePermille: undefined } }),
};

const LOCAL_ANT_LEAD = "- Free ants follow these defaults until a count mark claims them.";

/** Worker home guard, patch dispatch, patch patrol, queen-threat recall and crowding-retarget wording. */
const WORKER_STRATEGY = [/home guard/i, /guard home/i, /standing guard/i, /patch dispatch/i, /dispatched/i, /patch assignment/i,
  /scout home-side/i, /scouting it while it regrows/i, /queen[- ]threat/i, /recall/i, /Cluster-only/i, /nearest other stocked tile/i];


describe("rules-27 agent text describes the local worker rules", () => {
  it.each(Object.keys(CONFIGS))("states no worker strategy in the briefing or shared rules prose (%s)", name => {
    const config = CONFIGS[name]!;
    const text = [briefing(config), briefing(config, undefined, { house: true }), joinBriefing(config),
      ...balanceRuleLines(config, true), ...balanceRuleLines(config), ...softSpacingLines(config)].join("\n");
    for (const wording of WORKER_STRATEGY) expect(text).not.toMatch(wording);
  });

  it("teaches the defaults, the outward rule and the count-mark override in every generation", () => {
    const live = CONFIGS.live!;
    const concise = briefing(live);
    const r = live.localAnts!.defendTiles; // 3 tiles: 6 fine tiles at grid scale 2
    // A new match carries the no-bot-moves rule; a config recorded before it still names the house bot.
    expect(briefing({ ...live, localAnts: { ...live.localAnts!, everyColony: undefined } })).toContain(`${LOCAL_ANT_LEAD} Active (not idle) colony seat: house bot off; none: on. Non-carrying`);
    expect(concise).toContain(`${LOCAL_ANT_LEAD} No house bot plans any colony, seated or not. Non-carrying ants outside squads/count marks bite in reach; within ${r} tiles of nearest live queen, pursue enemies within ${r} tiles of her. Otherwise free workers forage nearest colony-seen food and deliver to live nests;`);
    expect(concise).toContain("- Free workers: no remembered food available -> walk outward from nearest live nest until colony sees food. Count marks override; released workers resume where released.");
    expect(concise).toContain("Free, squad and count-mark carriers keep delivering to a live friendly queen past enemies");

    const full = "Idle free workers: when none of the food their colony remembers is available, they walk outward from their nearest live nest until the colony sees food. Ants claimed by count marks follow their marks instead; a released worker resumes these rules from where it was released.";
    const historical = briefing(CONFIGS.noCombatTotals!);
    expect(historical).toContain("Otherwise free workers forage the nearest food your colony's ants have seen and carry it to a live nest;");
    expect(historical).toContain(`- ${full}`);
    // House prompts and the public rules page compose the uncompacted copy.
    expect(balanceRuleLines(live)).toContain(full);
  });

  it("keeps the soft-spacing prose apart from the crowding retarget", () => {
    const [arrival] = softSpacingLines(CONFIGS.live!).filter(line => line.startsWith("Other goals:"));
    expect(arrival).toMatch(/subunits rooted in reach\.$/);
    const [crowd] = softSpacingLines(CONFIGS.noPointArrival!).filter(line => line.startsWith("Crowd arrival:"));
    expect(crowd).toContain("No reserved slots/posts/holding band. Displaced DEFEND/ATTACK soldiers return inside mark.");
  });
});

describe("rules-27 tool text", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  it("states no worker strategy in any tool description or schema", async () => {
    h = await startHarness({ simConfig: CONFIGS.live! });
    const agent = await h.connect();
    const tools = JSON.stringify((await agent.client.listTools()).tools);
    for (const wording of WORKER_STRATEGY) expect(tools).not.toMatch(wording);
    const rules = (await agent.call("rules")).data.rules as string;
    for (const wording of WORKER_STRATEGY) expect(rules).not.toMatch(wording);
  });
});
