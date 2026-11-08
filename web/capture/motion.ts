/**
 * The motion check: while a match plays, no page-space panel, card, strip, row, cell, label or
 * figure box moves or resizes; only a panel the viewer opens may change the layout.
 *
 * At 1920x1080 and 390x844, on the run's board, the primary recording plays at 1x for 60 s from 30 s before its attack
 * moment, with nothing opened (MOTION_VIEWPORTS). Every 250 ms of playback it reads getBoundingClientRect of every
 * rendered block, flex or grid box of the page but the board's canvas (inline text runs are not boxes here). Each box is
 * compared with where it was first seen in the window: a change of more than 1 px in x, y, width or height fails, each
 * time the box leaves its place (a move that returns fails as well: the 1.94 px swing of main 7081fbd's phone status
 * line). A box that comes or goes in space kept for it moves nothing else and is
 * listed, not failed; one that pushes anything shows in what it pushed.
 *
 * Feed and list lines: the lines of a list (ol, ul, role list or log) are followed
 * one by one as they are, not by place. A line may move as new entries arrive, recorded and not failed, only while
 * entries enter at one end of the list, always the same end, and no line changes its height or width (wraps
 * differently), nor anything inside it moves within it, after it appears. The list's own box and everything outside
 * it are held to the rule above.
 *
 * The WebKit phone pass runs the phone sizes and the iPhone's own 393x659. Writes DIR/motion.json
 * (motion-webkit.json for the WebKit pass; another record's name for another window, as the territory countdown's) with
 * every box's largest change and what came, went and moved in a list; every failure goes to problems with the box, the
 * time and the change.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { RENDER_DELAY_MS } from "../src/buffer.ts";
import { enginePrefix, openClient, type ClientPage } from "./browser.ts";
import { clockAt } from "./moments.ts";

/** A size to check. */
export type MotionViewport = readonly [label: string, size: readonly [number, number], phone: boolean];
/** Desktop and phone with nothing opened. */
export const MOTION_VIEWPORTS: readonly MotionViewport[] = [
  ["1080p", [1920, 1080], false],
  ["phone", [390, 844], true],
];
/**
 * The iPhone's own viewport (Playwright's iPhone 15 under Safari's bars), which the WebKit pass adds: a page too short for
 * its content, where the board's height must still be set once and never change during play.
 */
export const IPHONE_MOTION_VIEWPORT: MotionViewport = ["iphone15", [393, 659], true];
const SAMPLE_MS = 250;
const WINDOW_MS = 60_000;
const LEAD_MS = 30_000;
export const TOLERANCE_PX = 1;

export type Box = [x: number, y: number, w: number, h: number];
/** A list's line: followed by identity, its own box, and the boxes inside it relative to its corner. */
export interface ListLine { id: number; box: Box; inner: Record<string, Box> }
/** One reading of the page: its boxes by place, and each list's lines in order. */
export interface MotionSample { boxes: Record<string, Box>; lists: Record<string, ListLine[]> }

/**
 * The page's boxes now. A box outside the lists is keyed by where it sits in the page: its path from <body>, each step
 * its tag, classes and place among its siblings, so a box replaced by another in the same place (a glyph redrawn) keeps
 * its key and only a change of place or size counts. A list's lines are keyed by identity instead, so a line that
 * moves is known for the same line.
 */
