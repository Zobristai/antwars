import { describe, expect, it, vi } from "vitest";
import type { RankedMode } from "../../src/rating/ratings.ts";
import { admitMatchWatch, captureMatchAccess, isPublicMatch, spectatorDelaySeconds } from "../../src/live/match-access.js";

describe("per-match spectator admission", () => {
  const privateMatch = captureMatchAccess({ lobbyId: "private-lobby", visibility: "private", rated: true });
  const publicMatch = captureMatchAccess({ lobbyId: "public-lobby", visibility: "public", rated: false });

  it("captures access before slot reuse without retaining a mutable input", () => {
    const input = { lobbyId: "first", visibility: "private" as const, rated: true, mode: "house-2v2" as RankedMode };
    const captured = captureMatchAccess(input);
    input.lobbyId = "second";
    input.rated = false;
    input.mode = "1v1";
    expect(captured).toEqual({ lobbyId: "first", visibility: "private", rated: true, mode: "house-2v2" });
    expect(spectatorDelaySeconds(captured)).toBe(0);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("uses the rated delay regardless of visibility", () => {
    for (const visibility of ["private", "public"] as const) {
      expect(spectatorDelaySeconds({ lobbyId: "match", visibility, rated: true })).toBe(300);
      expect(spectatorDelaySeconds({ lobbyId: "match", visibility, rated: false })).toBe(60);
    }
  });

  it.each(["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const)("%s has no delay regardless of rating or visibility", mode => {
    for (const visibility of ["private", "public"] as const) for (const rated of [true, false]) {
      expect(spectatorDelaySeconds({ lobbyId: "match", visibility, rated, mode })).toBe(0);
    }
  });

  it("rejects invented house modes rather than treating a prefix as permission for zero delay", () => {
    const invalid = { lobbyId: "match", visibility: "public" as const, rated: true, mode: "house-5v5" as RankedMode };
    expect(spectatorDelaySeconds(invalid)).toBe(300);
    expect(() => captureMatchAccess(invalid)).toThrow("Invalid spectator match access policy");
  });

  it("admits public playback without reading or passing along an invite", async () => {
    const check = vi.fn(async () => false);
    expect(await admitMatchWatch(publicMatch, "not-a-seat-key", check)).toBe("allowed");
    expect(check).not.toHaveBeenCalled();
  });

  it("does not list private or unknown matches", () => {
    expect(isPublicMatch(publicMatch)).toBe(true);
    expect(isPublicMatch(privateMatch)).toBe(false);
    expect(isPublicMatch(undefined)).toBe(false);
    expect(isPublicMatch(null)).toBe(false);
  });

  it("refuses missing metadata or an absent invite before querying the store", async () => {
    const check = vi.fn(async () => true);
    for (const match of [undefined, null, privateMatch]) {
      expect(await admitMatchWatch(match, undefined, check)).toBe("refused");
    }
    expect(await admitMatchWatch(privateMatch, "", check)).toBe("refused");
    expect(check).not.toHaveBeenCalled();
  });

  it("checks the captured lobby for every new request, including after rotation", async () => {
    let current = "first-invite";
    const check = vi.fn(async (id: string, token: string) => id === "private-lobby" && token === current);
    const attached = await admitMatchWatch(privateMatch, "first-invite", check);
    expect(attached).toBe("allowed");
    current = "";
    expect(await admitMatchWatch(privateMatch, "first-invite", check)).toBe("refused");
    current = "fresh-invite";
    expect(await admitMatchWatch(privateMatch, "first-invite", check)).toBe("refused");
    expect(await admitMatchWatch(privateMatch, "fresh-invite", check)).toBe("allowed");
    // Prior admission is a value, not a subscription that tears down an attached stream.
    expect(attached).toBe("allowed");
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("fails closed without disguising a store outage as a valid invite", async () => {
    expect(await admitMatchWatch(privateMatch, "invite", async () => { throw new Error("unavailable"); })).toBe("unavailable");
  });

  it("rejects incomplete capture metadata", () => {
    expect(() => captureMatchAccess({ lobbyId: "", visibility: "public", rated: false })).toThrow("Invalid spectator match access policy");
  });
});
