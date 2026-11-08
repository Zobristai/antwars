import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { clear3dRetryUrl, MANUAL_3D_PARAM, RETRY_3D_DELAY_MS, RETRY_3D_PARAM, retry3dUrl, returnTo3dUrl, start3dWithRecovery } from "../../web/src/3d-recovery.ts";
import { install3dRecoveryMap } from "../../web/vite.config.ts";
import { boardMode, fallbackUrl, runBoard } from "../../web/src/webgl2.ts";

const base = "https://example.test/watch?match=7&replay=recorded&lobby=private&x=1&x=2#invite=fixture-secret";
const module = { renderer: "fixture" };

function startup(href = base) {
  const state = { href, navigations: [] as string[] };
  const s = {
    load: vi.fn(async () => module),
    start: vi.fn(async (_loaded: typeof module) => {}),
    href: () => state.href,
    replace: vi.fn((next: string) => { state.href = next; state.navigations.push(next); }),
    clean: vi.fn(() => { state.href = clear3dRetryUrl(state.href); }),
    wait: vi.fn(async (_ms: number) => {}),
  };
  return { state, s };
}

function identity(href: string) {
  const url = new URL(href);
  url.searchParams.delete("board");
  url.searchParams.delete(RETRY_3D_PARAM);
  url.searchParams.delete(MANUAL_3D_PARAM);
  return { path: url.pathname, query: [...url.searchParams], hash: url.hash };
}

