/**
 * Stills of the redesign (its stills contract): the recording's
 * own moments (web/capture/moments.ts), a mark with its owner, the colonies in action, a queen
 * under attack, a colony's fall and the result that follows it, rendered by this checkout's client
 * (or --dist, an older build) on Playwright's stepped clock at 1920x1080, 390x844, 844x390 and
 * 360x800, on the 2D board, or with --board 3d on the 3D board in its default tilted view. At
 * the mark moment the pointer (1080p) or a touch tap (the phones) also shows the newest marker's
 * tooltip: the mark's words, its gloss and who laid it; on the phones the newest marker clear of
 * ants, since on touch an ant under the tap wins, so a tap on a
 * marker with an ant on it must open that ant's card instead. The attack, fall and result scenes may come
 * from a second recording (--fall-recording) when the main one does not end with a colony falling
 * (the queen under attack shortly before she dies, her HP
 * falling); the mark and action scenes stay on the first. Each recording plays from its first
 * message, which the client takes as arriving at clock 0, so its scenes' clocks count from that
 * message's tick (moments.ts clockAt): a recording captured mid-match is stepped to its own ticks,
 * never past its last message. The attack scene fails the run unless a queen's cell in the HUD reads under
 * attack. A moment a recording never reaches is reported and its scene skipped, never rendered from another tick.
 *
 * An early end (--early-recording): one scene from a recording whose match
 * ends on a reason of the stream's own with no colony falling (early-cdf2877-s7003: colony 1 wins at
 * tick 9970 on sustained_territory). Its result card must read the page's words for the stream's reason
 * (web/src/story.ts resultHow: main's label for an end it knows, else the reason's own words),
 * no colony may be shown falling (no side dimmed), and the view must stand
 * where it was two seconds before the end: no camera moves by itself. A recording
 * with a fall moment is no early end and its scene is refused; the main and fall recordings keep
 * every other scene.
 *
 * On the phones, the squad tap (the agent with the largest
 * squad, at a tick when one of its ants stands on its own mark's tile or a tile beside it): the main
 * recording's qualifying ticks nearest the action moment (moments.ts squadTapCandidates, at most
 * SQUAD_TAP_TRIES) are tried in turn on each viewport, and at the first where that ant stands on the
 * uncovered board there a touch tap on it opens the agent's card only: no squad tooltip
 * and no mark tooltip (on touch the ant wins): the tap-squad
 * scene. When no tick qualifies on a viewport the run fails and says so, and any uncovered ant of that
 * agent is tapped instead. While the ant's card is open the page may hold its scroll, and closing the card must give
 * the scroll back, which the squad-tap scene checks.
 *
 * With --board 3d, the passes follow the scenes, kept from main: the fallbacks to the 2D
 * board, each of which must end on the reloaded 2D page (Pixi, board=2d, every other parameter
 * kept, no error after the reload): the 3D board's code failing to load (its chunk aborted), its
 * WebGL context lost, and a board too slow at its lowest quality (the stepped clock at 60 ms a
 * frame); then an emulated-phone timing: 390x844 with touch and the CPU slowed 4x, 30 s in real
 * time from the action moment, recording each tier the board stands at, its "too slow" warning
 * and the reload, in order: it passes held smooth (a median of PASS_MS or less) or stepped down to
 * the last tier, then warned, then reloaded as 2D (SwiftShader on the capture host's CPUs, not phone
 * hardware: supporting evidence only); last, a pass with WebGL turned off in the browser, where
 * both the 2D and the 3D address must end on the page's needs-WebGL message with no board drawn
 * and no page or console error at all (the page checks for WebGL before it
 * starts a board, web/src/webgl2.ts).
 *
 * In every scene the board fills its
 * area (no corner of the board's area, window.__antwarCapture.boardArea() (browser.ts), STAGE_INSET px in, off the board's outline:
 * stageCornersOffBoard) and a tooltip shown lies whole on the screen (tooltipBox); each fails the run. The 3D board
 * is the page's default and is judged first; the 2D board, through its switch, must still pass.
 * At the fall moment the fallen colony's queens, each her tile and the mound around it through the board's camera
 * (__antwar.nests()), must lie whole in the board's area on every viewport (the fallen queen whole in
 * frame; scene-checks.ts).
 *
 * The board-area report (--board-area): the board area's on-screen width and height at the main recording's action
 * moment at 1920x1080, 1366x768, 390x844, 360x780 and 844x390, on this board, in board-area.json; with --dist the same
 * pass measures an older build, so a baseline is measured by the same code.
 *
 * The house's models: the shipped recorded agent match (?replay: the live house's
 * four Claude Code players, two a colony) ten seconds in on every viewport, one still each (house-models). The models'
 * labels left the score card, so its check of them went with them. On every scene at a
 * desktop size, a status line that takes a second line fails the run.
 *
 * Standalone leaderboard (strict fake API, no recording/board): --leaderboard-scenes --out DIR [--dist DIR].
 * Usage: node --import ./src/ts-resolve.mjs web/capture/stills.ts --recording NAME --out DIR
 *          [--fall-recording NAME] [--early-recording NAME] [--board 2d|3d] [--dist DIR] [--model-label-fixture]
 *          [--board-area] [--queens-fixture]
 *          [--shard I/N]
 * --shard I/N runs shard I of N of the whole run, so N machines or
 * processes share it: the run's units, each one viewport's scenes in one engine or one pass (the house's
 * models, the first impression, the queens row, the empty server, the feed drop, the result screen, the motion checks,
 * the 3D board's fallbacks, emulated phone and WebGL-off page, the board area), are dealt in turn to the N shards
 * (shardUnits), so each unit runs in exactly one shard and none is dropped. Give each shard its own --out; stills.json
 * (shard) and summary.txt name the shard's units. Without --shard the whole run runs, as before.
 * --queens-fixture adds the queens row with 1, 4 and 10 queens a side at 360x800 and 1920x1080
 * (captureQueensRow), DIR/<board>-<viewport>-queens-<n>.jpg.
 * --model-label-fixture writes deterministic copies of the input recordings with long known, 64-byte unbroken
 * unknown and hostile model labels per colony, from reviewed code only; names and digests are in stills.json.
 * NAME is a recording in out/recordings. Without --dist, this checkout's client is built and served.
 * Writes DIR/*.jpg, DIR/stills.json and DIR/summary.txt: provenance, the moments found in each
 * recording and the squad tap's agent and tick, each scene's tick, frame result, tooltip and squad-tap
 * checks, the 3D passes' records, and every failed check. Any page or console error, a tooltip
 * that failed to show, a squad tap that opened no card or showed a tooltip, or a failed pass
 * fails the run; a failure never stops it: the run records it, carries on
 * through every viewport, scene and pass, writes both files, and then exits 1.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Browser } from "playwright-core";
import { decodeMessage, encodeMessage, encodePublicMessage, type StreamMessage, type StreamQueen } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { NEW_MATCH_GRID_SCALE, withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { SpectatorRecorder, SpectatorState, territoryWinOf } from "../../src/live/model.ts";
import { FALL_EMBLEM_PX, MARK_LIFE_MS, QUEEN_FRAME_TILES, RENDER_DELAY_MS } from "../src/buffer.ts";
import { markSymbol } from "../src/mark-symbols.ts";
import { resultHow } from "../src/story.ts";
import type { Antwar3dApi } from "../src/board3d/main3d.ts";
import { PASS_MS, TIERS } from "../src/board3d/quality.ts";
import { RETRY_3D_DELAY_MS } from "../src/3d-recovery.ts";
import type { FrameResult } from "../src/main.ts";
import { RECORDING_DIR, WEBKIT_DEVICE, enginePrefix, isWebKit, launchBrowser, launchWebKit, openClient, servePage, type ClientPage } from "./browser.ts";
import { prepare, provenance } from "./capture.ts";
import { captureLeaderboardStills } from "./leaderboard-stills.ts";
import { captureEmptyServer, captureFeedDrop } from "./empty-server.ts";
import { motionCheck, type MotionViewport } from "./motion.ts";
import { clockAt, matchEnd, sceneMoments, squadTapCandidates, type Moments, type SquadTap } from "./moments.ts";
import { sceneProblems, wrapProblems, type SceneRecord } from "./scene-checks.ts";

/** The capture viewports: a desktop, a phone, a phone turned to landscape and the narrowest phone; the phones with touch and a coarse pointer. */
const VIEWPORTS = [
  ["1080p", [1920, 1080], false],
  ["desktop", [1366, 768], false],
  ["phone", [390, 844], true],
  ["landscape", [844, 390], true],
  ["phone360", [360, 780], true],
] as const satisfies readonly (readonly [string, readonly [number, number], boolean])[];
/**
 * The territory countdown's window: the scripted scene from 30 s before the countdown appears, through
 * its clearing 20 s later, at both phones and 1280x800 in both engines; nothing outside its bar may move.
 */
const COUNTDOWN_MOTION_VIEWPORTS: readonly MotionViewport[] = [["countdown-390x844", [390, 844], true], ["countdown-360x800", [360, 800], true], ["countdown-1280x800", [1280, 800], false]];
/** Desktops where the masthead's first column is narrowest beside the score card (1280x800 once covered the credit's end). */
const REST_VIEWPORTS = [
  ["desktop1280", [1280, 800], false],
  ["desktop1440", [1440, 900], false],
] as const satisfies readonly (readonly [string, readonly [number, number], boolean])[];
/** The desktops shown in both engines (1280, 1440 and 1920). */
const DESKTOP_RAIL_VIEWPORTS = [...REST_VIEWPORTS, VIEWPORTS[0]] as const;

