/**
 * Which board the page starts, and what it shows when no board can start.
 *
 * - The public page defaults to 3D; ?board=3d also selects it. It needs WebGL2: without it
 *   the page starts the 2D board instead and says nothing (2D runs on WebGL1 too).
 * - ?board=2d explicitly selects 2D. If 3D fails to start, later fails, or runs too slowly
 *   (web/src/board3d/quality.ts), the page reloads with board=2d, keeping the match and other
 *   parameters. A 2D view never retries 3D automatically; its Try 3D link is an explicit choice.
 *   Failed module loading gets one fresh-document retry before fallback (3d-recovery.ts).
 * - When the browser has no usable WebGL at all (Pixi's own check, the one it selects a renderer
 *   with), no board starts: the page says the game view needs WebGL in place of the blank board,
 *   logs nothing, and the client's ready promise rejects with that reason (no error with WebGL off). If a board fails to start for another reason, the error is logged
 *   and ready rejects, as before. A board that started is never replaced.
 */
import { clear3dRetryUrl } from "./3d-recovery.ts";
import { PAGE_COPY } from "./story.ts";

export type BoardMode = "2d" | "3d";

/** Both live and labelled replay default to 3D; only an explicit board=2d selects 2D. */
export function boardMode(params: URLSearchParams): BoardMode {
  return params.get("board") === "2d" ? "2d" : "3d";
}

/** Whether a WebGL2 context can be made here. The test context is released at once. */
export function hasWebGL2(doc: Pick<Document, "createElement">): boolean {
  try {
    const gl = doc.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export interface Starters {
  /** WebGL2 available (hasWebGL2); asked only for the 3D board. */
  probe2(): boolean;
  start3d(): Promise<void>;
  start2d(): Promise<void>;
  /** Any WebGL available (Pixi's isWebGLSupported); asked before the 2D board starts. */
  webglSupported(): boolean;
  /** Put the needs-WebGL message on the page. */
  show(): void;
  log(e: unknown): void;
  /** Reject the client's ready promise. */
  reject(e: unknown): void;
  /** Reload the page as the 2D board (fallbackUrl). */
  fallback2d(): void;
}

/**
 * Start the board the mode asks for, falling back to 2D without WebGL2. If the 3D board fails
 * to start, the page reloads as the 2D board, with no message. With no WebGL at all, no board
 * starts: say so and reject, logging nothing. If the 2D board fails otherwise, log and reject.
 */
export async function runBoard(mode: BoardMode, s: Starters): Promise<void> {
  if (mode === "3d" && s.probe2()) {
    try {
      await s.start3d();
    } catch (e) {
      s.log(e);
      s.fallback2d();
    }
    return;
  }
  if (!s.webglSupported()) {
    s.show();
    s.reject(new Error(NEEDS_WEBGL_HEADING));
    return;
  }
  try {
    await s.start2d();
  } catch (e) {
    s.log(e);
    s.reject(e);
  }
}

/** Explicitly select 2D, preserving all other parameters and the fragment; applying twice changes nothing. */
export function fallbackUrl(href: string): string {
  const url = new URL(clear3dRetryUrl(href));
  url.searchParams.set("board", "2d");
  return url.toString();
}

export const NEEDS_WEBGL_HEADING = "The game view needs WebGL";
/** A fact, not instructions. */
export const NEEDS_WEBGL_TEXT = "WebGL is off or not supported in this browser.";

/** Replace the blank board and the waiting panel with the needs-WebGL message. */
export function showNeedsWebGL(doc: Document): void {
  for (const c of doc.querySelectorAll("canvas")) c.remove();
  let panel = doc.getElementById("aw-waiting");
  if (!panel) {
    panel = doc.createElement("div");
    panel.id = "aw-waiting";
    panel.className = "aw-waiting";
    doc.body.append(panel);
  }
  const heading = doc.createElement("p");
  heading.className = "aw-heading";
  heading.textContent = NEEDS_WEBGL_HEADING;
  const text = doc.createElement("p");
  text.textContent = NEEDS_WEBGL_TEXT;
  panel.replaceChildren(heading, text);
  panel.setAttribute("role", "alert");
  panel.dataset.needsWebgl = "1";
  panel.hidden = false;
}

/**
 * With no board and no HUD (the match or recording could not be opened: an error, or no stored matches), the
 * needs-WebGL panel is the whole page, so it gets the way home: a link to the landing at / with no query, styled
 * as the panel's Back to live link (replay.ts noStoredReplays).
 */
export function linkNeedsWebGLHome(doc: Document): void {
  const panel = doc.getElementById("aw-waiting");
  if (!panel || panel.querySelector(".aw-board-home")) return;
  const home = doc.createElement("a");
  home.className = "aw-board-home";
  home.href = "/";
  home.textContent = PAGE_COPY.home;
  home.style.cssText = "display:inline-flex;align-items:center;min-width:44px;min-height:44px";
  const line = doc.createElement("p");
  line.append(home);
  panel.append(line);
  panel.hidden = false;
}
