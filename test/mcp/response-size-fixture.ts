/** Scripted MCP size diagnostic; no agent/LLM matches or public traffic. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { COLONY_NAMES, SUB, rulesConfig, type RulesName, type SimConfig } from "../../src/sim/config.js";
import { gridScaleOf, newMatchConfig, resourceCellIndex, withGridScale } from "../../src/sim/gridScale.js";
import { newAnt } from "../../src/sim/map.js";
import { isPassable } from "../../src/sim/terrain.js";
import type { ColonyId, SimState } from "../../src/sim/types.js";
import { startHarness, type Harness } from "./harness.js";

/** The new-match maps in the reference MAPS' three positions (src/sim/config.ts): Open Field, Three Crossings v2 and
 * Central Lake v2, which took the old two's places. Iterations that build new-match configs measure these;
 * iterations that build the reference template (withGridScale, or an explicit grid) keep MAPS' ids. */
export const NEW_MATCH_REPLY_MAP_IDS = ["open-field", "three-crossings-v2", "central-lake-v2"] as const;

/** No dimension override means the actual new-match factory, including every
 * physical length conversion. Explicit grids retain the separate wire-only stress cases. */
export function replyFixtureConfig(name: RulesName, mapId?: string, grid?: { width: number; height: number }): SimConfig {
  const reference = rulesConfig(name);
  const base = grid === undefined ? newMatchConfig(reference)
    : { ...withGridScale(reference), mapWidth: grid.width, mapHeight: grid.height };
  return mapId === undefined ? base : { ...base, terrain: { ...base.terrain!, mapId } };
}

/** Null when the tile is passable; otherwise the nearest passable tile, scanning rings outward in row order. */
function nearestLand(s: SimState, x: number, y: number): [number, number] | null {
  if (isPassable(s, x, y)) return null;
  for (let r = 1; r < Math.max(s.config.mapWidth, s.config.mapHeight); r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < s.config.mapWidth && ny < s.config.mapHeight && isPassable(s, nx, ny)) return [nx, ny];
    }
  }
  throw new Error("no passable tile");
}

