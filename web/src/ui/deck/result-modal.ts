// The match result as a modal over the whole screen, shared by the deck and the 2D board: one native
// modal dialog, the page dimmed and inert behind it: the winner in the colony's colour, how it ended, rating changes, the
// decisive moments and the next start. It is named by its headline and described by how it ended, heard as it opens with
// the focus on Close. Close, Escape or a click on the dimmed page closes it, and it stays closed for that match's end: a
// replay seeked back before the end hides it, reaching the end again leaves it closed, and the next match's result opens
// it again, even when that result reads the same (Frame.match).
//
// Overlay exports are read only inside functions: overlays.ts imports both HUDs, which import this module.
import type { Frame } from "../../buffer.ts";
import { colonyNameNote, colonyNamesOf } from "../../../../src/sim/colonyNames.ts";
import { COLONY_INK, h, setAttr, setColonyText, setHidden, setText } from "../dom.ts";
import { userName, rosterHandle } from "../user-link.ts";
import { rowName, agentHandle } from "../../compose.ts";
import { D1_ICON } from "./icons.ts";
import { PAGE_WORDS, resultView, shareHref, type ResultView } from "./model.ts";

const COLONY_CSS = COLONY_INK;

export interface ResultModal {
  /** The dialog, for the page to place at its root. */
  readonly dialog: HTMLDialogElement;
  /** Show the frame's result, or none; null closes it. share is the public link to what plays (source.ts watchUrl), null for none. */
  update(frame: Frame | null, share?: string | null, eligible?: ReadonlySet<string>): void;
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
  const eyebrow = h(doc, "p", "rd-eyebrow", "Match result");
  const hero = h(doc, "div", "rd-hero");
  hero.append(eyebrow, head, how);
  top.append(hero, close);
  const ratings = h(doc, "ul", "d1-ratings"), moments = h(doc, "ol", "d1-moments"), next = h(doc, "p", "d1-result-next");
  // Share on X in the winner-colour button, only where the match has a public link.
  const shareLink = h(doc, "a", "d1-agent-button d1-share", PAGE_WORDS.share);
  shareLink.setAttribute("target", "_blank");
  shareLink.setAttribute("rel", "noopener noreferrer");
  shareLink.hidden = true;
  const standings = h(doc, "section", "rd-standings");
  const columns = h(doc, "div", "rd-columns");
  const playersLabel = h(doc, "span", "rd-label", "Players");
  const ratingLabel = h(doc, "span", "rd-label rd-rating-label", "Rating");
  columns.append(playersLabel, ratingLabel);
  const note = h(doc, "p", "rd-note");
  standings.append(columns, ratings, note);
  const decisive = h(doc, "section", "rd-decisive");
  decisive.append(h(doc, "p", "rd-label", "Decisive moment"), moments);
  const footer = h(doc, "div", "rd-footer");
  footer.append(next, shareLink);
  result.append(top, standings, decisive, footer);
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
  const writeBody = (r: ResultView | null, frame: Frame | null, eligible?: ReadonlySet<string>) => {
    const drawn = frame?.board?.setup.colonyNames;
    const board = frame?.board;
    const keyNow = r ? JSON.stringify([r, drawn ?? null, board?.setup.queens.length, board?.agents.map(agent => [agent.colony, agent.identity?.displayName, rosterHandle(eligible, agent.identity?.displayName)])]) : "";
    if (keyNow === bodyKey) return;
    bodyKey = keyNow;
    setHidden(result, r === null);
    if (!r || !board) return;
    result.style.setProperty("--d1-side", r.winner === null ? "var(--aw-ink-3)" : COLONY_CSS[r.winner]);
    setText(eyebrow, board.setup.queens.length > 2 ? "Free-for-all · Final result" : "Head-to-head · Final result");
    const winnerName = r.winner === null ? (r.headline === "Draw" ? "Match drawn" : r.headline) : colonyNamesOf(board.setup)[r.winner].replace(/ Colony$/, "");
    head.replaceChildren(h(doc, "span", "rd-winner-name", winnerName), ...(r.winner === null ? [] : [" ", h(doc, "span", "rd-outcome", "wins")]));
    head.setAttribute("aria-label", r.headline);
    head.style.color = r.winner === null ? "" : COLONY_CSS[r.winner];
    // The drawn winner's colony class identifies its name.
    head.className = drawn && r.winner !== null ? `d1-result-head c${r.winner}` : "d1-result-head";
    setAttr(head, "title", drawn && r.winner !== null ? colonyNameNote(drawn[r.winner]) : null);
    setText(how, r.how);
    // Read the delayed result's numeric changes directly; never parse display sentences.
    const changes = board.result?.ratingChanges;
    const hasRatings = board.setup.rated === true && changes !== undefined;
    standings.classList.toggle("is-rated", hasRatings);
    setHidden(ratingLabel, !hasRatings);
    setText(note, board.setup.rated === false ? "Unrated match · no rating changes" : !hasRatings ? r.ratings.find(row => row.name === "")?.text ?? "" : "");
    setHidden(note, note.textContent === "");
    ratings.replaceChildren(...board.agents.map((agent, index) => {
      const named = rowName(agent.identity?.displayName ?? agentHandle(index), undefined);
      const li = h(doc, "li", "d1-rating");
      li.style.setProperty("--rd-colony", COLONY_CSS[agent.colony]);
      const identity = h(doc, "div", "rd-identity");
      const colony = h(doc, "span", "rd-colony", colonyNamesOf(board.setup)[agent.colony].replace(/ Colony$/, ""));
      setAttr(colony, "title", drawn ? colonyNameNote(drawn[agent.colony]) : null);
      const name = userName(doc, rosterHandle(eligible, agent.identity?.displayName), named.name, "d1-rating-name");
      const badgeLine = h(doc, "span", "rd-player");
      badgeLine.append(name);
      named.badges.forEach(text => badgeLine.append(" ", h(doc, "span", "d1-tag", text)));
      identity.append(colony, " ", badgeLine);
      li.append(identity);
      if (hasRatings) {
        const change = changes.find(c => c.agent === index);
        const numbers = h(doc, "span", "rd-numbers");
        if (change) {
          const before = Math.round(change.before), after = Math.round(change.after), difference = after - before;
          const signed = `${difference > 0 ? "+" : difference < 0 ? "−" : ""}${Math.abs(difference)}`;
          numbers.append(h(doc, "strong", "rd-after", String(after)), ` (${signed})`);
        }
        li.append(" ", numbers);
      }
      return li;
    }));
    setHidden(ratings, board.agents.length === 0);
    moments.replaceChildren(...r.moments.map(m => {
      const li = h(doc, "li", "d1-moment");
      // The moment in its colony's colour; another colony it names (the queen overrun) in that colony's own.
      const what = h(doc, "span", drawn ? `d1-moment-what c${m.colony}` : "d1-moment-what");
      setColonyText(doc, what, m.what, drawn);
      what.title = m.what;
      what.style.color = COLONY_CSS[m.colony];
      const who = h(doc, "span", "d1-moment-who");
      if (drawn) {
        const name = h(doc, "span", `aw-colony-name c${m.colony}`, m.who.replace(/ Colony$/, ""));
        name.style.color = COLONY_CSS[m.colony];
        setAttr(name, "title", colonyNameNote(m.who));
        who.append(name);
      } else setText(who, m.who.replace(/ Colony$/, ""));
      li.append(h(doc, "span", "d1-when", m.when), what, who);
      return li;
    }));
    setHidden(decisive, r.moments.length === 0);
    setText(next, r.next);
  };

  return {
    dialog,
    update(frame, share = null, eligible) {
      const shown = resultView(frame);
      const href = shareHref(frame, share);
      if (href === null) shareLink.removeAttribute("href");
      else if (shareLink.getAttribute("href") !== href) shareLink.setAttribute("href", href);
      setHidden(shareLink, href === null);
      const end = resultEndKey(frame, shown);
      shownEnd = shown ? end : "";
      const open = shown !== null && end !== closedEnd;
      if (!open && dialog.open) dialog.close();
      writeBody(shown, frame, eligible);
      if (open && !dialog.open && dialog.isConnected) dialog.showModal();
    },
    destroy() {
      for (const off of listeners.splice(0)) off();
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