export function motionSample(c: ClientPage): Promise<MotionSample> {
  return c.page.evaluate(() => {
    const w = window as unknown as { __awMotionIds?: WeakMap<Element, number>; __awMotionNext?: number };
    const ids = (w.__awMotionIds ??= new WeakMap());
    const idOf = (e: Element) => {
      let id = ids.get(e);
      if (id === undefined) {
        id = w.__awMotionNext = (w.__awMotionNext ?? 0) + 1;
        ids.set(e, id);
      }
      return id;
    };
    const boxes: Record<string, [number, number, number, number]> = {};
    const lists: Record<string, { id: number; box: [number, number, number, number]; inner: Record<string, [number, number, number, number]> }[]> = {};
    const shown = new Set(["block", "flex", "grid", "inline-block", "inline-flex", "inline-grid", "list-item", "flow-root", "table"]);
    const round = (v: number) => Math.round(v * 100) / 100;
    const step = (n: Element) => {
      const cls = [...n.classList].filter((k) => k.startsWith("aw-")).slice(0, 2).join(".");
      const index = n.parentElement ? [...n.parentElement.children].indexOf(n) + 1 : 1;
      return `${n.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${n.id ? `#${n.id}` : ""}:${index}`;
    };
    const path = (e: Element, top: Element | null = null) => {
      const parts: string[] = [];
      for (let n: Element | null = e; n && n !== document.body && n !== top; n = n.parentElement) parts.unshift(step(n));
      return parts.join(" > ");
    };
    const isList = (e: Element) => e.matches("ol, ul, [role=list], [role=log]");
    const rect = (e: Element) => {
      const r = e.getBoundingClientRect();
      return [round(r.x), round(r.y), round(r.width), round(r.height)] as [number, number, number, number];
    };
    const counts = (e: Element) => !(e instanceof HTMLCanvasElement || e instanceof HTMLScriptElement) && shown.has(getComputedStyle(e).display) && e.getClientRects().length > 0;
    for (const e of document.body.querySelectorAll("*")) {
      if (!counts(e)) continue;
      // A list's line, or anything inside one, is read with its line below.
      let inLine = false;
      for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) if (n.parentElement && isList(n.parentElement)) { inLine = true; break; }
      if (inLine) continue;
      boxes[path(e)] = rect(e);
      if (!isList(e)) continue;
      lists[path(e)] = [...e.children].filter(counts).map((l) => {
        const box = rect(l);
        const inner: Record<string, [number, number, number, number]> = {};
        for (const d of l.querySelectorAll("*")) {
          if (!counts(d)) continue;
          const r = rect(d);
          inner[path(d, l)] = [round(r[0] - box[0]), round(r[1] - box[1]), r[2], r[3]];
        }
        return { id: idOf(l), box, inner };
      });
    }
    return { boxes, lists };
  });
}

/** The last steps of a box's path, enough to name it in a problem line. */
const short = (element: string) => element.split(" > ").slice(-3).join(" > ");

export interface MotionChange {
  element: string;
  /** Milliseconds into the window. */
  at: number;
  /** x, y, width and height against the box's place when first seen in the window (or, inside a line, the line's corner). */
  delta: Box;
  kind: "moved" | "appeared" | "went" | "line-moved" | "line-resized" | "line-inner-moved" | "line-entered-out-of-order";
  /** A failure of the check, rather than a change it records. */
  fails: boolean;
}

export interface MotionResult {
  /** Each box's largest change in x, y, width and height over the window. */
  max: Map<string, Box>;
  changes: MotionChange[];
}

const beyond = (delta: readonly number[]) => delta.some((d) => Math.abs(d) > TOLERANCE_PX);
const less = (a: Box, b: Box) => a.map((v, i) => Math.round((v - b[i]!) * 100) / 100) as Box;

/**
 * The check over a window's readings, in order. A box out of its first place by more than the tolerance fails once
 * each time it leaves it; a list's lines follow the feed rule in the header.
 */