export function prepareLargestView(h: Harness, spread = false): void {
  const s = h.game.match!.state;
  const scale = gridScaleOf(s.config);
  const tick = s.config.matchTicks - 1000;
  s.tick = tick;
  s.result = null;
  s.earlyWinProgress = undefined;
  // Dense combat-front stress snapshot: both full colonies visible to each seat.
  // Ant ids reflect late-match replacements rather than only the opening roster.
  s.ants = [];
  s.nextAntId = 15000;
  for (const colony of [0, 1] as const) for (let i = 0; i < 512; i++) {
    const ant = newAnt(s.config, s.nextAntId++, colony, ((8 + i % 5) * SUB + 500) * scale, ((22 + Math.floor(i / 5) % 5) * SUB + 500) * scale);
    if (s.config.castes) ant.caste = i % 2 ? "worker" : "soldier";
    ant.hp = i % 2 ? 3999 : 7999;
    s.ants.push(ant);
  }
  for (const [seat, agent] of s.agents.entries()) {
    agent.lastCallTick = tick;
    agent.lastCommandTick = null;
    agent.joinedTick = tick;
    agent.idle = false;
    const ants = s.ants.filter(a => a.colony === agent.colony && a.squad === null).slice(0, s.config.squadSize);
    agent.squad = ants.map(a => a.id);
    for (const [i, ant] of ants.entries()) {
      ant.squad = agent.id;
      if (spread) {
        ant.x = ((8 + (i % 3) * 18) * SUB + 500) * scale; ant.y = ((10 + Math.floor(i / 3) * 23) * SUB + 500) * scale;
        // A squad never stands in water or rock: on a map with water at that tile (Isthmus), the nearest land tile instead.
        const land = nearestLand(s, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB));
        if (land !== null) { ant.x = land[0] * SUB + 500; ant.y = land[1] * SUB + 500; }
      }
    }
    // A possible backlog of sighted hatch events, not newly simulated hatches.
    // Every event already passed the sim's sight filter, as pendingEvents requires.
    agent.pendingEvents = Array.from({ length: 1024 }, (_, i) => ({ type: "hatch" as const,
      tick: tick - 3000 + i, antId: 10000 + i, colony: (i % 2) as ColonyId,
      tileX: 8 * scale, tileY: 24 * scale, ...(s.config.castes ? { caste: "worker" as const } : {}) }));
    // More than one page of old own-mark priorities must fit without being lost,
    // even in the spread view with the largest full-view and reconnect payloads.
    for (let i = 0; i < 80; i++) {
      agent.pendingEvents.push(s.config.countMarks && i % 2 === 0
        ? { type: "count_mark_accepted", tick: tick - 1000 + i, markId: 100000 + i,
          agentId: agent.id, colony: agent.colony, tileX: 8 * scale, tileY: 24 * scale, verb: "GATHER", count: 20,
          availability: { claimedAnts: 400, freeAntsNow: 0 },
          message: "0 free ants now; this mark recruits as ants hatch or free up" }
        : { type: "mark_laid", tick: tick - 1000 + i, markId: 100000 + i,
          agentId: agent.id, colony: agent.colony, tileX: 8 * scale, tileY: 24 * scale,
          words: ["GATHER", "ATTACK", "QUEEN"] });
    }
  }
  if (spread) {
    const centres = [[8,10],[26,10],[44,10],[8,33],[26,33],[44,33]] as const;
    const visibleTiles: [number, number][] = [];
    for (let y = 0; y < s.config.mapHeight; y++) for (let x = 0; x < s.config.mapWidth; x++) {
      if (isPassable(s, x, y) && centres.some(([cx,cy]) => (x-cx*scale)**2+(y-cy*scale)**2 <= s.config.sightTiles**2)) visibleTiles.push([x,y]);
    }
    for (const [i, ant] of s.ants.filter(a => a.squad === null).entries()) {
      const [x,y] = visibleTiles[i % visibleTiles.length]!;
      ant.x = x * SUB + 500; ant.y = y * SUB + 500; ant.hp = 2001 + i;
    }
    // Fine grids store food once per original resource cell, not in every fine
    // tile. Fill every legal anchor; filling non-anchors would invent food that
    // the physical simulation cannot create and inflate the visible-cell table.
    for (let i = 0; i < s.food.length; i++) s.food[i] = resourceCellIndex(s.config, i) === i && isPassable(s, i % s.config.mapWidth, Math.floor(i / s.config.mapWidth)) ? 1 + i % 7 : 0;
    s.owner.fill(0); s.lastVisit.fill(tick);
    for (const colony of s.colonies) {
      const first = { ...colony.queens!.find(q => q.lostTick === null)!, lostTick: null };
      colony.queens = Array.from({length:4}, (_,i) => ({...first,id:colony.id*10+i,queenX:((8+16*i)*SUB+500)*scale,
        queenY:((colony.id ? 42 : 2)*SUB+500)*scale,foundedTick:3000+i*1800}));
      colony.queens.unshift(...Array.from({length:5}, (_,i) => ({...first,id:50+colony.id*10+i,
        lostTick:9000+i*100,foundedTick:i*100})));
      colony.foodStore = 0;
    }
    const markCount = s.config.marksPerAgent ?? Math.ceil(s.config.markLifetimeTicks / s.config.commandFloorTicks);
    s.marks = s.agents.flatMap((agent, seat) => Array.from({length:markCount}, (_,i) => ({
      id:100+seat*markCount+i, agentId:agent.id, colony:agent.colony,
      tileX:(26+i)*scale, tileY:10*scale, words:["GATHER","ATTACK","QUEEN"] as const, laidTick:tick-100,
      steering:6
    })));
    s.nextMarkId = 1000;
  }
}

