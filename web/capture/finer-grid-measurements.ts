/** Offline screenshot measurements, never a second render or geometry-based size estimate.
 * A person marks actual visible object edges in the original PNG's pixel coordinates.
 * node --import ./src/ts-resolve.mjs web/capture/finer-grid-measurements.ts --observations out/chromium/observations.json --bounds out/chromium/object-bounds.json --out out/chromium/object-measurements.json
 * The capture emits object-bounds.json as an unmeasured template. Missing/obscured
 * objects remain gaps; completing this ledger is not a product acceptance verdict.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const OBJECTS = ["ant", "nest", "food", "rock"] as const;
type ObjectKind = typeof OBJECTS[number];
export type ObjectBounds = { kind: ObjectKind; identity: string; status: "measured"; bounds: [number, number, number, number]; visualSubject?: "nest-body" | "queen-crown" | "other-marker" } |
  { kind: ObjectKind; status: "unmeasured" | "absent" | "obscured"; reason: string };
export interface ImagePin { file: string; sha256: string; width: number; height: number; cssWidth: number; cssHeight: number }
type PhysicalPixels = { x: number; y: number };
type ObjectSize = { width: number; height: number };
export interface ScaleImage { image: ImagePin; context: { map: string; phase: string; board: string; browser: string; device: string; tick: number; label: string }; scale: unknown;
  normalization?: { target: PhysicalPixels; baseline: { file: string; sha256: string } | null };
}
export interface BoundsEntry { file: string; sha256: string; objects: ObjectBounds[] }

/** Read dimensions from the PNG's own IHDR, not a presumed device pixel ratio. */
export function imagePin(file: string, bytes: Buffer, cssWidth: number, cssHeight: number): ImagePin {
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR", "Expected a PNG screenshot");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert([width, height, cssWidth, cssHeight].every(v => Number.isFinite(v) && v > 0), "Invalid image dimensions");
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), width, height, cssWidth, cssHeight };
}

/** A human marks pixels; this declaration distinguishes the nest from its UI marker.
 * Unknown historical phone-3D bounds cannot silently become nest measurements.
 */
function nestEvidenceGap(object: ObjectBounds, context?: ScaleImage["context"]): string | null {
  if (object.kind !== "nest" || object.status !== "measured") return null;
  if (object.visualSubject === "queen-crown" || object.visualSubject === "other-marker") return "Marker bounds are not nest-body evidence";
  if (context?.board === "3d" && context.device === "iphone15" && object.visualSubject !== "nest-body") return "Phone 3D nest-body evidence is unconfirmed; mark the nest itself with visualSubject nest-body or retain this gap";
  return null;
}

export function measureImage(pin: ImagePin, entry: BoundsEntry, context?: ScaleImage["context"]) {
  assert(entry.file === pin.file && entry.sha256 === pin.sha256, "Measurement does not name the captured image");
  assert(entry.objects.length === OBJECTS.length && new Set(entry.objects.map(o => o.kind)).size === OBJECTS.length && entry.objects.every(o => OBJECTS.includes(o.kind)), "Each image needs exactly one ant, nest, food and rock entry");
  const pixelsPerCssX = pin.width / pin.cssWidth, pixelsPerCssY = pin.height / pin.cssHeight;
  return entry.objects.map(object => {
    if (object.status !== "measured") {
      assert(["unmeasured", "absent", "obscured"].includes(object.status) && object.reason.trim(), "Missing objects need an explicit reason");
      return { ...object, css: null };
    }
    const nestGap = nestEvidenceGap(object, context);
    if (nestGap) return { kind: object.kind, status: "unmeasured" as const, reason: nestGap, rejectedMeasurement: object, css: null };
    assert(object.identity.trim(), "Measured object needs a visible identity/location description");
    const [x0, y0, x1, y1] = object.bounds;
    assert(object.bounds.length === 4 && object.bounds.every(Number.isFinite) && x0 >= 0 && y0 >= 0 && x1 <= pin.width && y1 <= pin.height && x1 > x0 && y1 > y0, "Object edges must form a positive box inside the original PNG");
    return { ...object, css: { x0: x0 / pixelsPerCssX, y0: y0 / pixelsPerCssY, width: (x1 - x0) / pixelsPerCssX, height: (y1 - y0) / pixelsPerCssY }, pixelsPerCssX, pixelsPerCssY };
  });
}

