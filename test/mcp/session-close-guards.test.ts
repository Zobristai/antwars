import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exitOnShutdownSignal } from "../../src/main.js";
import { TEST_MCP_CONFIG, startHarness, type Harness } from "./harness.js";

let h: Harness | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
  h = null;
});

/** The server transport's close rejects on its first call only; every later close is the real one. */
function firstCloseRejects(): void {
  const realClose = StreamableHTTPServerTransport.prototype.close;
  let failed = false;
  vi.spyOn(StreamableHTTPServerTransport.prototype, "close").mockImplementation(function (this: StreamableHTTPServerTransport) {
    if (!failed) {
      failed = true;
      return Promise.reject(new Error("transport close boom"));
    }
    return realClose.call(this);
  });
}

describe("MCP session close guards", () => {
  it("one rejecting close in a sweep is logged; the sweep resolves and the other idle session still closes", async () => {
    h = await startHarness();
    await h.connect();
    await h.connect();
    expect(h.handler.sessionCount).toBe(2);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    firstCloseRejects();

    h.clock.now += TEST_MCP_CONFIG.sessionIdleMs + 1;
    await expect(h.handler.sweep()).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("antwar mcp session close failed: Error: transport close boom"));
    // The failed session stays and is retried by the next sweep; the other one closed.
    expect(h.handler.sessionCount).toBe(1);
    await h.handler.sweep();
    expect(h.handler.sessionCount).toBe(0);
  });

  it("one rejecting close in close() is logged; close resolves and the other session still closes", async () => {
    h = await startHarness();
    await h.connect();
    await h.connect();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    firstCloseRejects();

    await expect(h.handler.close()).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("antwar mcp session close failed: Error: transport close boom"));
    expect(h.handler.sessionCount).toBe(1);
  });

  it("a failed shutdown on the shutdown signal is logged and exits 1, with no unhandled rejection", async () => {
    const before = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn<(code: number) => void>();
    try {
      exitOnShutdownSignal({ shutdown: () => Promise.reject(new Error("shutdown boom")) }, exit);
      process.emit("SIGTERM");
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("antwar shutdown failed: Error: shutdown boom"));
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const l of process.listeners(signal)) if (!before[signal].includes(l)) process.removeListener(signal, l);
      }
    }
  });

  it("a successful shutdown still exits 0", async () => {
    const before = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
    const exit = vi.fn<(code: number) => void>();
    try {
      exitOnShutdownSignal({ shutdown: () => Promise.resolve() }, exit);
      process.emit("SIGINT");
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const l of process.listeners(signal)) if (!before[signal].includes(l)) process.removeListener(signal, l);
      }
    }
  });
});
