import { ruleSections } from "../../web/rules.js";
import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { startHarness } from "./harness.js";
import { HISTORICAL_CONFIG } from "../sim/fixtures.js";
import { playable } from "../playable.ts";

const redesign = playable(rulesConfig("redesign"));

/** Deliberately separate smell and recruitment: the public defaults happen to match. */
function changedRules(): SimConfig {
  return {
    ...redesign,
    ticksPerSecond: 20,
    commandFloorTicks: 140,
    squadSize: 4,
    smellTiles: 2,
    marksPerAgent: 5,
    markLifetimeTicks: 2460,
    localAnts: { defendTiles: 7 },
    countMarks: { recruitTiles: 11, defendTiles: 6 },
    queenHp: { hp: 77_000, biteDamage: 3_000, biteIntervalTicks: 60, regenHp: 2_000, regenIntervalTicks: 180, regenClearTiles: 8, shieldTicks: 2200 },
  };
}

describe("redesign briefing teaches decisions, not just command syntax", () => {
  it.each([true, false])("keeps founding's shared command limit in both forms (count marks: %s)", (withCountMarks) => {
    const config = withCountMarks ? redesign : { ...redesign, countMarks: undefined };
    for (const render of [briefing, joinBriefing]) {
      const text = render(config);
      const founding = text.split("\n").find(line => /^-?\s*found_queen[: ]/.test(line));
      if (withCountMarks || render === briefing) {
        expect(founding).toContain(`Shares the order${withCountMarks ? "/count_mark" : ""} command limit`);
      }
      expect(text).toContain(`order${withCountMarks ? ", count_mark" : ""} and found_queen share one allowance`);
    }
    const withoutFounding = { ...config, queenFounding: undefined };
    for (const text of [briefing(withoutFounding), joinBriefing(withoutFounding)]) {
      expect(text.split("\n").some(line => /^-?\s*found_queen[: ]/.test(line))).toBe(false);
    }
  });

  it("preserves compact movement, victory and vacancy-recruitment rules", () => {
    const text = briefing(redesign);
    expect(text).toMatch(/go_to[^\n]*every squad ant walks straight/);
    expect(text).toMatch(/Time-up[^\n]*both last queens lost same tick[^\n]*kills>territory>ants alive>food delivered>draw/);
    expect(text).toMatch(/vacancies recruit eligible free ants again/);
  });

  it("limits reconnect history and priority retention to this match in both forms", () => {
    for (const text of [briefing(redesign), joinBriefing(redesign)]) {
      expect(text).toMatch(/(?:[Hh]istory[^\n]*priorities)[^\n]*survive reconnects[^\n]*for this match/);
    }
  });

  it("teaches both hatch intervals from config without changing historical briefing", () => {
    expect(briefing(redesign)).toContain("a worker takes one hatch interval (1 s), a soldier takes 2 hatch intervals (2 s)");
    const changed = { ...redesign, ticksPerSecond: 20, hatchIntervalTicks: 30,
      hatchTiming: { soldierIntervalMultiplier: 3 } };
    expect(briefing(changed)).toContain("a worker takes one hatch interval (1.5 s), a soldier takes 3 hatch intervals (4.5 s)");
    expect(briefing({ ...redesign, hatchTiming: undefined })).not.toContain("hatch intervals (");
  });
  it("distinguishes verb, requested count, answered claims and squad steering", () => {
    const text = briefing(redesign);
    expect(text).toContain("count_mark directs free ants, order steers your squad");
    // Vocabulary order is not a rule; each admitted verb must be taught.
    const verbs = text.match(/count_mark \{[^\n]+\}: ([A-Z/]+) for/)?.[1]?.split("/");
    expect(verbs).toHaveLength(6);
    expect(verbs).toEqual(expect.arrayContaining(["DEFEND", "ATTACK", "FORAGE", "GATHER", "PATROL", "LINE"]));
    expect(text).toContain("whole count 1-10,000");
    expect(text).toContain("marks/myMarks claimed=answered now, possibly short; never promised");
    expect(text).not.toContain("steering field counts squad ants following word marks");
    expect(briefing({ ...redesign, patrolLinkTiles: undefined, wordMarksDisabled: undefined })).toContain("steering field counts squad ants following word marks");
    expect(text).toContain("including workers already foraging");
    expect(text).toContain("with no caste preference");
    expect(text).toContain("Marks recruit in laid order");
    expect(text).toContain("the mark keeps its original");
    expect(text).toContain(`Whole land tile within ${redesign.sightTiles} tiles of any living ant of your colony`);
    expect(text).not.toContain("Word marks");
    expect(text).toContain("omit both coordinates for a current squad ant, never a future destination");
    expect(text).toContain("nearest free ants anywhere in your colony");
    expect(text).not.toContain("claimableAnts");
    expect(text).toContain("freeAntsNow");
    expect(text).toContain("0 free ants now; this mark recruits as ants hatch or free up");
    expect(text).toContain("Count marks do not steer your squad");
    const example = text.slice(text.indexOf("Worked example:"));
    expect(example).toContain('count_mark {"verb":"FORAGE"');
    expect(example).toContain("claimed (answered now)");
    expect(example).toContain('order {"kind":"hold","intent":"guard this position"}');
  });

  it("explains autonomous ants, their limits, queen survival and why commands can help or harm", () => {
    const text = briefing(redesign);
    expect(text).toContain("free workers forage nearest colony-seen food");
    expect(text).toContain("free soldiers carry no food and, apart from local fights, hold within");
    expect(text).toContain("Strategy: workers gather and soldiers hold where they are, but you choose objectives");
    expect(text).toContain("Pulling workers off food can cost your economy");
    expect(text).toContain("more commands alone do not win");
    expect(text).toContain("queens are dead");
    expect(text).toContain("There is no overrun");
    expect(text).toContain("hp and maxHp in milli-HP");
    expect(text).toContain("Every live queen hatches on its own interval");
  });

  it("takes reach, caps, placement limits, timers and queen HP from the match config", () => {
    const config: SimConfig = changedRules();
    const text = briefing(config);
    expect(text).toContain("whole count 1-10,000");
    expect(text).toContain("within 2 tiles of the mark, or within 11 tiles of a claimed group member");
    expect(text).toContain("DEFEND walks to its mark and pursues enemies within 6 tiles");
    expect(text).toContain("lifetime of 123 s from its original laying");
    expect(text).not.toContain("5-mark limit");
    expect(text).toContain("share the command allowance");
    expect(text).toContain("one within 7 tiles of its nearest live queen");
    expect(text).toContain("Place a count mark on a tile where one of your own squad ants stands");
    expect(text).toContain("hold within 7 tiles of where they became free");
    expect(text).toContain("each queen has 77 HP");
    expect(text).toContain("for 3 HP every 3 s");
    expect(text).toContain("queens take no damage before 110 s");
    expect(text).toContain("With no enemy within 8 tiles a queen regains 2 HP every 9 s");
    expect(text).toContain('count_mark {"verb":"FORAGE","count":4}');
    expect(text).toContain("After 7 s you may adjust");
    expect(text).not.toContain("from 1 to 20");
  });

  it("keeps the recorded mark-slot sentence only for historical control configs", () => {
    expect(briefing(playable(HISTORICAL_CONFIG))).toContain("you keep at most 3 (a new one replaces your oldest)");
    expect(briefing({ ...redesign, marksPerAgent: 5 })).not.toContain("you keep at most");
    // States the shared allowance once.
    expect(briefing(redesign)).not.toContain("Count marks share the command allowance");
    expect(briefing(redesign)).toContain("order, count_mark and found_queen share one allowance per agent");
  });


  it.each(["v4", "count-marks"] as const)("does not teach local ants or HP queens in %s", (name) => {
    const text = briefing(playable(rulesConfig(name)));
    expect(text).not.toContain("Why command:");
    expect(text).not.toContain("Queens with HP");
    if (name === "v4") {
      expect(text).not.toContain("count_mark");
      expect(text).toContain("The loop: call observe, then order (optionally carrying one mark). Repeat.");
      expect(text).toContain('"words":["FOOD","N","MANY"]');
    } else {
      expect(text).toContain("or assigned as house guards");
      expect(text).toContain("Answered means");
    }
  });

  it("returns the teaching on real join/rejoin and accepts its worked count mark, reporting answered ants", async () => {
    // Stationary ants keep the placement fixture stable; no production behavior is replaced.
    const config = { ...changedRules(), antSpeedTilesPerSecond: 0 };
    const harness = await startHarness({ simConfig: config });
    try {
      const agent = await harness.connect();
      const joined = await agent.call("join", {});
      expect(joined.isError, joined.text).toBe(false);
      expect(joined.data.briefing).toBe(joinBriefing(config, harness.game.mcpConfig));
      const fullRules = await agent.call("rules");
      expect(fullRules.data.rules).toBe(briefing(config, harness.game.mcpConfig));
      const match = fullRules.data.rules.match(/2\. count_mark (\{[^\n]+?\}) ->/) as RegExpMatchArray | null;
      expect(match).not.toBeNull();
      const request: Record<string, unknown> = JSON.parse(match![1]!);
      expect(request).not.toHaveProperty("tileX");
      expect((await agent.call("count_mark", request)).isError).toBe(false);
      const observed = await agent.call("observe", {});
      const marks = observed.data.view.myMarks as { verb: string; count: number; claimed: number; steering: number }[];
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ verb: "FORAGE", count: request.count, steering: 0 });
      expect(marks[0]!.claimed).toBeGreaterThan(0);
      expect(marks[0]!.claimed).toBeLessThanOrEqual(Number(request.count));
      const rejoined = await agent.call("join", { token: joined.data.reconnectToken });
      expect(rejoined.isError, rejoined.text).toBe(false);
      expect(rejoined.data.briefing).toBe(joinBriefing(config, harness.game.mcpConfig));
    } finally {
      await harness.close();
    }
  });
});

