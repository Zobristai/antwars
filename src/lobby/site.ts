/**
 * The public site every lobby link points at: private invite links and
 * locate_match's spectatorUrl use it whichever host was called. antwars.ai serves the
 * entry service, which relays a match's /watch routes to whichever slot plays it.
 */
export const SITE_ORIGIN = "https://antwars.ai";

/** The site page that shows a lobby's match. */
export function lobbyPageUrl(lobbyId: string): string {
  return `${SITE_ORIGIN}/?lobby=${lobbyId}`;
}