export function measurementTemplate(images: readonly ScaleImage[]): BoundsEntry[] {
  return images.map(({ image, context }) => ({ file: image.file, sha256: image.sha256, objects: OBJECTS.map(kind => ({ kind, status: "unmeasured", reason: kind === "nest" && context.board === "3d" && context.device === "iphone15"
    ? "Mark the visible nest body itself, not the queen crown or marker, and set visualSubject to nest-body; otherwise record an explicit gap."
    : "Mark the actual visible object edges in the original PNG, or record why this image cannot measure it." })) }));
}

/** Direct measured CSS extents at the common target, axis by axis. No size
 * tolerance is added: camera convergence epsilon is NOT an object-size threshold.
 */
export function normalizeObjectSize(raw: ObjectSize, reached: PhysicalPixels, target: PhysicalPixels) {
  assert(raw && reached && target && [raw.width, raw.height, reached.x, reached.y, target.x, target.y].every(n => Number.isFinite(n) && n > 0), "Object size and physical-tile scales must be finite and positive");
  const normalized = { width: raw.width * (target.x / reached.x), height: raw.height * (target.y / reached.y) };
  assert(Object.values(normalized).every(n => Number.isFinite(n) && n > 0), "Normalized object size is not finite and positive");
  return { raw, reached, target, normalized };
}

export function compareObjectSize(candidate: ObjectSize, baseline: ObjectSize, reached: PhysicalPixels, baselineReached: PhysicalPixels, target: PhysicalPixels) {
  const actual = normalizeObjectSize(candidate, reached, target), expected = normalizeObjectSize(baseline, baselineReached, target);
  const delta = { width: actual.normalized.width - expected.normalized.width, height: actual.normalized.height - expected.normalized.height };
  return { candidate: actual, baseline: expected, delta, smaller: delta.width < 0 || delta.height < 0 };
}

type MeasuredImage = ScaleImage & { objects: ReturnType<typeof measureImage> };
/** Pair only the same map, board, browser, device and tick; bind the baseline to
 * the exact reference screenshot recorded by the candidate capture.
 */
export function compareMatchedImages(images: readonly MeasuredImage[]) {
  const key = (i: MeasuredImage) => JSON.stringify([i.context.map, i.context.board, i.context.browser, i.context.device, i.context.tick]);
  const keys = new Set(images.map(key));
  const gaps: { context: string; kind?: ObjectKind; reason: string }[] = [];
  const comparisons: { context: string; candidate: ImagePin; baseline: ImagePin; kind: ObjectKind; candidateIdentity: string; baselineIdentity: string; measurement: ReturnType<typeof compareObjectSize> }[] = [];
  for (const context of keys) {
    const matched = images.filter(i => key(i) === context && i.context.label === "matched-zoom");
    const candidates = matched.filter(i => i.context.phase === "candidate"), baselines = matched.filter(i => i.context.phase === "baseline");
    if (candidates.length !== 1 || baselines.length !== 1) { gaps.push({ context, reason: "Exactly one candidate and baseline matched image required" }); continue; }
    const candidate = candidates[0]!, baseline = baselines[0]!;
    const reference = candidate.normalization?.baseline;
    if (!reference || reference.file !== baseline.image.file || reference.sha256 !== baseline.image.sha256) {
      gaps.push({ context, reason: "Matched baseline reference is missing or differs from the measured screenshot" }); continue;
    }
    const reached = (candidate.scale as { pixelsPerPhysicalTile?: PhysicalPixels[] } | null)?.pixelsPerPhysicalTile?.[0];
    const baselineReached = (baseline.scale as { pixelsPerPhysicalTile?: PhysicalPixels[] } | null)?.pixelsPerPhysicalTile?.[0];
    const target = candidate.normalization?.target;
    if (!reached || !baselineReached || !target) { gaps.push({ context, reason: "Reached or target physical-tile scale is missing" }); continue; }
    for (const kind of OBJECTS) {
      const actual = candidate.objects.find(o => o.kind === kind), expected = baseline.objects.find(o => o.kind === kind);
      if (!actual || !expected || actual.status !== "measured" || expected.status !== "measured" || !actual.css || !expected.css) {
        gaps.push({ context, kind, reason: `Object not measurable in both images: candidate ${actual?.status ?? "missing"}, baseline ${expected?.status ?? "missing"}` }); continue;
      }
      const nestGap = nestEvidenceGap(actual, candidate.context) ?? nestEvidenceGap(expected, baseline.context);
      if (nestGap) { gaps.push({ context, kind, reason: nestGap }); continue; }
      try {
        const measurement = compareObjectSize({ width: actual.css.width, height: actual.css.height }, { width: expected.css.width, height: expected.css.height }, reached, baselineReached, target);
        comparisons.push({ context, candidate: candidate.image, baseline: baseline.image, kind, candidateIdentity: actual.identity, baselineIdentity: expected.identity, measurement });
      } catch (error) { gaps.push({ context, kind, reason: String(error) }); }
    }
  }
  if (!keys.size) gaps.push({ context: "all", reason: "No captured comparison images" });
  // Sampling is per map/board/engine/device, but comparisons above remain tick-isolated.
  // A measured default/home image cannot fill a missing matched-comparison sample.
  const pairs = new Map<string, { map: string; board: string; engine: string; device: string; contexts: Set<string> }>();
  for (const image of images) {
    const { map, board, browser: engine, device } = image.context;
    const pairKey = JSON.stringify([map, board, engine, device]);
    if (!pairs.has(pairKey)) pairs.set(pairKey, { map, board, engine, device, contexts: new Set() });
    pairs.get(pairKey)!.contexts.add(key(image));
  }
  const coverage = [...pairs.values()].map(({ contexts, ...pair }) => {
    const objects = OBJECTS.map(kind => {
      const samples = comparisons.filter(c => contexts.has(c.context) && c.kind === kind);
      return { kind, hasMeasuredInstance: samples.length > 0, measuredInstances: samples.length,
        smallerInstances: samples.filter(c => c.measurement.smaller).length,
        gaps: gaps.filter(g => contexts.has(g.context) && (!g.kind || g.kind === kind)) };
    });
    return { ...pair, objects, hasEveryObjectType: objects.every(o => o.hasMeasuredInstance),
      hasSmallerObjects: objects.some(o => o.smallerInstances > 0) };
  });
  return { comparisons, gaps, coverage, sizeFailures: comparisons.filter(c => c.measurement.smaller) };
}

