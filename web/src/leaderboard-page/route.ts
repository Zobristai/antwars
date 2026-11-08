export const LEADERBOARD_HREF = "/?page=leaderboard";
const isRoot = (url: URL): boolean => url.pathname === "/" || url.pathname === "/index.html";
const isPage = (url: URL, page: string): boolean => isRoot(url) && url.searchParams.get("page") === page;
export function isLeaderboardPage(url: URL): boolean {
  return isPage(url, "leaderboard");
}
export function isMatchesPage(url: URL): boolean {
  return isPage(url, "matches");
}
/** The bare front page: the landing. Any watch, lobby, replay, recording, capture or page link keeps its page. */
export function isLandingPage(url: URL): boolean {
  const params = url.searchParams;
  return isRoot(url) && !["watch", "lobby", "replay", "recording", "capture", "page"].some(key => params.has(key));
}

/** Keep the existing entry modules off the standalone pages, including their side effects. */
export async function dispatchPage(url: URL, start: {
  leaderboard(): Promise<unknown>;
  matches(): Promise<unknown>;
  landing(): Promise<unknown>;
  spectator(): Promise<unknown>;
}): Promise<void> {
  if (isLeaderboardPage(url)) { await start.leaderboard(); return; }
  if (isMatchesPage(url)) { await start.matches(); return; }
  if (isLandingPage(url)) { await start.landing(); return; }
  await start.spectator();
}
