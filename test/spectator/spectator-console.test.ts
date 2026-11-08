import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { captureConsole } from "../../web/capture/spectator-console.ts";

function probe(redact: (value: unknown) => string = String) {
  let emit!: (message: { type(): string; text(): string }) => void;
  const events: string[] = [];
  const page = { on: (event: string, listener: typeof emit) => { events.push(event); emit = listener; } };
  const report = captureConsole(page as unknown as Pick<Page, "on">, redact);
  return { report, events, log: (text: string, type = "warn") => emit({ type: () => type, text: () => text }) };
}

describe("spectator failure console evidence", () => {
  it("retains warning reasons and errors with timestamps without changing page behavior", () => {
    const { report, events, log } = probe();
    log("3D board: too slow; reloading as the 2D board");
    log("renderer failure", "error");
    expect(events).toEqual(["console"]);
    expect(report.entries.map(entry => [entry.type, entry.text, entry.truncated])).toEqual([
      ["warn", "3D board: too slow; reloading as the 2D board", false], ["error", "renderer failure", false],
    ]);
    expect(report.entries[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(report.dropped).toBe(0);
  });

  it("redacts a secret before truncating even when it crosses the retained text boundary", () => {
    const secret = "private-invite-token";
    const { report, log } = probe(value => String(value).split(secret).join("[redacted]"));
    log("x".repeat(1990) + secret + " extra".repeat(500));
    const entry = report.entries[0]!;
    expect(entry.text).toHaveLength(2000);
    expect(entry.text).toContain("[redacted]");
    expect(entry.text).not.toContain("private");
    expect(entry.truncated).toBe(true);
  });

  it("bounds retained messages, reports dropped history and keeps the latest fallback evidence", () => {
    const { report, log } = probe();
    for (let i = 0; i < 220; i++) log(`message ${i}`);
    expect(report.entries).toHaveLength(200);
    expect(report.dropped).toBe(20);
    expect(report.entries[0]!.text).toBe("message 20");
    expect(report.entries.at(-1)!.text).toBe("message 219");
  });
});
