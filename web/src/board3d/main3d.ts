/**
 * The default 3D board (also ?board=3d): live or replay drawn with Babylon.js on WebGL2,
 * built from the earlier Babylon.js prototype and fed exactly as the 2D board is: the same
 * stream feed or recording, delayed playback (web/src/buffer.ts), clock, HTML overlays, waiting
 * panel and "Bring your agent" button. web/src/main.ts loads this module only when starting 3D.
 *
 * Drawn: lit ground with relief carrying the territory, trails and the glowing front
 * (ground.ts); 3D ants with a walk cycle, and corpses (ants3d.ts); fights (effects3d.ts); the
 * nests and queens (nests.ts); a warm key light with shadows, a cool fill, bloom and vignette.
 * The marks' markers and the squads' badges are the 2D board's own (web/src/words.ts,
 * web/src/squads.ts), drawn on a transparent Pixi canvas over the 3D one that takes no pointer
 * events, placed from the 3D camera's projection and re-placed whenever the camera moves.
 *
 * Camera (view.ts): the prototype's tilted hero angle by default, or top-down, switched from the
 * bottom bar; drag to orbit, right-drag or two fingers to pan, wheel or pinch to zoom.
 */
import { loadIcons } from "../icons/textures.ts";
import { mountIconDom } from "../icons/dom.ts";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import "@babylonjs/core/Cameras/Inputs/arcRotateCameraPointersInput.js";
import "@babylonjs/core/Cameras/Inputs/arcRotateCameraMouseWheelInput.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import "@babylonjs/core/Culling/ray.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Application } from "pixi.js";
import { streamQueens } from "../../../src/live/format.ts";
import { openingBounds, openingPhase } from "../start-framing.ts";
import { fitOpeningPose } from "./start-framing.ts";
import { foundingAspect, foundingFrame, fitFoundingPose } from "./queen-framing.ts";
import { Frame, Playback, QUEEN_FRAME_TILES, fallWindow, fallenNests, fallenQueenBox } from "../buffer.ts";
import { createClock } from "../clock.ts";
import { gpuReadback, realTimeSource, type RealNow } from "../timing.ts";
import { CVD_MATRICES } from "../effects.ts";
import { FONT_LICENCE, Words, loadFonts, nestRects, nestZoneRect, type Rect } from "../words.ts";
import { Camera, FALL_MOVE_MS, easeInOut, fightLane, keepPinch, queensBox, reducedMotion, type View } from "../camera.ts";
import { Squads, agentHues } from "../squads.ts";
import { Overlays } from "../overlays.ts";
import { openSource } from "../source.ts";
import { TeamView, teamViewControl } from "../team-view.ts";
import { mountReplayControls } from "../replay-controls.ts";
import { Waiting } from "../waiting.ts";
import { TOUCH_RADIUS_PX, linkLine } from "../compose.ts";
import { excerptEnded, modeCopy } from "../replay.ts";
import type { AntwarApi, ClientInfo, FrameResult } from "../main.ts";
import { CLEAR_RGB, COLONY_RGB, Ground } from "./ground.ts";
import { boardLook, type BoardLook } from "../board-look.ts";
import { Ants3D } from "./ants3d.ts";
import { Battles3D } from "./effects3d.ts";
import { Food3D } from "./food3d.ts";
import { Rocks3D } from "./rocks.ts";
import { StartBoxes3D, phoneOpeningOutline } from "./start-boxes.ts";
import { BoardMarkers3D, type ScreenPoint } from "./markers3d.ts";
import { Nests } from "./nests.ts";
import { gridScale } from "../grid-scale.ts";
import { FOV, MIN_RADIUS, antTiles, fallPose, lerpPose, pickNearest, poseAfterResize, viewPose, viewTilePx, type Pose, type ViewName } from "./view.ts";
import { QualityController, TIERS, WINDOW, median, startTier } from "./quality.ts";
import { onBoard } from "../terrain.ts";

/** As the 2D board: internal resolution capped at a 2560 px long side, the next match looked for every 30 s, an 800 ms finale fade. */
const MAX_INTERNAL_LONG_SIDE = 2560;
const NEXT_MATCH_POLL_MS = 30_000;
const FINALE_FADE_MS = 800;

/** Exclude only the interval spent applying/rendering a reconnect snapshot.
 * Do not reset the controller: repeated reconnects must not erase evidence of a
 * genuinely slow device. Playback and the renderer continue using the real clock.
 */
export function createQualitySampler(quality: Pick<QualityController, "frame">) {
  let previous: number | null = null;
  let measuredTime = 0;
  return (now: number, reconnectCatchUp: boolean) => {
    if (previous !== null && !reconnectCatchUp) measuredTime += Math.max(0, now - previous);
    previous = now;
    return reconnectCatchUp ? "hold" : quality.frame(measuredTime);
  };
}

/** The 3D board's capture API: the 2D board's, plus its camera. */
export interface Antwar3dApi extends AntwarApi {
  camera(): { view: ViewName; alpha: number; beta: number; radius: number; target: number[] };
  setView(name: ViewName): void;
  /** Capture a real recorded patch close up, keeping this view's angles. Coordinates are tiles. */
  focusAt(tx: number, ty: number, radius: number): void;
  /** The quality tier now, the last full window's median frame time (ms) and the overlay's median render cost (ms). */
  quality(): { tier: number; median: number | null; filling: number; overlayMs: number | null };
}

