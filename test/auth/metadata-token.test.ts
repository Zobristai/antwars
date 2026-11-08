import { afterEach, describe, expect, it, vi } from "vitest";
import { metadataAccessToken } from "../../src/auth/metadata-token.ts";

const SECRET = "fake-token-never-a-credential";

function recording(response: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const request: typeof fetch = async (input, init) => { calls.push({ url: String(input), init }); return response(); };
  return { calls, request };
}

describe("metadataAccessToken", () => {
  it("asks the metadata server for the default service account token, refusing redirects", async () => {
    const { calls, request } = recording(() => Response.json({ access_token: SECRET }));
    await expect(metadataAccessToken(request)).resolves.toBe(SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(new Headers(calls[0]!.init?.headers).get("Metadata-Flavor")).toBe("Google");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up after 5 s", async () => {
    const started = Date.now();
    const request: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
    });
    await expect(metadataAccessToken(request)).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
  }, 10_000);

  it("honours a caller abort as well as its own deadline", async () => {
    const controller = new AbortController();
    const request: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
    });
    const pending = metadataAccessToken(request, controller.signal);
    controller.abort(new Error("caller gone"));
    await expect(pending).rejects.toThrow("caller gone");
  });

  it("never puts provider bodies or token text in its errors", async () => {
    await expect(metadataAccessToken(recording(() => new Response(SECRET, { status: 403 })).request))
      .rejects.toThrow(/^replay identity request failed: HTTP 403$/);
    for (const body of [{}, null, { access_token: 123 }, { access_token: "" }, { token: SECRET }]) {
      const error = await metadataAccessToken(recording(() => Response.json(body)).request).catch((e: unknown) => e);
      expect(String(error)).toBe("Error: replay identity response has no access token");
    }
  });
});

describe("metadataAccessToken caching", () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A metadata server whose answers are scripted per request; it counts every request. */
  function scripted(...answers: (() => Response | Promise<Response>)[]) {
    let requests = 0;
    const request: typeof fetch = async () => answers[Math.min(requests++, answers.length - 1)]!();
    return { request, requests: () => requests };
  }
  const issued = (token: string, expires_in?: number) => () => Response.json({ access_token: token, expires_in });

  it("reuses one token within its lifetime and refetches 5 minutes before expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
    const m = scripted(issued("first", 3600), issued("second", 3600));
    for (let i = 0; i < 5; i++) await expect(metadataAccessToken(m.request)).resolves.toBe("first");
    expect(m.requests()).toBe(1);
    vi.setSystemTime(new Date("2026-11-03T00:54:59Z"));
    await expect(metadataAccessToken(m.request)).resolves.toBe("first");
    vi.setSystemTime(new Date("2026-11-03T00:55:00Z"));
    await expect(metadataAccessToken(m.request)).resolves.toBe("second");
    await expect(metadataAccessToken(m.request)).resolves.toBe("second");
    expect(m.requests()).toBe(2);
  });

  it("does not cache a token without a usable expires_in or with less than 5 minutes left", async () => {
    for (const expires of [undefined, 300, Number.NaN]) {
      const m = scripted(() => Response.json({ access_token: "once", expires_in: expires }));
      await metadataAccessToken(m.request);
      await metadataAccessToken(m.request);
      expect(m.requests()).toBe(2);
    }
  });

  it("does not cache a failed or malformed fetch; the next call fetches afresh", async () => {
    const m = scripted(() => new Response("", { status: 503 }), () => Response.json({}), issued("good", 3600));
    await expect(metadataAccessToken(m.request)).rejects.toThrow("HTTP 503");
    await expect(metadataAccessToken(m.request)).rejects.toThrow("no access token");
    await expect(metadataAccessToken(m.request)).resolves.toBe("good");
    await expect(metadataAccessToken(m.request)).resolves.toBe("good");
    expect(m.requests()).toBe(3);
  });

  it("shares one in-flight request; one caller's abort neither cancels it nor fails the others", async () => {
    let answer!: (response: Response) => void;
    let sharedSignal: AbortSignal | undefined;
    let requests = 0;
    const request: typeof fetch = (_input, init) => {
      requests++; sharedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { answer = resolve; });
    };
    const leaving = new AbortController();
    const abandoned = metadataAccessToken(request, leaving.signal);
    const staying = metadataAccessToken(request, new AbortController().signal);
    const unsignalled = metadataAccessToken(request);
    leaving.abort(new Error("caller gone"));
    await expect(abandoned).rejects.toThrow("caller gone");
    expect(sharedSignal!.aborted).toBe(false);
    answer(Response.json({ access_token: "shared", expires_in: 3600 }));
    await expect(staying).resolves.toBe("shared");
    await expect(unsignalled).resolves.toBe("shared");
    await expect(metadataAccessToken(request)).resolves.toBe("shared");
    expect(requests).toBe(1);
  });

  it("does not cache an aborted fetch for later callers", async () => {
    const m = scripted(() => Promise.reject(new DOMException("timed out", "TimeoutError")), issued("after", 3600));
    await expect(metadataAccessToken(m.request)).rejects.toThrow("timed out");
    await expect(metadataAccessToken(m.request)).resolves.toBe("after");
    expect(m.requests()).toBe(2);
  });

  it("keeps a separate token per fetch function", async () => {
    const a = scripted(issued("a", 3600)), b = scripted(issued("b", 3600));
    await expect(metadataAccessToken(a.request)).resolves.toBe("a");
    await expect(metadataAccessToken(b.request)).resolves.toBe("b");
    await expect(metadataAccessToken(a.request)).resolves.toBe("a");
    expect([a.requests(), b.requests()]).toEqual([1, 1]);
  });
});