it("describes every live mark job plainly without retired caps across briefings, rules and tool text", async () => {
  const config = playable(rulesConfig("redesign"));
  const h = await startHarness({ simConfig: config });
  try {
    const agent = await h.connect(), tools = (await agent.client.listTools()).tools;
    const text = [briefing(config), joinBriefing(config), ruleSections(config).flatMap(s => s.lines).join("\n"),
      ...tools.filter(t => t.name === "mark" || t.name === "count_mark").map(t => t.description ?? "")];
    for (const copy of text) {
      expect(copy).not.toMatch(/the attack order|as order does|20-ant|1[-–]20|1 to 20|60% (?:claim|cap)|4 live queens|[345]-mark limit|claimableAnts|claim cap reached/i);
    }
    for (const copy of text.slice(0, 3)) {
      expect(copy).toContain("DEFEND walks to its mark, holds and never chases");
      expect(copy).toContain("ATTACK marches there, then pursues the nearest enemy");
      // Rules 26: the caste line states FORAGE's workers-only rule once.
      expect(copy).toContain("FORAGE works food nearest the mark and delivers home.");
      expect(copy).toContain("FORAGE recruits workers only even with any or omitted caste; caste soldier is refused");
      expect(copy).toContain("GATHER holds its mark");
      expect(copy).toContain(`PATROL: same-colony marks within ${config.patrolLinkTiles} tiles (Euclidean) link transitively`);
      expect(copy).toContain("ants loop oldest to newest (laidTick, then id) and back");
      expect(copy).toContain("A lone patrol mark holds exactly like DEFEND");
      expect(copy).toContain("LINE runs tileX/tileY to toTileX/toTileY");
      expect(copy).not.toMatch(/\bAVOID\b|follow_trail|[Ww]ord marks/);
    }
    for (const copy of [text[0]!, text[2]!]) expect(copy).toContain("Free ants follow these defaults until a count mark claims them");
    expect(config.localAnts).toMatchObject({ soldierFrontSharePermille: 500, soldierPatchSharePermille: 900,
      workerPatchDispatchSharePermille: 400, workerHomeGuardCount: 32, workerHomeGuardSharePermille: 250, workerQueenRecallCount: 32 });
    expect(config.queenFounding!.totalGuardSharePermille).toBe(600);
  } finally { await h.close(); }
});

