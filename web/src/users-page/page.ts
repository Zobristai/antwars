import { mountFrame, rebuild } from "../pages/chrome.ts";
import { usersRoster } from "../pages/users.ts";
import { loadedText } from "../pages/model.ts";
import { h } from "../ui/dom.ts";
import { pill } from "../ui/pages.ts";
import { userHref } from "../ui/user-link.ts";
import type { Collection } from "../matches-page/data.ts";
import { usersResponse, type PublicUser } from "./data.ts";

export function mountUsersPage(doc: Document, win: Window, request = win.fetch.bind(win)) {
  const host = h(doc, "div", "aw-page-host"); doc.body.append(host);
  const waiting = doc.getElementById("aw-waiting"), wasHidden = waiting?.hidden;
  if (waiting) waiting.hidden = true;
  const oldTitle = doc.title; doc.title = "Users — Antwars";
  const frame = mountFrame(doc, host, "users");
  const band = h(doc, "div", "d1p-summary"), title = h(doc, "h1", "d1p-title", "Users"); title.id = "roster-title";
  const fresh = h(doc, "div", "d1p-fresh"), loaded = h(doc, "p", "d1p-loaded"), refresh = pill(doc, "Refresh"); refresh.classList.add("d1p-refresh");
  fresh.append(refresh, loaded); band.append(title, fresh); frame.band.append(band);
  let data: Collection<PublicUser> = { status: "loading", rows: [] }, pending: AbortController | undefined;
  const requested = () => new URLSearchParams(win.location.search).get("user");
  const roster = usersRoster(doc, win.location.search, name => {
    const previous = requested(); win.history.pushState(null, "", name ? userHref(name)! : "/?page=users");
    draw(); if (name) reveal(); else if (previous) frame.content.querySelector<HTMLElement>(`[data-key="${CSS.escape(`user|${previous}`)}"]`)?.focus();
  });
  function reveal() {
    const link = frame.content.querySelector<HTMLElement>(".users-open .users-entry");
    link?.focus({ preventScroll: true }); link?.scrollIntoView({ block: "center" });
  }
  // Measure the full text in the active font. A narrower viewport, browser text setting or font
  // swap can change whether the full label fits; restore it as soon as space allows.
  function fitState() {
    const line = frame.content.querySelector<HTMLElement>(".users-fit-state"), words = line?.lastElementChild;
    if (!line || !words) return;
    words.textContent = line.dataset.full!;
    if (words.scrollWidth > words.clientWidth) words.textContent = line.dataset.short!;
  }
  const size = new ResizeObserver(fitState); size.observe(frame.content);
  doc.fonts.addEventListener("loadingdone", fitState);
  function draw() {
    refresh.disabled = data.status === "loading";
    rebuild(doc, frame.content, () => [roster(data, requested(), draw)]); fitState();
  }
  async function load() {
    pending?.abort(); const controller = pending = new AbortController();
    data = { status: "loading", rows: [] }; loaded.textContent = ""; draw();
    try {
      const res = await request("/matches/users", { signal: controller.signal });
      if (!res.ok) throw Error("Users unavailable");
      const { users } = usersResponse.parse(await res.json());
      if (controller.signal.aborted) return;
      data = { status: "ready", rows: users }; loaded.textContent = loadedText(Date.now());
    } catch { if (controller.signal.aborted) return; data = { status: "error", rows: [] }; }
    draw(); if (requested()) reveal();
  }
  const pop = () => { draw(); reveal(); };
  function destroy() {
    size.disconnect(); doc.fonts.removeEventListener("loadingdone", fitState);
    pending?.abort(); frame.destroy(); host.remove(); doc.title = oldTitle;
    if (waiting && wasHidden !== undefined) waiting.hidden = wasHidden;
    win.removeEventListener("popstate", pop); win.removeEventListener("pagehide", destroy);
  }
  refresh.addEventListener("click", () => { void load(); }); win.addEventListener("popstate", pop);
  win.addEventListener("pagehide", destroy, { once: true }); void load(); return destroy;
}
