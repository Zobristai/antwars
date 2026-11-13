/**
 * antwar spectator client (extends the prototype): follows a
 * live match from the server's stream, or plays a recorded one, through the
 * delayed-playback buffer, and draws it with PixiJS 8 forced to WebGL2
 * (preference 'webgl'; no WebGPU). Overlays are HTML over
 * the canvas.
 *
 * URL parameters:
 *   lobby=ID       follow a specific lobby (default: random ongoing public match)
 *   replay         play the shipped recorded agent match, labelled as a recording
 *   recording=NAME play recordings/NAME.bin instead (bench and capture; shown as the live view)
 *   capture        no animation loop; the harness calls frame() after stepping Playwright's clock
 *   tilt=1         tilt-shift on (off by default, so the board is sharp)
 *   trails=0       traffic trails off
 *   frametime=1    report the client's frame times (window.__antwar.frameTimes())
 *   board=2d       select 2D instead of the default 3D board; board=3d also works.
 *                  Without WebGL2, 2D starts instead (web/src/webgl2.ts).
 */
import { loadIcons } from "./icons/textures.ts";
import { mountIconDom } from "./icons/dom.ts";
import { Application, Container, isWebGLSupported, type WebGLRenderer } from "pixi.js";
import { streamQueens } from "../../src/live/format.ts";
import { openingBounds, openingPhase } from "./start-framing.ts";
import { Frame, Playback, QUEEN_FRAME_TILES, fallWindow, fallenNests, fallenQueenBox } from "./buffer.ts";
import { createClock } from "./clock.ts";
import { gpuReadback, realTimeSource, type RealNow } from "./timing.ts";
import { bakeSoil } from "./soil.ts";
import { boardLook, type BoardLook } from "./board-look.ts";
import { Territory } from "./territory.ts";
import { Ants, antLengthPx } from "./ants.ts";
import { gridScale } from "./grid-scale.ts";
import { FoodPiles } from "./food.ts";
import { StartBoxes2D } from "./start-boxes2d.ts";
import { Battles, CVD_MATRICES, PlaceMarkers, QueenHomes, cvdFilter, tiltShift, type Deficiency } from "./effects.ts";
import { FONT_LICENCE, Words, loadFonts, nestRects, nestZoneRect, type MarkStats, type Rect } from "./words.ts";
import { Camera, FALL_MOVE_MS, LOCATE_ZOOM, easeInOut, fightLane, foundingEnvelope, lerpView, queensBox, reducedMotion, type View } from "./camera.ts";
import { Squads, agentHues } from "./squads.ts";
import { Overlays } from "./overlays.ts";
import { openSource } from "./source.ts";
import { TeamView, teamViewControl } from "./team-view.ts";
import { Fog2D } from "./fog2d.ts";
import { mountReplayControls } from "./replay-controls.ts";
import { colonyNamesOf } from "../../src/sim/colonyNames.ts";
import type { RecordingStats } from "./recording.ts";
import { Waiting } from "./waiting.ts";
import { TOUCH_RADIUS_PX, linkLine, tiltOn as tiltParam } from "./compose.ts";
import { excerptEnded, modeCopy } from "./replay.ts";
import { boardMode, fallbackUrl, hasWebGL2, linkNeedsWebGLHome, runBoard, showNeedsWebGL, unlinkNeedsWebGLHome } from "./webgl2.ts";
import { clear3dRetryUrl, start3dWithRecovery } from "./3d-recovery.ts";

/** Internal resolution is capped at a 2560 px long side. */
export const MAX_INTERNAL_LONG_SIDE = 2560;
/** After the result is shown, look for the next match this often. */
const NEXT_MATCH_POLL_MS = 30_000;
/** At the result the board's labels and badges fade out over this long, leaving the board and the result. */
const FINALE_FADE_MS = 800;

export interface ClientInfo {
  rendererString: string;
  webgl2: boolean;
  rendererName: string;
  cssSize: [number, number];
  canvasSize: [number, number];
  resolution: number;
  source: string;
  mapW: number;
  mapH: number;
  fontLicence: string;
  /** The colour-blindness simulation matrices the client applies (3x3, row-major, on sRGB values). */
  cvdMatrices: Record<Deficiency, readonly number[]>;
}

export interface FrameResult {
  clockMs: number;
  playbackMs: number;
  playbackTick: number;
  underrun: boolean;
  /** Board items drawn this frame: squad badges and mark markers (markers carry no text). */
  labels: number;
  marks: MarkStats;
  /** Chat lines playback has reached. */
  chat: number;
  squadTags: { full: number; squads: number };
  agents: number;
  intentLines: number;
  /** Effects on screen this frame: fight shockwaves, fading corpses, timeline places marked. */
  fights: number;
  corpses: number;
  placeMarks: number;
  /** Real-time costs, present only when the bench timing source is installed. */
  phases?: Record<string, number>;
  ingestMs?: number;
  /** Elapsed decode/preparation work reported by the worker, separate from main-thread phase costs. */
  workerMs?: number;
  /** Main-thread worker-message delivery (including lazy event.data decoding), outside the frame phase. */
  deliveryMs?: number;
  updateMs?: number;
  renderMs?: number;
}

