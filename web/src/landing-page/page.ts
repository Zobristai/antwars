// The front page: Field guide.
// A hero frame of a stored match under the title and
// subtitle; then the top ten of the Antwars Model Index · 1v1 and the newest five recordings, drawn by the Leaderboard's and
// the Matches page's own cards (pages/leaderboard.ts rankingCard, pages/matches.ts recordingsCard) from those pages' own
// data owners, so a change to either page's card changes this page too; then Bring your agent.
import "../ui/ui.css";
import "../pages/archive.css";
import "./landing.css";
import { AGENT_ADDRESS_LABEL, AGENT_HEADING, buildAgentPanel, mcpAddress } from "../agent.ts";
import { loadLeaderboard } from "../leaderboard.ts";
import { C } from "../leaderboard-page/copy.ts";
import { loadRanking, type RankingView } from "../leaderboard-page/view.ts";
import { createMatchesData, type MatchesView } from "../matches-page/data.ts";
import { rebuild } from "../pages/chrome.ts";
import { rankingCard } from "../pages/leaderboard.ts";
import { CHALLENGE_HREF } from "../pages/model.ts";
import { mountTip, recordingsCard } from "../pages/matches.ts";
import { storeFeatureEnabled } from "../store-capabilities.ts";
import { INSPIRED_BY_URL, PAGE_COPY } from "../story.ts";
import { EMBLEM_SRC, homeLink } from "../ui/deck/brand.ts";
import { h } from "../ui/dom.ts";
import { PAGES, keep } from "../ui/format.ts";
import { PAGE_WORDS } from "../ui/pages.ts";
import { LANDING_COPY } from "./copy.ts";
import { HERO, type HeroCrop } from "./hero/hero.ts";
import { heroView } from "./model.ts";

/** The phone form's width (landing.css), where the hero takes its portrait crop. */
const PHONE = "(max-width: 719px)";
/** The rows each card shows: the top ten, the newest five. */
export const RANKING_ROWS = 10;
export const RECORDING_ROWS = 5;
/** The full Leaderboard on the table this page previews; the Leaderboard reads the mode from the link. */
export const RANKINGS_HREF = "/?page=leaderboard&mode=house-1v1";
export const MATCHES_HREF = "/?page=matches";
/** The bare front page's own ranking: the Antwars Model Index at 1v1, under the Leaderboard's own table id. */
const RANKING = { title: `${C.houseModeTitle} · 1v1`, id: "aw-house-mode-ranking" } as const;

/** A crop's files as a srcset, each by its width. */
const srcset = (crop: HeroCrop) => crop.files.map(file => `${file.src} ${file.width}w`).join(", ");