/**
 * Start the 3D board. fallback reloads the page as the 2D board; it is called, once, when the
 * board loses its WebGL context (Babylon's or the overlay's), throws while running, or stays too
 * slow at the lowest quality tier (quality.ts). A failed start rejects, and web/src/main.ts falls back.
 */
export async function start3d(client: { ready: Promise<ClientInfo>; resolveReady: (i: ClientInfo) => void; rejectReady: (error: Error) => void; fallback: (reason: string) => void }): Promise<void> {
  const params = new URLSearchParams(location.search);
  const capture = params.has("capture");
  let w = window.innerWidth;
  let h = window.innerHeight;
  let resolution = internalResolution(w, h);
  const realNow: RealNow | null = window.__antwarRealNow ? realTimeSource() : null;
  const clock = createClock();
  // Capture and bench read pixels back; a live viewer's frames do neither (the readback and a preserved buffer cost frame time).
  const measuring = gpuReadback(params);
  const quality = new QualityController(startTier({ coarsePointer: matchMedia("(pointer: coarse)").matches, shortSide: Math.min(w, h) }));
  const sampleQuality = createQualitySampler(quality);
  let qualityResets = 0;

  const canvas = document.createElement("canvas");
  const sizeCanvas = () => {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };
  sizeCanvas();
  document.body.appendChild(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: measuring, stencil: true, premultipliedAlpha: false, alpha: false }, false);
  if (engine.webGLVersion !== 2) throw new Error(`3D board: Babylon started on WebGL${engine.webGLVersion}, not WebGL2`);
  /** The render resolution: the page's internal resolution, scaled down by the quality tier. */
  const scaleEngine = () => engine.setHardwareScalingLevel(1 / (resolution * TIERS[quality.tier]!.scale));
  scaleEngine();
  const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererString = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  await loadFonts();

  const input = await openSource(params, clock, document, client.rejectReady);
  if (!input) return;
  const { replay, feed, head, source, linkState } = input;
  let playback = new Playback({ live: !input.recorded });
  let replayGeneration = input.recording?.generation ?? 0;
  const setup = head.full!.setup;
  const W = setup.mapW;
  const H = setup.mapH;
  // The initial view frames the fight lane between the nests, as the 2D board's does.
  const scale = gridScale(setup);
  const lane = fightLane(setup);

  // The HUD's host first, so the board can be framed in the HUD's window once it mounts.
  let hoverAgent = -1;
  let squadsRef: Squads | null = null;
  let wordsRef: Words | null = null;
  let markersRef: BoardMarkers3D | null = null;
  let centreOnRef: ((tx: number, ty: number) => void) | null = null;
  let wholeBoardRef: (() => void) | null = null;
  let overviewRef: (() => void) | null = null;
  const overlays = new Overlays(
    document.body,
    {
      hover: (agent) => {
        hoverAgent = agent;
        if (squadsRef) squadsRef.hovered = agent;
      },
      // A live mark chosen in the log (as web/src/main.ts): its tooltip shows at its marker,
      // and the camera turns on the mark's tile, keeping its angles and distance.
      focusMark: (id, tx, ty) => {
        if (!wordsRef || !squadsRef) return;
        wordsRef.choose(id);
        squadsRef.focused = -1;
        centreOnRef?.(tx + 0.5, ty + 0.5);
      },
      // The page's Whole board and Show on board, on this board's own camera moves: the
      // current view's default pose, and the turn onto a place that a chosen mark makes.
      wholeBoard: () => wholeBoardRef?.(),
      // The whole board from straight above, for the HUD's view control.
      overview: () => overviewRef?.(),
      // The retained −/+ controls use the same limits as the camera's scripted zoom.
      zoom: (factor) => { cam.radius = Math.min(cam.upperRadiusLimit ?? Infinity, Math.max(cam.lowerRadiusLimit ?? 0, cam.radius / factor)); },
      locate: (tx, ty) => centreOnRef?.(tx, ty),
      // The order the viewer points at in the dock or on the card: its tile lit on the board in its agent's hue (markers3d.ts).
      target: (tile, colour) => {
        if (!markersRef) return;
        markersRef.target = tile;
        markersRef.targetColour = colour;
      },
    },
    "3d",
  );
  // The same live/recorded line as 2D, in the deck's legend.
  const mode = replay ? "replay" : "live";
  overlays.setMode(modeCopy(mode, head.full!.agents.length, false, location.pathname, input.storedId, head.full!.setup.rated, input.delaySeconds, input.harnessPhase));
  overlays.setShare(input.share);
  const controls = params.has("replay") && input.recording
    ? mountReplayControls(document, input.recording) : null;
  window.addEventListener("pagehide", () => controls?.close(), { once: true });
  const queens = queensBox(setup);
  const fitCam = new Camera(W, H, w, h, overlays.boardArea(w, h), lane, queens, scale);

  const scene = new Scene(engine);
  // Linear, as the image-processing pass expects its input (it converts every pixel to gamma); the ground shader linearises its own output, so the off-board fade and the background both come out #0b0805.
  scene.clearColor = new Color4(...CLEAR_RGB, 1).toLinearSpace();
  scene.ambientColor = new Color3(0, 0, 0);
  scene.skipPointerMovePicking = true;

  const ground = new Ground(scene, W, H, scale);
  // A colony's point of view: the ground darkens outside its sight; the board draws only what it sees. Its
  // control, which the deck places among the board controls when it mounts.
  const teamView = new TeamView();
  const teamViewSelect = teamViewControl(document, teamView);
  ground.plugin.values.trails = params.get("trails") !== "0" ? 1 : 0;
  const lanePose = (name: ViewName) => viewPose(name, W, H, w, h, fitCam.view, overlays.boardArea(w, h), lane, queens, scale);
  // Multi-queen streams can found anywhere on later-held land. Freeze the complete
  // nest-corner envelope once, not the current queen count or their occupied tiles.
  // Historical single-queen recordings retain their existing lane framing.
  const founding = head.full!.queens ? foundingFrame(W, H, (x, y) => ground.heightAt(x, y)) : null;
  const initialTilt = lanePose("tilted");
  if (founding) {
    overlays.setBoardAspect(foundingAspect(founding, initialTilt));
    fitCam.resize(w, h, overlays.boardArea(w, h));
  }
  const fitted = new Map<ViewName, { key: string; pose: Pose }>();
  /** Preserve the initial tilted orientation, but fit all possible later nest corners.
   * Cache by actual viewport/stage geometry: founding and ordinary frames do no fit work.
   * Tick-zero opening and the separate fall solver below retain their own behavior.
   */
  const defaultPose = (name: ViewName): Pose => {
    if (!founding) return lanePose(name);
    const area = overlays.boardArea(w, h);
    const key = `${w}:${h}:${area.x0}:${area.y0}:${area.x1}:${area.y1}`;
    const cached = fitted.get(name);
    if (cached?.key === key) return cached.pose;
    const base = name === "tilted" ? initialTilt : lanePose(name);
    const pose = fitFoundingPose(base, founding, w, h, area, scale);
    fitted.set(name, { key, pose });
    return pose;
  };
  /** Ant length in tiles (view.ts antTiles) at the CSS px per tile the tilted default view draws at the board's centre. */
  const antScale = () => antTiles(viewTilePx(defaultPose("tilted"), w, h), scale);
  let openingBoard: Parameters<typeof openingBounds>[0] | null = openingPhase(head.tick, head.full) ? head.full : null;
  const openingDefaultPose = (name: ViewName): Pose => {
    const base = defaultPose(name);
    // Conservative full queen-mesh extent (Nests uses ant length * 2.4), without changing mesh size.
    const extent = Math.max(3 * scale, antScale() * 2.4 + scale);
    const bounds = openingBoard ? openingBounds(openingBoard, extent) : null;
    return bounds ? fitOpeningPose(base, bounds, H, w, h, overlays.boardArea(w, h), scale, extent) : base;
  };
  const ants = new Ants3D(scene, ground, antScale(), COLONY_RGB);
  const battles = new Battles3D(scene, ground);
  const food = new Food3D(scene, ground);
  const rocks = new Rocks3D(scene, ground);
  const startBoxes = new StartBoxes3D(scene, ground, COLONY_RGB);
  const nests = new Nests(scene, ground, setup, ants.lengthTiles, COLONY_RGB);
  nests.update(streamQueens(head.full!));

  // Light: a warm low key from the west-north-west (upper left on screen) with a shadow map, and a cool sky fill.
  const fill = new HemisphericLight("fill", new Vector3(-0.2, 1, 0.3), scene);
  fill.intensity = 0.85;
  fill.diffuse = new Color3(0.6, 0.68, 0.9);
  fill.groundColor = new Color3(0.2, 0.13, 0.08);
  fill.specular = new Color3(0, 0, 0);
  const keyDir = new Vector3(0.84, -0.4, -0.37).normalize();
  const key = new DirectionalLight("key", keyDir, scene);
  key.diffuse = new Color3(1.0, 0.76, 0.5);
  key.specular = new Color3(1.0, 0.85, 0.65);
  key.intensity = 2.3;
  key.position = new Vector3(W / 2, 0, H / 2).subtract(keyDir.scale(Math.max(W, H) * 1.2));
  key.autoUpdateExtends = false;
  key.autoCalcShadowZBounds = true;
  const ext = Math.hypot(W, H) * 0.62;
  key.orthoLeft = -ext;
  key.orthoRight = ext;
  key.orthoTop = ext;
  key.orthoBottom = -ext;
  const shadows = new ShadowGenerator(2048, key);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.002;
  shadows.normalBias = 0.01;
  shadows.darkness = 0.12;
  for (const m of [...ants.casters, ...nests.casters]) shadows.addShadowCaster(m, false);
  let nestCasters = nests.casters.length;

  // One orbit camera for both views; the toggle moves it to the chosen view's pose.
  let viewName: ViewName = "tilted";
  const cam = new ArcRotateCamera("view", 0, 1, 10, Vector3.Zero(), scene);
  cam.fov = FOV;
  cam.minZ = 0.5;
  cam.lowerBetaLimit = 0.01;
  cam.upperBetaLimit = 1.35;
  cam.lowerRadiusLimit = MIN_RADIUS;
  cam.wheelDeltaPercentage = 0.02;
  cam.pinchDeltaPercentage = 0.01;
  cam.panningAxis = new Vector3(1, 0, 1);
  cam.mapPanning = true;
  cam.panningSensibility = 40;
  cam.inertia = 0.6;
  cam.panningInertia = 0.6;
  cam.attachControl(canvas, true);
  // A pinch is this board's zoom, not the browser's page zoom, in either orientation (camera.ts keepPinch).
  keepPinch(canvas);
  const applyPose = (p: Pose) => {
    // setTarget re-derives the angles from the current position, so the angles are set after it.
    cam.setTarget(new Vector3(...p.target));
    cam.alpha = p.alpha;
    cam.beta = p.beta;
    cam.radius = p.radius;
    cam.inertialAlphaOffset = cam.inertialBetaOffset = cam.inertialRadiusOffset = cam.inertialPanningX = cam.inertialPanningY = 0;
  };
  centreOnRef = (tx, ty) => applyPose({ alpha: cam.alpha, beta: cam.beta, radius: cam.radius, target: [tx, 0, H - ty] });
  const camPose = (): Pose => ({ alpha: cam.alpha, beta: cam.beta, radius: cam.radius, target: [cam.target.x, cam.target.y, cam.target.z] });
  /** The zoom limits cover both views' defaults, so the camera never clamps a default pose. */
  const setLimits = () => {
    cam.upperRadiusLimit = Math.max(openingDefaultPose("tilted").radius, openingDefaultPose("top").radius) * 2;
    cam.maxZ = cam.upperRadiusLimit * 3;
  };
  /** The last default pose the camera was put at; a resize re-fits only while it still stands there. */
  let lastDefault: Pose | null = null;
  const showView = (name: ViewName) => {
    viewName = name;
    const pose = openingDefaultPose(name);
    setLimits();
    applyPose(pose);
    lastDefault = pose;
  };
  // The initial tilted pose and internal whole-board framing remain. The HUD's view control asks for the top-down
  // default pose, which then stays this board's view.
  wholeBoardRef = () => showView(viewName);
  overviewRef = () => showView("top");
  showView("tilted");

  const pipeline = new DefaultRenderingPipeline("post", true, scene, [cam]);
  pipeline.samples = 4;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 1.0;
  pipeline.bloomWeight = 0.55;
  pipeline.bloomKernel = 48;
  pipeline.bloomScale = 0.5;
  pipeline.imageProcessingEnabled = true;
  const ip = pipeline.imageProcessing;
  // No tone mapping: it darkens the territory tint, which is game information.
  ip.toneMappingEnabled = false;
  ip.contrast = 1.08;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.6;
  ip.vignetteStretch = 0.4;
  ip.vignetteColor = new Color4(0.02, 0.012, 0.006, 0);
  ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;

  // The board look (board-look.ts), set by the HUD, relights the board and recolours its ground and boulders, which
  // then cast shadows; the plain values return when it clears.
  const currentLight = {
    key: key.diffuse.clone(), keyIntensity: key.intensity, fill: fill.diffuse.clone(), fillGround: fill.groundColor.clone(),
    fillIntensity: fill.intensity, darkness: shadows.darkness, contrast: ip.contrast, vignette: ip.vignetteWeight,
  };
  let lookShown: BoardLook | null = null;
  const relook = () => {
    lookShown = boardLook();
    const look = lookShown?.board3d;
    const light = look?.light;
    ground.relook();
    rocks.setColour(look?.rock ?? null);
    if (look) shadows.addShadowCaster(rocks.mesh, false);
    else shadows.removeShadowCaster(rocks.mesh, false);
    key.diffuse = light ? new Color3(...light.key) : currentLight.key.clone();
    key.intensity = light?.keyIntensity ?? currentLight.keyIntensity;
    fill.diffuse = light ? new Color3(...light.fill) : currentLight.fill.clone();
    fill.groundColor = light ? new Color3(...light.fillGround) : currentLight.fillGround.clone();
    fill.intensity = light?.fillIntensity ?? currentLight.fillIntensity;
    shadows.darkness = light?.shadowDarkness ?? currentLight.darkness;
    ip.contrast = light?.contrast ?? currentLight.contrast;
    ip.vignetteWeight = light?.vignetteWeight ?? currentLight.vignette;
  };

  const applyTier = () => {
    const t = TIERS[quality.tier]!;
    pipeline.samples = t.msaa;
    pipeline.bloomEnabled = t.bloom;
    shadows.mapSize = t.shadowMap;
    key.shadowEnabled = t.shadows;
    scaleEngine();
  };
  applyTier();

  let gaveUp = false;
  const giveUp = (why: string) => {
    if (gaveUp) return;
    gaveUp = true;
    engine.stopRenderLoop();
    client.fallback(why);
  };
  engine.onContextLostObservable.add(() => giveUp("its WebGL context was lost"));

  // The 2D board's markers and badges, on a transparent Pixi canvas over the 3D one that takes no pointer events.
  const pixi = new Application();
  await pixi.init({ width: w, height: h, backgroundAlpha: 0, preference: "webgl", antialias: false, autoStart: false, resolution, autoDensity: true });
  pixi.ticker.stop();
  mountIconDom(document);
  void loadIcons();
  pixi.canvas.style.cssText += ";position:fixed;left:0;top:0;pointer-events:none";
  document.body.append(pixi.canvas);
  pixi.canvas.addEventListener("webglcontextlost", () => giveUp("the overlay's WebGL context was lost"));
  const words = new Words({ w, h });
  const squads = new Squads(pixi.renderer, w);
  const markers = new BoardMarkers3D(pixi.renderer);
  squadsRef = squads;
  wordsRef = words;
  markersRef = markers;
  // The markers and badges; the tooltips are the page's own, above every panel.
  pixi.stage.addChild(markers.layer, words.layer, squads.layer);

  // Tile -> screen through the 3D camera; recomputed every frame before anything is placed.
  let viewport = new Viewport(0, 0, 1, 1).toGlobal(w, h);
  const vp = new Matrix();
  const tmp = new Vector3();
  const out = new Vector3();
  const toScreen = (tx: number, ty: number): [number, number] => {
    tmp.set(tx, ground.heightAt(tx, ty), H - ty);
    Vector3.ProjectToRef(tmp, Matrix.IdentityReadOnly, vp, viewport, out);
    return [out.x, out.y];
  };
  const toScreenRef = (tx: number, ty: number, point: ScreenPoint): void => {
    tmp.set(tx, ground.heightAt(tx, ty), H - ty);
    Vector3.ProjectToRef(tmp, Matrix.IdentityReadOnly, vp, viewport, out);
    point.x = out.x; point.y = out.y;
  };
  const projectNow = () => cam.getViewMatrix().multiplyToRef(cam.getProjectionMatrix(true), vp);
  /** Changes whenever the camera or the screen does, so the markers and badges are re-placed (the prototype's stale-label bug). */
  const viewKey = () => `${w}x${h}:${cam.alpha.toFixed(3)},${cam.beta.toFixed(3)},${cam.radius.toFixed(2)},${cam.target.x.toFixed(2)},${cam.target.z.toFixed(2)}`;

  let resized = true;
  window.addEventListener("resize", () => (resized = true));
  const refit = () => {
    resized = false;
    if (window.innerWidth === w && window.innerHeight === h) return;
    const before = camPose();
    w = window.innerWidth;
    h = window.innerHeight;
    resolution = internalResolution(w, h);
    sizeCanvas();
    scaleEngine();
    engine.resize();
    pixi.renderer.resize(w, h, resolution);
    viewport = new Viewport(0, 0, 1, 1).toGlobal(w, h);
    fitCam.resize(w, h, overlays.boardArea(w, h));
    words.resize({ w, h });
    squads.resize(w);
    ants.lengthTiles = antScale();
    nests.lengthTiles = ants.lengthTiles;
    // A resize or rotation fits the board again, but only while the camera is at the default view:
    // a phone's address bar hiding fires resize too, and must not undo the viewer's pan and zoom.
    const next = openingDefaultPose(viewName);
    const pose = poseAfterResize(before, lastDefault ?? next, next);
    setLimits();
    applyPose(pose);
    if (pose === next) lastDefault = next;
  };
  // The first board frame fits the board to the HUD's window, which the camera was made before (the whole screen until
  // the HUD mounts), so no panel sits on the board; as on a resize, a moved camera keeps its pose.
  let areaStale = true;
  const refitArea = () => {
    areaStale = false;
    const before = camPose();
    fitCam.resize(w, h, overlays.boardArea(w, h));
    ants.lengthTiles = antScale();
    nests.lengthTiles = ants.lengthTiles;
    const next = openingDefaultPose(viewName);
    const pose = poseAfterResize(before, lastDefault ?? next, next);
    setLimits();
    applyPose(pose);
    if (pose === next) lastDefault = next;
  };

  let frame = new Frame();
  /** The frame the board draws: the playback frame, or one colony's view of it (team-view.ts); the HUD reads frame. */
  let shown = frame;
  const waiting = new Waiting(document.getElementById("aw-waiting"), document.querySelector(".aw-wait-state"));
  let overlaysOn = true;
  let wordsOn = true;
  let resultShownAt: number | null = null;
  let endedAt: number | null = null;
  let fallTurned = false;
  /** The camera's move into the fall, while it plays: from the pose it left, to the fall pose, from when. */
  let fallMove: { from: Pose; to: Pose; startedAt: number } | null = null;
  let matchSeen = 0;
  /** The rects the last layout kept clear of (the panels and the nests), which are not labels. */
  let lastBlocked: Rect[] = [];
  const pixel = new Uint8Array(4);
  /** The overlay's render cost per drawn frame (ms), its last WINDOW samples. */
  const overlayCosts: number[] = [];

  /** The frametime=1 line (frameTimes()): the median frame time first, plainly, then the tier and the overlay's cost. */
  const frameTimesOn = params.get("frametime") === "1";
  let frameTimes: string | null = null;
  const frameTimeLine = () => {
    const overlay = overlayCosts.length ? ` · overlay ${median(overlayCosts).toFixed(1)} ms` : "";
    const m = quality.lastMedian;
    const head = m === null ? `3D measuring (${quality.filling} of ${WINDOW} frames)` : `3D ${m.toFixed(1)} ms median (${WINDOW} frames)`;
    return `${head} · tier ${quality.tier}${overlay}`;
  };

  // Hover and tap: the 2D board's wiring (web/src/main.ts antAt, pickAnt and the
  // canvas listeners), copied rather than shared, since the 2D side is owned separately. Only the ant
  // test differs: ants are found where they appear on screen, within 1.2 tiles at the zoom there.
  /** Screen px per tile at a tile point, along the ground's x axis. */
  const tilePxAt = (tx: number, ty: number) => {
    const [ax, ay] = toScreen(tx, ty);
    const [bx, by] = toScreen(tx + 1, ty);
    return Math.hypot(bx - ax, by - ay);
  };
  const antAt = (x: number, y: number, minPx = 0): number => {
    projectNow();
    return pickNearest(
      shown.count,
      (i) => toScreen(shown.x[i]!, shown.y[i]!),
      (i) => tilePxAt(shown.x[i]!, shown.y[i]!),
      x,
      y,
      minPx,
    );
  };
  /**
   * A click or tap. On a badge: shows that squad's tooltip and selects its agent, keeping any
   * ant already selected. Elsewhere: selects the nearest ant and the agent whose squad holds it,
   * shows the tooltip of a mark whose marker it lands on (not on touch with an ant under the
   * tap: the ant wins), and the tooltip of the squad whose ant it lands on;
   * on empty board it clears the ant and agent selection.
   */
  // Test the actual relief under the pointer, not the flat camera plane. The decorative ring
  // does not select nearby playable ants/marks through their generous touch hit areas.
  const playableAt = (x: number, y: number): boolean => {
    const point = scene.createPickingRay(x, y, null, cam).intersectsMesh(ground.mesh).pickedPoint;
    return point !== null && onBoard(point.x, H - point.z, W, H);
  };
  const pickAnt = (x: number, y: number, touch = false): number | null => {
    if (!playableAt(x, y)) {
      words.clearFocus();
      squads.focused = -1;
      overlays.select(null);
      overlays.selectAgent(-1);
      return null;
    }
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
  // A press that moves more than a few px orbits or pans the camera; only a still press picks. The press's
  // pointer type goes to the pick: on touch the ant wins over a mark under the same tap.
  let pressedAt: [number, number] | null = null;
  let touched = false;
  canvas.addEventListener("pointerdown", (e) => {
    pressedAt = [e.clientX, e.clientY];
    touched = e.pointerType === "touch";
  });
  canvas.addEventListener("click", (e) => {
    const still = !pressedAt || Math.hypot(e.clientX - pressedAt[0], e.clientY - pressedAt[1]) <= 4;
    pressedAt = null;
    if (still) pickAnt(e.offsetX, e.offsetY, touched);
  });
  // Hover (a mouse; touch has tap): a mark's marker shows its tooltip, a squad's badge or ants its model label.
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons !== 0) return;
    if (!playableAt(e.offsetX, e.offsetY)) {
      words.hoverAt();
      squads.focused = -1;
      return;
    }
    // A mark chosen in the log stays focused unless the pointer is on another marker.
    words.hoverAt(e.offsetX, e.offsetY);
    const badge = squads.badgeAt(e.offsetX, e.offsetY);
    const best = badge >= 0 ? -1 : antAt(e.offsetX, e.offsetY);
    squads.focused = badge >= 0 ? badge : best >= 0 ? shown.agent[best]! : -1;
  });
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    words.hoverAt();
    squads.focused = -1;
  });
  // A tap or click off the board (the HTML controls included) dismisses a tapped tooltip.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target === canvas) return;
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

  const step = (render = true): FrameResult => {
    if (resized) refit();
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
      showView(viewName);
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
    const drew = playback.sample(now, frame);
    shown = teamView.apply(frame);
    const board = frame.board;
    const nextOpening = openingPhase(frame.tick, board) ? board : null;
    if (nextOpening?.setup !== openingBoard?.setup || nextOpening?.queens !== openingBoard?.queens) {
      const before = camPose();
      openingBoard = nextOpening; // Clear before the next-match and fall branches below.
      const next = openingDefaultPose(viewName);
      const pose = poseAfterResize(before, lastDefault ?? next, next);
      setLimits();
      applyPose(pose);
      if (pose === next) lastDefault = next;
    }
    // The fall window: as a colony's last queen is lost, the camera turns onto the fallen colony's
    // nests, a restrained step nearer (view.ts fallPose), so her collapse is seen before the result card follows it
    // by its beat; at no other time does the camera move by itself, and the next match opens on the fight again. The
    // turn is a short eased move on the playback clock, a cut for a
    // viewer who prefers reduced motion.
    if (board && playback.matches !== matchSeen) {
      if (matchSeen > 0) showView(viewName);
      matchSeen = playback.matches;
    }
    const fallBox = board ? fallenNests(board) : null;
    if (fallBox === null) {
      fallTurned = false;
      fallMove = null;
    } else if (!fallTurned) {
      fallTurned = true;
      // Use the viewer's current pose: the unchanged geometry helper keeps its incoming rotation while zooming and recentring.
      // Her box judged at the relief's height under it, as toScreen draws her and the stills measure her (nests()).
      const to = fallPose(camPose(), fallBox, fallenQueenBox(board!)!, W, H, w, h, overlays.boardArea(w, h), (tx, ty) => ground.heightAt(tx, ty));
      if (reducedMotion()) applyPose(to);
      else fallMove = { from: camPose(), to, startedAt: now };
    }
    if (fallMove !== null) {
      const t = (now - fallMove.startedAt) / FALL_MOVE_MS;
      applyPose(lerpPose(fallMove.from, fallMove.to, easeInOut(t)));
      if (t >= 1) fallMove = null;
    }
    // The board's state moves every frame, drawn or not, so a catch-up without drawing ends where a drawn one would.
    if (boardLook() !== lookShown) relook();
    ground.update(shown, now);
    rocks.update(shown);
    const selected = squads.selected;
    ants.update(shown, selected, agentHues(board?.agents ?? []), fallWindow(frame));
    projectNow();
    const outlineBufferW = engine.getRenderWidth(), outlineBufferH = engine.getRenderHeight();
    startBoxes.update(shown, phoneOpeningOutline(w, h, openingPhase(frame.tick, board)) ? {
      key: `${viewKey()}:${outlineBufferW}x${outlineBufferH}`,
      project: (tx, ty) => {
        const [x, y] = toScreen(tx, ty);
        return [x * outlineBufferW / w, y * outlineBufferH / h];
      },
    } : undefined);
    // The layout keeps the labels and badges clear of the panels and of the nests.
    const blocked = [...(overlaysOn ? overlays.blocked() : []), ...(board ? nestRects(streamQueens(board), board.setup.overrunRadiusTiles, toScreen) : [])];
    lastBlocked = blocked;
    const tilePx = tilePxAt(cam.target.x, H - cam.target.z);
    nests.update(shown.board ? streamQueens(shown.board) : []);
    while (nestCasters < nests.casters.length) shadows.addShadowCaster(nests.casters[nestCasters++]!, false);
    food.update(shown, tilePx);
    battles.update(shown, tilePx);
    markers.update(shown, toScreenRef);
    words.update(shown, toScreen, blocked, `${viewKey()}:${overlaysOn}`, squads.anchors(shown, toScreen), squads.badgeR);
    squads.updateBadges(shown, toScreen, words.badges);
    if (board?.result) endedAt ??= now;
    else endedAt = null;
    words.layer.alpha = squads.layer.alpha = endedAt === null ? 1 : Math.max(0, 1 - (now - endedAt) / FINALE_FADE_MS);
    // Hover and tap details, as on the 2D board: the page's tooltips, above every panel, until the finale.
    const tipsOn = overlaysOn && wordsOn && endedAt === null;
    const markTip = tipsOn ? words.tipContent() : null;
    if (markTip) overlays.tips.mark.show(markTip, { w, h });
    else overlays.tips.mark.hide();
    const squadTip = tipsOn ? squads.tipContent(shown, overlays.selectedAgent) : null;
    if (squadTip) overlays.tips.squad.show(squadTip, { w, h });
    else overlays.tips.squad.hide();
    if (board) {
      const ended = replay && excerptEnded(frame.tick, input.lastTick);
      overlays.setMode(modeCopy(mode, board.agents.length, ended, location.pathname, input.storedId, board.setup.rated, input.delaySeconds, input.harnessPhase));
      // A stall the client already detects (Playback.underrun), shown only while the match or recording still runs.
      overlays.setStalled(board.result === null && !ended && playback.underrun(now));
    }
    if (overlaysOn) {
      overlays.update(frame);
      overlays.setLink(linkLine(input.recorded ? "open" : linkState(), !!board?.result));
      if (areaStale && board) refitArea();
    }
    const t2 = realNow?.() ?? 0;
    if (render) {
      scene.render();
      const o0 = clock.now();
      pixi.renderer.render(pixi.stage);
      overlayCosts.push(clock.now() - o0);
      if (overlayCosts.length > WINDOW) overlayCosts.shift();
      if (measuring) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const reconnectCatchUp = !input.recorded && playback.resets > 1 && playback.resets !== qualityResets;
      qualityResets = playback.resets;
      const decision = sampleQuality(clock.now(), reconnectCatchUp);
      if (decision === "step") applyTier();
      else if (decision === "fallback") giveUp(`too slow at quality tier ${quality.tier} of ${TIERS.length - 1} (median frame ${quality.lastMedian!.toFixed(1)} ms)`);
      if (frameTimesOn) frameTimes = frameTimeLine();
    }
    const t3 = realNow?.() ?? 0;
    if (feed) waiting.state(linkState());
    waiting.frame(drew);

    if (board?.result) {
      resultShownAt ??= now;
      if (now - resultShownAt >= NEXT_MATCH_POLL_MS) {
        resultShownAt = now;
        input.nextMatch();
      }
    } else resultShownAt = null;

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
      placeMarks: markers.shown,
    };
    if (realNow) {
      result.ingestMs = t1 - t0;
      result.workerMs = workerMs;
      result.deliveryMs = deliveryMs;
      result.updateMs = t2 - t1;
      result.renderMs = t3 - t2;
    }
    return result;
  };

  const readAll = (): Uint8Array<ArrayBuffer> => {
    const all = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, all);
    return all;
  };
  const api: Antwar3dApi = {
    ready: client.ready,
    frame: (render) => step(render ?? true),
    setOptions(o) {
      // tilt (tilt-shift) and cvd are 2D board effects; the 3D board ignores them.
      if (o.trails !== undefined) ground.plugin.values.trails = o.trails ? 1 : 0;
      if (o.front !== undefined) ground.plugin.values.front = o.front ? 1 : 0;
      if (o.ants !== undefined) ants.setVisible(o.ants);
      if (o.battles !== undefined) battles.setVisible(o.battles);
      if (o.words !== undefined) {
        wordsOn = o.words;
        words.layer.visible = squads.layer.visible = o.words;
      }
      if (o.overlays !== undefined) {
        overlaysOn = o.overlays;
        overlays.setVisible(o.overlays);
      }
      if (o.markLabels !== undefined) words.setLabelsVisible(o.markLabels);
    },
    async hashFrame() {
      step();
      const digest = await crypto.subtle.digest("SHA-256", readAll());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    samplePixel(x, y) {
      step();
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(x * resolution), gl.drawingBufferHeight - 1 - Math.floor(y * resolution), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0]!, px[1]!, px[2]!, px[3]!];
    },
    frameTimes: () => frameTimes,
    boardArea: () => overlays.area(),
    tileToScreen: (tx, ty) => {
      projectNow();
      return toScreen(tx, ty);
    },
    hover: (agent) => overlays.setHover(agent),
    highlighted() {
      const squad: number[] = [];
      const selected = squads.selected;
      for (let i = 0; i < shown.count; i++) if (selected >= 0 && shown.agent[i] === selected) squad.push(shown.id[i]!);
      return { tinted: squad, ringed: squad.length, agent: selected, squad };
    },
    focusedMark: () => words.focus,
    clickAt: (x, y) => pickAnt(x, y),
    antAt: (x, y) => {
      if (!playableAt(x, y)) return null;
      const i = antAt(x, y);
      return i < 0 ? null : shown.id[i]!;
    },
    labelRects: () => words.placer.rects.filter((r) => !sameRect(r, lastBlocked) && r.x1 - r.x0 > 12),
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
    zoomAt: (f) => (cam.radius = Math.min(cam.upperRadiusLimit ?? Infinity, Math.max(cam.lowerRadiusLimit ?? 0, cam.radius / f))),
    panBy(dx, dy) {
      // As the 2D board's panBy: the board moves with the drag. Screen px become ground tiles at the target, along the
      // camera's forward on the ground (fx, fz) and its right (fz, -fx).
      const k = (2 * cam.radius * Math.tan(FOV / 2)) / h;
      const fx = -Math.cos(cam.alpha);
      const fz = -Math.sin(cam.alpha);
      const t = cam.target;
      applyPose({ alpha: cam.alpha, beta: cam.beta, radius: cam.radius, target: [t.x + (-dx * fz + dy * fx) * k, t.y, t.z + (dx * fx + dy * fz) * k] });
    },
    view(): View {
      projectNow();
      const [ox, oy] = toScreen(0, 0);
      const [x1, y1] = toScreen(1, 0);
      return { ox, oy, tilePx: Math.hypot(x1 - ox, y1 - oy) };
    },
    playback: () => ({ resets: playback.resets, newestTick: playback.newestTick }),
    recording: () => input.recording ? { stats: input.recording.stats, complete: input.recording.complete, lastTick: input.lastTick, time: input.recording.time, error: input.recording.error?.message ?? null } : null,
    options: () => ({ tilt: false, trails: ground.plugin.values.trails === 1, markLabels: words.labelsVisible }),
    board: () => {
      const b = frame.board;
      return b ? { tick: frame.tick, held: [...b.held] as [number, number], overrun: [...b.overrun] as [number, number], deaths: [...b.deaths] as [number, number], winner: b.result?.winner ?? null, ended: b.result !== null, intents: b.agents.map((a) => a.intent) } : null;
    },
    squadAnts(agent, onOwnMark = false) {
      projectNow();
      if (onOwnMark) return words.antsOnOwnMark(shown, agent, toScreen);
      const out: [number, number][] = [];
      for (let i = 0; i < shown.count; i++) if (shown.agent[i] === agent) out.push(toScreen(shown.x[i]!, shown.y[i]!));
      return out;
    },
    nests() {
      const b = frame.board;
      if (!b) return [];
      projectNow();
      return streamQueens(b).map((q) => ({ colony: q.colony, id: q.id, lost: q.lostTick !== null, rect: nestZoneRect(q, QUEEN_FRAME_TILES, toScreen) }));
    },
    camera: () => ({ view: viewName, alpha: cam.alpha, beta: cam.beta, radius: cam.radius, target: cam.target.asArray() }),
    quality: () => ({ tier: quality.tier, median: quality.lastMedian, filling: quality.filling, overlayMs: overlayCosts.length ? median(overlayCosts) : null }),
    setView: showView,
    focusAt: (tx, ty, radius) => applyPose({ alpha: cam.alpha, beta: cam.beta, radius: Math.max(MIN_RADIUS, Math.min(cam.upperRadiusLimit ?? Infinity, radius)), target: [tx, ground.heightAt(tx, ty), H - ty] }),
  };
  window.__antwar = api;

  overlays.mountHud({ deck: true, replay: controls?.el ?? null, teamView: teamViewSelect, waiting: null });
  client.resolveReady({
    rendererString,
    webgl2: engine.webGLVersion === 2,
    rendererName: `babylon ${Engine.Version} webgl${engine.webGLVersion}`,
    cssSize: [w, h],
    canvasSize: [canvas.width, canvas.height],
    resolution,
    source,
    mapW: W,
    mapH: H,
    fontLicence: FONT_LICENCE,
    cvdMatrices: CVD_MATRICES,
  });

  if (!capture) {
    engine.runRenderLoop(() => {
      try {
        step();
      } catch (e) {
        console.error(e);
        giveUp("it threw while running");
      }
    });
  }
}

function internalResolution(w: number, h: number): number {
  return Math.min(1, MAX_INTERNAL_LONG_SIDE / Math.max(w, h));
}

/** True for one of the overlay panels' own rects (they sit in the placer as obstacles, not labels). */
function sameRect(r: Rect, blocked: readonly Rect[]): boolean {
  return blocked.some((b) => b.x0 === r.x0 && b.y0 === r.y0 && b.x1 === r.x1 && b.y1 === r.y1);
}
