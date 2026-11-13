// The match result as a modal over the whole screen, shared by the deck and the 2D board: one native
// modal dialog, the page dimmed and inert behind it: the winner in the colony's colour, how it ended, rating changes, the
// decisive moments and the next start. It is named by its headline and described by how it ended, heard as it opens with
// the focus on Close. Close, Escape or a click on the dimmed page closes it, and it stays closed for that match's end: a
// replay seeked back before the end hides it, reaching the end again leaves it closed, and the next match's result opens
// it again, even when that result reads the same (Frame.match).
//
// Overlay exports are read only inside functions: overlays.ts imports both HUDs, which import this module.
import type { Frame } from "../../buffer.ts";
import { colonyNameNote, type ColonyNamePair } from "../../../../src/sim/colonyNames.ts";
import { COLONY_INK, h, setAttr, setColonyText, setHidden, setText } from "../dom.ts";
import { D1_ICON } from "./icons.ts";
import { PAGE_WORDS, resultView, shareHref, type ResultView } from "./model.ts";

const COLONY_CSS = COLONY_INK;

export interface ResultModal {
  /** The dialog, for the page to place at its root. */
  readonly dialog: HTMLDialogElement;
  /** Show the frame's result, or none; null closes it. share is the public link to what plays (source.ts watchUrl), null for none. */
  update(frame: Frame | null, share?: string | null): void;
  destroy(): void;
}

/**
 * The end a frame shows, as the key the viewer's Close holds: the match (Frame.match, Playback's count of distinct
 * matches, so a reconnect keeps it and another match changes it) and the end itself, never playback.
 */
export function resultEndKey(frame: Frame | null, shown: ResultView | null): string {
  const end = frame?.board?.result ?? null;
  return shown && end ? JSON.stringify([frame!.match, end.tick, end.winner, end.reason, shown.headline, shown.how, shown.ratings]) : "";
}

export function mountResultModal(doc: Document): ResultModal {
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: (e: Event) => void) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const dialog = h(doc, "dialog", "d1-dialog d1-result-dialog");
  const result = h(doc, "div", "d1-result");
  result.hidden = true;
  const head = h(doc, "p", "d1-result-head"), how = h(doc, "p", "d1-result-how");
  head.id = "d1-result-head";
  how.id = "d1-result-how";
  dialog.setAttribute("aria-labelledby", head.id);
  dialog.setAttribute("aria-describedby", how.id);
  const close = h(doc, "button", "d1-close");
  close.type = "button";
  close.setAttribute("aria-label", PAGE_WORDS.close);
  close.innerHTML = D1_ICON.close;
  const top = h(doc, "div", "d1-result-top");
  top.append(head, close);
  const ratings = h(doc, "ul", "d1-ratings"), moments = h(doc, "ol", "d1-moments"), next = h(doc, "p", "d1-result-next");
  // Share on X: the post intent in a new tab, only where the match has a public link, in the site's cyan button
  // (deck.css .d1-agent-button).
  const shareLink = h(doc, "a", "d1-agent-button d1-share", PAGE_WORDS.share);
  shareLink.setAttribute("target", "_blank");
  shareLink.setAttribute("rel", "noopener noreferrer");
  shareLink.hidden = true;
  result.append(top, how, ratings, moments, next, shareLink);
  dialog.append(result);

  /** The match's end now shown, and the one the viewer closed: keys over the end itself, not over playback. */
  let shownEnd = "", closedEnd = "";
  const dismiss = () => {
    closedEnd = shownEnd;
    if (dialog.open) dialog.close();
  };
  listen(close, "click", dismiss);
  // Escape is the dialog's own cancel, alongside the visible Close, and closes it the same way.
  listen(dialog, "cancel", e => { e.preventDefault(); dismiss(); });
  // A click on the dimmed page lands on the dialog itself, outside its body.
  listen(dialog, "click", e => { if (e.target === dialog) dismiss(); });

  let bodyKey = "";
  /**
   * drawn: the match's drawn colony names (unrated), else undefined. A drawn name is shown in its colony's colour with
   * its one-line source as its tooltip wherever the result names it; the rated names are shown as they always were.
   */
  const writeBody = (r: ResultView | null, drawn: ColonyNamePair | undefined) => {
    const keyNow = r ? JSON.stringify([r, drawn ?? null]) : "";
    if (keyNow === bodyKey) return;
    bodyKey = keyNow;
    setHidden(result, r === null);
    if (!r) return;
    result.style.setProperty("--d1-side", r.winner === null ? "var(--aw-ink-3)" : COLONY_CSS[r.winner]);
    setText(head, r.headline);
    head.style.color = r.winner === null ? "" : COLONY_CSS[r.winner];
    setAttr(head, "title", drawn && r.winner !== null ? colonyNameNote(drawn[r.winner]) : null);
    setText(how, r.how);
    // Each player's shown name, its level and Fast badges as the Leaderboard shows them, then the change.
    ratings.replaceChildren(...r.ratings.map(row => {
      if (row.name === "") return h(doc, "li", undefined, row.text);
      // Spaces between the parts keep the line's text whole for assistive technology; the flex gap spaces it on screen.
      const li = h(doc, "li", "d1-rating");
      li.append(h(doc, "span", "d1-rating-name", row.name), " ");
      if (row.badges.length > 0) {
        const tags = h(doc, "span", "d1-tags");
        row.badges.forEach((text, i) => tags.append(...(i > 0 ? [" "] : []), h(doc, "span", "d1-tag", text)));
        li.append(tags, " ");
      }
      li.append(h(doc, "span", "d1-rating-change", `· ${row.text}`));
      return li;
    }));
    setHidden(ratings, r.ratings.length === 0);
    moments.replaceChildren(...r.moments.map(m => {
      const li = h(doc, "li", "d1-moment");
      // The moment in its colony's colour; another colony it names (the queen overrun) in that colony's own.
      const what = h(doc, "span", "d1-moment-what");
      setColonyText(doc, what, m.what, drawn);
      what.style.color = COLONY_CSS[m.colony];
      const who = h(doc, "span", "d1-moment-who");
      setColonyText(doc, who, `· ${m.who}`, drawn);
      li.append(h(doc, "span", "d1-when", m.when), what, who);
      return li;
    }));
    setHidden(moments, r.moments.length === 0);
    setText(next, r.next);
  };

  return {
    dialog,
    update(frame, share = null) {
      const shown = resultView(frame);
      const href = shareHref(frame, share);
      if (href === null) shareLink.removeAttribute("href");
      else if (shareLink.getAttribute("href") !== href) shareLink.setAttribute("href", href);
      setHidden(shareLink, href === null);
      const end = resultEndKey(frame, shown);
      shownEnd = shown ? end : "";
      const open = shown !== null && end !== closedEnd;
      if (!open && dialog.open) dialog.close();
      writeBody(shown, frame?.board?.setup.colonyNames);
      if (open && !dialog.open && dialog.isConnected) dialog.showModal();
    },
    destroy() {
      for (const off of listeners.splice(0)) off();
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
