import { describe, expect, it } from "vitest";
import { createFirestore } from "../../src/store/firestore.ts";

/** A Google-hosted Store (no emulator) against a fake metadata server and Firestore API. */
function fakeFirestore() {
  let tokenRequests = 0;
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal") {
      tokenRequests++;
      return Response.json({ access_token: "fake-firestore-token", expires_in: 3599 });
    }
    if (url.pathname.endsWith(":runQuery")) return Response.json([{ readTime: "2026-11-03T00:00:00Z" }]);
    if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "fake-transaction" });
    if (url.pathname.endsWith(":rollback")) return Response.json({});
    return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
  };
  const store = createFirestore({ projectId: "fake-project", namespace: "token-test", request });
  return { store, tokenRequests: () => tokenRequests };
}

describe("Firestore store metadata token acquisition", () => {
  it("reuses one metadata token across operations within its lifetime", async () => {
    const { store, tokenRequests } = fakeFirestore();
    expect(tokenRequests()).toBe(0);
    await store.get("games/one");
    await store.get("games/two");
    await store.query("games", { orderBy: "startedAt", direction: "DESCENDING", limit: 1 });
    await store.transaction(async () => ({ result: undefined, writes: [] }));
    expect(tokenRequests()).toBe(1);
  });
});
