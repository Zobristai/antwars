/** The disk-backed capture route supplies only the real no-storage replay-list response. */
import type { Browser, Route } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { servePage } from "../../web/capture/browser.ts";

type Fulfillment = NonNullable<Parameters<Route["fulfill"]>[0]>;

/** Fake only Playwright's transport; requests run through the real servePage route callback. */
async function capture(abort?: RegExp) {
  let handle: ((route: Route) => Promise<unknown>) | undefined;
  const listeners = new Map<string, (event: unknown) => void>();
  const page = {
    on: (event: string, listener: (event: unknown) => void) => { listeners.set(event, listener); },
    addInitScript: async () => {},
    clock: { install: async () => {}, pauseAt: async () => {} },
  };
  const context = {
    newPage: async () => page,
    addInitScript: async () => {},
    route: async (_pattern: string, listener: (route: Route) => Promise<unknown>) => { handle = listener; },
  };
  const browser = { newContext: async () => context, browserType: () => ({ name: () => "chromium" }) } as unknown as Browser;
  const served = await servePage(browser, {
    recording: "fixture", width: 390, height: 844, tilt: false,
    webDir: "/__antwar_capture_missing_files__", abort,
  });
  return {
    errors: served.errors,
    emit: (event: string, value: unknown) => listeners.get(event)?.(value),
    request: async (path: string, method = "GET") => {
      let response: Fulfillment | undefined;
      let aborted = false;
      const route = {
        request: () => ({ url: () => `http://localhost:4718${path}`, method: () => method }),
        fulfill: async (value: Fulfillment) => { response = value; },
        abort: async () => { aborted = true; },
      } as unknown as Route;
      if (handle === undefined) throw new Error("capture did not install its shared route");
      await handle(route);
      return { response, aborted };
    },
  };
}

describe("capture replay-list fixture", () => {
  it("GET /live/replays matches the real no-storage server's 200 empty JSON list", async () => {
    const server = await capture();
    const { response, aborted } = await server.request("/live/replays");
    expect(aborted).toBe(false);
    expect(response).toEqual({
      status: 200, contentType: "application/json", headers: { "cache-control": "no-store" },
      body: '{"replays":[]}',
    });
    expect(server.errors).toEqual([]);
  });

  it.each(["/missing.js", "/live/missing", "/live/replays/", "/live/replays-extra"])("keeps missing %s at 404", async (path) => {
    const server = await capture();
    expect(await server.request(path)).toEqual({ response: { status: 404, body: "not found" }, aborted: false });
  });

  it.each(["HEAD", "POST", "DELETE"])("does not fixture %s requests", async (method) => {
    const server = await capture();
    expect(await server.request("/live/replays", method)).toEqual({ response: { status: 404, body: "not found" }, aborted: false });
  });

  it("retains explicit abort simulation before fixture handling", async () => {
    const server = await capture(/^\/live\/replays$/);
    expect(await server.request("/live/replays")).toEqual({ response: undefined, aborted: true });
  });

  it("still records console and page errors instead of hiding fixture failures", async () => {
    const server = await capture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      server.emit("console", { type: () => "error", text: () => "Failed to load resource: 404 (Not Found)" });
      server.emit("pageerror", new Error("capture failure"));
      expect(server.errors).toEqual([
        "console error: Failed to load resource: 404 (Not Found)",
        "page error: capture failure",
      ]);
      expect(log).toHaveBeenCalledWith("[page] capture failure");
    } finally {
      log.mockRestore();
    }
  });
});
