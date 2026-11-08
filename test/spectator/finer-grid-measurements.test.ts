import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imagePin, measureImage, measurementTemplate, readMeasurements, normalizeObjectSize, compareObjectSize, compareMatchedImages, OBJECTS, type BoundsEntry, type ScaleImage } from "../../web/capture/finer-grid-measurements.ts";

function png(width = 1179, height = 2556) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function fixture() {
  const bytes = png(), pin = imagePin("map.png", bytes, 393, 852);
  const captured: ScaleImage = { image: pin, context: { map: "open-field", phase: "candidate", board: "2d", browser: "webkit", device: "iphone15", tick: 0, label: "default" }, scale: { pixelsPerPhysicalTile: [{ x: 12, y: 12 }] } };
  const entry: BoundsEntry = { file: pin.file, sha256: pin.sha256, objects: OBJECTS.map(kind => ({ kind, identity: "visible isolated object at the specified pixel box", status: "measured", bounds: [30, 60, 66, 84] })) };
  return { bytes, pin, captured, entry };
}

describe("direct finer-grid screenshot measurements", () => {
  it("converts actual PNG edge bounds to CSS pixels without using model geometry or physical tile scale", () => {
    const { pin, entry } = fixture();
    expect(measureImage(pin, entry)[0]).toMatchObject({ status: "measured", pixelsPerCssX: 3, pixelsPerCssY: 3, css: { x0: 10, y0: 20, width: 12, height: 8 } });
    const other = imagePin("map.png", png(786, 1704), 393, 852);
    expect(measureImage(other, { ...entry, sha256: other.sha256 })[0]!.css?.width).toBe(18);
  });
  it("keeps absent, obscured and unmeasured objects as gaps, not zero-sized or successful comparisons", () => {
    const { pin, captured } = fixture();
    const entry = measurementTemplate([captured])[0]!;
    entry.objects[0] = { kind: "ant", status: "absent", reason: "no ants at this tick" };
    entry.objects[1] = { kind: "nest", status: "obscured", reason: "badge overlaps outline" };
    expect(measureImage(pin, entry).map(o => o.css)).toEqual([null, null, null, null]);
  });
  it("refuses wrong images, duplicate objects, out-of-image edges and invented size readings", () => {
    const { pin, entry } = fixture();
    expect(() => measureImage(pin, { ...entry, sha256: "0".repeat(64) })).toThrow("captured image");
    expect(() => measureImage(pin, { ...entry, objects: [...entry.objects.slice(0, 3), entry.objects[0]!] })).toThrow("exactly one");
    for (const bounds of [[0, 0, 1200, 30], [1, 1, 1, 3], [NaN, 0, 1, 1]]) {
      const bad = structuredClone(entry); bad.objects[0] = { kind: "ant", identity: "ant 1", status: "measured", bounds: bounds as [number, number, number, number] };
      expect(() => measureImage(pin, bad)).toThrow("positive box");
    }
    expect(() => imagePin("bad.png", Buffer.alloc(30), 393, 852)).toThrow("PNG");
  });
  it("rechecks screenshot bytes and exact image-set coverage before emitting measured output", async () => {
    const { bytes, pin, captured, entry } = fixture();
    const dir = await mkdtemp(join(tmpdir(), "finer-measurement-"));
    try {
      await writeFile(join(dir, pin.file), bytes);
      expect((await readMeasurements([captured], [entry], dir)).status).toBe("incomplete"); // A measured candidate alone is not a comparison.
      expect((await readMeasurements([captured], measurementTemplate([captured]), dir)).status).toBe("incomplete");
      await expect(readMeasurements([captured], [], dir)).rejects.toThrow("every captured");
      await expect(readMeasurements([captured], [entry, entry], dir)).rejects.toThrow("every captured");
      await writeFile(join(dir, pin.file), png(1180));
      await expect(readMeasurements([captured], [entry], dir)).rejects.toThrow("Screenshot digest or dimensions changed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("reached-zoom normalization", () => {
  it("preserves equal physical sizes despite unequal reached zoom, independently on both axes", () => {
    const result = compareObjectSize({ width: 12, height: 4 }, { width: 24, height: 8 }, { x: 4, y: 2 }, { x: 8, y: 4 }, { x: 10, y: 6 });
    expect(result).toMatchObject({ candidate: { raw: { width: 12, height: 4 }, reached: { x: 4, y: 2 }, target: { x: 10, y: 6 }, normalized: { width: 30, height: 12 } }, baseline: { normalized: { width: 30, height: 12 } }, delta: { width: 0, height: 0 }, smaller: false });
  });
  it("does not mistake a smaller raw image for a smaller object, but exposes smaller normalized widths or heights", () => {
    const target = { x: 8, y: 8 };
    expect(compareObjectSize({ width: 10, height: 10 }, { width: 16, height: 16 }, { x: 4, y: 4 }, target, target).smaller).toBe(false);
    expect(compareObjectSize({ width: 7, height: 10 }, { width: 16, height: 16 }, { x: 4, y: 4 }, target, target)).toMatchObject({ smaller: true, delta: { width: -2, height: 4 } });
    expect(compareObjectSize({ width: 10, height: 7 }, { width: 16, height: 16 }, { x: 4, y: 4 }, target, target)).toMatchObject({ smaller: true, delta: { width: 4, height: -2 } });
    // The camera's convergence epsilon must not become a new object-size allowance.
    expect(compareObjectSize({ width: 16 - 1e-7, height: 16 }, { width: 16, height: 16 }, target, target, target).smaller).toBe(true);
  });
  it("rejects zero, negative, nonfinite or overflowing readings instead of fabricating a size result", () => {
    for (const x of [0, -1, NaN, Infinity]) expect(() => normalizeObjectSize({ width: 10, height: 10 }, { x, y: 1 }, { x: 1, y: 1 })).toThrow("finite and positive");
    expect(() => normalizeObjectSize({ width: 1e300, height: 1 }, { x: 1e-300, y: 1 }, { x: 1, y: 1 })).toThrow("finite and positive");
  });

  function pair() {
    const { pin, captured, entry } = fixture();
    const baseline = { ...captured, image: { ...pin, file: "baseline.png" }, context: { ...captured.context, phase: "baseline", label: "matched-zoom" }, scale: { pixelsPerPhysicalTile: [{ x: 12, y: 12 }] }, objects: measureImage(pin, entry) };
    const smallerRaw = { ...entry, objects: OBJECTS.map(kind => ({ kind, status: "measured" as const, identity: `${kind} at specified edges`, bounds: [30, 60, 48, 72] as [number, number, number, number] })) };
    const candidate = { ...captured, context: { ...captured.context, label: "matched-zoom" }, scale: { pixelsPerPhysicalTile: [{ x: 6, y: 6 }] }, normalization: { target: { x: 12, y: 12 }, baseline: { file: baseline.image.file, sha256: baseline.image.sha256 } }, objects: measureImage(pin, smallerRaw) };
    return { candidate, baseline, smallerRaw, entry };
  }
  it("pairs exact images across the full capture context and keeps every raw/normalized measurement", () => {
    const { candidate, baseline } = pair();
    const result = compareMatchedImages([candidate, baseline]);
    expect(result.gaps).toEqual([]);
    expect(result.sizeFailures).toEqual([]);
    expect(result.comparisons).toHaveLength(4);
    expect(result.comparisons[0]).toMatchObject({ kind: "ant", candidate: candidate.image, baseline: baseline.image, measurement: { candidate: { raw: { width: 6, height: 4 }, normalized: { width: 12, height: 8 } }, delta: { width: 0, height: 0 } } });
    expect(compareMatchedImages([candidate, { ...baseline, context: { ...baseline.context, device: "other-device" } }]).gaps).toHaveLength(2);
    expect(compareMatchedImages([candidate, baseline, baseline]).sizeFailures).toEqual([]);
    expect(compareMatchedImages([candidate, baseline, baseline]).gaps).toHaveLength(1);
  });
  it("reports incomplete evidence distinctly from genuinely smaller objects", () => {
    const { candidate, baseline } = pair();
    const badReference = { ...candidate, normalization: { ...candidate.normalization, baseline: { file: "wrong.png", sha256: baseline.image.sha256 } } };
    expect(compareMatchedImages([badReference, baseline])).toMatchObject({ comparisons: [], sizeFailures: [], gaps: [{ reason: expect.stringContaining("reference") }] });
    const invalidScale = { ...candidate, scale: { pixelsPerPhysicalTile: [{ x: 0, y: 6 }] } };
    expect(compareMatchedImages([invalidScale, baseline]).gaps).toHaveLength(4);
    expect(compareMatchedImages([invalidScale, baseline]).sizeFailures).toEqual([]);
    const absent = { ...candidate, objects: candidate.objects.map(o => ({ kind: o.kind, status: "absent" as const, reason: "absent at this tick", css: null })) };
    expect(compareMatchedImages([absent, baseline])).toMatchObject({ comparisons: [], sizeFailures: [], gaps: expect.any(Array) });
    const smaller = { ...candidate, scale: { pixelsPerPhysicalTile: [{ x: 8, y: 8 }] } };
    expect(compareMatchedImages([smaller, baseline]).sizeFailures).toHaveLength(4);
  });
  it("reports each object type for every pair without borrowing other contexts or default images", () => {
    const { candidate, baseline } = pair();
    const other = { ...candidate, image: { ...candidate.image, file: "other.png" }, context: { ...candidate.context, browser: "chromium", device: "desktop", map: "central-lake", board: "3d" } };
    const result = compareMatchedImages([candidate, baseline, other]);
    expect(result.coverage).toHaveLength(2);
    expect(result.coverage[0]).toMatchObject({ map: "open-field", board: "2d", engine: "webkit", device: "iphone15", hasEveryObjectType: true, hasSmallerObjects: false });
    expect(result.coverage[0]!.objects.map(o => [o.kind, o.hasMeasuredInstance, o.measuredInstances])).toEqual(OBJECTS.map(kind => [kind, true, 1]));
    expect(result.coverage[1]!.hasEveryObjectType).toBe(false);
    for (const object of result.coverage[1]!.objects) {
      expect(object).toMatchObject({ hasMeasuredInstance: false, measuredInstances: 0 });
      expect(object.gaps).toHaveLength(1);
    }
    const defaultOnly = compareMatchedImages([{ ...candidate, context: { ...candidate.context, label: "default" } }, baseline]);
    expect(defaultOnly.coverage[0]!.objects.every(o => !o.hasMeasuredInstance)).toBe(true);
  });
  it("aggregates valid same-tick samples, retains other-tick gaps, and does not hide a smaller instance", () => {
    const { candidate, baseline } = pair();
    const absentRock = { ...candidate, context: { ...candidate.context, tick: 1 }, objects: candidate.objects.map(o => o.kind === "rock" ? { kind: o.kind, status: "obscured" as const, reason: "hidden at tick1", css: null } : o), scale: { pixelsPerPhysicalTile: [{ x: 8, y: 8 }] } };
    const laterBaseline = { ...baseline, context: { ...baseline.context, tick: 1 } };
    const result = compareMatchedImages([candidate, baseline, absentRock, laterBaseline]);
    expect(result.coverage).toHaveLength(1);
    expect(result.coverage[0]).toMatchObject({ hasEveryObjectType: true, hasSmallerObjects: true });
    expect(result.coverage[0]!.objects.find(o => o.kind === "ant")).toMatchObject({ measuredInstances: 2, smallerInstances: 1 });
    expect(result.coverage[0]!.objects.find(o => o.kind === "rock")).toMatchObject({ measuredInstances: 1, smallerInstances: 0, gaps: [{ reason: expect.stringContaining("not measurable") }] });
    expect(compareMatchedImages([candidate, laterBaseline]).coverage[0]!.objects.every(o => !o.hasMeasuredInstance)).toBe(true);
    const missingNest = { ...candidate, objects: candidate.objects.map(o => o.kind === "nest" ? { kind: o.kind, status: "obscured" as const, reason: "no visible nest body", css: null } : o) };
    expect(compareMatchedImages([missingNest, baseline]).coverage[0]!.objects.find(o => o.kind === "nest")).toMatchObject({ hasMeasuredInstance: false, measuredInstances: 0 });
  });
  it("requires actual phone 3D nest-body evidence and never counts crowns or unconfirmed historical bounds", async () => {
    const { candidate, baseline, smallerRaw, entry } = pair();
    const phoneCandidate = { ...candidate, context: { ...candidate.context, board: "3d" } };
    const phoneBaseline = { ...baseline, context: { ...baseline.context, board: "3d" } };
    expect(measurementTemplate([phoneCandidate])[0]!.objects[1]).toMatchObject({ reason: expect.stringContaining("not the queen crown") });
    // Even direct comparison callers cannot bypass the declaration.
    const unconfirmed = compareMatchedImages([phoneCandidate, phoneBaseline]);
    expect(unconfirmed.coverage[0]!.objects.find(o => o.kind === "nest")).toMatchObject({ hasMeasuredInstance: false });
    expect(unconfirmed.gaps[0]!.reason).toContain("unconfirmed");
    const dir = await mkdtemp(join(tmpdir(), "nest-body-measurements-"));
    try {
      await writeFile(join(dir, candidate.image.file), png()); await writeFile(join(dir, baseline.image.file), png());
      const withSubject = (bounds: BoundsEntry, visualSubject: "nest-body" | "queen-crown" | "other-marker"): BoundsEntry => ({ ...bounds, objects: bounds.objects.map(o => o.kind === "nest" && o.status === "measured" ? { ...o, visualSubject } : o) });
      const baselineEntry = { ...entry, file: baseline.image.file };
      for (const subject of [undefined, "queen-crown", "other-marker"] as const) {
        const candidateEntry = subject ? withSubject(smallerRaw, subject) : smallerRaw;
        const result = await readMeasurements([phoneCandidate, phoneBaseline], [candidateEntry, withSubject(baselineEntry, "nest-body")], dir);
        expect(result.status).toBe("incomplete");
        expect(result.sizeFailures).toEqual([]);
        expect(result.images[0]!.objects.find(o => o.kind === "nest")).toMatchObject({ status: "unmeasured", css: null, rejectedMeasurement: { status: "measured" } });
        expect(result.coverage[0]!.objects.find(o => o.kind === "nest")).toMatchObject({ hasMeasuredInstance: false, measuredInstances: 0 });
      }
      const actualNest = await readMeasurements([phoneCandidate, phoneBaseline], [withSubject(smallerRaw, "nest-body"), withSubject(baselineEntry, "nest-body")], dir);
      expect(actualNest.status).toBe("measured-awaiting-visual-review");
      expect(actualNest.coverage[0]).toMatchObject({ hasEveryObjectType: true, hasSmallerObjects: false });
      expect(actualNest.comparisons.find(o => o.kind === "nest")!.measurement.delta).toEqual({ width: 0, height: 0 });
      const baselineCrown = await readMeasurements([phoneCandidate, phoneBaseline], [withSubject(smallerRaw, "nest-body"), withSubject(baselineEntry, "queen-crown")], dir);
      expect(baselineCrown.coverage[0]!.hasEveryObjectType).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("writes normalized comparisons only after the PNG digest checks, leaving failed captures to the CLI's existing guard", async () => {
    const { candidate, baseline, smallerRaw, entry } = pair();
    const dir = await mkdtemp(join(tmpdir(), "normalized-measurements-"));
    try {
      await writeFile(join(dir, candidate.image.file), png()); await writeFile(join(dir, baseline.image.file), png());
      const entries = [smallerRaw, { ...entry, file: baseline.image.file }];
      expect((await readMeasurements([candidate, baseline], entries, dir)).status).toBe("measured-awaiting-visual-review");
      const smaller = { ...candidate, scale: { pixelsPerPhysicalTile: [{ x: 8, y: 8 }] } };
      expect((await readMeasurements([smaller, baseline], entries, dir)).status).toBe("smaller-at-target");
      await writeFile(join(dir, baseline.image.file), png(1180));
      await expect(readMeasurements([candidate, baseline], entries, dir)).rejects.toThrow("Screenshot digest");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