export interface SceneOptions {
  tilt?: boolean;
  trails?: boolean;
  cvd?: Deficiency | null;
  ants?: boolean;
  words?: boolean;
  markLabels?: boolean;
  front?: boolean;
  battles?: boolean;
  overlays?: boolean;
}

export interface AntwarApi {
  ready: Promise<ClientInfo>;
  /** Step to the clock's time and draw; render false (the 3D board only) updates without drawing, for catching up. */
  frame(render?: boolean): FrameResult;
  setOptions(o: SceneOptions): void;
  /** Render the current clock time again and return SHA-256 of the full frame's pixels. */
  hashFrame(): Promise<string>;
  /** Render the current clock time again and read one pixel at CSS coordinates. */
  samplePixel(x: number, y: number): [number, number, number, number];
  tileToScreen(tx: number, ty: number): [number, number];
  /** The client's frame times as one line with frametime=1 in the address (frame interval and client work medians; the 3D board's tier); null without it. */
  frameTimes(): string | null;
  /** The screen area the board is fitted to now, in CSS px: the HUD's window, or the whole screen before the HUD mounts. */
  boardArea(): Rect;
  /** Highlight one agent's squad as hovering its roster row does (-1 for none). */
  hover(agent: number): void;
  /**
   * Ants drawn tinted and ringed this frame, the selected squad's agent (Squads.selected: the agent
   * hovered or selected in the roster, else pointed at or tapped on the board; -1 for none) and its ants.
   */
  highlighted(): { tinted: number[]; ringed: number; agent: number; squad: number[] };
  /** The mark whose tooltip shows now (pointer, tap or a chosen log line), or null. */
  focusedMark(): number | null;
  /** Select the ant nearest a screen point, as a mouse click does; returns its id or null. */
  clickAt(x: number, y: number): number | null;
  /** The ant a click or tap at a screen point would pick, without picking it; its id or null. */
  antAt(x: number, y: number): number | null;
  /** Every board label's screen rect this frame (the squad badges), for overlap checks. */
  labelRects(): Rect[];
  /**
   * Screen bounds of everything drawn now with text or a badge, from what is on
   * screen: squad badges (tag) and the hover or tap tooltips (tooltip), which may
   * cover the board by design. Marks are markers with no text.
   */
  drawnLabels(): { kind: "tag" | "tooltip"; rect: Rect }[];
  /** Each mark's marker drawn now, in screen px. */
  markers(): { id: number; x: number; y: number; answered: number }[];
  /** Each mark's label drawn now (a count mark's reading on its plate beside its marker), with its box in screen px: the mark's own tap target. */
  markLabels(): { id: number; text: string; rect: Rect }[];
  zoomAt(factor: number, x: number, y: number): void;
  panBy(dx: number, dy: number): void;
  view(): View;
  playback(): { resets: number; newestTick: number };
  recording(): { stats: Readonly<RecordingStats>; complete: boolean; lastTick: number; time: number; error: string | null } | null;
  /** Whether tilt-shift and trails are on now. */
  options(): { tilt: boolean; trails: boolean; markLabels: boolean };
  /** What the delayed playback's board says now. */
  board(): { tick: number; held: [number, number]; overrun: [number, number]; deaths: [number, number]; winner: number | null; ended: boolean; intents: string[] } | null;
  /** Screen positions of an agent's squad ants; with onOwnMark, of those standing on or beside a mark of its own, the nearest to its marker first. */
  squadAnts(agent: number, onOwnMark?: boolean): [number, number][];
  /**
   * Each queen the stream lists (a legacy recording's derived from its setup): her colony, whether she is lost, and her
   * own box on the screen through the board's camera — her tile and QUEEN_FRAME_TILES around, her mound and emblem
   * (words.ts nestZoneRect) — for the stills' fall check; [] without a board.
   */
  nests(): { colony: number; id: number; lost: boolean; rect: Rect }[];
}

declare global {
  interface Window {
    __antwar: AntwarApi;
  }
}

let resolveReady!: (i: ClientInfo) => void;
let rejectReady!: (e: unknown) => void;
const ready = new Promise<ClientInfo>((res, rej) => {
  resolveReady = res;
  rejectReady = rej;
});
// Handled by default: a page with no board rejects it (webgl2.ts) with nothing awaiting it, and a visitor's console
// shows no uncaught rejection; the capture tools attach their own handlers and still read the reason.
ready.catch(() => undefined);
const notReady = () => {
  throw new Error("antwar client not ready");
};
window.__antwar = {
  ready,
  frame: notReady,
  setOptions: notReady,
  hashFrame: notReady,
  samplePixel: notReady,
  tileToScreen: notReady,
  frameTimes: notReady,
  boardArea: notReady,
  hover: notReady,
  highlighted: notReady,
  focusedMark: notReady,
  clickAt: notReady,
  antAt: notReady,
  labelRects: notReady,
  drawnLabels: notReady,
  markers: notReady,
  markLabels: notReady,
  zoomAt: notReady,
  panBy: notReady,
  view: notReady,
  playback: notReady,
  recording: notReady,
  options: notReady,
  board: notReady,
  squadAnts: notReady,
  nests: notReady,
};

