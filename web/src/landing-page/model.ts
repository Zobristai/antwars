// The front page's hero: what its recording line says, from the stored frame. Pure: no DOM, no requests, no clock.
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { replayDate } from "../replay.ts";
import { keep, utcStamp } from "../ui/format.ts";
import { LANDING_COPY } from "./copy.ts";
import type { HeroFrame } from "./hero/hero.ts";

export interface HeroView {
  /** The recording line: its map, its date and its Replay. */
  readonly recording: { readonly label: string; readonly date: string | null; readonly replay: string };
  /** What the frame shows, for assistive technology; the recording line before it says which match it is. */
  readonly alt: string;
}

/** The recording's calendar date, from its immutable id. */
export const recordedOn = (replayId: string): string | null => {
  const at = replayDate(replayId);
  return at === null ? null : utcStamp(at)?.split(" · ")[0] ?? null;
};

/** The hero names its frame's recording by map and date and links its replay. */
export function heroView(frame: HeroFrame, search: string): HeroView {
  return {
    recording: { label: LANDING_COPY.recorded(frame.map), date: recordedOn(frame.replayId), replay: keep(`/?replay=${encodeURIComponent(frame.replayId)}`, search) },
    alt: LANDING_COPY.heroAlt(COLONY_NAMES[0], COLONY_NAMES[1]),
  };
}