export async function measureReplies(name: RulesName, spread = false, mapId?: string, grid?: { width: number; height: number }, slot = false,
  configure: (config: SimConfig) => SimConfig = config => config, prepare: (h: Harness) => void = () => {}) {
  const config = configure(replyFixtureConfig(name, mapId, grid));
  const scale = gridScaleOf(config);
  const identities = Array.from({ length: 8 }, (_, i) => `budget-seat-${i}`);
  const h = await startHarness({ simConfig: config, start: !slot, ...(slot ? { slot: {
    identityOf: async (key: string) => identities.includes(key) ? key : undefined,
    locate: async (id: string) => id === "budget-lobby" ? { slot: "public-0", mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" } : undefined,
  } } : {}) });
  try {
    if (slot) h.game.seatLobby("budget-lobby", identities.map((identityId, i) => ({ identityId, displayName: `Budget ${i}`, colony: (i % 2) as ColonyId })));
    const seats = [];
    for (let i = 0; i < 8; i++) {
      const agent = await h.connect();
      const join = await agent.call("join", slot ? { key: identities[i] } : { colony: COLONY_NAMES[i % 2] });
      if (join.isError) throw new Error(join.text);
      seats.push({ agent, token: join.data.reconnectToken as string, key: identities[i] });
    }
    if (slot) h.game.startMatch(1);
    const samples: { tool: string; seat: number; isError: boolean; textChars: number; textBytes: number; structuredBytes: number; completeBytes: number; eventCount: number }[] = [];
    for (const [seat, { agent, token, key }] of seats.entries()) {
      const tools = (await agent.client.listTools()).tools.map(t => t.name);
      for (const tool of tools) {
        prepareLargestView(h, spread);
        prepare(h);
        const args: Record<string, unknown> = tool === "join" ? (slot ? { key } : { token })
          : tool === "locate_match" ? { lobbyId: "budget-lobby" }
          : tool === "observe" ? { map: true }
          : tool === "order" ? { kind: "hold" }
          : tool === "mark" ? { words: ["HELP"] }
          : tool === "count_mark" ? { verb: "GATHER", count: 20 }
          : tool === "found_queen" ? { tileX: 8 * scale, tileY: 24 * scale } : {};
        const reply = await agent.client.callTool({ name: tool, arguments: args });
        const content = reply.content as { type: string; text?: string }[];
        const text = content.map(c => c.text ?? "").join("");
        if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(reply.structuredContent)) throw new Error("MCP reply copies disagree");
        samples.push({ tool, seat, isError: reply.isError === true, textChars: text.length,
          textBytes: Buffer.byteLength(text), structuredBytes: Buffer.byteLength(JSON.stringify(reply.structuredContent)), completeBytes: Buffer.byteLength(JSON.stringify(reply)), eventCount: ((reply.structuredContent as {view?: {events?: unknown[]}})?.view?.events ?? []).length });
      }
    }
    return { config, rules: name, mapId: h.game.match!.state.terrain?.mapId, spread, seats: 8, antsPerColony: 512, tick: h.game.match!.state.tick,
      method: "Synthetic late-match dense combat front and 1024 already-sighted hatch backlog; real loopback SDK calls, no LLM matches. Tool result JSON excludes JSON-RPC/HTTP framing.", samples,
      maxima: Object.fromEntries([...new Set(samples.map(s => s.tool))].map(tool => [tool, Math.max(...samples.filter(s => s.tool === tool).map(s => s.completeBytes))])) };
  } finally { await h.close(); }
}

/** A 32-event backlog of ordinary, already-sighted combat and mark traffic. */
export function mixedCombatMarkPage(tick: number, agentId: string): import("../../src/sim/types.js").VisibleEvent[] {
  return [
    ...Array.from({ length: 12 }, (_, i) => ({ type: "hatch" as const, tick, antId: 20000 + i, colony: 0 as const, tileX: 26, tileY: 10, caste: "worker" as const })),
    ...Array.from({ length: 8 }, (_, i) => ({ type: "fight" as const, tick, antId: 15000 + i, targetId: 15512 + i, colony: 0 as const, tileX: 26, tileY: 10 })),
    ...Array.from({ length: 8 }, (_, i) => ({ type: "death" as const, tick, antId: 20020 + i, colony: 0 as const, tileX: 26, tileY: 10 })),
    ...Array.from({ length: 4 }, (_, i) => ({ type: "mark_laid" as const, tick, markId: 1000 + i, agentId, colony: 0 as const, tileX: 26, tileY: 10, words: ["GATHER", "ATTACK", "QUEEN"] as const })),
  ];
}

/** Upper bound on distinct ants in one colony over a whole match, hence either
 * mark counter. Ignore food/cap/spacing/losses to overestimate births. The
 * original queen may hatch at tick 0; founded queens wait one base interval.
 * Sources: config.ts, map.ts createMatch/nextQueenFoundingTick, agents.ts
 * foundQueen, forage.ts hatch, and step.ts's matchTicks termination.
 */
export function matchCounterBound(config: SimConfig): number {
  const { matchTicks, hatchIntervalTicks: interval, startAnts, queenFounding } = config;
  let total = startAnts + Math.ceil(matchTicks / interval);
  if (queenFounding !== undefined) {
    const first = queenFounding.firstFoundTick ?? 0;
    for (let tick = first; tick < matchTicks; tick += queenFounding.cooldownTicks) {
      total += Math.floor((matchTicks - 1 - tick) / interval);
    }
  }
  return total;
}

/** Full teammate marks and the existing duplicate own listing; no view data is compressed away.
 * unpagedReply measures the complete 32-event backlog before applying the page cap and budgets,
 * not evidence that the pager delivered it. Tests pin the measured page and recover the full backlog by cursor.
 */
