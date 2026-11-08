import { HOUSE_USERNAME } from "../identity/houseOwnership.js";
import { isListedHouse } from "./houseLabels.js";

/**
 * The server-side log of house handles a surface will show as "Unlisted model": each such render is logged server-side
 * with the handle, so it gets fixed in HOUSE_LABELS.
 * No report route: the server logs where it already serves the names a page shows (the leaderboard, /watch/catalog,
 * /watch/queue, /matches and a match stream's start). The pages do not poll, so one served response is one page render.
 * Server-only: the browser never imports this.
 */

/** The owner/handle part of a shown name: a seat's " #n" suffix dropped. */
const handleOf = (name: string): string => name.replace(/ #\d+$/, "");

/** Whether a name is an antwars handle that HOUSE_LABELS does not list. */
export function unlistedHouseHandle(name: string): boolean {
  const handle = handleOf(name);
  return handle.toLowerCase().startsWith(`${HOUSE_USERNAME}/`) && !isListedHouse(handle);
}

/** One warning per distinct unlisted house handle among the names one response serves, naming the surface. */
export function logUnlistedHouse(surface: string, names: Iterable<string | null | undefined>, log: (message: string, detail: object) => void = console.warn): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !unlistedHouseHandle(name)) continue;
    const handle = handleOf(name).toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    log("antwar unlisted house handle", { surface, handle });
  }
}