export function motionChanges(samples: readonly { at: number; sample: MotionSample }[]): MotionResult {
  const seen = new Map<string, Box>();
  const max = new Map<string, Box>();
  /** What is out of its place or size now: each failure counts once each time it leaves. */
  const away = new Set<string>();
  const leaves = (key: string, out: boolean) => {
    const left = out && !away.has(key);
    if (out) away.add(key);
    else away.delete(key);
    return left;
  };
  const changes: MotionChange[] = [];
  let previous: MotionSample | null = null;
  /** The end a list's new entries come in at, once one has. */
  const entryEnd = new Map<string, "first" | "last">();
  /** Each line's box when it appeared (its size holds), where it was last (it may move as entries arrive), and what is inside it as first seen. */
  const lineSeen = new Map<string, { first: Box; last: Box; inner: Record<string, Box> }>();
  for (const { at, sample } of samples) {
    for (const [element, box] of Object.entries(sample.boxes)) {
      const base = seen.get(element);
      if (base === undefined) {
        seen.set(element, box);
        max.set(element, [0, 0, 0, 0]);
        if (previous !== null) changes.push({ element, at, delta: box, kind: "appeared", fails: false });
        continue;
      }
      const delta = less(box, base);
      const top = max.get(element)!;
      for (let i = 0; i < 4; i++) if (Math.abs(delta[i]!) > Math.abs(top[i]!)) top[i] = delta[i]!;
      if (leaves(element, beyond(delta))) changes.push({ element, at, delta, kind: "moved", fails: true });
    }
    if (previous !== null) {
      for (const element of Object.keys(previous.boxes)) if (!(element in sample.boxes)) changes.push({ element, at, delta: seen.get(element)!, kind: "went", fails: false });
      for (const [list, lines] of Object.entries(sample.lists)) {
        const before = previous.lists[list] ?? [];
        const old = new Set(before.map((l) => l.id));
        const kept = lines.filter((l) => old.has(l.id));
        const fresh = lines.map((l, i) => (old.has(l.id) ? -1 : i)).filter((i) => i >= 0);
        // New entries at one end: every new line before all kept ones, or after them, and the kept ones in their order.
        const end = fresh.length === 0 ? null : fresh.every((i, k) => i === k) ? "first" : fresh.every((i, k) => i === lines.length - fresh.length + k) ? "last" : "middle";
        const order = before.filter((l) => kept.some((k) => k.id === l.id)).map((l) => l.id);
        const inOrder = kept.every((l, i) => l.id === order[i]);
        const established = entryEnd.get(list);
        if (end === "first" || end === "last") {
          if (established === undefined) entryEnd.set(list, end);
        }
        const oneEnd = (end === "first" || end === "last") && (established === undefined || established === end) && inOrder;
        if (end !== null && !oneEnd) changes.push({ element: list, at, delta: [0, 0, 0, 0], kind: "line-entered-out-of-order", fails: true });
        for (const line of kept) {
          const key = `${list} > line ${line.id}`;
          const was = lineSeen.get(key)!;
          const grown = less(line.box, was.first);
          const moved = less(line.box, was.last);
          if (leaves(`${key} size`, beyond([grown[2], grown[3]]))) changes.push({ element: key, at, delta: grown, kind: "line-resized", fails: true });
          if (beyond([moved[0], moved[1]])) changes.push({ element: key, at, delta: moved, kind: "line-moved", fails: !oneEnd });
          for (const [inner, box] of Object.entries(line.inner)) {
            const first = was.inner[inner];
            if (first === undefined) continue;
            const shift = less(box, first);
            if (leaves(`${key} > ${inner}`, beyond(shift))) changes.push({ element: `${key} > ${inner}`, at, delta: shift, kind: "line-inner-moved", fails: true });
          }
          lineSeen.set(key, { first: was.first, last: line.box, inner: { ...Object.fromEntries(Object.entries(line.inner).filter(([k]) => !(k in was.inner))), ...was.inner } });
        }
        for (const line of lines) if (!old.has(line.id)) lineSeen.set(`${list} > line ${line.id}`, { first: line.box, last: line.box, inner: line.inner });
      }
    } else {
      for (const [list, lines] of Object.entries(sample.lists)) for (const line of lines) lineSeen.set(`${list} > line ${line.id}`, { first: line.box, last: line.box, inner: line.inner });
    }
    previous = sample;
  }
  return { max, changes };
}

