import { PLAYBACK_RATES, type PlaybackRate, type Recording } from "./recording.ts";

export function replayTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Native range/select controls provide keyboard, pointer and touch behavior without a custom drag handler.
 * The caller mounts only for explicit replays, never the live page's stand-in recording; the HUD places `el` (HudHost.replay). */
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
  };
  update();
  return { el, update, close: () => el.remove() };
}
