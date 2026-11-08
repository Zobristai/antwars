/**
 * The waiting panel: web/index.html
 * shows it from load, so a spectator who arrives before the delayed stream's
 * first release, or between matches, sees why nothing is drawn yet. It is
 * hidden once the first frame of the match draws. Only the wordmark and Connecting… are shown until that first frame.
 * Stream state and delay disclosure belong to the loaded page, not developer setup.
 */
import type { LinkState } from "./stream.ts";

export const WAITING_COPY: Record<LinkState, string> = { connecting: "Connecting…", open: "Connecting…", reconnecting: "Connecting…" };
/** The line while a lobby link's match has started but its delayed stream has released nothing yet. */
export const STARTING_COPY = "Live match starting";

/** Says the live match is starting in the panel's state line, until the source opens and the page takes the line over. */
export function liveStarting(doc: Pick<Document, "querySelector">): void {
  const line = doc.querySelector(".aw-wait-state");
  if (line) line.textContent = STARTING_COPY;
}

export class Waiting {
  private shown = "";

  constructor(
    private readonly el: Pick<HTMLElement, "hidden"> | null,
    private readonly line: Pick<HTMLElement, "textContent"> | null = null,
  ) {}

  /** The live stream's state, for the line under the heading; a recording never calls it. */
  state(s: LinkState): void {
    const text = WAITING_COPY[s];
    if (!this.line || text === this.shown) return;
    this.shown = text;
    this.line.textContent = text;
  }

  /** Call after each rendered frame; drew is whether playback had anything to draw. */
  frame(drew: boolean): void {
    if (this.el) this.el.hidden = drew;
  }
}