it("teaches optional caste and filter-only re-lays in both briefings and config-driven Rules", () => {
  for (const text of [briefing(redesign), joinBriefing(redesign), ruleSections(redesign).flatMap(section => section.lines).join("\n")]) {
    expect(text).toContain("Optional caste: any, worker, soldier; omitted means any");
    expect(text).toContain("releases only ants it excludes");
  }
  // The agent reply says nearest-first once, on the recruitment line.
  for (const text of [joinBriefing(redesign), ruleSections(redesign).flatMap(section => section.lines).join("\n")]) {
    expect(text).toContain("Only the chosen caste recruits, nearest first");
  }
  expect(briefing(redesign)).toContain("Only the chosen caste recruits. ");
  expect(briefing(redesign)).toContain("Recruitment and replacements: nearest free ants anywhere in your colony first.");
  const { casteSelection: _selection, ...oldRules } = redesign.countMarks!;
  const recorded = { ...redesign, countMarks: oldRules };
  expect(briefing(recorded)).not.toContain("Optional caste:");
  expect(joinBriefing(recorded)).not.toContain("Optional caste:");
  expect(ruleSections(recorded).flatMap(section => section.lines).join("\n")).not.toContain("Optional caste:");
});

it("teaches sparse MCP caste output while keeping omitted-means-any explicit", () => {
  // States omitted-means-any once, on the caste line.
  expect(briefing(redesign)).toContain("Replies, notices and history include caste only for worker or soldier.");
  expect(briefing(redesign).split("omitted means any")).toHaveLength(2);
  expect(briefing(redesign)).toContain("Optional caste: any, worker, soldier; omitted means any.");
  expect(joinBriefing(redesign)).toContain("omitted means any");
});

