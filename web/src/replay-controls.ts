import { COLONY_NAMES } from "../../src/sim/config.ts";
import { PLAYBACK_RATES, type PlaybackRate, type Recording } from "./recording.ts";
import type { ReplayEvent } from "./replay-events.ts";
import "./replay-marks.css";

export function replayTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const KIND_NAMES = { fight: "Fight", nest: "Nest lost", food: "Food lead" } as const;
/** The native thumb's half width: its centre travels this far inside each end of the track. */
const THUMB_INSET = 8;
/** How long a mark's label stays after a tap or a chosen line. */
const LABEL_MS = 2000;
// Static markup (no recording data): a diamond, a downward triangle and a dot, outlined dark so each reads on the
// track's filled and empty parts alike (replay-marks.css colours them).
const GLYPHS = {
  fight: '<path d="M0 -6L6 0L0 6L-6 0Z"/>',
  nest: '<path d="M-6.5 -5.5L6.5 -5.5L0 6.5Z"/>',
  food: '<circle r="5.5"/>',
} as const;
const glyphMarkup = (kind: ReplayEvent["kind"]) =>
  `<svg class="aw-mark-glyph" viewBox="-8 -8 16 16" aria-hidden="true" focusable="false">${GLYPHS[kind]}</svg>`;

/** The words a mark is read by: its kind, its colony where it has one, and its match time. */
export function markWords(e: ReplayEvent): string[] {
  return [KIND_NAMES[e.kind], ...(e.colony === null ? [] : [COLONY_NAMES[e.colony]]), replayTime(e.ms)];
}

/** Where a moment stands along a track of `width` px: the thumb's centre at that position. */
export function markX(ms: number, duration: number, width: number): number {
  return THUMB_INSET + Math.min(1, Math.max(0, ms / duration)) * Math.max(0, width - 2 * THUMB_INSET);
}

/** Marks closer than `gap` px along a track of `width` px join one group, chained left to right. */
export function groupMarks(events: readonly ReplayEvent[], duration: number, width: number, gap: number): { x: number; events: ReplayEvent[] }[] {
  const groups: { xs: number[]; events: ReplayEvent[] }[] = [];
  for (const e of events) {
    const x = markX(e.ms, duration, width);
    const last = groups.at(-1);
    if (last && x - last.xs.at(-1)! < gap) { last.xs.push(x); last.events.push(e); }
    else groups.push({ xs: [x], events: [e] });
  }
  return groups.map(g => ({ x: Math.min(width - THUMB_INSET, Math.max(THUMB_INSET, g.xs.reduce((s, x) => s + x, 0) / g.xs.length)), events: g.events }));
}

/** Native range/select controls provide keyboard, pointer and touch behavior without a custom drag handler.
 * The caller mounts only for explicit replays, never the live page's stand-in recording; the HUD places `el` (HudHost.replay).
 * Once the recording's marks are read (Recording.events), they stand on the slider's track as buttons: a click or tap
 * jumps there, marks too close to tell apart join a counted group that opens a list (replay-marks.css). */
