/** The server stamps inert metadata before scripts, so there is no late mount or layout shift.
 * Absent metadata (for example a static recording fixture) never enables unavailable controls.
 * These flags describe configuration, not a store's momentary health. local-match marks the local held match
 * (README's "Run it locally"), which has no lobby or catalog entry.
 */
export function storeFeatureEnabled(doc: Pick<Document, "querySelector">, feature: "lobbies" | "public-matches" | "local-match"): boolean {
  return doc.querySelector(`meta[name="antwar-${feature}"]`)?.getAttribute("content") === "true";
}
