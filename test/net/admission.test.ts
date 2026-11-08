import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmissionCap, EXEMPT, REFUSAL_LOG_MS } from "../../src/net/admission.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("admission caps", () => {
  it("bounds places overall and per source, null sources sharing one key, and an exempt request counting only overall", () => {
    const cap = createAdmissionCap("test", { max: 5, perSource: 2 }, () => {});
    const a1 = cap.take("192.0.2.1"), a2 = cap.take("192.0.2.1");
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    expect(cap.take("192.0.2.1")).toBeNull();
    expect(cap.take(null)).not.toBeNull();
    expect(cap.take(null)).not.toBeNull();
    expect(cap.take(null)).toBeNull();
    expect(cap.openFor(null)).toBe(2);
    // Past every source's bound but within the overall cap.
    expect(cap.take(EXEMPT)).not.toBeNull();
    expect(cap.open).toBe(5);
    expect(cap.take(EXEMPT)).toBeNull();
    expect(cap.take("198.51.100.7")).toBeNull();
    // A release is given back once, however often it is called.
    a1!();
    a1!();
    expect(cap.open).toBe(4);
    expect(cap.openFor("192.0.2.1")).toBe(1);
    expect(cap.take("192.0.2.1")).not.toBeNull();
  });

  it("logs refusals as one count per cap at most once a minute, never with an address", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const cap = createAdmissionCap("watch relays", { max: 1, perSource: 1 }, (line) => lines.push(line));
    cap.take("192.0.2.1");
    for (let i = 0; i < 5; i += 1) cap.take("192.0.2.1");
    // The first refusal after a quiet minute at once; the rest summed into the next line.
    expect(lines).toEqual(["antwar admission watch relays: refused 1 request past the cap (max 1, 1 per source, 1 open)"]);
    vi.advanceTimersByTime(REFUSAL_LOG_MS - 1);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(lines[1]).toBe("antwar admission watch relays: refused 4 requests past the cap (max 1, 1 per source, 1 open)");
    // A quiet minute logs nothing; the next refusal is logged at once again.
    vi.advanceTimersByTime(REFUSAL_LOG_MS * 3);
    expect(lines).toHaveLength(2);
    cap.take("198.51.100.7");
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toMatch(/192\.0\.2\.1|198\.51\.100\.7/);
  });

  it("refuses invalid limits at creation", () => {
    expect(() => createAdmissionCap("bad", { max: 0 })).toThrow(/max must be a positive integer/);
    expect(() => createAdmissionCap("bad", { max: 1, perSource: 1.5 })).toThrow(/perSource must be a positive integer/);
  });
});