export function mountReplayControls(doc: Document, recording: Recording): { el: HTMLDivElement; update(): void; close(): void } {
  const el = doc.createElement("div");
  el.className = "aw-replay-controls";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Replay playback");
  const label = doc.createElement("label");
  label.textContent = "Speed ";
  const speed = doc.createElement("select");
  speed.setAttribute("aria-label", "Replay speed");
  for (const rate of PLAYBACK_RATES) {
    const option = doc.createElement("option");
    option.value = String(rate);
    option.textContent = `${rate}×`;
    speed.append(option);
  }
  speed.value = String(recording.rate);
  speed.onchange = () => recording.setRate(Number(speed.value) as PlaybackRate);
  label.append(speed);
  const seek = doc.createElement("input");
  seek.type = "range";
  seek.min = "0";
  seek.max = "0";
  seek.step = "100";
  seek.value = "0";
  seek.setAttribute("aria-label", "Replay position");
  const time = doc.createElement("output");
  time.className = "aw-replay-time";
  const state = doc.createElement("span");
  state.className = "aw-replay-state";
  state.setAttribute("role", "status");
  let interacting = false;
  const preview = () => {
    const position = replayTime(Number(seek.value));
    const duration = recording.duration === null ? "…" : replayTime(recording.duration);
    time.textContent = `${position} / ${duration}`;
    seek.setAttribute("aria-valuetext", `${position} of ${duration}`);
  };
  seek.onpointerdown = () => { interacting = true; };
  seek.oninput = preview;
  seek.onchange = () => { interacting = false; recording.seek(Number(seek.value)); };
  seek.onpointerup = seek.onpointercancel = seek.onblur = () => { interacting = false; };
  el.append(label, seek, time, state);

  // ---- the marks: a layer over the slider, a label chip and a group's list over the row
  const layer = doc.createElement("div");
  layer.className = "aw-marks";
  const chip = doc.createElement("div");
  chip.className = "aw-mark-label";
  chip.hidden = true;
  const list = doc.createElement("div");
  list.className = "aw-mark-list";
  list.setAttribute("role", "menu");
  list.hidden = true;
  let events: readonly ReplayEvent[] | null = null;
  let laidOut: readonly ReplayEvent[] | null = null;
  let laidDuration = 0;
  let trackWidth = 0;
  /** Where the thumb's centre stood along the track when the covered marks were last marked. */
  let laidThumb = NaN;
  // Re-laid out only when the slider's box changes, never measured every frame.
  let dirty = true;
  const Observer = doc.defaultView?.ResizeObserver;
  const resized = Observer ? new Observer(() => { dirty = true; }) : null;
  resized?.observe(el);
  resized?.observe(seek);
  let items: { x: number; events: ReplayEvent[]; button: HTMLButtonElement; reach: number }[] = [];
  let openItem: (typeof items)[number] | null = null;
  /** A list a mouse opened by pointing stays open when that mouse then clicks; only a list a click opened toggles. */
  let openedByPointing = false;
  let chipTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const px = (name: string, fallback: number) => {
    const value = parseFloat(doc.defaultView?.getComputedStyle(el).getPropertyValue(name) ?? "");
    return Number.isFinite(value) ? value : fallback;
  };
  /** A chip or list over the row, centred on x but ending left of the Seeking chip's place, inside the row. */
  const place = (node: HTMLElement, x: number) => {
    const width = node.offsetWidth;
    const right = el.clientWidth - px("--aw-mark-reserve", 84);
    node.style.left = `${Math.max(0, Math.min(seek.offsetLeft + x - width / 2, right - width))}px`;
  };
  const words = (node: HTMLElement, e: ReplayEvent) => {
    node.replaceChildren();
    const glyph = doc.createElement("span");
    glyph.className = `aw-mark-icon ${e.kind}${e.colony === null ? "" : ` c${e.colony}`}`;
    glyph.innerHTML = glyphMarkup(e.kind);
    const text = doc.createElement("span");
    text.className = "aw-mark-words";
    const [kind, ...rest] = markWords(e);
    const at = rest.pop()!;
    text.append(doc.createTextNode(`${kind} · `));
    if (rest.length) {
      const colony = doc.createElement("span");
      colony.className = `aw-mark-colony c${e.colony}`;
      colony.textContent = rest[0]!;
      text.append(colony, doc.createTextNode(" · "));
    }
    const when = doc.createElement("b");
    when.textContent = at;
    text.append(when);
    node.append(glyph, text);
  };
  const showChip = (e: ReplayEvent, x: number, forMs: number | null) => {
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = null;
    closeList();
    words(chip, e);
    chip.hidden = false;
    place(chip, x);
    if (forMs !== null) chipTimer = setTimeout(hideChip, forMs);
  };
  const hideChip = () => { if (chipTimer) clearTimeout(chipTimer); chipTimer = null; chip.hidden = true; };
  const jump = (e: ReplayEvent, x: number) => {
    recording.seek(e.ms);
    showChip(e, x, LABEL_MS);
  };
  const closeList = (refocus = false) => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    if (!openItem) return;
    openItem.button.setAttribute("aria-expanded", "false");
    if (refocus) openItem.button.focus();
    openItem = null;
    list.hidden = true;
    list.replaceChildren();
  };
  const openList = (item: (typeof items)[number]) => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    if (openItem === item) return;
    closeList();
    hideChip();
    openItem = item;
    openedByPointing = false;
    item.button.setAttribute("aria-expanded", "true");
    for (const e of item.events) {
      const row = doc.createElement("button");
      row.type = "button";
      row.className = "aw-mark-row";
      row.setAttribute("role", "menuitem");
      row.setAttribute("aria-label", markWords(e).join(", "));
      words(row, e);
      row.onclick = () => { const x = item.x; closeList(); item.button.focus(); jump(e, x); };
      list.append(row);
    }
    list.hidden = false;
    place(list, item.x);
  };
  const laterClose = () => { if (closeTimer) clearTimeout(closeTimer); closeTimer = setTimeout(() => closeList(), 200); };
  // Pointing (a mouse, not a touch, whose taps also report entering) opens a group's list and shows a mark's label.
  const mouse = (event: PointerEvent) => event.pointerType === "mouse";
  list.onpointerenter = (event: PointerEvent) => { if (mouse(event) && closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
  list.onpointerleave = (event: PointerEvent) => { if (mouse(event)) laterClose(); };
  list.onkeydown = (event: KeyboardEvent) => { if (event.key === "Escape") closeList(true); };
  const outside = (event: Event) => {
    const target = event.target as Node | null;
    if (openItem && target && !list.contains(target) && !openItem.button.contains(target)) closeList();
  };
  doc.addEventListener?.("pointerdown", outside);
  const layout = () => {
    const duration = recording.duration;
    if (!events || !duration) return;
    if (!dirty && laidOut === events && laidDuration === duration) return;
    dirty = false;
    laidOut = events;
    laidDuration = duration;
    laidThumb = NaN;
    const width = trackWidth = seek.offsetWidth;
    closeList();
    hideChip();
    // The glyph fills 12 of its 16-unit box; the thumb covers a mark (or a group's count) its own half width overlaps.
    const glyphReach = THUMB_INSET + px("--aw-mark-size", 16) * 0.375;
    const countReach = THUMB_INSET + px("--aw-mark-count-width", 19) / 2;
    layer.style.left = `${seek.offsetLeft}px`;
    layer.style.top = `${seek.offsetTop}px`;
    layer.style.width = `${width}px`;
    layer.style.height = `${seek.offsetHeight}px`;
    layer.replaceChildren();
    items = groupMarks(events, duration, width, px("--aw-mark-gap", 18)).map(group => {
      const button = doc.createElement("button");
      button.type = "button";
      button.style.left = `${group.x}px`;
      const first = group.events[0]!;
      if (group.events.length === 1) {
        button.className = `aw-mark ${first.kind}${first.colony === null ? "" : ` c${first.colony}`}`;
        button.setAttribute("aria-label", markWords(first).join(", "));
        button.innerHTML = glyphMarkup(first.kind);
      } else {
        button.className = "aw-mark group";
        button.setAttribute("aria-label", `${group.events.length} marks, ${replayTime(first.ms)} to ${replayTime(group.events.at(-1)!.ms)}`);
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", "false");
        const count = doc.createElement("span");
        count.className = "aw-mark-count";
        count.textContent = String(group.events.length);
        button.append(count);
      }
      const item = { ...group, button, reach: group.events.length === 1 ? glyphReach : countReach };
      if (group.events.length === 1) {
        button.onclick = () => jump(first, group.x);
        button.onpointerenter = (event: PointerEvent) => { if (mouse(event)) showChip(first, group.x, null); };
        button.onpointerleave = (event: PointerEvent) => { if (mouse(event) && !chipTimer) hideChip(); };
        button.onfocus = () => showChip(first, group.x, null);
        button.onblur = () => { if (!chipTimer) hideChip(); };
      } else {
        // A keyboard press (a click with no pointer detail) also moves focus into the list, to its first line.
        button.onclick = (event: MouseEvent) => {
          if (openItem === item && event.detail !== 0 && !openedByPointing) return closeList();
          openList(item);
          openedByPointing = false;
          if (event.detail === 0) (list.children[0] as HTMLElement | undefined)?.focus();
        };
        button.onpointerenter = (event: PointerEvent) => {
          if (!mouse(event)) return;
          const opening = openItem !== item;
          openList(item);
          if (opening) openedByPointing = true;
        };
        button.onpointerleave = (event: PointerEvent) => { if (mouse(event)) laterClose(); };
        button.onkeydown = (event: KeyboardEvent) => { if (event.key === "Escape") closeList(true); };
      }
      layer.append(button);
      return item;
    });
    el.append(layer, chip, list);
  };
  /** As drawn, the marks lie on the track under the thumb: the layer is cut away in the thumb's shape, and a mark the
   * thumb covers takes no pointer, so the thumb stays the target there. Keyboard focus still reaches it. */
  const underThumb = () => {
    const duration = recording.duration;
    if (!duration || !items.length) return;
    const thumb = markX(Number(seek.value), duration, trackWidth);
    if (Math.abs(thumb - laidThumb) < 0.25) return;
    laidThumb = thumb;
    layer.style.setProperty("--aw-thumb-x", `${thumb.toFixed(1)}px`);
    for (const item of items) item.button.classList.toggle("is-covered", Math.abs(item.x - thumb) < item.reach);
  };
  const update = () => {
    const duration = recording.duration;
    speed.disabled = recording.error !== null;
    seek.disabled = duration === null || duration === 0 || recording.error !== null;
    seek.max = String(duration ?? 0);
    if (!interacting) seek.value = String(recording.position);
    preview();
    // Keep this line's height reserved from mount, so discovery and seeking move no other controls.
    const text = recording.error ? "Recording unavailable" : recording.seeking ? "Seeking…" : duration === null
      ? recording.durationError ? "Duration unavailable — playback continues" : "Loading replay duration…" : "";
    if (state.textContent !== text) state.textContent = text;
    el.setAttribute("aria-busy", String(recording.seeking));
    events = recording.events;
    if (events && events.length && !recording.error) { layout(); underThumb(); }
  };
  update();
  return { el, update, close: () => {
    if (chipTimer) clearTimeout(chipTimer);
    if (closeTimer) clearTimeout(closeTimer);
    doc.removeEventListener?.("pointerdown", outside);
    resized?.disconnect();
    el.remove();
  } };
}
