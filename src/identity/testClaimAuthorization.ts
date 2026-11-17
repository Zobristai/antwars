/** Server-selected username identity IDs, never names or caller-supplied claims. */
export function testClaimOwnerIdsFromEnv(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const value = env.ANTWARS_TEST_CLAIM_OWNER_IDS;
  if (value === undefined || value.trim() === "") return [];
  const ids = value.split(",").map(id => id.trim().toLowerCase());
  if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) {
    // Configuration can contain private account identifiers: never echo it.
    throw new Error("invalid ANTWARS_TEST_CLAIM_OWNER_IDS: use comma-separated username identity UUIDs");
  }
  return [...new Set(ids)];
}
