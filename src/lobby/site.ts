/**
 * The public site every lobby link points at: private invite links and
 * locate_match's spectatorUrl use it whichever host was called. antwars.ai serves the
 * entry service, which relays a match's /watch routes to whichever slot plays it.
 */
export const SITE_ORIGIN = "https://antwars.ai";

/** The public wait stream for a waiting token (src/accounts/waitStream.ts). */
export function waitStreamUrl(token: string): string {
  return `${SITE_ORIGIN}/wait/${token}`;
}

/** The site page that shows a lobby's match. */
export function lobbyPageUrl(lobbyId: string): string {
  return `${SITE_ORIGIN}/?lobby=${lobbyId}`;
}