/** A failure's line for the run's problems. */
export function motionProblem(name: string, change: MotionChange): string {
  const [dx, dy, dw, dh] = change.delta;
  const when = `at ${(change.at / 1000).toFixed(2)} s`;
  switch (change.kind) {
    case "line-entered-out-of-order": return `${name}: ${short(change.element)}: new lines entered other than at one end ${when}`;
    case "line-resized": return `${name}: ${short(change.element)} changed size after it appeared: width ${dw}, height ${dh} px ${when}`;
    case "line-inner-moved": return `${name}: ${short(change.element)} moved within its line by x ${dx}, y ${dy}, width ${dw}, height ${dh} px ${when}`;
    case "line-moved": return `${name}: ${short(change.element)} moved by x ${dx}, y ${dy} px with no entry arriving at the list's one end ${when}`;
    default: return `${name}: ${short(change.element)} moved/resized by x ${dx}, y ${dy}, width ${dw}, height ${dh} px ${when}`;
  }
}

/**
 * Plays the window and checks it. In a WebKit browser (--webkit-phone) only the default sizes' phones run, as the WebKit
 * phone pass's, and the record is motion-webkit.json; viewports may name other sizes (a check of another build at its
 * size, or the territory countdown's), which run as named in either engine.
 */
export async function motionCheck(browser: Browser, board: "2d" | "3d", recording: string, first: number, attack: number | null, out: string, webDir: string | undefined, problems: string[], viewports: readonly MotionViewport[] = MOTION_VIEWPORTS, record = "motion"): Promise<void> {
  const pre = enginePrefix(browser);
  const sizes = pre === "" || viewports !== MOTION_VIEWPORTS ? viewports : [...viewports.filter(([, , phone]) => phone), IPHONE_MOTION_VIEWPORT];
  const leadTicks = Math.round(LEAD_MS / TICK_MS);
  const from = attack === null ? first : Math.max(first, attack - leadTicks);
  // The window is measured from the attack; a recording without one is still checked, from its start, and says so.
  const note = attack === null ? `${recording} has no attack moment; the window starts at its first tick` : null;
  if (note !== null) console.log(`motion ${pre}${board}: ${note}`);
  const report: unknown[] = [];
  for (const [label, vp, phone] of sizes) {
    const name = `motion ${pre}${board}-${label}`;
    let c: ClientPage | undefined;
    try {
      c = await openClient(browser, { recording, width: vp[0], height: vp[1], tilt: board === "3d", webDir, board, phone });
      let now = 0;
      const at = clockAt(from, RENDER_DELAY_MS, first);
      while (now < at) {
        const step = Math.min(1000, at - now);
        await c.advance(step);
        now += step;
        await c.frame(false);
      }
      await c.frame();
      await c.page.evaluate(async () => { await document.fonts.ready; });
      const samples: { at: number; sample: MotionSample }[] = [];
      for (let t = 0; t <= WINDOW_MS; t += SAMPLE_MS) {
        if (t > 0) {
          await c.advance(SAMPLE_MS);
          await c.frame(false);
        }
        samples.push({ at: t, sample: await motionSample(c) });
      }
      const { max, changes } = motionChanges(samples);
      const elements = [...max].map(([element, delta]) => ({ element, maxDelta: { x: delta[0], y: delta[1], width: delta[2], height: delta[3] } }));
      report.push({ viewport: label, size: vp, fromTick: from, samples: samples.length, elements, changes });
      problems.push(...changes.filter((change) => change.fails).map((change) => motionProblem(name, change)));
    } catch (e) {
      problems.push(`${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    } finally {
      if (c) await c.close().catch(() => undefined);
    }
  }
  writeFileSync(join(out, pre === "" ? `${record}.json` : `${record}-webkit.json`), `${JSON.stringify({ board, engine: pre === "" ? "chromium" : "webkit", recording, windowMs: WINDOW_MS, sampleMs: SAMPLE_MS, tolerancePx: TOLERANCE_PX, ...(note === null ? {} : { note }), viewports: report }, null, 2)}\n`);
}
