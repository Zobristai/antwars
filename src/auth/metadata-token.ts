/// <reference types="node" />

const TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
/** Refetch this long before the reported expiry (google-auth-library's eager-refresh threshold). */
const REFRESH_MARGIN_MS = 5 * 60_000;

interface TokenState {
  cached?: { readonly token: string; readonly refreshAt: number };
  inflight?: Promise<string>;
}
/** Per fetch function: production callers share the global fetch, each injected fake is isolated. */
const states = new WeakMap<typeof fetch, TokenState>();

/**
 * Cloud Run service identity from the GCE metadata server, for every Google API
 * caller (Firestore store, replay and record buckets, operator scripts).
 * Deliberately lazy, with a 5 s deadline, no redirects and no token in error output.
 * A token is reused until REFRESH_MARGIN_MS before its reported expires_in; a
 * response without a usable expires_in is used once and not cached. Concurrent
 * callers share one in-flight request, which only its own deadline can cancel: a
 * caller's signal abandons that caller's wait, never the shared request. Failures
 * are never cached.
 */
export async function metadataAccessToken(request: typeof fetch, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let state = states.get(request);
  if (state === undefined) states.set(request, state = {});
  if (state.cached !== undefined && Date.now() < state.cached.refreshAt) return state.cached.token;
  if (state.inflight === undefined) {
    const shared = state;
    const inflight = fetchToken(request).then(({ token, refreshAt }) => {
      if (refreshAt !== undefined) shared.cached = { token, refreshAt };
      return token;
    }).finally(() => { if (shared.inflight === inflight) shared.inflight = undefined; });
    // Handled here so a request every caller abandoned cannot surface as unhandled.
    inflight.catch(() => {});
    state.inflight = inflight;
  }
  return untilAborted(state.inflight, signal);
}

async function fetchToken(request: typeof fetch): Promise<{ token: string; refreshAt: number | undefined }> {
  const requestedAt = Date.now();
  const response = await request(TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`replay identity request failed: HTTP ${response.status}`);
  }
  const token: unknown = await response.json();
  if (typeof token !== "object" || token === null || !("access_token" in token) ||
      typeof token.access_token !== "string" || token.access_token.length === 0) {
    throw new Error("replay identity response has no access token");
  }
  const expiresIn = "expires_in" in token ? token.expires_in : undefined;
  const lifetimeMs = typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn * 1_000 : 0;
  return { token: token.access_token, refreshAt: lifetimeMs > REFRESH_MARGIN_MS ? requestedAt + lifetimeMs - REFRESH_MARGIN_MS : undefined };
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  return new Promise<T>((resolve, reject) => {
    const abandon = () => reject(signal.reason);
    signal.addEventListener("abort", abandon, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abandon));
  });
}