it("Wording cuts keep every cut fact stated once", () => {
  const shipped = newMatchConfig(rulesConfig("redesign"));
  const text = briefing(shipped);
  // Bite reach: defined once, referenced as "in reach".
  expect(text).toContain("Ant and queen bite reach is 2 tiles, including diagonals");
  expect(text).toContain("attack (tileX,tileY): march to target. Enemy in reach: stand and fight;");
  expect(text).toContain("- Combat: non-carrying ants, any order, with an enemy in reach, hit the lowest-HP enemy each tick.");
  // FORAGE workers-only: stated once on the caste line; recruitment still includes workers already foraging.
  expect(text).not.toContain("except FORAGE recruits workers only");
  expect(text).toContain("FORAGE recruits workers only even with any or omitted caste; caste soldier is refused.");
  expect(text).toContain("Recruit with no caste preference when caste is any, including workers already foraging.");
  // Implied duplicates.
  expect(text).not.toContain("Carriers deliver; squads/count marks exempt.");
  expect(text).toContain("Non-carrying ants outside squads/count marks bite in reach");
  expect(text).not.toContain("squads/count marks remove ants from free pool");
  expect(text).toContain("order may carry spectators-only intent");
  expect(text).toContain(`{"kind":"hold","intent":"guard this position"} -> hold.`);
  expect(text).toContain("There is no overrun.");
});