describe("fresh-document 3D loading recovery", () => {
  it("imports and starts once on success, removing internal state before initialization", async () => {
    const { s, state } = startup(retry3dUrl(base)!);
    s.start.mockImplementation(async (loaded) => {
      expect(loaded).toBe(module);
      expect(state.href).toBe(base);
    });
    await start3dWithRecovery(s);
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(s.wait).not.toHaveBeenCalled();
    expect(s.replace).not.toHaveBeenCalled();
  });

  it("a failed file navigates once, then a fresh document can genuinely load and start", async () => {
    const { s, state } = startup();
    s.load.mockRejectedValueOnce(new TypeError("module load failed"));
    await start3dWithRecovery(s);
    expect(s.load).toHaveBeenCalledTimes(1); // Never re-import a rejected graph in this document.
    expect(s.start).not.toHaveBeenCalled();
    expect(s.clean).not.toHaveBeenCalled();
    expect(s.wait).toHaveBeenCalledExactlyOnceWith(RETRY_3D_DELAY_MS);
    expect(state.navigations).toEqual([retry3dUrl(base)]);
    await start3dWithRecovery(s); // The next invocation represents the fresh document.
    expect(s.load).toHaveBeenCalledTimes(2);
    expect(s.start).toHaveBeenCalledExactlyOnceWith(module);
    expect(state.href).toBe(base);
  });

  it("exhaustion throws the original error for existing 2D fallback, without another retry", async () => {
    const { s, state } = startup();
    const failure = new TypeError("module load failed; status unknown");
    s.load.mockRejectedValue(failure);
    await start3dWithRecovery(s);
    await expect(start3dWithRecovery(s)).rejects.toBe(failure);
    expect(state.navigations).toHaveLength(1);
    expect(s.start).not.toHaveBeenCalled();
    expect(s.wait).toHaveBeenCalledTimes(1);
    expect(new URL(fallbackUrl(state.href)).searchParams.has(RETRY_3D_PARAM)).toBe(false);
  });

  it("never retries initialization after a loaded renderer partially starts", async () => {
    const { s } = startup(retry3dUrl(base)!);
    const failure = new Error("renderer failed after canvas creation");
    s.start.mockRejectedValue(failure);
    await expect(start3dWithRecovery(s)).rejects.toBe(failure);
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(s.wait).not.toHaveBeenCalled();
    expect(s.replace).not.toHaveBeenCalled();
  });

  it("does not touch storage, even if reading it would throw", async () => {
    const storage = new Proxy({}, { get() { throw new Error("storage denied"); } });
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("localStorage", storage);
    try {
      const { s } = startup();
      s.load.mockRejectedValueOnce(new TypeError("failed file"));
      await start3dWithRecovery(s);
      expect(s.replace).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not repeatedly schedule navigation if a marked URL has duplicate or malformed markers", async () => {
    for (const suffix of ["", "=wrong", "=1&aw-3d-retry=1"]) {
      const href = `https://example.test/?aw-3d-retry${suffix}`;
      expect(retry3dUrl(href)).toBeNull();
      expect(new URL(clear3dRetryUrl(href)).searchParams.has(RETRY_3D_PARAM)).toBe(false);
    }
  });
});

describe("fallback and manual return", () => {
  it.each([
    base, "https://example.test/?replay#frame", "https://example.test/?board=2d&recording=fixture&capture=1",
    "https://example.test/?board=3d&board=3d&match=7&x=1&x=2#view",
  ])("preserves match/replay/lobby/query/hash through retry, fallback and explicit return: %s", (href) => {
    const retry = retry3dUrl(href)!;
    const fallback = fallbackUrl(retry);
    const manual = returnTo3dUrl(fallback);
    for (const next of [retry, fallback, manual]) expect(identity(next)).toEqual(identity(href));
    expect(new URL(fallback).searchParams.getAll("board")).toEqual(["2d"]);
    expect(new URL(manual).searchParams.getAll("board")).toEqual(["3d"]);
    expect(new URL(manual).searchParams.has(RETRY_3D_PARAM)).toBe(false);
    expect(new URL(manual).searchParams.get(MANUAL_3D_PARAM)).toBe("1");
    expect(new URL(retry3dUrl(manual)!).searchParams.has(MANUAL_3D_PARAM)).toBe(false);
    expect(new URL(fallbackUrl(manual)).searchParams.has(MANUAL_3D_PARAM)).toBe(false);
    expect(retry3dUrl(manual)).not.toBeNull(); // A manual choice permits a new bounded attempt.
  });

  it("a manual unsupported-capability attempt stays usable 2D without loading or navigating again", async () => {
    const { s } = startup(returnTo3dUrl(fallbackUrl(base)));
    const two = vi.fn(async () => {}), fallback = vi.fn();
    await runBoard(boardMode(new URL(s.href()).searchParams), {
      probe2: () => false, start3d: () => start3dWithRecovery(s), start2d: two,
      webglSupported: () => true, show: vi.fn(), log: vi.fn(), reject: vi.fn(), fallback2d: fallback,
    });
    expect(two).toHaveBeenCalledTimes(1);
    expect(s.load).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("entrypoint records every 2D startup with no capability gate, leaving runtime fallback intact", () => {
    const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/start2d: async \(\) => \{[\s\S]*const href = fallbackUrl\(location.href\);[\s\S]*history.replaceState\(history.state, "", href\);\s*await start\(\);/);
    expect(main).toContain('load: () => import("./board3d/main3d.ts")');
    expect(main).toContain("start: (module) => module.start3d(");
    expect(main).toContain("fallback: fallbackTo2d");
    expect(main).toContain("location.replace(fallbackUrl(location.href))");
    const helper = readFileSync(new URL("../../web/src/3d-recovery.ts", import.meta.url), "utf8");
    expect(helper).not.toMatch(/sessionStorage|localStorage|console\./);
  });
});

describe("pre-entry graph refresh", () => {
  function install(href: string) {
    const inserted: { type?: string; id?: string; textContent?: string }[] = [];
    const doc = { baseURI: "https://example.test/spectator/index.html", createElement: vi.fn(() => ({})), currentScript: { after: (map: object) => inserted.push(map) } };
    vi.stubGlobal("location", { href });
    vi.stubGlobal("document", doc);
    try { install3dRecoveryMap(["./assets/main3d.js", "./assets/dependency.js"]); }
    finally { vi.unstubAllGlobals(); }
    return { inserted, doc };
  }
  it("does nothing for an ordinary 3D load or explicit 2D", () => {
    for (const query of ["board=3d", "board=2d"]) {
      const { inserted, doc } = install(`https://example.test/?${query}`);
      expect(inserted).toHaveLength(0);
      expect(doc.createElement).not.toHaveBeenCalled();
    }
  });
  it.each([RETRY_3D_PARAM, MANUAL_3D_PARAM])("maps entry AND dependency to the same fresh identity for %s", flag => {
    const href = `https://example.test/?board=3d&${flag}=1#invite=not-an-asset-token`;
    const first = install(href).inserted[0]!;
    const second = install(href).inserted[0]!;
    expect(first).toMatchObject({ type: "importmap", id: "aw-3d-importmap" });
    const { imports } = JSON.parse(first.textContent!) as { imports: Record<string, string> };
    const tokens = Object.entries(imports).map(([original, target]) => {
      expect(original).toMatch(/^https:\/\/example.test\/spectator\/assets\//);
      const url = new URL(target);
      expect(url.pathname).toBe(new URL(original).pathname);
      expect(url.hash).toBe("");
      expect([...url.searchParams.keys()]).toEqual(["aw-3d-load"]);
      return url.searchParams.get("aw-3d-load");
    });
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(1);
    expect(first.textContent).not.toContain("invite");
    expect(second.textContent).not.toBe(first.textContent);
  });
});
