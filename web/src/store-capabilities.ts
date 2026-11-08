/** The server stamps inert metadata before scripts, so there is no late mount or layout shift.
 * Absent metadata (for example a static recording fixture) never enables unavailable controls.
 * These flags describe configuration, not a store's momentary health.
 */
export function storeFeatureEnabled(doc: Pick<Document, "querySelector">, feature: "lobbies" | "public-matches"): boolean {
  return doc.querySelector(`meta[name="antwar-${feature}"]`)?.getAttribute("content") === "true";
}
