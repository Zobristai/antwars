import { describe, expect, it } from "vitest";
import { firestoreFromEnv } from "../../src/store/firestore.ts";

/**
 * Characterization of the environment-selected store. Every request is
 * recorded with its URL and bearer; Firestore answers NOT_FOUND, so a get() makes
 * exactly one store request (plus a metadata token request on the Google path).
 */
function recordingFetch() {
  const calls: { url: string; authorization: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (new URL(url).hostname === "metadata.google.internal") return Response.json({ access_token: "metadata-token", expires_in: 3599 });
    return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
  };
  return { request, calls };
}

async function storeRequests(env: Record<string, string | undefined>) {
  const { request, calls } = recordingFetch();
  const store = firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: "env-test", ...env }, request);
  expect(store?.namespace).toBe("env-test");
  expect(await store!.get("games/one")).toBeNull();
  return calls;
}

/** The refusal's message for a store selected from env; it happens before any request. */
function refusalOf(env: Record<string, string>): string {
  const { request, calls } = recordingFetch();
  let refusal: unknown;
  try { firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: "env-test", ...env }, request); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(Error);
  expect(calls).toEqual([]);
  return (refusal as Error).message;
}

const documentPath = (projectId: string) => `/v1/projects/${projectId}/databases/(default)/documents/namespaces/env-test/games/one`;

describe("firestoreFromEnv with FIRESTORE_EMULATOR_HOST set", () => {
  it("sends every request to the emulator over plain HTTP with bearer owner and no metadata token", async () => {
    const calls = await storeRequests({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", GCLOUD_PROJECT: "demo-antwar" });
    expect(calls).toEqual([{ url: `http://127.0.0.1:8080${documentPath("demo-antwar")}`, authorization: "Bearer owner" }]);
  });

  it("refuses a namespace with no project, before any request, instead of reaching a default project", () => {
    expect(refusalOf({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }))
      .toBe("ANTWAR_STORE_NAMESPACE=env-test refused: missing GCLOUD_PROJECT, the Google Cloud project of the shared store");
  });

  for (const host of ["127.0.0.1:8080", "localhost:8080", "[::1]:8080"]) {
    it(`accepts the loopback host ${host} outside Cloud Run`, async () => {
      const calls = await storeRequests({ FIRESTORE_EMULATOR_HOST: host, GCLOUD_PROJECT: "demo-antwar" });
      expect(calls).toEqual([{ url: `http://${host}${documentPath("demo-antwar")}`, authorization: "Bearer owner" }]);
    });
  }
});

describe("firestoreFromEnv refuses the emulator outside local dev and test runs", () => {
  /** The refusal's message; refusal happens at selection, before any request. */
  const select = (env: Record<string, string>): string => {
    const { request, calls } = recordingFetch();
    let refusal: unknown;
    try { firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: "env-test", ...env }, request); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
    return (refusal as Error).message;
  };

  it("refuses a non-loopback host without K_SERVICE", () => {
    expect(select({ FIRESTORE_EMULATOR_HOST: "emulator.example.com:8080" }))
      .toBe("FIRESTORE_EMULATOR_HOST=emulator.example.com:8080 refused: the emulator must be a loopback host:port (127.0.0.1, localhost or [::1])");
  });

  for (const host of ["127.0.0.1", "localhost", "10.0.0.5:8080", "127.0.0.1:8080/x", "localhost.example.com:8080"]) {
    it(`refuses ${host}, which is not a loopback host:port`, () => {
      expect(select({ FIRESTORE_EMULATOR_HOST: host })).toMatch(/^FIRESTORE_EMULATOR_HOST=.* refused: the emulator must be a loopback host:port/);
    });
  }

  it("refuses a loopback host when K_SERVICE marks a Cloud Run service", () => {
    expect(select({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", K_SERVICE: "antwar-public-0" }))
      .toBe("FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 refused: the emulator is for local dev and test runs, and K_SERVICE=antwar-public-0 means this is Cloud Run");
  });

  it("leaves Google-hosted Firestore on Cloud Run unchanged", async () => {
    const calls = await storeRequests({ K_SERVICE: "antwar-public-0", GCLOUD_PROJECT: "demo-antwar" });
    expect(calls.at(-1)).toEqual({ url: `https://firestore.googleapis.com${documentPath("demo-antwar")}`, authorization: "Bearer metadata-token" });
  });
});

describe("firestoreFromEnv with FIRESTORE_EMULATOR_HOST unset", () => {
  for (const [label, env] of [["unset", {}], ["empty", { FIRESTORE_EMULATOR_HOST: "" }]] as const) {
    it(`uses Google-hosted Firestore with the metadata token when the variable is ${label}`, async () => {
      const calls = await storeRequests({ ...env, GCLOUD_PROJECT: "demo-antwar" });
      expect(calls).toEqual([
        { url: "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", authorization: null },
        { url: `https://firestore.googleapis.com${documentPath("demo-antwar")}`, authorization: "Bearer metadata-token" },
      ]);
    });
  }

  // No fallback Google project: a store configured without one refuses to start, naming the setting.
  for (const [label, env] of [["unset", {}], ["empty", { GCLOUD_PROJECT: "" }], ["unset on Cloud Run", { K_SERVICE: "antwar-public-0" }]] as const) {
    it(`refuses a namespace whose project is ${label}, before any request`, () => {
      expect(refusalOf(env)).toBe("ANTWAR_STORE_NAMESPACE=env-test refused: missing GCLOUD_PROJECT, the Google Cloud project of the shared store");
    });
  }
});