/** --shard I/N: the shard to run, or null without the flag (the whole run). */
export function parseShard(arg: string | undefined): { index: number; count: number } | null {
  if (arg === undefined) return null;
  const parts = /^(\d+)\/(\d+)$/.exec(arg.trim());
  if (!parts) throw new Error(`--shard is I/N, for example 1/4; got ${arg}`);
  const index = Number(parts[1]);
  const count = Number(parts[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`--shard ${arg}: I runs from 1 to N`);
  return { index, count };
}

/** The units shard I of N runs: the whole run's units dealt in turn, so each runs in exactly one shard and the heavy viewports spread. */
export function shardUnits<T>(units: readonly T[], shard: { index: number; count: number } | null): T[] {
  return shard === null ? [...units] : units.filter((_, k) => k % shard.count === shard.index - 1);
}

type Moment = keyof Moments;
/** A step of a recording's run: a scene moment, the squad tap, or the early-end recording's view measured before its end (no still) and its result. */
type Step = Moment | "tap-squad" | "mark-labels" | "early-view" | "early-end" | "territory";
/** Ticks before the early end at which the view is measured, to be found unmoved at the result. */
const EARLY_VIEW_LEAD_TICKS = 20;
/** How many of the squad tap's qualifying ticks, nearest the action moment first, a viewport tries before the run fails. */
const SQUAD_TAP_TRIES = 24;
/** How far in from the board area's corners the board must still be drawn: the 3D ground's soft edge is narrower than this. */
const STAGE_INSET = 16;

/** A still and its measurements; the checks on the record are scene-checks.ts sceneProblems. */
interface Scene extends SceneRecord {
  moment: Moment | "mark-owner" | "mark-labels-off" | "mark-labels-restored" | "tap-squad" | "early-end" | "first-impression" | "territory" | "house-models";
  markLabels?: MarkLabelsSnapshot;
  recording: string;
  board: "2d" | "3d";
  viewport: readonly [number, number];
  /** The moment's playback tick, and the one the frame actually showed. */
  tick: number;
  playbackTick: number;
  /** The 3D board's camera view. */
  view?: string;
  frame: FrameResult;
  firstImpression?: unknown;
  /**
   * The mark-owner scene: the mark pointed at or tapped — on its label where one is drawn (`label`), the mark's own
   * target, else its marker — whether an ant stood on the marker (a phone's tap then opens the ant's card), and
   * whether its tooltip showed.
   */
  owner?: { markId: number; label: boolean; antUnder: boolean; tooltip: boolean };
  /** The attack scene: the HUD's queen cells reading under attack (their labels: colony, queen and HP). */
  attack?: { rows: string[] };
  /** The early-end scene: the stream's reason, the card's winner and how lines, the dimmed sides counted (none allowed), and whether the view moved since before the end. */
  early?: { reason: string; winner: string; how: string; fallenSides: number; viewMoved: boolean };
  /** The tap-squad scene: the agent whose ant was tapped and its squad's ants, whether that ant stood on a mark of its own under its marker, whether its card opened and whether any tooltip showed. */
  squad?: { agent: number; squad: number; onOwnMark: boolean; card: boolean; tooltip: boolean };
}

export interface CountLabelCandidate {
  tick: number;
  counts: { id: number; verb: string; text: string }[];
}

/** Recording-derived layout changes, not the sixth mark: try only ticks with live, fully faded-in count metadata. */
export function countLabelCandidates(messages: readonly StreamMessage[]): CountLabelCandidate[] {
  let state: SpectatorState | null = null;
  const shown = new Map<number, number>();
  const found: CountLabelCandidate[] = [];
  let previous = "";
  for (const message of messages) {
    if (message.full !== null) state = new SpectatorState(structuredClone(message.full), message.tick, message.ants);
    else state?.apply(message);
    if (state === null || state.full.result !== null) continue;
    for (const event of message.events) if (event.kind === "mark" && !shown.has(event.mark.id)) shown.set(event.mark.id, message.tick);
    if (message.full !== null) for (const m of state.full.marks) if (!shown.has(m.id)) shown.set(m.id, Math.min(message.tick, m.laidTick + 1));
    const tps = state.full.setup.ticksPerSecond || 10;
    const counts = state.full.marks.flatMap((m) => {
      const age = (message.tick - (shown.get(m.id) ?? m.laidTick + 1)) * 1000 / tps;
      return markSymbol(m.verb) !== null && m.count !== undefined && m.claimed !== undefined && age >= 400 && age < MARK_LIFE_MS
        ? [{ id: m.id, verb: m.verb!, text: `${m.claimed}/${m.count}` }] : [];
    });
    // Markers, count text and nest exclusion boxes are what can change the label layout in this unpanned view.
    const key = JSON.stringify([state.full.marks.map((m) => [m.id, m.tileX, m.tileY]), counts, state.full.queens?.map((q) => [q.id, q.colony, q.x, q.y, q.lostTick])]);
    if (counts.length > 0 && key !== previous) found.push({ tick: message.tick, counts });
    previous = key;
  }
  return found;
}

export interface CountLabelProbe {
  labels: MarkLabelsSnapshot["labels"];
  markers: { id: number; x: number; y: number }[];
  stage: { x0: number; y0: number; x1: number; y1: number };
  uncovered: number[];
}

/** A genuine sample has matching stream counts, a whole plate AND its marker on the uncovered captured stage. */
export function countLabelSample(candidate: CountLabelCandidate, probe: CountLabelProbe): number | null {
  const s = probe.stage;
  return candidate.counts.find((count) => probe.labels.some((label) => {
    const p = probe.markers.find((m) => m.id === count.id);
    const r = label.rect;
    return label.id === count.id && label.text === count.text && p !== undefined && probe.uncovered.includes(count.id)
      && r.x0 >= s.x0 && r.y0 >= s.y0 && r.x1 <= s.x1 && r.y1 <= s.y1
      && p.x - 13 >= s.x0 && p.x + 13 <= s.x1 && p.y - 13 >= s.y0 && p.y + 13 <= s.y1;
  }))?.id ?? null;
}

export interface MarkLabelsSnapshot {
  on: boolean;
  pressed: string | null;
  markers: number[];
  badges: number;
  labels: { id: number; text: string; rect: { x0: number; y0: number; x1: number; y1: number } }[];
  sample?: { tick: number; id: number; verb: string; text: string };
}

/** A real UI toggle must leave the paused frame's markers and badges intact, then restore compact labels. */
export function markLabelToggleProblems(before: MarkLabelsSnapshot, hidden: MarkLabelsSnapshot, restored: MarkLabelsSnapshot, screen: readonly [number, number]): string[] {
  const problems: string[] = [];
  if (!before.on || before.pressed !== "true" || !restored.on || restored.pressed !== "true" || hidden.on || hidden.pressed !== "false") problems.push("mark labels control and board state disagree");
  if (before.labels.length === 0) problems.push("no compact count label is visible; the recording does not prove the labels toggle");
  if (hidden.labels.length !== 0) problems.push("labels remain visible with mark labels off");
  for (const state of [hidden, restored]) {
    if (JSON.stringify(state.markers) !== JSON.stringify(before.markers) || state.badges !== before.badges) problems.push("toggling labels changed the markers or squad badges");
  }
  const readings = (state: MarkLabelsSnapshot) => state.labels.map(({ id, text }) => ({ id, text }));
  if (JSON.stringify(readings(before)) !== JSON.stringify(readings(restored))) problems.push("compact labels did not return when switched on");
  for (const label of [...before.labels, ...restored.labels]) {
    if (!/^\d+\/\d+$/.test(label.text)) problems.push(`mark ${label.id} has a non-compact count: ${label.text}`);
    const r = label.rect;
    if (r.x0 < 0 || r.y0 < 0 || r.x1 > screen[0] || r.y1 > screen[1]) problems.push(`mark ${label.id}'s label is clipped`);
  }
  return problems;
}

/** The existing batches share the named and stress labels across both colonies' seats. */
export const MODEL_LABEL_FIXTURE_OFFSETS = [0, 3, 6, 9] as const;

/** Deterministic presentation fixtures only: no sim inputs, agent joins or changes to the source recording.
 * Stagger the colonies so even two seats per colony cover named, long, unknown
 * and hostile labels across the existing four batches. No seats or non-label fields change.
 */
export function withModelLabelFixture(messages: readonly StreamMessage[], offset = 0): StreamMessage[] {
  const assigned = new Map<string, string>();
  const counts = [0, 0];
  const labels = [
    "GPT-6.1 self-named experimental colony strategist long label",
    "UnlistedModel" + "x".repeat(51),
    '<img src=x onerror="alert(1)">',
    "GLM-5", "Claude Opus", "Gemini 3", "Kimi K2", "DeepSeek V4", "Qwen3", "Grok 4.7", "Meta/Llama-4",
  ];
  const labelFor = (agent: number, colony: 0 | 1): string => {
    const key = `${colony}:${agent}`;
    if (!assigned.has(key)) {
      const index = counts[colony]!++;
      assigned.set(key, labels[(index + offset + colony * 2) % labels.length]!);
    }
    return assigned.get(key)!;
  };
  return messages.map((m) => ({
    ...m,
    full: m.full === null ? null : { ...m.full, agents: m.full.agents.map((a, i) => ({ ...a, modelLabel: labelFor(i, a.colony) })) },
    events: m.events.map((e) => e.kind === "join" ? { ...e, modelLabel: labelFor(e.agent, e.colony) } : e),
  }));
}

/** How far into the shipped recording the house models check looks: reference captures were cold and at 10 s. */
const HOUSE_MODELS_AT_MS = 10_000;

/**
 * A scripted territory countdown, from the actual evaluator and public encoder, with no agent joins
 * and no ants. From the earliest tick a lead counts (minTick) the first colony holds one tile short of the sustained
 * lead over the second's; 30 s in it takes that tile, so the server's countdown starts at the least lead it ever runs at
 * (exactly the ratio: one tile less and it clears that step); 20 s later the tile goes and the countdown clears. Every
 * tile stays visited and no queen hatches, so nothing else changes. The still is 10 s into the countdown; the motion
 * check's window (30 s either side of its start) takes in its appearing and its clearing.
 */
export function territoryRecording() {
  const config = withGridScale(rulesConfig("redesign"));
  const rules = config.earlyWin;
  if (rules === undefined) throw new Error("territory scene needs the server's sustained-lead rules");
  const tps = config.ticksPerSecond;
  const other = 20;
  const lead = Math.max(rules.minHeldTiles, Math.ceil((other * rules.territoryRatioPermille) / 1000));
  const initial = createMatch(9901, config);
  initial.tick = rules.minTick;
  initial.ants = [];
  initial.owner.fill(-1); initial.owner.fill(0, 0, lead - 1); initial.owner.fill(1, lead - 1, lead - 1 + other);
  const tile = lead - 1 + other;
  const hold = (s: typeof initial) => {
    s.lastVisit.fill(s.tick);
    for (const colony of s.colonies) for (const queen of colony.queens ?? []) queen.lastHatchTick = s.tick;
  };
  hold(initial);
  let state = step(initial).state;
  const recorder = new SpectatorRecorder(state);
  const first = state.tick;
  const packets = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  let start: number | null = null;
  let cleared: number | null = null;
  let still: number | null = null;
  for (let i = 1; i <= 65 * tps; i++) {
    if (i === 30 * tps) state.owner[tile] = 0;
    if (i === 50 * tps) state.owner[tile] = -1;
    hold(state);
    const out = step(state); state = out.state;
    packets.push(encodePublicMessage({ ...recorder.record(out), full: null }));
    const win = territoryWinOf(state);
    if (win !== undefined && start === null) start = state.tick;
    if (win === undefined && start !== null && cleared === null) cleared = state.tick;
    if (win !== undefined && start !== null && still === null && state.tick === start + 10 * tps) still = state.tick;
  }
  if (start === null || cleared === null || still === null) throw new Error(`scripted territory scene: the countdown ${start === null ? "never started" : cleared === null ? "never cleared" : "was not running 10 s in"}`);
  const recording = "territory-countdown";
  mkdirSync(RECORDING_DIR, { recursive: true });
  writeFileSync(join(RECORDING_DIR, `${recording}.bin`), packMessages(packets));
  return { recording, first, tick: still, start };
}

async function main() {
  const { values } = parseArgs({ options: { "leaderboard-scenes": { type: "boolean", default: false }, recording: { type: "string" }, "fall-recording": { type: "string" }, "early-recording": { type: "string" }, out: { type: "string" }, dist: { type: "string" }, board: { type: "string", default: "2d" }, "first-impression-fixture": { type: "boolean", default: false }, "queens-fixture": { type: "boolean", default: false }, "motion-check": { type: "boolean", default: false }, "model-label-fixture": { type: "boolean", default: false }, "board-area": { type: "boolean", default: false }, "webkit-phone": { type: "boolean", default: false }, shard: { type: "string" } } });
  if (values["leaderboard-scenes"]) {
    if (!values.out) throw new Error("leaderboard stills needs --out");
    if (values.shard) throw new Error("standalone leaderboard scenes are not recording shards");
    if (!values.dist) await prepare();
    await captureLeaderboardStills(resolve(values.out), values.dist ? resolve(values.dist) : undefined);
    return;
  }
  if (!values.recording || !values.out) throw new Error("stills needs --recording and --out");
  if (values.board !== "2d" && values.board !== "3d") throw new Error("--board is 2d or 3d");
  const board = values.board;
  const labelFixtures: { source: string; recording: string; sha256: string; offset: number }[] = [];
  const fixtureRecording = (source: string, offset = 0): string => {
    if (!values["model-label-fixture"]) return source;
    const bytes = packMessages(withModelLabelFixture(loadRecording(source), offset).map(encodeMessage));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const recording = `label-models-${sha256.slice(0, 16)}`;
    writeFileSync(join(RECORDING_DIR, `${recording}.bin`), bytes);
    labelFixtures.push({ source, recording, sha256, offset });
    return recording;
  };
  const mainRecording = fixtureRecording(values.recording);
  const territory = territoryRecording();
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const webDir = values.dist ? resolve(values.dist) : undefined;
  if (!webDir) await prepare();

  // The moments of each recording; the fall recording, when given, supplies the attack, fall and result scenes. Each
  // recording's clock counts from its first message's tick (clockAt): one captured mid-match is stepped to its own ticks.
  if (values["first-impression-fixture"]) {
    mkdirSync(RECORDING_DIR, { recursive: true });
    writeFileSync(join(RECORDING_DIR, "first-impression-fixture.bin"), packMessages(firstImpressionFixture().map(encodeMessage)));
  }
  if (values["queens-fixture"]) {
    mkdirSync(RECORDING_DIR, { recursive: true });
    for (const n of QUEENS_FIXTURE_COUNTS) writeFileSync(join(RECORDING_DIR, `queens-fixture-${n}.bin`), packMessages(queensFixture(n).map(encodeMessage)));
  }
  const mainMessages = loadRecording(mainRecording);
  const mainMoments = sceneMoments(mainMessages);
  const mainFirst = mainMessages[0]?.tick ?? 0;
  const labelCandidates = countLabelCandidates(mainMessages);
  const fallRecording = values["fall-recording"] ? fixtureRecording(values["fall-recording"]) : null;
  const fallMessages = fallRecording === null ? null : loadRecording(fallRecording);
  const fallMoments = fallMessages === null ? null : sceneMoments(fallMessages);
  const plan: { recording: string; first: number; fixtureSuffix?: string; moments: Partial<Record<Exclude<Step, "tap-squad">, number | null>> }[] = [
    { recording: territory.recording, first: territory.first, moments: { territory: territory.tick } },
    { recording: mainRecording, first: mainFirst, moments: { mark: mainMoments.mark, action: mainMoments.action, ...(fallMoments === null ? { attack: mainMoments.attack, fall: mainMoments.fall, result: mainMoments.result } : {}) } },
    ...(fallMoments === null || fallRecording === null || fallMessages === null ? [] : [{ recording: fallRecording, first: fallMessages[0]?.tick ?? 0, moments: { attack: fallMoments.attack, fall: fallMoments.fall, result: fallMoments.result } }]),
  ];
  if (values["model-label-fixture"]) {
    for (const offset of MODEL_LABEL_FIXTURE_OFFSETS.slice(1)) {
      plan.push({ recording: fixtureRecording(values.recording, offset), first: mainFirst, fixtureSuffix: `models-${offset}`, moments: { action: mainMoments.action } });
    }
  }
  for (const { recording, first, moments } of plan) {
    console.log(`${recording}: plays from tick ${first}`);
    for (const [moment, tick] of Object.entries(moments)) console.log(tick === null ? `${recording}: no ${moment} moment in the recording; its scene is skipped` : `${recording}: ${moment} at tick ${tick}`);
  }
  // The Rules page (/rules) renders the recording's rules, as the live server renders the match's.
  const rules = withGridScale(rulesConfig(mainMessages[0]?.full?.setup.rules));
  const problems: string[] = [];
  /** A step, page or pass that threw: recorded as a failed check, logged, and the run carries on. */
  const failed = (what: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    problems.push(`${what}: ${message}`);
    console.error(`${what}: ${e instanceof Error ? (e.stack ?? message) : message}`);
  };
  // The early end: one scene from a recording ending on the stream's own reason with no colony
  // falling: the view measured EARLY_VIEW_LEAD_TICKS before the end, then the result once the card has followed it.
  const earlyRecording = values["early-recording"] ? fixtureRecording(values["early-recording"]) : null;
  const earlyMessages = earlyRecording === null ? null : loadRecording(earlyRecording);
  const early = earlyMessages === null ? null : matchEnd(earlyMessages);
  if (earlyRecording !== null && earlyMessages !== null) {
    const earlyMoments = sceneMoments(earlyMessages);
    const earlyFirst = earlyMessages[0]?.tick ?? 0;
    if (early === null || earlyMoments.result === null) problems.push(`${earlyRecording}: no end in the early-end recording; its scene is skipped`);
    else if (earlyMoments.fall !== null) problems.push(`${earlyRecording}: a colony falls at tick ${earlyMoments.fall} in the early-end recording; it is no early end and its scene is skipped`);
    else {
      plan.push({ recording: earlyRecording, first: earlyFirst, moments: { "early-view": Math.max(earlyFirst, early.tick - EARLY_VIEW_LEAD_TICKS), "early-end": earlyMoments.result } });
      console.log(`${earlyRecording}: plays from tick ${earlyFirst}; early end at tick ${early.tick} (${early.reason}, winner ${early.winner}); its scene at tick ${earlyMoments.result}`);
    }
  }
  // The result card at 360x800 besides the stills' sizes, its scene alone (the card at 390x844, the phone's, and
  // 360x800, both engines), and the territory countdown, its scene alone (at 390x844, 360x800 and 1280x800, both engines).
  const alone: Record<string, Step> = { result360x800: "result", territory360x800: "territory", territory1280x800: "territory" };
  const viewports: readonly (readonly [string, readonly [number, number], boolean])[] = [...VIEWPORTS, ["result360x800", [360, 800], true], ["territory360x800", [360, 800], true], ["territory1280x800", [1280, 800], false]];
  // --shard I/N: the whole run's units in run order, dealt in turn to the N
  // shards; a unit is one viewport's scenes in one engine, or one pass. Without it every unit runs, as before.
  const shard = parseShard(values.shard);
  const motionUnits = values["motion-check"] ? ["motion-countdown", "motion"] : [];
  const firstImpressionUnits = values["first-impression-fixture"] ? ["first-impression"] : [];
  const webkitLabels = viewports.filter(([label, , phone]) => phone || label === "territory1280x800").map(([label]) => label);
  const units = [
    ...viewports.map(([label]) => label),
    "house-models",
    ...firstImpressionUnits,
    ...(values["queens-fixture"] ? ["queens"] : []),
    "empty-server",
    "feed-drop",
    "result-screen",
    ...motionUnits,
    ...(board === "3d" ? ["fallback-3d-code-fails-to-load", "fallback-3d-context-lost", "fallback-3d-too-slow", "emulated-phone"] : []),
    ...(values["board-area"] ? ["board-area"] : []),
    ...(values["webkit-phone"] ? [...webkitLabels, "house-models", ...firstImpressionUnits, "empty-server", "feed-drop", "result-screen", ...motionUnits].map((unit) => `webkit-${unit}`) : []),
    ...(board === "3d" ? ["webgl-off"] : []),
  ];
  const shardList = shardUnits(units, shard);
  /** Whether this shard runs a unit; a name outside the run's units is a mistake here, not a unit to drop. */
  const mine = (unit: string): boolean => {
    if (!units.includes(unit)) throw new Error(`stills: ${unit} is not one of the run's units`);
    return shardList.includes(unit);
  };

  // The squad tap, on the main recording: the ticks nearest the action moment at which the agent
  // with the largest squad has an ant on or beside its own mark, tried in turn on each phone viewport. A recording with
  // no such tick cannot show the rule: the scene is skipped and the run fails.
  const squadTaps = squadTapCandidates(mainMessages, mainMoments.action ?? 0, SQUAD_TAP_TRIES);
  if (squadTaps.length === 0) problems.push(`tap-squad: no tick in ${mainRecording} at which the agent with the largest squad has an ant on or beside its own mark; the scene is skipped`);
  else console.log(`${mainRecording}: squad tap at tick ${squadTaps[0]!.tick}, agent ${squadTaps[0]!.agent} (${squadTaps[0]!.squad} ants), with ${squadTaps.length - 1} more tick(s) to try: ${squadTaps.map((t) => t.tick).join(", ")}`);

  const browser = await launchBrowser();
  const scenes: Scene[] = [];
  let fallbacks: unknown[] | null = null;
  let phoneTiming: unknown = null;
  let boardArea: unknown[] | null = null;
  let webkitPass: { device: string; version: string; viewports: string[]; ran: boolean; note?: string } | null = null;
  const resultScreens: unknown[] = [];
  // The 360x800 result screen plays the recording the result scene plays.
  const resultSource = fallRecording !== null && fallMessages !== null && fallMoments !== null ? { recording: fallRecording, first: fallMessages[0]?.tick ?? 0, tick: fallMoments.result } : { recording: mainRecording, first: mainFirst, tick: mainMoments.result };
  const resultScreen = async (b: Browser) => {
    if (resultSource.tick === null) {
      problems.push(`${enginePrefix(b)}${board}-phone360x800-result: ${resultSource.recording} has no result, so the 360x800 result screen is not checked`);
      return;
    }
    try { resultScreens.push(await resultScreenWhole(b, board, { ...resultSource, tick: resultSource.tick, webDir }, out, problems)); }
    catch (e) { failed(`${enginePrefix(b)}360x800 result screen`, e); }
  };
  const prov = provenance(browser);
  try {
    /**
     * A viewport's scenes: in Chromium, and with --webkit-phone each phone's
     * again in WebKit as the iPhone 15, whose stills and checks carry the webkit- prefix.
     */
    const viewportScenes = async (browser: Browser, label: string, vp: readonly [number, number], phone: boolean): Promise<void> => {
      const pre = enginePrefix(browser);
      for (const { recording, first, moments, fixtureSuffix } of plan) {
        const entries = (Object.entries(moments) as [Step, number | null][]).filter((e): e is [Step, number] => e[1] !== null && (alone[label] === undefined || e[0] === alone[label])).sort((a, b) => a[1] - b[1]);
        if (entries.length === 0) continue;
        let c: ClientPage;
        try {
          c = closeChecked(await openClient(browser, { recording, width: vp[0], height: vp[1], tilt: board === "3d", webDir, board, phone, rules }), `${pre}${recording} ${board} ${label}`, problems);
        } catch (e) {
          failed(`${pre}${recording} ${board} ${label}: the client did not open`, e);
          continue;
        }
        let now = 0;
        // Catch up without drawing (a software-rendered 3D frame takes seconds); each shot draws.
        const goTo = async (clockMs: number) => {
          while (now < clockMs) {
            const step = Math.min(1000, clockMs - now);
            await c.advance(step);
            now += step;
            await c.frame(false);
          }
        };
        /** One still of the client page, with its checks. */
        const shoot = async (moment: Scene["moment"], tick: number, extra: Pick<Scene, "owner" | "squad" | "attack" | "early" | "fall" | "markLabels"> = {}) => {
          const view = board === "3d" ? (await c.page.evaluate(() => (window.__antwar as Antwar3dApi).camera().view)) : undefined;
          const f = await c.frame();
          // CSS transitions (the bug's hit flash, the result's fade) settle in real time; the board itself only moves with the clock.
          await c.page.waitForTimeout(1000);
          await c.frame();
          const file = `${pre}${board}-${label}-${moment}${fixtureSuffix ? `-${fixtureSuffix}` : ""}.jpg`;
          writeFileSync(join(out, file), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
          const wraps = await statusWraps(c);
          const emptyCorners = await stageCornersOffBoard(c);
          const tooltip = await tooltipBox(c);
          // The board's share of the screen's height: the board area's height over the viewport's.
          const boardShare = await boardShareOf(c);
          const scene: Scene = { file, moment, recording, board, viewport: vp, tick, playbackTick: f.playbackTick, ...(view === undefined ? {} : { view }), frame: f, ...extra, wraps, emptyCorners, boardShare, ...(tooltip ? { tooltip } : {}) };
          scenes.push(scene);
          // Every check on the record (scene-checks.ts).
          problems.push(...sceneProblems(scene));
          const checked = extra.owner ? `, ${extra.owner.label ? "label" : "marker"} of mark ${extra.owner.markId}: tooltip ${extra.owner.tooltip}${extra.owner.antUnder ? " (an ant on the marker)" : ""}` : extra.squad ? `, agent ${extra.squad.agent} (${extra.squad.squad} ants)${extra.squad.onOwnMark ? " on its own mark" : " off its marks"}: card ${extra.squad.card}, tooltip ${extra.squad.tooltip}` : extra.attack ? `, under attack: ${extra.attack.rows.join("; ") || "no queen"}` : extra.early ? `, early end (${extra.early.reason}): "${extra.early.winner}" "${extra.early.how}", dimmed sides ${extra.early.fallenSides}, view ${extra.early.viewMoved ? "moved" : "still"}` : extra.fall ? `, fallen colony ${extra.fall.colony ?? "none"}, ${extra.fall.nests.length} queen(s)` : "";
          console.log(`${file}: tick ${f.playbackTick}, ${f.marks.markers} markers, ${f.squadTags.full} badges, ${f.chat} log lines, board ${Math.round(boardShare * 100)}% of the height${checked}`);
        };
        /**
         * The squad tap on a phone: at the first of the
         * candidate ticks where an ant of the agent with the largest squad, on or beside a mark of its own, stands on
         * the uncovered board here, a touch on it opens that agent's card only, with no squad tooltip (the card names
         * it) and no mark tooltip (on touch the ant wins). When no candidate tick qualifies on this viewport, the run fails
         * and says so, and any uncovered ant of the last candidate's agent is tapped instead.
         */
        /** The page's scroll: closing the card must give it back. */
        const pageScroll = () => c.page.evaluate(() => Math.round(window.scrollY));
        /** The first of the agent's ants (on or beside a mark of its own, nearest its marker first, when asked) standing on the uncovered board here, or null. */
        const antToTap = (agent: number, onOwnMark: boolean) => c.page.evaluate(([agent, own]) => window.__antwar.squadAnts(agent, own).find((p) => document.elementFromPoint(p[0], p[1])?.tagName === "CANVAS") ?? null, [agent, onOwnMark] as const);
        /** The tap on `ant` of the candidate's agent: its card and no tooltip, then the page put back with its scroll checked. */
        const tapAnt = async (tap: SquadTap, ant: readonly [number, number], onOwnMark: boolean) => {
          const name = `${pre}${board}-${label}-tap-squad`;
          const scrollBefore = await pageScroll();
          await c.page.touchscreen.tap(ant[0], ant[1]);
          await goTo(now + 300);
          const after = await c.page.evaluate((selection) => ({
            card: document.querySelector(selection) !== null,
            agent: window.__antwar.highlighted().agent,
            mark: window.__antwar.focusedMark(),
            tooltip: window.__antwar.drawnLabels().some((d) => d.kind === "tooltip"),
          }), SELECTION_SHOWN);
          await shoot("tap-squad", tap.tick, { squad: { agent: tap.agent, squad: tap.squad, onOwnMark, card: after.card, tooltip: after.tooltip } });
          if (!after.card || after.agent !== tap.agent) problems.push(`${name}: tapping agent ${tap.agent}'s ant did not open its card`);
          if (after.tooltip || after.mark !== null) problems.push(`${name}: ${after.mark !== null ? `mark ${after.mark} stayed focused` : "a squad tooltip showed"} with agent ${tap.agent}'s card; on touch the ant wins`);
          // Back to the plain page: the selection cleared; closing it must leave the scroll as it was before the tap.
          await c.page.keyboard.press("Escape");
          await goTo(now + 100);
          const scrollAfter = await pageScroll();
          if (scrollAfter !== scrollBefore) problems.push(`${name}: closing the ant's card left the page scrolled ${scrollAfter} px, where it stood at ${scrollBefore} px before the tap; closing a card must give the scroll back`);
          await c.page.mouse.move(vp[0] - 2, vp[1] - 2);
          await goTo(now + 100);
        };
        /** One candidate tick: tapped when the agent's ant on or beside its own mark stands on the uncovered board here. */
        const tapSquad = async (tap: SquadTap): Promise<boolean> => {
          const ant = await antToTap(tap.agent, true);
          if (ant === null) return false;
          await tapAnt(tap, ant, true);
          return true;
        };
        /** No candidate tick showed the rule on this viewport: the run fails and says so, and any uncovered ant of the agent is tapped instead. */
        const tapFallback = async (tap: SquadTap, tried: number) => {
          const ant = await antToTap(tap.agent, false);
          problems.push(`${pre}${board}-${label}-tap-squad: at none of the ${tried} tick(s) nearest the action moment does the largest squad's ant on or beside its own mark stand on the uncovered board at this viewport; the squad tap was not shown${ant === null ? ` (and agent ${tap.agent} has no ant on the uncovered board at tick ${tap.tick})` : ` (agent ${tap.agent}'s ant off its marks was tapped at tick ${tap.tick} instead)`}`);
          if (ant !== null) await tapAnt(tap, ant, false);
        };
        /**
         * The early end: the result card up, reading the stream's own reason; no colony shown
         * falling (no side of the HUD dimmed); and the view as it was before the end,
         * since no camera moves by itself outside a fall window.
         */
        const viewNow = () => c.page.evaluate(() => window.__antwar.view());
        let viewBefore: Awaited<ReturnType<typeof viewNow>> | null = null;
        const earlyEnd = async (tick: number, end: NonNullable<typeof early>) => {
          const seen = await c.page.evaluate(() => ({
            card: document.querySelector(".d1-result:not([hidden])") !== null,
            winner: document.querySelector(".d1-result-head")?.textContent?.trim() ?? "",
            how: document.querySelector(".d1-result-how")?.textContent?.trim() ?? "",
            fallenSides: document.querySelectorAll(".is-fallen").length,
            ended: window.__antwar.board()?.ended ?? false,
          }));
          const view = await viewNow();
          const viewMoved = viewBefore === null || Math.abs(view.ox - viewBefore.ox) > 0.5 || Math.abs(view.oy - viewBefore.oy) > 0.5 || Math.abs(view.tilePx - viewBefore.tilePx) > 1e-6;
          await shoot("early-end", tick, { early: { reason: end.reason, winner: seen.winner, how: seen.how, fallenSides: seen.fallenSides, viewMoved } });
          const name = `${pre}${board}-${label}-early-end`;
          if (!seen.card || !seen.ended) problems.push(`${name}: the result card is not up at the early end`);
          const expected = resultHow(end, earlyMessages?.some((m) => m.full?.queens !== undefined) ?? false);
          if (seen.how !== expected) problems.push(`${name}: the result reads "${seen.how}", not the page's words for the stream's reason "${end.reason}" ("${expected}")`);
          if (seen.fallenSides > 0) problems.push(`${name}: a colony is shown falling at an early end (${seen.fallenSides} dimmed side(s))`);
          if (viewMoved) problems.push(`${name}: the view moved by itself between ${EARLY_VIEW_LEAD_TICKS} ticks before the end and the result${viewBefore === null ? " (no view was measured before the end)" : ""}`);
        };
        /** Try a recording-derived tick against this viewport's real placement before exercising the capture option. */
        const captureLabels = async (candidate: CountLabelCandidate): Promise<boolean> => {
          const labelState = async (): Promise<MarkLabelsSnapshot> => {
            const frame = await c.frame();
            const state = await c.page.evaluate(() => ({
              on: window.__antwar.options().markLabels,
              // Legacy snapshot field: read the actual capture option, not the removed DOM control.
              pressed: String(window.__antwar.options().markLabels),
              markers: window.__antwar.markers().map((m) => m.id),
              labels: window.__antwar.markLabels(),
            }));
            return { ...state, badges: frame.squadTags.full };
          };
          const beforeLabels = await labelState();
          const probe = await c.page.evaluate(() => {
            const s = window.__antwarCapture.boardArea();
            const labels = window.__antwar.markLabels();
            const markers = window.__antwar.markers();
            const onCanvas = (x: number, y: number) => document.elementFromPoint(x, y)?.tagName === "CANVAS";
            return {
              labels, markers, stage: { x0: Math.max(0, s.x0), y0: Math.max(0, s.y0), x1: Math.min(innerWidth, s.x1), y1: Math.min(innerHeight, s.y1) },
              uncovered: labels.filter((l) => {
                const m = markers.find((m) => m.id === l.id);
                return m && onCanvas(m.x, m.y) && onCanvas((l.rect.x0 + l.rect.x1) / 2, (l.rect.y0 + l.rect.y1) / 2);
              }).map((l) => l.id),
            };
          });
          const id = countLabelSample(candidate, probe);
          if (id === null) return false;
          const sample = { tick: candidate.tick, ...candidate.counts.find((m) => m.id === id)! };
          beforeLabels.sample = sample;
          try {
            await c.page.evaluate(() => window.__antwar.setOptions({ markLabels: false }));
            const hiddenLabels = { ...await labelState(), sample };
            await shoot("mark-labels-off", candidate.tick, { markLabels: hiddenLabels });
            await c.page.evaluate(() => window.__antwar.setOptions({ markLabels: true }));
            const restoredLabels = { ...await labelState(), sample };
            await shoot("mark-labels-restored", candidate.tick, { markLabels: restoredLabels });
            problems.push(...markLabelToggleProblems(beforeLabels, hiddenLabels, restoredLabels, vp).map((p) => `${pre}${board}-${label}-mark-labels: ${p}`));
          } finally {
            await c.page.evaluate(() => window.__antwar.setOptions({ markLabels: true }));
            await c.frame();
          }
          return true;
        };
        // On the phones the squad tap's candidate ticks join the main recording's scenes, in clock order: the first at
        // which the ant stands on the uncovered board here is tapped, and the ticks after it pass.
        const taps = phone && recording === mainRecording ? squadTaps : [];
        const lastTapTick = Math.max(...taps.map((t) => t.tick));
        let tapped = false;
        const labelTicks = recording === mainRecording && fixtureSuffix === undefined ? labelCandidates : [];
        let labelsCaptured = false;
        let labelTries = 0;
        const steps: [Step, number][] = [...entries, ...taps.map((t): [Step, number] => ["tap-squad", t.tick]), ...labelTicks.map((t): [Step, number] => ["mark-labels", t.tick])];
        steps.sort((a, b) => a[1] - b[1]);
        /** One step of the run: a scene with its checks, the squad tap, or the early end's measures. */
        const runStep = async (moment: Step, tick: number) => {
          const target = clockAt(tick, RENDER_DELAY_MS, first);
          if (moment === "mark-labels" && (labelsCaptured || now > target)) return;
          await goTo(target);
          if (moment === "mark-labels") {
            labelTries++;
            labelsCaptured = await captureLabels(labelTicks.find((c) => c.tick === tick)!);
            return;
          }
          if (moment === "tap-squad") {
            const candidate = taps.find((t) => t.tick === tick);
            if (candidate === undefined || tapped) return;
            tapped = await tapSquad(candidate);
            if (!tapped && tick === lastTapTick) await tapFallback(candidate, taps.length);
            return;
          }
          if (moment === "early-view") {
            viewBefore = await viewNow();
            return;
          }
          if (moment === "early-end") {
            if (early !== null) await earlyEnd(tick, early);
            return;
          }
          if (moment === "attack") {
            // The queen under attack: her cell in the HUD's queens ringed as under attack (the 2D
            // board's cell, ui/hud.ts; the deck's lamp, ui/deck/deck.ts); the run fails without one. Each row is her cell's
            // reading ("<colony> queen N: 36 HP, under attack").
            const seen = await c.page.evaluate(() => ({
              rows: [...document.querySelectorAll<HTMLElement>(".d2-cell.is-attacked, .d1-lamp.is-attacked")].map((r) => r.getAttribute("aria-label") ?? ""),
            }));
            await shoot(moment, tick, { attack: seen });
            if (seen.rows.length === 0) problems.push(`${pre}${board}-${label}-attack: no queen's cell reads under attack`);
          } else if (moment === "fall") {
            // The fallen queen whole in frame: the colony the board shows fallen (every queen the stream
            // lists for it lost) and each of its queens' box on the screen, judged against the board's area (scene-checks.ts):
            // her tile and her emblem (option B: her zone and ground margin may give
            // way at the stage's top and bottom). Her tile is the one whose QUEEN_FRAME_TILES box the board reports
            // (__antwar.nests()), her emblem FALL_EMBLEM_PX around its centre, both through the board's own camera.
            const seen = await c.page.evaluate(([mapW, mapH, frameTiles, emblemPx]) => {
              const stage = window.__antwarCapture.boardArea();
              const nests = window.__antwar.nests();
              const corners = new Map<string, [number, number]>();
              const corner = (x: number, y: number): [number, number] => {
                const k = `${x},${y}`;
                let p = corners.get(k);
                if (!p) corners.set(k, (p = window.__antwar.tileToScreen(x, y)));
                return p;
              };
              const boxOf = (x0: number, y0: number, x1: number, y1: number) => {
                const ps = [corner(x0, y0), corner(x1, y0), corner(x0, y1), corner(x1, y1)];
                return { x0: Math.min(...ps.map((p) => p[0])), y0: Math.min(...ps.map((p) => p[1])), x1: Math.max(...ps.map((p) => p[0])), y1: Math.max(...ps.map((p) => p[1])) };
              };
              const own = (r: { x0: number; y0: number; x1: number; y1: number }) => {
                for (let ty = 0; ty < mapH; ty++) {
                  for (let tx = 0; tx < mapW; tx++) {
                    const b = boxOf(tx - frameTiles, ty - frameTiles, tx + 1 + frameTiles, ty + 1 + frameTiles);
                    if (Math.abs(b.x0 - r.x0) + Math.abs(b.y0 - r.y0) + Math.abs(b.x1 - r.x1) + Math.abs(b.y1 - r.y1) > 1e-6) continue;
                    const t = boxOf(tx, ty, tx + 1, ty + 1);
                    const [cx, cy] = window.__antwar.tileToScreen(tx + 0.5, ty + 0.5);
                    return { x0: Math.min(t.x0, cx - emblemPx), y0: Math.min(t.y0, cy - emblemPx), x1: Math.max(t.x1, cx + emblemPx), y1: Math.max(t.y1, cy + emblemPx) };
                  }
                }
                return r;
              };
              const fallen = [0, 1].find((colony) => nests.some((n) => n.colony === colony) && nests.every((n) => n.colony !== colony || n.lost));
              return {
                colony: fallen ?? null,
                stage: { x0: stage.x0, y0: stage.y0, x1: stage.x1, y1: stage.y1 },
                nests: nests.filter((n) => n.colony === fallen).map((n) => ({ id: n.id, rect: own(n.rect) })),
              };
            }, [c.info.mapW, c.info.mapH, QUEEN_FRAME_TILES, FALL_EMBLEM_PX] as const);
            await shoot(moment, tick, { fall: seen });
          } else await shoot(moment, tick);
          if (moment !== "mark") return;
          // The mark with its owner: the newest mark whose label is drawn on the uncovered board is tapped on its label,
          // the mark's own target whatever stands under it (a label tap opens
          // the mark, never the ant beneath), and the mark must open — its tooltip shown, no card. With no label drawn
          // (a recording of word marks carries none), the newest marker not under a panel is pointed at, or on a phone
          // tapped: the newest clear of ants, where there is one, since on touch an ant under the tap wins,
          // so with an ant on every marker the tap must open the ant's card and show no tooltip.
          const m = await c.page.evaluate((phone) => {
            const onBoard = (x: number, y: number) => document.elementFromPoint(x, y)?.tagName === "CANVAS";
            // A squad badge is drawn over a mark's label and takes a tap within 4 px of its box first (squads.ts badgeAt),
            // rightly: the label's tap lands on a point of the label that no badge covers (in one landscape still,
            // Circle's badge on mark 6's label centre opened its agent's card), nearest the label's centre.
            const badges = window.__antwar.drawnLabels().filter((d) => d.kind === "tag").map((d) => d.rect);
            const free = (x: number, y: number) => onBoard(x, y) && !badges.some((b) => x >= b.x0 - 4 && x <= b.x1 + 4 && y >= b.y0 - 4 && y <= b.y1 + 4);
            const labelPoint = (r: { x0: number; y0: number; x1: number; y1: number }) => {
              const cx = (r.x0 + r.x1) / 2;
              const cy = (r.y0 + r.y1) / 2;
              for (let dx = 0; dx <= (r.x1 - r.x0) / 2 - 3; dx += 3) {
                for (const x of dx === 0 ? [cx] : [cx + dx, cx - dx]) if (free(x, cy)) return { x, y: cy, centre: dx === 0 };
              }
              return null;
            };
            const labelled = window.__antwar.markLabels().flatMap((l) => {
              const at = labelPoint(l.rect);
              return at === null ? [] : [{ id: l.id, ...at }];
            }).sort((a, b) => b.id - a.id)[0];
            if (labelled) return { id: labelled.id, x: labelled.x, y: labelled.y, label: true, antUnder: false, centre: labelled.centre };
            const shown = window.__antwar.markers().filter((p) => onBoard(p.x, p.y)).sort((a, b) => b.id - a.id);
            const clear = phone ? shown.find((p) => window.__antwar.antAt(p.x, p.y) === null) : undefined;
            const pick = clear ?? shown[0];
            return pick ? { id: pick.id, x: pick.x, y: pick.y, label: false, antUnder: phone && clear === undefined, centre: true } : null;
          }, phone);
          if (m === null) {
            console.log(`${board} ${label}: no marker on the board at the mark moment`);
            return;
          }
          if (m.label && !m.centre) console.log(`${board} ${label}: mark ${m.id}'s label centre lies under a squad badge; tapped at ${Math.round(m.x)},${Math.round(m.y)} on the label`);
          if (phone) await c.page.touchscreen.tap(m.x, m.y);
          else await c.page.mouse.move(m.x, m.y);
          await goTo(now + 300);
          const after = await c.page.evaluate((selection) => ({ tooltip: window.__antwar.drawnLabels().some((d) => d.kind === "tooltip"), card: document.querySelector(selection) !== null, focused: window.__antwar.focusedMark() }), SELECTION_SHOWN);
          await shoot("mark-owner", tick, { owner: { markId: m.id, label: m.label, antUnder: m.antUnder, tooltip: after.tooltip } });
          if (m.label && (after.focused !== m.id || !after.tooltip || after.card)) problems.push(`${pre}${board}-${label}-mark-owner: the ${phone ? "tap" : "pointer"} on mark ${m.id}'s label ${after.card ? "opened an ant's card" : after.focused !== m.id ? `focused ${after.focused === null ? "no mark" : `mark ${after.focused}`}` : "showed no tooltip"}; a mark's label opens the mark, whatever stands under it`);
          else if (!m.label && m.antUnder && (!after.card || after.tooltip)) problems.push(`${pre}${board}-${label}-mark-owner: an ant stands on every marker, and the tap on marker ${m.id} ${!after.card ? "opened no card" : "showed a tooltip"}; on touch the ant wins`);
          else if (!m.label && !m.antUnder && !after.tooltip) problems.push(`${pre}${board}-${label}-mark-owner: the newest marker showed no tooltip`);
          await c.page.keyboard.press("Escape");
          await c.page.mouse.move(vp[0] - 2, vp[1] - 2);
        };
        // A step that throws is a failed check; the steps after it, and every other viewport, still run.
        for (const [moment, tick] of steps) {
          try {
            await runStep(moment, tick);
          } catch (e) {
            failed(`${pre}${board}-${label}-${moment} at tick ${tick} of ${recording}`, e);
          }
        }
        if (recording === mainRecording && fixtureSuffix === undefined && !labelsCaptured) problems.push(`${pre}${board}-${label}-mark-labels: no eligible compact count label on the captured stage in ${labelTries} recording-derived candidate tick(s); labels toggle not proven`);
        try {
          await c.close();
        } catch (e) {
          failed(`${pre}${recording} ${board} ${label}: closing the client`, e);
        }
      }
    };
    for (const [label, vp, phone] of viewports) if (mine(label)) await viewportScenes(browser, label, vp, phone);
    // The live house's models on every viewport, in the shipped recording of its players (?replay),
    // and at 1280x800 and 1440x900 too.
    if (mine("house-models")) {
      try {
        await captureHouseModels(browser, board, [...VIEWPORTS, ...REST_VIEWPORTS], out, webDir, problems, scenes);
      } catch (e) {
        failed("house models", e);
      }
    }
    if (values["first-impression-fixture"] && mine("first-impression")) {
      try { await captureFirstImpression(browser, board, out, webDir, problems, scenes); }
      catch (e) { failed("first impression fixture", e); }
    }
    if (values["queens-fixture"] && mine("queens")) {
      try { await captureQueensRow(browser, board, out, webDir, problems); }
      catch (e) { failed("queens fixture", e); }
    }
    // Empty server, cold load: the live page with no match plays the bundled recording.
    if (mine("empty-server")) {
      try { await captureEmptyServer(browser, board, VIEWPORTS, out, webDir, problems); }
      catch (e) { failed("empty server", e); }
    }
    // A live feed that drops mid-match: Reconnecting… over the last frame; the recording only once the server says no match.
    if (mine("feed-drop")) {
      try { await captureFeedDrop(browser, board, VIEWPORTS, out, webDir, problems); }
      catch (e) { failed("feed drop", e); }
    }
    if (mine("result-screen")) await resultScreen(browser);
    // Zero layout shift: the primary recording at 1x for 60 s from 30 s before its attack; motion.json.
    if (values["motion-check"]) {
      if (mine("motion-countdown")) {
        try { await motionCheck(browser, board, territory.recording, territory.first, territory.start, out, webDir, problems, COUNTDOWN_MOTION_VIEWPORTS, "motion-countdown"); }
        catch (e) { failed("countdown motion check", e); }
      }
      if (mine("motion")) {
        try { await motionCheck(browser, board, mainRecording, mainFirst, mainMoments.attack, out, webDir, problems); }
        catch (e) { failed("motion check", e); }
      }
    }
    if (board === "3d") {
      // Passes: each way the 3D board gives up ends on the reloaded 2D page; then the emulated phone. A pass
      // that throws is a failed check; the passes after it still run.
      const fellBack = (name: string, vp: [number, number], abort?: RegExp) => fallsBackTo2d(browser, out, { recording: mainRecording, webDir, name, vp, abort }, problems);
      fallbacks = [];
      for (const [name, vp, abort] of [["fallback-3d-code-fails-to-load", [1920, 1080], /\/assets\/main3d-[^/]*\.js$/], ["fallback-3d-context-lost", [1920, 1080], undefined], ["fallback-3d-too-slow", [360, 640], undefined]] as const) {
        if (!mine(name)) continue;
        try {
          fallbacks.push(await fellBack(name, [vp[0], vp[1]], abort));
        } catch (e) {
          failed(name, e);
        }
      }
      if (mine("emulated-phone")) {
        try {
          phoneTiming = await emulatedPhone(browser, mainRecording, mainMoments.action ?? 0, mainFirst, webDir, problems);
        } catch (e) {
          failed("emulated phone", e);
        }
      }
    }
    if (values["board-area"] && mine("board-area")) {
      try {
        boardArea = await boardAreas(browser, { recording: mainRecording, tick: mainMoments.action ?? mainFirst, first: mainFirst, webDir, board, rules }, problems);
      } catch (e) {
        failed("board area", e);
      }
    }
    // The WebKit phone pass: every phone scene again in Playwright WebKit
    // as the iPhone 15, with the first-impression, empty-server and feed-drop scenes and the phone motion check; an
    // overlap or a move there fails the run as in Chromium. A 3D run needs WebGL2 in WebKit: one without it (the capture host's
    // renders 2D only) runs no 3D phone pass here, and stills.json says so; the 2D run's pass covers the page.
    if (values["webkit-phone"] && shardList.some((unit) => unit.startsWith("webkit-"))) {
      let wk: Browser | null = null;
      try {
        wk = await launchWebKit();
        // The phones, and the countdown's desktop size in a desktop page (both engines at 1280x800).
        const phones = viewports.filter(([label, , phone]) => phone || label === "territory1280x800");
        webkitPass = { device: WEBKIT_DEVICE, version: wk.version(), viewports: phones.map(([label]) => label), ran: true };
        if (board === "3d" && !(await webGl2In(wk))) {
          webkitPass = { ...webkitPass, ran: false, note: "this WebKit has no WebGL2, so the 3D board's phone scenes did not run in WebKit; the 2D run's WebKit pass covers the page" };
          console.log(`webkit-phone: ${webkitPass.note}`);
        } else {
          for (const [label, vp, phone] of phones) if (mine(`webkit-${label}`)) await viewportScenes(wk, label, vp, phone);
          // The desktops' house models, in WebKit too (both engines).
          if (mine("webkit-house-models")) {
            try { await captureHouseModels(wk, board, DESKTOP_RAIL_VIEWPORTS, out, webDir, problems, scenes); }
            catch (e) { failed("webkit desktop house models", e); }
          }
          if (values["first-impression-fixture"] && mine("webkit-first-impression")) {
            try { await captureFirstImpression(wk, board, out, webDir, problems, scenes); }
            catch (e) { failed("webkit first impression fixture", e); }
          }
          const phoneViewports = VIEWPORTS.filter(([, , phone]) => phone);
          if (mine("webkit-empty-server")) {
            try { await captureEmptyServer(wk, board, phoneViewports, out, webDir, problems); }
            catch (e) { failed("webkit empty server", e); }
          }
          if (mine("webkit-feed-drop")) {
            try { await captureFeedDrop(wk, board, phoneViewports, out, webDir, problems); }
            catch (e) { failed("webkit feed drop", e); }
          }
          if (mine("webkit-result-screen")) await resultScreen(wk);
          if (values["motion-check"]) {
            if (mine("webkit-motion-countdown")) {
              try { await motionCheck(wk, board, territory.recording, territory.first, territory.start, out, webDir, problems, COUNTDOWN_MOTION_VIEWPORTS, "motion-countdown"); }
              catch (e) { failed("webkit countdown motion check", e); }
            }
            if (mine("webkit-motion")) {
              try { await motionCheck(wk, board, mainRecording, mainFirst, mainMoments.attack, out, webDir, problems); }
              catch (e) { failed("webkit motion check", e); }
            }
          }
        }
      } catch (e) {
        failed("webkit-phone", e);
      } finally {
        await wk?.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (boardArea !== null) writeFileSync(join(out, "board-area.json"), `${JSON.stringify({ board, client: webDir ?? "this checkout's web/dist", recording: mainRecording, tick: mainMoments.action ?? mainFirst, areas: boardArea }, null, 1)}\n`);
  let webglOff: Awaited<ReturnType<typeof stillsWebglOff>> | null = null;
  if (board === "3d" && mine("webgl-off")) {
    try {
      webglOff = await stillsWebglOff(mainRecording, out, webDir, problems);
    } catch (e) {
      failed("webgl off", e);
    }
  }
  // Every failed check, in stills.json and summary.txt; then the run fails when any did.
  writeFileSync(join(out, "stills.json"), `${JSON.stringify({ task: "stills", ...prov, client: webDir ?? "this checkout's web/dist", board, shard: shard === null ? null : { ...shard, units: shardList }, webkitPhone: webkitPass, resultScreens, recording: mainRecording, fallRecording, earlyRecording, labelFixtures, moments: { main: mainMoments, fall: fallMoments }, squadTaps, earlyEnd: early, boardArea, scenes, fallbacks, phoneTiming, webglOff, problems }, null, 1)}\n`);
  writeFileSync(join(out, "summary.txt"), `${board}: ${scenes.length} scene(s)${shard === null ? "" : ` in shard ${shard.index}/${shard.count} (${shardList.join(", ")})`}; ${problems.length === 0 ? "every check passed" : `${problems.length} failed check(s):\n${problems.join("\n")}`}\n`);
  if (problems.length > 0) throw new Error(`stills checks failed:\n${problems.join("\n")}`);
}

/**
 * Open the 3D board, make it give up (abort: its code fails to load; name containing
 * "context-lost": its WebGL context is lost; otherwise: frames drawn 60 ms apart on the stepped
 * clock until the quality controller gives up), and require the page to end as the reloaded 2D
 * board: Pixi, board=2d, every other parameter kept, and no error after the reload.
 */
export async function fallsBackTo2d(browser: Browser, out: string, o: { recording: string; webDir: string | undefined; name: string; vp: [number, number]; abort?: RegExp }, problems: string[]) {
  const [width, height] = o.vp;
  const { page, errors, url } = await servePage(browser, { recording: o.recording, width, height, tilt: true, webDir: o.webDir, board: "3d", abort: o.abort });
  const fail = (p: string) => problems.push(`${o.name}: ${p}`);
  const reloadedAs2d = (u: URL) => u.searchParams.get("board") === "2d";
  let drawn = 0;
  try {
    const abort = o.abort;
    const failedCode = abort ? page.waitForEvent("requestfailed", {
      predicate: (request) => abort.test(new URL(request.url()).pathname),
    }) : null;
    await page.goto(url);
    if (failedCode) {
      await failedCode;
      // The import rejection must settle before stepping its retry timer. servePage
      // pauses time, so waiting in real time alone can never reach the retry document.
      await page.waitForLoadState("networkidle");
      await page.clock.runFor(RETRY_3D_DELAY_MS + 1);
    }
    if (!o.abort) {
      await page.evaluate(() => window.__antwar.ready);
      if (o.name.includes("context-lost")) {
        await page.evaluate(() => (document.querySelector("canvas")!.getContext("webgl2") as WebGL2RenderingContext).getExtension("WEBGL_lose_context")!.loseContext());
      } else {
        // Draw frames 60 ms apart until the board gives up and the page reloads (the evaluate then fails).
        try {
          for (; drawn < 3000 && !reloadedAs2d(new URL(page.url())); drawn++) {
            await page.clock.runFor(60);
            await page.evaluate(() => window.__antwar.frame());
          }
        } catch {
          // The page navigated away: the reload.
        }
      }
    }
    await page.waitForURL(reloadedAs2d, { timeout: 120_000 });
    const since = errors.length;
    const info = await page.evaluate(() => window.__antwar.ready);
    await page.evaluate(() => window.__antwar.frame());
    const now = new URL(page.url());
    const file = `${o.name}.jpg`;
    writeFileSync(join(out, file), await page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
    if (/babylon/i.test(info.rendererName)) fail(`the page is still the 3D board (${info.rendererName})`);
    const before = new URL(url);
    before.searchParams.set("board", "2d");
    if (now.search !== before.search) fail(`the reload changed the parameters: ${now.search}, expected ${before.search}`);
    const after = errors.slice(since);
    if (after.length > 0) fail(`errors on the reloaded 2D page: ${JSON.stringify(after)}`);
    console.log(`${file}: reloaded as ${info.rendererName} at ${now.search}${drawn ? ` after ${drawn} frames` : ""}`);
    return { file, viewport: o.vp, renderer: info.rendererName, url: now.search, framesBeforeFallback: drawn || null, errorsBeforeReload: errors.slice(0, since) };
  } catch (e) {
    fail(`did not end on the 2D board: ${e instanceof Error ? e.message : String(e)}`);
    return { name: o.name, failed: true };
  } finally {
    await page.context().close();
  }
}

/**
 * Supporting evidence: an emulated phone (390x844, touch, the CPU slowed 4x) on
 * the 3D board, 30 s in real time from `fromTick`, recording each tier the board stands at, its
 * "too slow" warning and the reload, in order. It passes held smooth (a median of PASS_MS or
 * less) or stepped down tier by tier to the last, then warned, then reloaded as 2D.
 */
async function emulatedPhone(browser: Browser, recording: string, fromTick: number, firstTick: number, webDir: string | undefined, problems: string[]) {
  const PHONE: [number, number] = [390, 844];
  const c = closeChecked(await openClient(browser, { recording, width: PHONE[0], height: PHONE[1], tilt: true, webDir, board: "3d", phone: true }), `3D board at ${PHONE[0]}x${PHONE[1]} (emulated phone)`, problems);
  const renderer = `${c.info.rendererName} on ${c.info.rendererString}`;
  let now = 0;
  const target = clockAt(fromTick, RENDER_DELAY_MS, firstTick);
  while (now < target) {
    const step = Math.min(1000, target - now);
    await c.advance(step);
    now += step;
    await c.frame(false);
  }
  const cdp = await c.page.context().newCDPSession(c.page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await c.page.clock.resume();
  const quality = () => c.page.evaluate(() => (window.__antwar as Antwar3dApi).quality());
  let q = await quality();
  let frames = 0;
  let reloaded = false;
  // The proof is an order of events, recorded here before the reload can lose the page.
  const events: ({ at: number; frame: number } & ({ kind: "tier"; tier: number; medianMs: number | null } | { kind: "slow"; text: string } | { kind: "reload" }))[] = [];
  const t0 = Date.now();
  const log = (e: Record<string, unknown> & { kind: string }) => events.push({ at: Date.now() - t0, frame: frames, ...e } as (typeof events)[number]);
  log({ kind: "tier", tier: q.tier, medianMs: q.median });
  c.page.on("console", (m) => {
    if (m.text().includes("too slow")) log({ kind: "slow", text: m.text() });
  });
  const end = Date.now() + 30_000;
  try {
    while (Date.now() < end) {
      await c.frame();
      if (++frames % 10 === 0) {
        const was = q.tier;
        q = await quality();
        if (q.tier !== was) log({ kind: "tier", tier: q.tier, medianMs: q.median });
      }
    }
    q = await quality();
  } catch {
    // The board gave up and the page reloaded as the 2D board.
    reloaded = true;
    log({ kind: "reload" });
  }
  const lastTier = TIERS.length - 1;
  const tiers = events.flatMap((e) => (e.kind === "tier" ? [e.tier] : []));
  const iLast = events.findIndex((e) => e.kind === "tier" && e.tier === lastTier);
  const iSlow = events.findIndex((e) => e.kind === "slow");
  const iReload = events.findIndex((e) => e.kind === "reload");
  const steppedThenFellBack = tiers.length > 1 && tiers.every((t, i) => i === 0 || t === tiers[i - 1]! + 1) && iLast >= 0 && iSlow > iLast && iReload > iSlow;
  const heldSmooth = !reloaded && q.median !== null && q.median <= PASS_MS;
  // Information only: the 2D board's median frame time over 60 frames after the reload.
  let after2dMs: number | null = null;
  if (reloaded) {
    try {
      await c.page.waitForFunction(() => !!window.__antwar, undefined, { timeout: 20_000 });
      await c.page.evaluate(() => window.__antwar.ready);
      const gaps: number[] = [];
      let last = Date.now();
      for (let i = 0; i < 61; i++) {
        await c.page.evaluate(() => window.__antwar.frame());
        const t = Date.now();
        if (i > 0) gaps.push(t - last);
        last = t;
      }
      gaps.sort((x, y) => x - y);
      after2dMs = (gaps[29]! + gaps[30]!) / 2;
    } catch (e) {
      console.log(`emulated phone: no 2D timing after the reload (${String(e)})`);
    }
  }
  const timing = {
    viewport: PHONE,
    emulation: "isMobile, hasTouch, CPU throttled 4x (CDP Emulation.setCPUThrottlingRate)",
    renderer: `${renderer} (SwiftShader on the capture host's CPUs, not phone hardware; frame intervals include the harness's per-frame call)`,
    fromTick,
    seconds: 30,
    frames,
    tier: q.tier,
    medianMs: q.median,
    overlayMs: q.overlayMs,
    passLineMs: PASS_MS,
    pass: heldSmooth || steppedThenFellBack,
    heldSmooth,
    steppedThenFellBack,
    events,
    reloadedAs2d: reloaded,
    after2dMedianMs: after2dMs,
  };
  console.log(`emulated phone: ${JSON.stringify(timing)}`);
  if (!timing.pass) problems.push("emulated phone: neither held smooth nor stepped down, warned and reloaded as 2D in order");
  await c.close();
  return timing;
}

/**
 * WebGL turned off in the browser: the 2D and the 3D address, at 1920x1080 and 390x844,
 * must each end on the needs-WebGL message with no canvas left and the client's ready promise
 * rejected with the reason, and no page or console error at all; and the
 * rest of the page must work without a board: the HUD's Agents panel shown, standing open in its
 * pane (ui/hud.ts, ui/agents.ts), its heading whole and clear on the screen once scrolled to.
 */
async function stillsWebglOff(recording: string, out: string, webDir: string | undefined, problems: string[]) {
  const browser = await launchBrowser({ webgl: false });
  const shots: { file: string; board: string; viewport: [number, number]; message: string; failure: string | null; errors: string[]; agents: { whole: boolean; clear: boolean; opened: boolean } | null }[] = [];
  try {
    for (const board of ["2d", "3d"] as const) {
      for (const [label, [width, height]] of [["1080p", [1920, 1080]], ["phone", [390, 844]]] as const) {
        const name = `webgl-off-${board}-${label}`;
        const file = `${name}.jpg`;
        const fail = (p: string) => problems.push(`${file}: ${p}`);
        const { page, errors, url } = await servePage(browser, { recording, width, height, tilt: true, webDir, board });
        try {
          await page.goto(url);
          // The ready promise settles without the clock; the page records how.
          const failure = await page.evaluate(() => window.__antwar.ready.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e))));
          // The HUD mounts once the recording is read (web/src/main.ts startWithoutBoard): its Agents panel must be shown,
          // its heading whole and clear on the screen once scrolled to; every scroll is put back for the still.
          const mounted = await page.waitForSelector(".d2-agents-title", { state: "attached", timeout: 20_000 }).then(() => true, () => false);
          const agents = mounted
            ? await page.evaluate(() => {
                const title = document.querySelector<HTMLElement>(".d2-agents-title")!;
                const scrolled: [Element, number, number][] = [];
                for (let p: Element | null = title.parentElement; p; p = p.parentElement) scrolled.push([p, p.scrollTop, p.scrollLeft]);
                const page: [number, number] = [window.scrollX, window.scrollY];
                title.scrollIntoView({ block: "nearest", inline: "nearest" });
                const r = title.getBoundingClientRect();
                const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
                const seen = { whole: r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, clear: hit !== null && title.contains(hit), opened: document.querySelector(".d2-agents")!.getClientRects().length > 0 };
                for (const [p, top, left] of scrolled) { p.scrollTop = top; p.scrollLeft = left; }
                window.scrollTo(page[0], page[1]);
                return seen;
              })
            : null;
          const state = await page.evaluate(() => {
            const panel = document.getElementById("aw-waiting");
            return { shown: !!panel && !panel.hidden && panel.dataset.needsWebgl === "1", message: panel?.textContent ?? "", canvases: document.querySelectorAll("canvas").length };
          });
          writeFileSync(join(out, file), await page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
          if (failure === null) fail("a board started with WebGL turned off");
          if (!state.shown) fail("the needs-WebGL message is not shown");
          if (state.canvases > 0) fail(`${state.canvases} canvas(es) left on the page`);
          if (agents === null) fail("the Agents panel is not on the page; the page must work without a board");
          else if (!agents.opened) fail("the Agents panel is not shown; the page must work without a board");
          else if (!agents.whole || !agents.clear) fail(`the Agents panel's heading is ${!agents.whole ? "not whole on the screen" : "under another element"} once scrolled to; the page must work without a board`);
          if (errors.length > 0) fail(`errors with WebGL off: ${JSON.stringify(errors)}`);
          shots.push({ file, board, viewport: [width, height], message: state.message, failure, errors: [...errors], agents });
          console.log(`${file}: message shown ${state.shown}, start failure "${failure}", Agents panel ${agents === null ? "missing" : `shown ${agents.opened}, heading whole ${agents.whole}, clear ${agents.clear}`}`);
        } catch (e) {
          // A page that threw is a failed check; the other addresses still run.
          fail(e instanceof Error ? e.message : String(e));
        } finally {
          await page.context().close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}

/**
 * The house's models: the shipped recorded agent match (?replay: four Claude Code house
 * players, two a colony, as the live page plays it while no match is live) ten seconds in, one still on each viewport.
 * A desktop status line on a second line fails the run (the recording's own line is the longest the page
 * shows); its other measurements are on the record with every scene's.
 */
export async function captureHouseModels(browser: Browser, board: "2d" | "3d", viewports: readonly (readonly [string, readonly [number, number], boolean])[], out: string, webDir: string | undefined, problems: string[], scenes: Scene[]): Promise<void> {
  for (const [label, viewport, phone] of viewports) {
    const file = `${enginePrefix(browser)}${board}-${label}-house-models.jpg`;
    let c: ClientPage | undefined;
    try {
      c = closeChecked(await openClient(browser, { recording: "", replay: true, width: viewport[0], height: viewport[1], tilt: board === "3d", webDir, board, phone }), `${file}`, problems);
      for (let ms = 0; ms < HOUSE_MODELS_AT_MS; ms += 1000) {
        await c.advance(1000);
        await c.frame(false);
      }
      await c.page.evaluate(async () => { await document.fonts.ready; });
      await c.frame();
      // CSS transitions settle in real time, as for every scene.
      await c.page.waitForTimeout(1000);
      const frame = await c.frame();
      writeFileSync(join(out, file), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
      const scene: Scene = { file, moment: "house-models", recording: "replay", board, viewport, tick: frame.playbackTick, playbackTick: frame.playbackTick, frame, wraps: await statusWraps(c), emptyCorners: await stageCornersOffBoard(c), boardShare: await boardShareOf(c) };
      scenes.push(scene);
      // Its own check, the asked one; the scene's other measurements are on the record (stills.json) with every scene's.
      problems.push(...wrapProblems(scene));
      console.log(`${file}: tick ${frame.playbackTick}, ${frame.agents} agents${scene.wraps?.length ? `, wraps: ${scene.wraps.join(", ")}` : ""}`);
    } catch (e) {
      problems.push(`${file}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    } finally {
      if (c) await c.close().catch(() => undefined);
    }
  }
}

/** A stable no-agent presentation fixture for the retained first-impression scope.
 * Queen framing and founding stability are covered elsewhere, not by this capture.
 */
export function firstImpressionFixture(): StreamMessage[] {
  // Every match plays at grid scale 2: the reference 64x48 board in fine tiles.
  const S = NEW_MATCH_GRID_SCALE, W = 64 * S, H = 48 * S;
  const queen = (colony: 0 | 1, x: number, y: number): StreamQueen => ({ colony, id: 0, x: x * S * 256 + 128, y: y * S * 256 + 128, foundedTick: 0, lostTick: null, overrun: 0, hp: 100_000 });
  const starting = [queen(0, 8, 24), queen(1, 55, 24)];
  const ants: StreamMessage["ants"] = { count: 0, id: new Uint32Array(), x: new Uint16Array(), y: new Uint16Array(), heading: new Uint8Array(), colony: new Uint8Array(), agent: new Int16Array() };
  const territory = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) territory[y * W + x] = x < W / 2 ? 1 : 2;
  return [{ tick: 0, ants, events: [], full: { match: 97, setup: { mapW: W, mapH: H, gridScale: S, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 300, overrunRadiusTiles: 2 * S, queens: [[starting[0]!.x, starting[0]!.y], [starting[1]!.x, starting[1]!.y]], rules: "redesign" }, territory, queens: starting, hatched: [0, 0], agents: [], marks: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null } }];
}

/** The queens fixture's sizes (the next captures show 1, 4 and about 10 queens a side). */
export const QUEENS_FIXTURE_COUNTS = [1, 4, 10] as const;

/**
 * The first-impression match with `n` queens a colony (scripted state allowed for these captures):
 * each colony's queens founded in turn, its first at its setup nest; from 4 up its second queen is lost, and at 10 the
 * second colony's sixth too; the second colony's newest queen is bitten a tick after the snapshot, so her slot is ringed
 * and her side reads "under attack" while the first colony's does not.
 */
export function queensFixture(n: number): StreamMessage[] {
  const base = firstImpressionFixture()[0]!;
  const tick = 3000;
  const queens: StreamQueen[] = [];
  for (const colony of [0, 1] as const) {
    for (let id = 0; id < n; id++) {
      const [sx, sy] = base.full!.setup.queens[colony]!;
      const S = base.full!.setup.gridScale ?? NEW_MATCH_GRID_SCALE;
      const dx = id === 0 ? 0 : 256 * S * (2 + ((id * 7) % 18)), dy = id === 0 ? 0 : 256 * S * (((id * 11) % 36) - 18);
      const lost = (n >= 4 && id === 1) || (n >= 10 && colony === 1 && id === 5);
      queens.push({ colony, id, x: colony === 0 ? sx + dx : sx - dx, y: sy + dy, foundedTick: id * 250, lostTick: lost ? 2000 + id : null, overrun: 0, hp: lost ? 0 : 100_000 - id * 8_000 });
    }
  }
  return [
    { ...base, tick, full: { ...base.full!, queens } },
    { ...base, tick: tick + 1, full: null, events: [{ kind: "queenHp", colony: 1, queenId: n - 1, hp: 35_000 }] },
  ];
}

/**
 * The queens with 1, 4 and 10 a side at 360x800 and 1920x1080, from queensFixture: writes
 * DIR/<board>-<viewport>-queens-<n>.jpg, and fails the run where the board's area differs between the three:
 * founding a queen moves nothing of the board.
 */
async function captureQueensRow(browser: Browser, board: "2d" | "3d", out: string, webDir: string | undefined, problems: string[]): Promise<void> {
  const pre = enginePrefix(browser);
  for (const [label, vp, phone] of [["phone360x800", [360, 800], true], ["1080p", [1920, 1080], false]] as const) {
    const seen: { n: number; stage: string }[] = [];
    for (const n of QUEENS_FIXTURE_COUNTS) {
      const file = `${pre}${board}-${label}-queens-${n}.jpg`;
      let c: ClientPage | undefined;
      try {
        c = closeChecked(await openClient(browser, { recording: `queens-fixture-${n}`, width: vp[0], height: vp[1], tilt: false, webDir, board, phone }), `queens ${file}`, problems);
        await c.advance(RENDER_DELAY_MS + 200);
        await c.frame();
        await settleFirstImpression(c);
        await c.frame();
        writeFileSync(join(out, file), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
        const stage = await c.page.evaluate(() => JSON.stringify(window.__antwarCapture.boardArea()));
        seen.push({ n, stage });
        console.log(`${file}: board area ${stage}`);
      } catch (e) {
        problems.push(`${file}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      } finally {
        if (c) await c.close().catch(() => undefined);
      }
    }
    if (new Set(seen.map((s) => s.stage)).size > 1) problems.push(`${pre}${board}-${label}-queens: the board's area changes with the queens (${seen.map((s) => `${s.n}: ${s.stage}`).join("; ")})`);
  }
}


/** Advance the harness's paused clock until finite UI animations and geometry have settled.
 * Awaiting requestAnimationFrame directly would deadlock this capture's paused clock.
 */
async function settleFirstImpression(c: ClientPage): Promise<void> {
  await c.page.evaluate(async () => { await document.fonts.ready; });
  let previous = "";
  for (let step = 0; step < 120; step++) {
    await c.advance(16);
    await c.frame();
    const state = await c.page.evaluate(() => {
      const moving = document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
      return { moving, geometry: JSON.stringify(window.__antwarCapture.boardArea()) };
    });
    if (!state.moving && previous === state.geometry) return;
    previous = state.geometry;
  }
  throw new Error("first-impression layout did not settle within 120 stepped frames");
}

/** Save each completed scene directly; one failed action never discards evidence or later viewports. */
/**
 * The result screen whole at 360x800 (main's key, "Three ways a match
 * ends", ended 28 px off screen there): with the result up and the page at rest, every element outside the board that
 * shows text sits whole on screen, and none is set smaller than at 390x844, so nothing fits by shrinking type. Writes
 * DIR/<board>-phone360x800-result.jpg; every failure goes to problems.
 */
export async function resultScreenWhole(browser: Browser, board: "2d" | "3d", o: { recording: string; first: number; tick: number; webDir: string | undefined }, out: string, problems: string[]): Promise<unknown> {
  const pre = enginePrefix(browser);
  const name = `${pre}${board}-phone360x800-result`;
  const read = async (width: number, height: number, shot: string | null) => {
    const c = await openClient(browser, { recording: o.recording, width, height, tilt: board === "3d", webDir: o.webDir, board, phone: true });
    try {
      let now = 0;
      const at = clockAt(o.tick, RENDER_DELAY_MS, o.first);
      while (now < at) {
        const step = Math.min(1000, at - now);
        await c.advance(step);
        now += step;
        await c.frame(false);
      }
      await c.frame();
      // At rest: a second of play after the result shows, so the event caption it takes over from has sunk out under it
      // (overlays.ts CAPTION_EXIT_MS); the result's fade and the bars' fills run in real time.
      await c.advance(1000);
      await c.frame(false);
      await c.page.waitForTimeout(1000);
      await c.frame();
      if (shot !== null) writeFileSync(join(out, shot), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
      return await c.page.evaluate(() => {
        const step = (n: Element) => `${n.tagName.toLowerCase()}${[...n.classList].filter((k) => k.startsWith("aw-")).slice(0, 2).map((k) => `.${k}`).join("")}:${n.parentElement ? [...n.parentElement.children].indexOf(n) + 1 : 1}`;
        const path = (e: Element) => {
          const parts: string[] = [];
          for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) parts.unshift(step(n));
          return parts.join(" > ");
        };
        // The result as drawn: a text that it is not part of but overlaps is not whole either.
        const panels = [...document.querySelectorAll<HTMLElement>(".d1-result")].filter((p) => getComputedStyle(p).visibility === "visible" && p.getClientRects().length > 0);
        const texts: { key: string; text: string; font: number; rect: [number, number, number, number]; under: string[]; clippedBy: string | null }[] = [];
        for (const e of document.body.querySelectorAll<HTMLElement>("*")) {
          if (![...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "")) continue;
          const style = getComputedStyle(e);
          if (style.visibility !== "visible" || e.getClientRects().length === 0) continue;
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const under = panels.filter((p) => {
            if (p.contains(e)) return false;
            const q = p.getBoundingClientRect();
            return Math.min(r.right, q.right) - Math.max(r.left, q.left) > 0.5 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 0.5;
          }).map((p) => [...p.classList].slice(0, 2).join("."));
          // Cut by a box that clips it (a card scrolled inside) is not whole either.
          let clippedBy: string | null = null;
          for (let p = e.parentElement; p && p !== document.body && clippedBy === null; p = p.parentElement) {
            const ps = getComputedStyle(p);
            if (ps.overflowX === "visible" && ps.overflowY === "visible") continue;
            const q = p.getBoundingClientRect();
            if (r.left < q.left - 0.5 || r.top < q.top - 0.5 || r.right > q.right + 0.5 || r.bottom > q.bottom + 0.5) clippedBy = [...p.classList].filter((k) => k.startsWith("aw-")).slice(0, 2).join(".") || p.tagName.toLowerCase();
          }
          texts.push({ key: path(e), text: (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60), font: Number.parseFloat(style.fontSize), rect: [r.left, r.top, r.right, r.bottom], under, clippedBy });
        }
        return { result: document.querySelector(".d1-result:not([hidden])") !== null, width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY, texts };
      });
    } finally {
      await c.close();
    }
  };
  const small = await read(360, 800, `${name}.jpg`);
  const base = await read(390, 844, null);
  const found: string[] = [];
  if (!small.result) found.push("no result card is up at the result moment");
  for (const t of small.texts) {
    if (t.rect[0] < -0.5 || t.rect[1] < -0.5 || t.rect[2] > small.width + 0.5 || t.rect[3] > small.height + 0.5) found.push(`"${t.text}" is not whole on screen (${Math.round(t.rect[1])} to ${Math.round(t.rect[3])} px of ${small.height})`);
    if (t.under.length > 0) found.push(`"${t.text}" overlaps ${t.under.join(", ")}`);
    if (t.clippedBy !== null) found.push(`"${t.text}" is cut by its ${t.clippedBy}`);
    const was = base.texts.find((b) => b.key === t.key);
    if (was !== undefined && t.font < was.font - 0.01) found.push(`"${t.text}" is set at ${t.font} px, smaller than its ${was.font} px at 390x844`);
  }
  problems.push(...found.map((problem) => `${name}: ${problem}`));
  console.log(`${name}: ${small.texts.length} texts, ${found.length ? found.join("; ") : "all whole, none smaller"}`);
  return { name, viewport: [360, 800], recording: o.recording, tick: o.tick, texts: small.texts.length, problems: found };
}

/** Whether this browser gives a page WebGL2 (a WebKit build may not: the capture host's renders 2D only). */
async function webGl2In(browser: Browser): Promise<boolean> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
  } finally {
    await context.close();
  }
}

async function captureFirstImpression(browser: Browser, board: "2d" | "3d", out: string, webDir: string | undefined, problems: string[], scenes: Scene[]): Promise<void> {
  const pre = enginePrefix(browser);
  for (const [label, vp, phone] of VIEWPORTS) {
    if (isWebKit(browser) && !phone) continue;
    let c: ClientPage | undefined;
    try {
      c = closeChecked(await openClient(browser, { recording: "first-impression-fixture", width: vp[0], height: vp[1], tilt: false, webDir, board, phone }), `first impression ${board} ${label}`, problems);
      const loading = await c.page.evaluate(() => {
        const panel = document.getElementById("aw-waiting")!;
        return { words: panel.textContent?.replace(/\s+/g, " ").trim() ?? "", shown: !panel.hidden };
      });
      const loadingFile = `${board}-${label}-loading.jpg`;
      writeFileSync(join(out, loadingFile), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
      if (loading.words !== "Antwars Connecting…" || !loading.shown) problems.push(`${loadingFile}: first frame is not wordmark and Connecting… only (${JSON.stringify(loading)})`);
      await c.advance(RENDER_DELAY_MS);
      await c.frame();
      await settleFirstImpression(c);
      const frame = await c.frame();
      const file = `${board}-${label}-no-agents.jpg`;
      writeFileSync(join(out, file), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
      const measurement = await c.page.evaluate(() => ({
        stage: window.__antwarCapture.boardArea(),
        gutter: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--aw-gutter")),
      }));
      const scene: Scene = { file, moment: "first-impression", recording: "first-impression-fixture", board, viewport: vp, tick: 0, playbackTick: frame.playbackTick, frame, wraps: await statusWraps(c), emptyCorners: await stageCornersOffBoard(c), boardShare: await boardShareOf(c), firstImpression: { ...measurement, loading: { file: loadingFile, ...loading } } };
      scenes.push(scene);
      problems.push(...sceneProblems(scene));
      if (measurement.gutter !== 24) problems.push(`${file}: gutter is ${measurement.gutter}, expected 24 px`);
    } catch (e) {
      problems.push(`first impression ${board} ${label}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    } finally {
      if (c) {
        try { await c.close(); }
        catch (e) { problems.push(`first impression ${board} ${label}: closing client: ${String(e)}`); }
      }
    }
  }
}

/** A recording's messages, decoded (out/recordings/NAME.bin). */
function loadRecording(name: string): StreamMessage[] {
  return unpackMessages(readFileSync(join(RECORDING_DIR, `${name}.bin`))).map(decodeMessage);
}

/**
 * A desktop's status line in the HUD (the 2D board's mode label; the deck's legend) on more than one line, each as
 * "status line: text (N lines)": it keeps one line in every state.
 */
async function statusWraps(c: ClientPage): Promise<string[]> {
  return c.page.evaluate(() => {
    const lines = (e: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(e);
      const tops: number[] = [];
      for (const r of range.getClientRects()) if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < 2)) tops.push(r.top);
      return tops.length;
    };
    if (!(window.innerWidth >= 1280 && window.innerHeight > 500)) return [];
    return [...document.querySelectorAll<HTMLElement>(".d2-mode-label, .d1-legend")].filter((e) => (e.textContent ?? "") !== "" && lines(e) > 1).map((e) => `status line: ${e.textContent ?? ""} (${lines(e)} lines)`);
  });
}

/** The board's share of the screen's height: the board area's height over the viewport's. */
function boardShareOf(c: ClientPage): Promise<number> {
  return c.page.evaluate(() => {
    const a = window.__antwarCapture.boardArea();
    return (a.y1 - a.y0) / window.innerHeight;
  });
}

/**
 * The HUD showing a selected ant or agent: the 2D board's card for an ant outside any squad or the agent's open row
 * (ui/hud.ts paintCard, ui/agents.ts), or the deck's selection (ui/deck/pane.ts).
 */
const SELECTION_SHOWN = ".d2-card:not([hidden]), .d2-agent-item.is-open, .d1-selected:not([hidden])";

/**
 * The board area's corners, each STAGE_INSET px in, that lie off the board: the board's four
 * corners projected through the board's own camera make its outline on the screen, a rectangle on the 2D board and a
 * trapezoid on the tilted 3D one; a corner outside it would show the page's colour. Empty when the board fills its area.
 */
async function stageCornersOffBoard(c: ClientPage): Promise<string[]> {
  return c.page.evaluate(([mapW, mapH, inset]) => {
    const a = window.__antwarCapture.boardArea();
    const s = { left: a.x0, top: a.y0, right: a.x1, bottom: a.y1 };
    const outline = ([[0, 0], [mapW, 0], [mapW, mapH], [0, mapH]] as const).map(([x, y]) => window.__antwar.tileToScreen(x, y));
    const inside = (x: number, y: number) => {
      let on = false;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const [xi, yi] = outline[i]!;
        const [xj, yj] = outline[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
      }
      return on;
    };
    const corners: [string, number, number][] = [["top left", s.left + inset, s.top + inset], ["top right", s.right - inset, s.top + inset], ["bottom left", s.left + inset, s.bottom - inset], ["bottom right", s.right - inset, s.bottom - inset]];
    return corners.filter(([, x, y]) => !inside(x, y)).map(([name]) => name);
  }, [c.info.mapW, c.info.mapH, STAGE_INSET] as const);
}

/** The board-area report's sizes: width, height and whether a phone (touch, a coarse pointer). */
const AREA_VIEWPORTS = [[1920, 1080, false], [1366, 768, false], [390, 844, true], [360, 780, true], [844, 390, true]] as const;

/**
 * The board's on-screen area at each of the report's sizes: the board area's width and height at playback tick
 * `tick` of the recording, on this board, as rendered by this checkout's client or by --dist's older build.
 */
async function boardAreas(browser: Browser, o: { recording: string; tick: number; first: number; webDir: string | undefined; board: "2d" | "3d"; rules: Parameters<typeof openClient>[1]["rules"] }, problems: string[]) {
  const areas: { viewport: [number, number]; stage: { width: number; height: number; area: number } }[] = [];
  for (const [width, height, phone] of AREA_VIEWPORTS) {
    const c = closeChecked(await openClient(browser, { recording: o.recording, width, height, tilt: o.board === "3d", webDir: o.webDir, board: o.board, phone, rules: o.rules }), `board area ${o.board} ${width}x${height}`, problems);
    try {
      const target = clockAt(o.tick, RENDER_DELAY_MS, o.first);
      for (let now = 0; now < target;) {
        const step = Math.min(1000, target - now);
        await c.advance(step);
        now += step;
        await c.frame(false);
      }
      await c.frame();
      const s = await c.page.evaluate(() => {
        const a = window.__antwarCapture.boardArea();
        return { width: a.x1 - a.x0, height: a.y1 - a.y0 };
      });
      const stage = { width: Math.round(s.width), height: Math.round(s.height), area: Math.round(s.width * s.height) };
      areas.push({ viewport: [width, height], stage });
      console.log(`board area ${o.board} ${width}x${height}: stage ${stage.width}x${stage.height} = ${stage.area} px²`);
    } finally {
      await c.close();
    }
  }
  return areas;
}

/** The tooltip shown now (the mark's or the squad's; web/src/tip.ts), its box and whether it lies whole on the screen; null with none. */
async function tooltipBox(c: ClientPage): Promise<Scene["tooltip"] | null> {
  return c.page.evaluate(() => {
    const tip = window.__antwar.drawnLabels().find((d) => d.kind === "tooltip");
    if (!tip) return null;
    const { x0, y0, x1, y1 } = tip.rect;
    return { x0, y0, x1, y1, onScreen: x0 >= 0 && y0 >= 0 && x1 <= innerWidth && y1 <= innerHeight };
  });
}

/** The client page, whose close() records any page or console error it saw into problems. */
function closeChecked(c: ClientPage, label: string, problems: string[]): ClientPage {
  const close = c.close;
  return {
    ...c,
    close: async () => {
      problems.push(...c.errors.map((e) => `${label}: ${e}`));
      await close();
    },
  };
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