export async function worstMarkObserve(mapId = "open-field", kind: "word" | "count" = "word", tool: "observe" | "join" | "reconnect" = "observe",
  options: { totals?: "zero" | "maximum"; layout?: "worst" | "normal"; grid?: { width: number; height: number } } = {}) {
  const config = replyFixtureConfig("redesign", mapId, options.grid);
  const scale = gridScaleOf(config);
  const h = await startHarness({ simConfig: config });
  try {
    const seats = [];
    for (let i = 0; i < 8; i++) {
      const agent = await h.connect();
      const joined = await agent.call("join", { colony: COLONY_NAMES[i % 2] });
      seats.push({ agent, token: joined.data.reconnectToken as string });
    }
    prepareLargestView(h, true);
    const state = h.game.match!.state;
    if (options.layout === "normal") state.ants = state.ants.filter(ant => ant.squad !== null);
    const markCount = options.layout === "normal" ? 1 : 18;
    const counterBound = matchCounterBound(state.config);
    // Leave room for one real tick's combat (<= colonyCap deaths per colony).
    // 8,329 and the upper bound 8,841 occupy exactly the same JSON width. All
    // replies are checked against the real post-tick values and the bound.
    const combatTotal = options.totals === "zero" ? 0 : counterBound - state.config.colonyCap;
    state.marks = state.agents.flatMap((agent, seat) => Array.from({ length: markCount }, (_, i) => ({
      id: 100 + seat * markCount + i, agentId: agent.id, colony: agent.colony,
      tileX: (kind === "word" ? 26 : 24 + i % 5) * scale, tileY: (kind === "word" ? 10 : 9 + Math.floor(i / 5)) * scale,
      words: kind === "word" ? ["GATHER", "ATTACK", "QUEEN"] as const : [],
      laidTick: state.tick - 1700 + i * 100, steering: 0,
      ...(kind === "count" ? { verb: "GATHER" as const, count: 512, revision: 0, caste: "soldier" as const,
        antsLost: combatTotal, enemiesKilled: combatTotal } : {}),
    })));
    state.nextMarkId = 2000;
    const page = Array.from({ length: 32 }, (_, i) => kind === "word"
      ? { type: "mark_laid" as const, tick: state.tick - (31 - i) * 100 - 1, markId: 1000 + i, agentId: state.agents[0]!.id, colony: 0 as const, tileX: 26 * scale, tileY: 10 * scale, words: ["GATHER", "ATTACK", "QUEEN"] as const }
      : { type: "count_mark_accepted" as const, tick: state.tick - (31 - i) * 100 - 1, markId: 1000 + i, agentId: state.agents[0]!.id, colony: 0 as const, tileX: 26 * scale, tileY: 10 * scale, verb: "GATHER" as const, count: 512, caste: "soldier" as const, availability: { claimedAnts: 0, freeAntsNow: 512 }, message: "512 free ants now; this mark recruits as ants hatch or free up" });
    // The live match advances in place and appends to pendingEvents, so the state takes its own copy of the fixture page.
    state.agents[0]!.pendingEvents = [...page];
    // Each public call takes a simulation tick. Reuse this synthetic view for
    // pagination measurements, without refilling sighted events or resetting
    // the Game's separate retained history, priority queue or cursor.
    const snapshot = structuredClone(state);
    for (const agent of snapshot.agents) agent.pendingEvents = [];
    const restoreSnapshot = () => { Object.assign(h.game.match!.state, structuredClone(snapshot)); };
    const expectedTotals = new Map<CallToolResult, ReadonlyMap<number, { lost: number; kills: number }>>();
    const captureTotals = (reply: CallToolResult) => {
      expectedTotals.set(reply, new Map(h.game.match!.state.marks.map(mark => [mark.id,
        { lost: mark.antsLost ?? 0, kills: mark.enemiesKilled ?? 0 }])));
    };
    let caller = seats[0]!.agent;
    if (tool === "reconnect") { await caller.end(); caller = await h.connect(); }
    const reply = await caller.client.callTool(tool === "observe" ? { name: "observe", arguments: { map: true } }
      : { name: "join", arguments: { token: seats[0]!.token } }) as CallToolResult;
    captureTotals(reply);
    const currentPages = [reply];
    for (let attempt = 0; attempt < 32; attempt++) {
      const last = currentPages.at(-1)!.structuredContent as { view: { priorityEventsMore: boolean } };
      if (!last.view.priorityEventsMore) break;
      restoreSnapshot();
      const next = await caller.client.callTool({ name: "observe", arguments: { map: true } }) as CallToolResult;
      captureTotals(next);
      currentPages.push(next);
    }
    const fixtureMarkIds = (result: CallToolResult): number[] => {
      const data = result.structuredContent as { view: { events: import("../../src/sim/types.js").VisibleEvent[] } };
      return data.view.events.flatMap(event => (event.type === "mark_laid" || event.type === "count_mark_accepted")
        && event.markId >= 1000 && event.markId < 1032 ? [event.markId] : []);
    };
    const currentMarkIds = currentPages.flatMap(fixtureMarkIds);
    const unpagedReply = structuredClone(reply);
    const data = unpagedReply.structuredContent as { view: { events: unknown[]; eventsMore: boolean; priorityEventsMore: boolean } };
    const history = h.game.eventHistory(state.agents[0]!.id);
    data.view.events = page.map(event => {
      if (event.type !== "count_mark_accepted") return event;
      const { availability: _availability, message: _message, ...notice } = event;
      const detailsSince = history.findIndex(retained => retained.type === event.type && retained.markId === event.markId);
      if (detailsSince < 0) throw new Error("Worst-case count notice is absent from retained history");
      return { ...notice, detailsSince };
    });
    // Keep the actual cursor and remaining-priority flags: a private seat
    // notice can still be queued after the whole mark-event backlog has been included.
    for (const block of unpagedReply.content) if (block.type === "text") block.text = JSON.stringify(data);
    const sizes = (result: typeof reply) => {
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
      return { textChars: text.length, completeBytes: Buffer.byteLength(JSON.stringify(result)), residual: Buffer.byteLength(JSON.stringify(result)) - 2 * text.length };
    };
    const replayedMarkIds: number[] = [], historySizes: ReturnType<typeof sizes>[] = [];
    const historyReplies: CallToolResult[] = [];
    const historyPages: { from: number; cursor: number; count: number; more: boolean }[] = [];
    {
      let cursor = 0;
      for (let attempt = 0; attempt < 32; attempt++) {
        restoreSnapshot();
        const history = await caller.client.callTool({ name: "observe", arguments: { since: cursor, map: true } }) as CallToolResult;
        captureTotals(history);
        historyReplies.push(history);
        historySizes.push(sizes(history));
        const data = history.structuredContent as { view: { events: import("../../src/sim/types.js").VisibleEvent[]; eventCursor: number; eventsMore: boolean } };
        for (const event of data.view.events) if ((event.type === "mark_laid" || event.type === "count_mark_accepted") && event.markId >= 1000 && event.markId < 1032) replayedMarkIds.push(event.markId);
        historyPages.push({ from: cursor, cursor: data.view.eventCursor, count: data.view.events.length, more: data.view.eventsMore });
        if (!data.view.eventsMore || replayedMarkIds.length >= page.length) break;
        if (data.view.eventCursor <= cursor) throw new Error(`Worst-case history made no progress: ${JSON.stringify({ ...sizes(history), viewFields: Object.fromEntries(Object.entries(data.view).map(([key, value]) => [key, JSON.stringify(value).length])) })}`);
        cursor = data.view.eventCursor;
      }
    }
    const allSizes = [...currentPages, ...historyReplies].map(sizes);
    const maximumActual = { textChars: Math.max(...allSizes.map(size => size.textChars)),
      completeBytes: Math.max(...allSizes.map(size => size.completeBytes)) };
    return { maximumActual, currentPages, currentMarkIds, historyReplies, combatTotal, counterBound, expectedTotals, replayedMarkIds, historySizes, historyPages, fixture: { colonySeats: state.agents.filter(a => a.colony === 0).length,
        antsPerColony: [0, 1].map(colony => state.ants.filter(a => a.colony === colony).length),
        marksPerSeat: state.agents.map(a => state.marks.filter(m => m.agentId === a.id).length) },
      mapId, kind, tool, page: kind === "word" ? "32-event three-word mark_laid backlog" : "32-event soldier count_mark_accepted backlog", reply, unpagedReply,
      actual: sizes(reply), unpaged: sizes(unpagedReply), expectedEvents: page.length };
  } finally { await h.close(); }
}

/** Construct a complete candidate page, retaining both MCP copies and all non-event fields. */
export function measureEventPage(reply: CallToolResult, eventCount: number) {
  const projected = structuredClone(reply);
  const data = projected.structuredContent as { view: { events: unknown[] } };
  if (!Number.isInteger(eventCount) || eventCount < 0 || eventCount > data.view.events.length) throw new Error("Invalid constructed event count");
  data.view.events = data.view.events.slice(0, eventCount);
  for (const block of projected.content) if (block.type === "text") block.text = JSON.stringify(data);
  return { reply: projected, eventCount, textChars: projected.content.filter(block => block.type === "text").map(block => block.text).join("").length,
    completeBytes: Buffer.byteLength(JSON.stringify(projected)) };
}