/** Mounts the front page into its own scroll host and loads its data; returns its teardown. */
export function mountLandingPage(doc: Document, win: Window, options: { request?: typeof fetch } = {}): () => void {
  const request = options.request ?? win.fetch.bind(win);
  const search = win.location.search;
  const link = (cls: string, text: string, href: string) => { const a = h(doc, "a", cls, text); a.href = href; return a; };
  const newTab = (a: HTMLAnchorElement, rel: string) => { a.target = "_blank"; a.rel = rel; return a; };
  /** The text as nodes, each occurrence of phrase held on one line (.fg-keep); the text itself is unchanged. */
  const keepTogether = (text: string, phrase: string) =>
    text.split(phrase).flatMap((part, index) => (index === 0 ? [part] : [h(doc, "span", "fg-keep", phrase), part]));

  const host = h(doc, "div", "aw-page-host");
  host.id = "aw-landing-page";
  const waiting = doc.getElementById("aw-waiting"), wasHidden = waiting?.hidden;
  if (waiting) waiting.hidden = true;
  // The front page's own tab title; the live viewer (/?watch=1) keeps index.html's "Antwars — live".
  const oldTitle = doc.title; doc.title = "Antwars";
  // The Archive pages' root (archive.css .d1p) holds the cards' tokens and rules; .fg places this page's own parts.
  const root = h(doc, "main", "d1p fg");
  const inner = h(doc, "div", "fg-inner");

  // ---------------------------------------------------------------- the mast: emblem and wordmark, the pages
  const mast = h(doc, "header", "fg-mast");
  const nav = h(doc, "nav", "d2-nav fg-nav");
  nav.setAttribute("aria-label", PAGE_COPY.name);
  for (const [, label, href] of PAGES) nav.append(link("d2-nav-link", label, keep(href, search)));
  const brand = h(doc, "p", "fg-brand");
  const emblem = h(doc, "img", "fg-emblem");
  emblem.src = EMBLEM_SRC; emblem.alt = ""; emblem.setAttribute("aria-hidden", "true"); emblem.width = 36; emblem.height = 28;
  // The emblem and the wordmark link home, as on every other page (ui/deck/brand.ts); the credit stays plain text.
  const home = homeLink(doc, "fg-home");
  home.append(emblem, h(doc, "span", "d2-wordmark", PAGE_COPY.name));
  brand.append(home, h(doc, "span", "d2-credit", PAGE_COPY.credit));
  mast.append(brand, nav);

  // ---------------------------------------------------------------- the hero: The words over one frame of a match
  // Focus order: the title (focused on load), Watch any match, Rankings, Replay. The frame comes last, so the recording
  // line is read before what the frame shows.
  const hero = h(doc, "section", "fg-hero");
  hero.setAttribute("aria-labelledby", "fg-title");
  const shown = heroView(HERO, search);
  const words = h(doc, "div", "fg-hero-body");
  const title = h(doc, "h1", "fg-title", LANDING_COPY.proposition);
  title.id = "fg-title"; title.tabIndex = -1;
  const lede = h(doc, "p", "fg-lede");
  lede.append(...keepTogether(LANDING_COPY.lede, LANDING_COPY.ledeKeep));
  const actions = h(doc, "div", "fg-hero-actions");
  // The quiet link underlines its word, not its arrow, which assistive technology does not read.
  const quiet = link("d2-link fg-quiet", "", keep(RANKINGS_HREF, search));
  const arrow = h(doc, "span", "fg-arrow", "→");
  arrow.setAttribute("aria-hidden", "true");
  quiet.append(h(doc, "span", "fg-quiet-word", LANDING_COPY.rankings), arrow);
  actions.append(link("d1-agent-button", LANDING_COPY.watchAny, keep("/?watch=1", search)), quiet);
  // The challenge bubble: the site's cyan button (deck.css .d1-agent-button), linking to the Leaderboard's
  // Antwars Model Index 1v1 board as the Waiting card does. Only where the server has the public leaderboard, which that
  // board belongs to.
  const ranked = storeFeatureEnabled(doc, "public-matches");
  if (ranked) {
    const bubble = link("d1-agent-button", C.challengeNew, keep(CHALLENGE_HREF, search));
    bubble.dataset.key = "challenge-new";
    actions.append(bubble);
  }
  const recording = h(doc, "p", "fg-recording");
  recording.append(h(doc, "strong", "fg-recording-label", shown.recording.label));
  if (shown.recording.date) recording.append(h(doc, "span", undefined, ` · ${shown.recording.date}`));
  // Its Replay is the same cyan row button the Recordings card's Replay is (matches.ts rowPill).
  recording.append(h(doc, "span", undefined, " · "), link("d1-agent-button d1p-row-pill", LANDING_COPY.replay, shown.recording.replay));
  words.append(title, lede, actions, recording);
  // The phone takes the portrait crop; every other width the desktop crop, each in the size the screen needs. The source
  // and the image join the picture before either names a file, so a phone never starts the desktop crop's download.
  const art = h(doc, "picture", "fg-hero-art"), portrait = h(doc, "source"), frame = h(doc, "img");
  art.append(portrait, frame);
  portrait.media = PHONE; portrait.sizes = "(min-width: 390px) 100vw, 390px"; portrait.srcset = srcset(HERO.phone);
  portrait.width = HERO.phone.width; portrait.height = HERO.phone.height;
  frame.width = HERO.desktop.width; frame.height = HERO.desktop.height; frame.alt = shown.alt; frame.decoding = "async";
  frame.setAttribute("fetchpriority", "high");
  frame.sizes = "(min-width: 1440px) 100vw, 1440px"; frame.srcset = srcset(HERO.desktop); frame.src = HERO.desktop.files[0]!.src;
  hero.append(words, art);

  // ---------------------------------------------------------------- the Leaderboard's and Matches' own cards
  const records = h(doc, "div", "fg-records");
  const tip = mountTip(doc, host, root);
  // Each card's foot link to its page in the site's cyan button.
  const rankingsFoot = link("d1-agent-button", C.title, keep(RANKINGS_HREF, search));
  const matchesFoot = link("d1-agent-button", PAGE_WORDS.matchesTitle, keep(MATCHES_HREF, search));

  // ---------------------------------------------------------------- Bring your agent: today's address row and Copy
  // Its own section heading over one of the pages' record cards, as designed.
  const agent = h(doc, "section", "fg-section fg-agent"), agentTitle = h(doc, "h2", "fg-section-title", AGENT_HEADING);
  agentTitle.id = "fg-agent-title";
  agent.setAttribute("aria-labelledby", agentTitle.id);
  const agentCard = h(doc, "div", "d1p-card");
  const field = h(doc, "div", "fg-agent-field");
  const addressLabel = h(doc, "p", "fg-agent-label", AGENT_ADDRESS_LABEL);
  addressLabel.id = "fg-address-label";
  const address = buildAgentPanel(doc, mcpAddress(win.location.origin), win.navigator?.clipboard).querySelector<HTMLElement>(".aw-byoa-address")!;
  address.setAttribute("role", "group"); address.setAttribute("aria-labelledby", addressLabel.id);
  address.querySelector(".aw-byoa-note")?.setAttribute("role", "status");
  field.append(addressLabel, address);
  agentCard.append(field);
  agent.append(agentTitle, agentCard);

  // ---------------------------------------------------------------- the pages' footer
  const foot = h(doc, "footer", "fg-foot");
  foot.append(h(doc, "span", "d2-credit", PAGE_COPY.credit), newTab(link("d2-link", LANDING_COPY.rules, "/rules"), "noopener"),
    newTab(link("d2-link", LANDING_COPY.inspired, INSPIRED_BY_URL), "noopener noreferrer"));

  inner.append(mast, hero, records, agent, foot);
  root.append(inner);
  host.append(root);
  doc.body.append(host);
  // Reading starts at the title on a fresh load; focus the visitor has already moved is never taken.
  queueMicrotask(() => {
    if (root.isConnected && (!doc.activeElement || doc.activeElement === doc.body)) title.focus({ preventScroll: true });
  });

  // ---------------------------------------------------------------- data: the Leaderboard's and Matches' own owners
  // As the Leaderboard page does: where the server has no public leaderboard, nothing is asked for and no Index card is drawn.
  let ranking: RankingView = { ...RANKING, status: "loading", rows: [], next: undefined };
  let matches: MatchesView | undefined;
  let drawn = "", closed = false;
  const draw = () => {
    if (closed) return;
    const next = JSON.stringify([ranking, matches?.recordings, matches?.next]);
    if (next === drawn) return;
    drawn = next;
    rebuild(doc, records, () => [
      ...(ranked ? [rankingCard(doc, ranking, "house-1v1", { search, limit: RANKING_ROWS, foot: rankingsFoot })] : []),
      ...(matches ? [recordingsCard(doc, matches, { search, tip, limit: RECORDING_ROWS, foot: matchesFoot })] : []),
    ]);
    tip.settle();
  };
  const loaded = ranked ? loadRanking({ ...RANKING, load: (cursor, signal) => loadLeaderboard(cursor, signal, request, { mode: "house-1v1" }) },
    view => { ranking = view; draw(); }) : undefined;
  const data = createMatchesData(request, view => { matches = view; draw(); });
  matches = data.view;
  data.refresh();
  draw();

  function destroy() {
    if (closed) return;
    closed = true;
    loaded?.destroy(); data.destroy(); tip.destroy(); host.remove(); doc.title = oldTitle;
    if (waiting && wasHidden !== undefined) waiting.hidden = wasHidden;
    win.removeEventListener("pagehide", destroy);
  }
  win.addEventListener("pagehide", destroy, { once: true });
  return destroy;
}