export async function readMeasurements(images: readonly ScaleImage[], entries: readonly BoundsEntry[], directory: string) {
  assert(new Set(images.map(i => i.image.file)).size === images.length && images.length > 0, "Captured scale image set is missing or ambiguous");
  assert(entries.length === images.length && new Set(entries.map(e => e.file)).size === entries.length, "Measurement ledger must cover every captured default/home image exactly once");
  const measured = [];
  for (const captured of images) {
    const pin = captured.image;
    assert(pin.file === basename(pin.file), "Screenshot must be a file in the capture directory");
    const bytes = await readFile(resolve(directory, pin.file));
    assert.deepEqual(imagePin(pin.file, bytes, pin.cssWidth, pin.cssHeight), pin, "Screenshot digest or dimensions changed");
    const entry = entries.find(e => e.file === pin.file);
    assert(entry, `Missing measurement: ${pin.file}`);
    measured.push({ ...captured, objects: measureImage(pin, entry, captured.context) });
  }
  const compared = compareMatchedImages(measured);
  const incomplete = compared.gaps.length > 0 || measured.some(m => m.objects.some(o => o.status !== "measured"));
  return { status: compared.sizeFailures.length ? "smaller-at-target" : incomplete ? "incomplete" : "measured-awaiting-visual-review", images: measured, ...compared }; // Size failures go to visual review; this is not an automatic product verdict.
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { observations: { type: "string" }, bounds: { type: "string" }, out: { type: "string" } } });
  assert(values.observations && values.bounds && values.out, "--observations, --bounds and --out required");
  const observations = JSON.parse(await readFile(values.observations, "utf8")) as { head: string; baselineHead: string; status: string; scaleImages: ScaleImage[] };
  const result = await readMeasurements(observations.scaleImages, JSON.parse(await readFile(values.bounds, "utf8")), dirname(resolve(values.observations)));
  await writeFile(values.out, JSON.stringify({ head: observations.head, baselineHead: observations.baselineHead, captureStatus: observations.status, ...result }, null, 2));
  if (result.status !== "measured-awaiting-visual-review" || observations.status === "capture-failed") process.exitCode = 1;
}