/**
 * No WebGL at all (webgl2.ts runBoard: no board starts): the rest of the page still works
 * — the stream or recording is read as a board would read it, the overlays mount and follow playback (the
 * score, the timeline, the agents, the rules), and the needs-WebGL message (`message`, web/index.html's waiting
 * panel) stands in the stage, where the board would be, its join panel given up to the masthead's button.
 */
async function startWithoutBoard(message: HTMLElement | null): Promise<void> {
  // The HUD remains usable without a GPU; mask loading needs no renderer.
  mountIconDom(document);
  void loadIcons();
  const params = new URLSearchParams(location.search);
  const clock = createClock();
  // Until the HUD mounts, and for good if the source never opens, the needs-WebGL panel is the page: it links home (webgl2.ts).
  linkNeedsWebGLHome(document);
  const input = await openSource(params, clock, document, rejectReady);
  if (!input) return;
  const { replay, head, linkState } = input;
  const overlays = new Overlays(document.body, { hover() {}, focusMark() {} }, "unavailable");
  // The HUD's window, where the board would be: the one part of the board's API a page without one has.
  window.__antwar.boardArea = () => overlays.area();
  overlays.setShare(input.share);
  const mode = replay ? "replay" : "live";
  overlays.setMode(modeCopy(mode, head.full!.agents.length, false, location.pathname, input.storedId, head.full!.setup.rated, input.delaySeconds));
  const controls = params.has("replay") && input.recording
    ? mountReplayControls(document, input.recording, colonyNamesOf(head.full!.setup)) : null;
  window.addEventListener("pagehide", () => controls?.close(), { once: true });
  // The needs-WebGL message stands in the HUD's window, where the board would be; its join panel is the HUD's.
  message?.querySelector(".aw-byoa")?.remove();
  unlinkNeedsWebGLHome(document);
  let playback = new Playback({ live: !input.recorded });
  let replayGeneration = input.recording?.generation ?? 0;
  let frame = new Frame();
  let resultShownAt: number | null = null;
  const step = () => {
    const realMs = clock.now();
    controls?.update();
    if (input.recording && input.recording.generation !== replayGeneration) {
      replayGeneration = input.recording.generation;
      playback = new Playback();
      frame = new Frame();
    }
    for (const arrival of input.take(realMs)) {
      if (arrival.kind === "prepared") playback.pushPrepared(arrival.prepared, arrival.at);
      else playback.push(arrival.m, arrival.at);
    }
    const now = input.now(realMs);
    playback.sample(now, frame);
    const board = frame.board;
    if (board) {
      const ended = replay && excerptEnded(frame.tick, input.lastTick);
      overlays.setMode(modeCopy(mode, board.agents.length, ended, location.pathname, input.storedId, board.setup.rated, input.delaySeconds));
    }
    if (board?.result) {
      resultShownAt ??= realMs;
      if (realMs - resultShownAt >= NEXT_MATCH_POLL_MS) input.nextMatch();
    } else resultShownAt = null;
    overlays.update(frame);
    overlays.setLink(linkLine(input.recorded ? "open" : linkState(), !!board?.result));
  };
  overlays.mountHud({ deck: false, replay: controls?.el ?? null, teamView: null, waiting: message });
  if (!params.has("capture")) {
    const loop = () => {
      step();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const capture = params.has("capture");
  // The screen size: read at load, and again after a rotation or window resize (refit, below).
  let w = window.innerWidth;
  let h = window.innerHeight;
  const resolution = internalResolution(w, h);
  const realNow: RealNow | null = window.__antwarRealNow ? realTimeSource() : null;
  const clock = createClock();

  const app = new Application();
  await app.init({ width: w, height: h, preference: "webgl", antialias: false, autoStart: false, background: "#121719", resolution, autoDensity: true });
  app.ticker.stop();
  mountIconDom(document);
  void loadIcons();
  document.body.appendChild(app.canvas);
  const renderer = app.renderer as WebGLRenderer;
  const gl = renderer.gl;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererString = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  await loadFonts();

  // Messages arrive from the stream or the recording (openSource); the first is always a full snapshot.
  // Until the first frame draws, web/index.html's waiting panel explains the delay.
  const input = await openSource(params, clock, document, rejectReady);
  if (!input) return;
  const { replay, feed, head, source, linkState } = input;
  let playback = new Playback({ live: !input.recorded });
  let replayGeneration = input.recording?.generation ?? 0;
  const W = head.full!.setup.mapW;
  const H = head.full!.setup.mapH;
  const scale = gridScale(head.full!.setup);
  // The initial view frames the fight lane between the nests; Whole board shows the whole map.
  const lane = fightLane(head.full!.setup);

  // The HUD's host first, so the board can fit into the HUD's window once it mounts.
  let camera!: Camera;
  const tilt = tiltShift(w, h);
  // Off by default: one value for the switch and the scene's filters.
  const tiltOn = tiltParam(params);
  const trailsOn = params.get("trails") !== "0";
  const overlays = new Overlays(
    document.body,
    {
      hover: (agent) => (squads.hovered = agent),
      // A live mark chosen in the log: its tooltip shows at its marker, brought to the middle of the board area.
      focusMark: (id, tx, ty) => {
        words.choose(id);
        squads.focused = -1;
        camera.centreOn(tx + 0.5, ty + 0.5);
      },
      // The page's zoom, Whole board and Show on board buttons: the viewer's own moves, never automatic.
      zoom: (factor) => camera.zoomBy(factor),
      wholeBoard: () => camera.reset(),
      locate: (x, y) => camera.centreOn(x, y, LOCATE_ZOOM),
      // The order the viewer points at in a HUD's Agents row: its tile lit on the board in its agent's hue (effects.ts PlaceMarkers).
      target: (tile, colour) => {
        places.target = tile;
        places.targetColour = colour;
      },
    },
    "2d",
  );
  overlays.setShare(input.share);
  // Live or recorded: the HUD's status line (replay.ts modeCopy).
  const mode = replay ? "replay" : "live";
  overlays.setMode(modeCopy(mode, head.full!.agents.length, false, location.pathname, input.storedId, head.full!.setup.rated, input.delaySeconds));
  const controls = params.has("replay") && input.recording
    ? mountReplayControls(document, input.recording, colonyNamesOf(head.full!.setup)) : null;
  window.addEventListener("pagehide", () => controls?.close(), { once: true });
  const envelope = foundingEnvelope(head.full!.setup);
  overlays.setBoardAspect((envelope.x1 - envelope.x0) / (envelope.y1 - envelope.y0));
  camera = new Camera(W, H, w, h, overlays.boardArea(w, h), lane, queensBox(head.full!.setup), scale);
  // The normal 2D home is fixed for every possible founding tile, not refitted to new queens.
  camera.setFoundingEnvelope(envelope);
  camera.setOpeningBounds(openingPhase(head.tick, head.full) ? openingBounds(head.full) : null);
  const fit = camera.fit;
  // Scene: [ scene (tilt-shift) [ world [ ground, front with its glow, queen homes, food piles, corpses, rings, battles, ants, places ] ], words, squad badges and tags ]
  // Fights are drawn beneath the ants, so a clash never hides the ants in it.
  const scene = new Container();
  const world = new Container();
  // The board look bakes its soil over the whole map, sized in physical tiles (board-look.ts).
  const physicalMap = { w: W / scale, h: H / scale };
  const territory = new Territory(W, H, bakeSoil(renderer, w, h, physicalMap), { w, h, ...fit });
  const ants = new Ants(renderer, antLengthPx(fit.tilePx * scale), fit.tilePx);
  const battles = new Battles(renderer, fit.tilePx);
  const places = new PlaceMarkers(fit.tilePx);
  const queens = new QueenHomes(fit.tilePx);
  const startBoxes = new StartBoxes2D(fit.tilePx);
  const food = new FoodPiles(renderer, fit.tilePx, scale);
  const words = new Words({ w, h });
  const squads = new Squads(renderer, w);
  // A colony's point of view: its fog over the ground and territory, under everything the view has filtered.
  const fog = new Fog2D(W, H);
  const teamView = new TeamView();
  // Its control, which the HUD places among the window's controls when it mounts.
  const teamViewSelect = teamViewControl(document, teamView);
  world.addChild(territory.fill, territory.frontLayer, fog.layer, startBoxes.layer, queens.layer, food.layer, ants.corpseLayer, squads.rings, battles.layer, ants.antLayer, queens.emblems, queens.crownIcons, places.layer);
  scene.addChild(world);
  // The markers and badges over the world; the tooltips are the page's own, above every panel.
  app.stage.addChild(scene, words.layer, squads.layer);
  scene.filters = tiltOn ? [tilt] : [];
  territory.trails = trailsOn;

  let overlaysOn = true;
  let wordsOn = true;

  let viewVersion = 0;
  const applyView = (v: View) => {
    world.position.set(v.ox, v.oy);
    world.scale.set(v.tilePx);
    territory.setView(v);
    battles.setTilePx(v.tilePx);
    places.setTilePx(v.tilePx);
    queens.setTilePx(v.tilePx);
    startBoxes.setTilePx(v.tilePx);
    food.setTilePx(v.tilePx);
    viewVersion++;
  };
  camera.onChange(applyView);
  applyView(camera.view);
  const pointer = camera.attach(app.canvas);

  // The first board frame fits the board to the HUD's window, which the camera was made before (the whole screen until
  // the HUD mounts). The labels' blocked rects and the camera's bounds follow the area; the view is fitted again only
  // while it is still the initial one (camera.ts setArea), so a move of the viewer's own is never undone.
  let areaStale = true;
  const refitArea = () => {
    areaStale = false;
    camera.setArea(overlays.boardArea(w, h));
    ants.setFit(antLengthPx(camera.fit.tilePx * scale), camera.fit.tilePx);
  };

  // After a rotation or window resize, the next frame re-fits everything sized to the screen and shows the whole board.
  // Starts true: the first frame also catches a resize while waiting for the first snapshot, before this listener existed.
  let resized = true;
  window.addEventListener("resize", () => (resized = true));
  const refit = () => {
    resized = false;
    if (window.innerWidth === w && window.innerHeight === h) return;
    w = window.innerWidth;
    h = window.innerHeight;
    renderer.resize(w, h, internalResolution(w, h));
    tilt.start = { x: 0, y: h / 2 };
    tilt.end = { x: w, y: h / 2 };
    camera.resize(w, h, overlays.boardArea(w, h));
    territory.resize(bakeSoil(renderer, w, h, physicalMap), { w, h, ...camera.view });
    words.resize({ w, h });
    squads.resize(w);
    ants.setFit(antLengthPx(camera.fit.tilePx * scale), camera.fit.tilePx);
  };

  let frame = new Frame();
  /** The frame the board draws: the playback frame, or one colony's view of it (team-view.ts); the HUD reads frame. */
  let shown = frame;
  const waiting = new Waiting(document.getElementById("aw-waiting"), document.querySelector(".aw-wait-state"));
  const pixel = new Uint8Array(4);
  let lastFrameAt: number | null = null;
  const frameIntervals: number[] = [];
  const frameCosts: number[] = [];
  /** The frametime=1 line (frameTimes()): null without the flag, or before a second frame. */
  const frameTimesOn = params.get("frametime") === "1";
  let frameTimes: string | null = null;
  let resultShownAt: number | null = null;
  let endedAt: number | null = null;
  let fallTurned = false;
  /** The camera's move into the fall, while it plays: from the view it left, to the fall view, from when. */
  let fallMove: { from: View; to: View; startedAt: number } | null = null;
  let matchSeen = 0;
  /** The rects the last layout kept clear of (the panels and the nests), which are not labels. */
  let lastBlocked: Rect[] = [];

  /**
   * The ant nearest a screen point, within 1.2 tiles, or within minPx screen px where a tile is drawn
   * smaller than that (a finger's tolerance), as a frame index; -1 for none.
   */
  const antAt = (x: number, y: number, minPx = 0): number => {
    const [tx, ty] = camera.toTile(x, y);
    let best = -1;
    let bestD = Math.max(1.2, minPx / camera.view.tilePx) ** 2;
    for (let i = 0; i < shown.count; i++) {
      const dx = shown.x[i]! - tx;
      const dy = shown.y[i]! - ty;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  /**
   * A click or tap. On a badge: shows that squad's tooltip and selects its agent,
   * keeping any ant already selected. Elsewhere: selects the
   * nearest ant and the agent whose squad holds it, shows the tooltip of a mark whose
   * marker it lands on (not on touch with an ant under the tap: the ant wins),
   * and the tooltip of the squad whose ant it lands on; on empty board it
   * clears the ant and agent selection.
   */
  const pickAnt = (x: number, y: number, touch = false): number | null => {
    const badge = squads.badgeAt(x, y);
    if (badge >= 0) {
      words.clearFocus();
      squads.focused = badge;
      overlays.selectAgent(badge);
      return null;
    }
    const exact = antAt(x, y);
    // A mark's label takes the tap whole: the mark opens, no ant is picked.
    if (words.tapAt(x, y, exact >= 0, touch)) {
      squads.focused = -1;
      return null;
    }
    // A finger's tolerance: with no ant under the tap itself, on touch the
    // nearest ant within TOUCH_RADIUS_PX is picked, unless the tap landed on a mark's marker, which then shows alone.
    const best = exact >= 0 ? exact : touch && words.focus === null ? antAt(x, y, TOUCH_RADIUS_PX) : -1;
    squads.focused = best >= 0 ? shown.agent[best]! : -1;
    if (best < 0) {
      overlays.select(null);
      overlays.selectAgent(-1);
      return null;
    }
    overlays.select({ antId: shown.id[best]!, colony: shown.colony[best]!, agent: shown.agent[best]! });
    overlays.selectAgent(shown.agent[best]!);
    return shown.id[best]!;
  };
  // The press's pointer type, for the click that ends it: on touch the ant wins over a mark under the same tap.
  let touched = false;
  app.canvas.addEventListener("pointerdown", (e) => (touched = e.pointerType === "touch"));
  app.canvas.addEventListener("click", (e) => {
    if (!pointer.dragged()) pickAnt(e.offsetX, e.offsetY, touched);
  });
  // Hover (a mouse; touch has tap): a mark's marker shows its tooltip, a squad's badge or ants its model label.
  app.canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons !== 0) return;
    // A mark chosen in the log stays focused unless the pointer is on another marker.
    words.hoverAt(e.offsetX, e.offsetY);
    const badge = squads.badgeAt(e.offsetX, e.offsetY);
    const best = badge >= 0 ? -1 : antAt(e.offsetX, e.offsetY);
    squads.focused = badge >= 0 ? badge : best >= 0 ? shown.agent[best]! : -1;
  });
  app.canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    words.hoverAt();
    squads.focused = -1;
  });
  // A tap or click off the board (the HTML controls included) dismisses a tapped tooltip;
  // capture phase, so a control that stops propagation still dismisses it. Taps on the board go through pickAnt.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target === app.canvas) return;
      words.clearFocus();
      squads.focused = -1;
    },
    true,
  );

  // Escape clears what the viewer chose: the ant, the agent and any tapped tooltip.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    overlays.select(null);
    overlays.selectAgent(-1);
    words.clearFocus();
    squads.focused = -1;
  });

  // The board look (board-look.ts), set by the HUD, is applied on the frame after it changes.
  let lookShown: BoardLook | null = boardLook();
  const relook = () => {
    lookShown = boardLook();
    territory.relook();
    territory.resize(bakeSoil(renderer, w, h, physicalMap), { w, h, ...camera.view });
  };

  const step = (): FrameResult => {
    if (resized) refit();
    if (boardLook() !== lookShown) relook();
    const realMs = clock.now();
    const t0 = realNow?.() ?? 0;
    let workerMs = 0;
    let deliveryMs = 0;
    controls?.update();
    if (input.recording && input.recording.generation !== replayGeneration) {
      replayGeneration = input.recording.generation;
      playback = new Playback();
      frame = new Frame();
      overlays.select(null);
      overlays.selectAgent(-1);
      words.clearFocus();
      squads.focused = squads.hovered = -1;
      endedAt = resultShownAt = null;
      fallTurned = false;
      fallMove = null;
      matchSeen = 0;
      camera.reset();
    }
    for (const arrival of input.take(realMs)) {
      if (arrival.kind === "prepared") {
        playback.pushPrepared(arrival.prepared, arrival.at);
        workerMs += arrival.workerMs;
        deliveryMs += arrival.deliveryMs;
      } else playback.push(arrival.m, arrival.at);
    }
    const now = input.now(realMs);
    const t1 = realNow?.() ?? 0;
    // Per-part costs, for the bench only.
    const phases: Record<string, number> = {};
    let mark = t1;
    const lap = (name: string) => {
      if (!realNow) return;
      const t = realNow();
      phases[name] = t - mark;
      mark = t;
    };
    const drew = playback.sample(now, frame);
    shown = teamView.apply(frame);
    lap("sample");
    const board = frame.board;
    // Clear the temporary opening home before any live/next-match/fall calculation.
    camera.setOpeningBounds(openingPhase(frame.tick, board) ? openingBounds(board) : null);
    // The fall window: as a colony's last queen is lost, the view turns onto the fallen colony's
    // nests, a restrained step in (camera.ts fallView), so her collapse is seen before the result card follows it by
    // its beat; at no other time does the camera move by itself, and the next match opens on the fight again. The
    // turn is a short eased move on the playback clock, a cut for a
    // viewer who prefers reduced motion.
    if (board && playback.matches !== matchSeen) {
      if (matchSeen > 0) camera.resize(w, h, overlays.boardArea(w, h));
      matchSeen = playback.matches;
    }
    const nests = board ? fallenNests(board) : null;
    if (nests === null) {
      fallTurned = false;
      fallMove = null;
    } else if (!fallTurned) {
      fallTurned = true;
      const to = camera.fallView(nests, fallenQueenBox(board!) ?? undefined);
      if (reducedMotion()) camera.set(to);
      else fallMove = { from: { ...camera.view }, to, startedAt: now };
    }
    if (fallMove !== null) {
      const t = (now - fallMove.startedAt) / FALL_MOVE_MS;
      camera.set(lerpView(fallMove.from, fallMove.to, easeInOut(t)));
      if (t >= 1) fallMove = null;
    }
    // The selected squad: hovered in the roster, else pointed at or tapped on the board.
    const selected = squads.selected;
    territory.update(shown, now);
    fog.update(shown);
    startBoxes.update(shown);
    queens.update(shown);
    food.update(shown);
    lap("territory");
    ants.update(shown, selected, agentHues(board?.agents ?? []), fallWindow(frame));
    squads.updateRings(shown, antLengthPx(camera.view.tilePx * scale) / camera.view.tilePx + 0.4 * scale);
    lap("ants");
    battles.update(shown);
    places.update(shown);
    lap("battles");
    // The layout keeps the labels and badges clear of the panels and of the nests.
    const blocked = [...(overlaysOn ? overlays.blocked() : []), ...(board ? nestRects(streamQueens(board), board.setup.overrunRadiusTiles, camera.toScreen) : [])];
    lastBlocked = blocked;
    words.update(shown, camera.toScreen, blocked, `${viewVersion}:${overlaysOn}`, squads.anchors(shown, camera.toScreen), squads.badgeR);
    lap("words");
    squads.updateBadges(shown, camera.toScreen, words.badges);
    lap("tags");
    // The finale: once playback has the result, the board's text and badges fade out under it, and the tooltips go.
    if (board?.result) endedAt ??= now;
    else endedAt = null;
    words.layer.alpha = squads.layer.alpha = endedAt === null ? 1 : Math.max(0, 1 - (now - endedAt) / FINALE_FADE_MS);
    // Hover and tap details: the focused marker's and squad's tooltips, in the page's type above every panel.
    const tipsOn = overlaysOn && wordsOn && endedAt === null;
    const markTip = tipsOn ? words.tipContent() : null;
    if (markTip) overlays.tips.mark.show(markTip, { w, h });
    else overlays.tips.mark.hide();
    const squadTip = tipsOn ? squads.tipContent(shown, overlays.selectedAgent) : null;
    if (squadTip) overlays.tips.squad.show(squadTip, { w, h });
    else overlays.tips.squad.hide();
    if (board) {
      const ended = replay && excerptEnded(frame.tick, input.lastTick);
      overlays.setMode(modeCopy(mode, board.agents.length, ended, location.pathname, input.storedId, board.setup.rated, input.delaySeconds));
    }
    if (overlaysOn) {
      overlays.update(frame);
      // Recordings play with the stream open. Whether agents are playing is said once, by the live
      // line, so this line keeps to the stream's own state.
      overlays.setLink(linkLine(input.recorded ? "open" : linkState(), !!board?.result));
      if (areaStale && board) refitArea();
    }
    lap("overlays");
    const t2 = realNow?.() ?? 0;
    renderer.render(app.stage);
    if (gpuReadback(params)) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const t3 = realNow?.() ?? 0;
    if (feed) waiting.state(linkState());
    waiting.frame(drew);

    // After the result, look for the next match now and then (public catalog selection, not a reopened finished feed).
    if (board?.result) {
      resultShownAt ??= now;
      if (now - resultShownAt >= NEXT_MATCH_POLL_MS) {
        resultShownAt = now;
        input.nextMatch();
      }
    } else resultShownAt = null;

    const cost = clock.now() - now;
    if (lastFrameAt !== null) frameIntervals.push(now - lastFrameAt);
    frameCosts.push(cost);
    lastFrameAt = now;
    if (frameIntervals.length > 120) frameIntervals.shift();
    if (frameCosts.length > 120) frameCosts.shift();
    if (frameIntervals.length > 0) {
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      if (frameTimesOn) frameTimes = `frame ${med(frameIntervals).toFixed(1)} ms · client work ${med(frameCosts).toFixed(1)} ms (medians of ${frameIntervals.length})`;
    }

    const agents = board?.agents ?? [];
    const result: FrameResult = {
      clockMs: now,
      playbackMs: frame.renderMs,
      playbackTick: frame.tick,
      underrun: playback.underrun(now),
      labels: squads.shown.full + words.stats.markers,
      marks: words.stats,
      chat: frame.chat.length,
      squadTags: squads.shown,
      agents: agents.length,
      intentLines: agents.filter((a) => a.intent.length > 0).length,
      fights: shown.fights.length,
      corpses: shown.corpses.length,
      placeMarks: places.shown,
    };
    if (realNow) {
      result.phases = phases;
      result.ingestMs = t1 - t0;
      result.workerMs = workerMs;
      result.deliveryMs = deliveryMs;
      result.updateMs = t2 - t1;
      result.renderMs = t3 - t2;
    }
    return result;
  };

  window.__antwar = {
    ready,
    frame: step,
    setOptions(o) {
      if (o.tilt !== undefined) scene.filters = o.tilt ? [tilt] : [];
      if (o.trails !== undefined) territory.trails = o.trails;
      if (o.cvd !== undefined) app.stage.filters = o.cvd ? [cvdFilter(o.cvd)] : [];
      if (o.ants !== undefined) ants.antLayer.visible = ants.corpseLayer.visible = o.ants;
      if (o.words !== undefined) {
        wordsOn = o.words;
        words.layer.visible = squads.layer.visible = o.words;
      }
      if (o.markLabels !== undefined) words.setLabelsVisible(o.markLabels);
      if (o.front !== undefined) territory.frontLayer.visible = o.front;
      if (o.battles !== undefined) battles.layer.visible = o.battles;
      if (o.overlays !== undefined) {
        overlaysOn = o.overlays;
        overlays.setVisible(o.overlays);
      }
    },
    async hashFrame() {
      step();
      const cw = gl.drawingBufferWidth;
      const ch = gl.drawingBufferHeight;
      const all = new Uint8Array(cw * ch * 4);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, all);
      const digest = await crypto.subtle.digest("SHA-256", all);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    samplePixel(x, y) {
      step();
      const px = new Uint8Array(4);
      const r = renderer.resolution;
      gl.readPixels(Math.floor(x * r), gl.drawingBufferHeight - 1 - Math.floor(y * r), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0]!, px[1]!, px[2]!, px[3]!];
    },
    tileToScreen: camera.toScreen,
    frameTimes: () => frameTimes,
    boardArea: () => overlays.area(),
    hover: (agent) => overlays.setHover(agent),
    highlighted() {
      const squad: number[] = [];
      const agent = squads.selected;
      for (let i = 0; i < shown.count; i++) if (agent >= 0 && shown.agent[i] === agent) squad.push(shown.id[i]!);
      return { tinted: [...ants.tinted], ringed: squads.rings.particleChildren.length, agent, squad };
    },
    focusedMark: () => words.focus,
    clickAt: (x, y) => pickAnt(x, y),
    antAt: (x, y) => {
      const i = antAt(x, y);
      return i < 0 ? null : shown.id[i]!;
    },
    labelRects: () => words.placer.rects.filter((r) => !blockedLike(r, lastBlocked) && r.x1 - r.x0 > 12),
    drawnLabels() {
      const out: { kind: "tag" | "tooltip"; rect: Rect }[] = [];
      const add = (kind: "tag" | "tooltip", blocks: readonly { getBounds(): { minX: number; minY: number; maxX: number; maxY: number } }[]) => {
        for (const b of blocks) {
          const g = b.getBounds();
          out.push({ kind, rect: { x0: g.minX, y0: g.minY, x1: g.maxX, y1: g.maxY } });
        }
      };
      if (squads.layer.visible) add("tag", squads.visibleBlocks());
      for (const rect of overlays.tipRects()) out.push({ kind: "tooltip", rect });
      return out;
    },
    markers: () => (words.layer.visible ? words.markers() : []),
    markLabels: () => (words.layer.visible ? words.drawnLabels() : []),
    zoomAt: (f, x, y) => camera.zoomAt(f, x, y),
    panBy: (dx, dy) => camera.panBy(dx, dy),
    view: () => ({ ...camera.view }),
    playback: () => ({ resets: playback.resets, newestTick: playback.newestTick }),
    recording: () => input.recording ? { stats: input.recording.stats, complete: input.recording.complete, lastTick: input.lastTick, time: input.recording.time, error: input.recording.error?.message ?? null } : null,
    options: () => ({ tilt: (scene.filters as unknown[] | null)?.length ? true : false, trails: territory.trailsOn, markLabels: words.labelsVisible }),
    board: () => {
      const b = frame.board;
      return b ? { tick: frame.tick, held: [...b.held] as [number, number], overrun: [...b.overrun] as [number, number], deaths: [...b.deaths] as [number, number], winner: b.result?.winner ?? null, ended: b.result !== null, intents: b.agents.map((a) => a.intent) } : null;
    },
    squadAnts(agent, onOwnMark = false) {
      const toScreen = (tx: number, ty: number) => camera.toScreen(tx, ty);
      if (onOwnMark) return words.antsOnOwnMark(shown, agent, toScreen);
      const out: [number, number][] = [];
      for (let i = 0; i < shown.count; i++) if (shown.agent[i] === agent) out.push(toScreen(shown.x[i]!, shown.y[i]!));
      return out;
    },
    nests() {
      const b = frame.board;
      return b ? streamQueens(b).map((q) => ({ colony: q.colony, id: q.id, lost: q.lostTick !== null, rect: nestZoneRect(q, QUEEN_FRAME_TILES, camera.toScreen) })) : [];
    },
  };

  overlays.mountHud({ deck: false, replay: controls?.el ?? null, teamView: teamViewSelect, waiting: null });
  resolveReady({
    rendererString,
    webgl2: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext,
    rendererName: renderer.name,
    cssSize: [w, h],
    canvasSize: [app.canvas.width, app.canvas.height],
    resolution: renderer.resolution,
    source,
    mapW: W,
    mapH: H,
    fontLicence: FONT_LICENCE,
    cvdMatrices: CVD_MATRICES,
  });

  if (!capture) {
    const loop = () => {
      step();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

/** Internal resolution for a CSS size, capped at MAX_INTERNAL_LONG_SIDE on the long side. */
function internalResolution(w: number, h: number): number {
  return Math.min(1, MAX_INTERNAL_LONG_SIDE / Math.max(w, h));
}

/** True for one of the overlay panels' own rects (they sit in the placer as obstacles, not labels). */
function blockedLike(r: Rect, blocked: readonly Rect[]): boolean {
  return blocked.some((b) => b.x0 === r.x0 && b.y0 === r.y0 && b.x1 === r.x1 && b.y1 === r.y1);
}

/** The 3D board gives up (failed start, lost context, a throw while running, too slow): reload as the 2D board. */
const fallbackTo2d = (reason = "it failed to start") => {
  console.warn(`3D board: ${reason}; reloading as the 2D board`);
  location.replace(fallbackUrl(location.href));
};
const clean3dRetry = () => {
  const href = clear3dRetryUrl(location.href);
  if (href !== location.href) history.replaceState(history.state, "", href);
};
runBoard(boardMode(new URLSearchParams(location.search)), {
  probe2: () => hasWebGL2(document),
  // The 3D board's code (and Babylon) loads only here, so explicit or fallback 2D never downloads it.
  start3d: () => start3dWithRecovery({
    load: () => import("./board3d/main3d.ts"),
    start: (module) => module.start3d({ ready, resolveReady, rejectReady, fallback: fallbackTo2d }),
    href: () => location.href,
    replace: (href) => location.replace(href),
    clean: clean3dRetry,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }),
  start2d: async () => {
    // Record the effective board without reloading when WebGL2 is unavailable. The
    // return link then changes the URL, so even a fragment-bearing link re-probes 3D.
    const href = fallbackUrl(location.href);
    if (href !== location.href) history.replaceState(history.state, "", href);
    await start();
  },
  webglSupported: () => isWebGLSupported(),
  show: () => {
    showNeedsWebGL(document);
    // The overlays carry the agent invitation even when the board cannot start.
    // The rest of the page works without a board: the overlays follow the stream or recording.
    startWithoutBoard(document.getElementById("aw-waiting")).catch((e) => console.error(e));
  },
  log: (e) => console.error(e),
  reject: (e) => rejectReady(e),
  fallback2d: fallbackTo2d,
});