describe("configured soft personal space and physical interactions", () => {
  it("teaches the configured push, rooted arrival and queen-tile rules without reserved spots", () => {
    const changed: SimConfig = { ...redesign, pointArrival: undefined, nestDeliverTiles: 2,
      softSeparation: { radius: 80, strength: 1200, maxStep: 170, epsilon: 2, arrivalSubunits: 250, arrivalLinkRadius: 130 } };
    const full = briefing(changed);
    expect(full).toContain("Within 80 subunits");
    expect(full).toContain("strength 1200, edge epsilon 2");
    expect(full).toContain("steering+push <=170 subunits/tick");
    expect(full).toContain("points: 250 subunits");
    expect(full).toContain("links <=130 subunits");
    expect(full).toContain("recomputed each tick, not remembered");
    expect(full).toContain("No reserved slots/posts/holding band");
    expect(full).toContain("Queens aren't bodies: no push/reserved/blocked tiles");
    expect(full).toContain("ants there push");
    expect(full).toContain("physically within 2 tiles");
    // Bite reach is one original-size tile: 2 fine tiles at grid scale 2.
    expect(full).toContain("Bites: within 2 tiles incl. diagonals");
    expect(full).toContain("Pickup: worker on stocked food tile");
    expect(full).toContain("Linked arrival: no remote pickup/delivery/bite");
    expect(joinBriefing(changed)).toContain("Soft space: push80/step170/link130 subunits");
    expect(joinBriefing(changed)).toContain("Fresh links, contact/queens: rules.");
    for (const fact of ["each ant steers itself", "no minimum distance/hard blocks", "ants squeeze past",
      "Water/rocks impassable", "same-goal/colony", "rooted at an ant in reach",
      "Displaced DEFEND/ATTACK soldiers return inside mark", "friends/enemies push alike, may overlap",
      "incl. diagonals; combat/queen-bite reach unchanged", "of live friendly queen",
      "Native terrain-safe hatch; no crowd reservation/spacing deferral"]) expect(full).toContain(fact);
  });

  it.each(["v4", "count-marks"] as const)("does not teach soft movement in %s", name => {
    for (const text of [briefing(playable(rulesConfig(name))), joinBriefing(playable(rulesConfig(name)))]) {
      expect(text).not.toContain("Personal space:");
      expect(text).not.toContain("Soft space:");
      expect(text).not.toContain("Crowd arrival:");
    }
  });
});

it.each(["count-marks", "redesign"])("teaches FORAGE recruitment and refusal (%s)", name => {
  const config = playable(rulesConfig(name));
  for (const render of [briefing, joinBriefing]) {
    expect(render(config)).toContain("FORAGE recruits workers only");
    expect(render(config)).toContain("caste soldier is refused");
  }
});

it("teaches organic resting geometry for both castes and keeps overflow separate from combat", () => {
  const config = playable(rulesConfig("redesign"));
  for (const text of [briefing(config), joinBriefing(config)]) {
    expect(text).toContain("organic-cluster");
    expect(text).toContain("resting place");
    expect(text).toContain("nearest walkable");
  }
  const full = briefing(config);
  expect(full).toContain("0.8 original tile");
  expect(full).toContain("workers and soldiers");
  expect(full).toContain(`${config.pointArrival!.jitter} subunits`);
  expect(full).toContain(`${config.pointArrival!.minimumSpacing} subunits`);
  expect(full).toContain("the area still decides combat targets");
});

describe("rules-25 small push radius exceptions", () => {
  const live = newMatchConfig(rulesConfig("redesign"));
  it("states when the small radius applies instead of the soldier radius", () => {
    const text = briefing(live);
    expect(text).toContain("soldier pairs 1600 subunits, but 200 for a guard settled at its queen and for a worker meeting its own settled guard or resting soldier;");
    expect(text).toContain("Contact: otherwise friends/enemies push alike;");
  });

  it("renders the stored-config text unchanged without the flags", () => {
    const { guardSettle: _g, restPass: _r, ...stored } = live.softSeparation!;
    const text = briefing({ ...live, softSeparation: stored });
    expect(text).toContain("soldier pairs 1600 subunits; strength");
    expect(text).toContain("Contact: friends/enemies push alike;");
    expect(text).not.toContain("resting soldier");
    const noPoint = briefing({ ...live, pointArrival: undefined, softSeparation: stored });
    expect(noPoint).toContain("original tile); worker–worker radius stays");
  });

  it("names only the exception whose flag is set", () => {
    const { guardSettle: _g, ...restOnly } = live.softSeparation!;
    expect(briefing({ ...live, softSeparation: restOnly })).toContain("soldier pairs 1600 subunits, but 200 for a worker meeting its own resting soldier;");
    expect(briefing({ ...live, pointArrival: undefined })).toContain("original tile), but 200 for a guard settled at its queen and for a worker meeting its own settled guard or resting soldier; worker–worker");
  });
});
