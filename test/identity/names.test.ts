import { describe, expect, it } from "vitest";
import { parseName } from "../../src/identity/identities.ts";
import { firestoreFromEnv } from "../../src/store/firestore.ts";

describe("name rule: ASCII after NFKC, compared case-insensitively", () => {
  it("keeps the NFKC display form and folds case for sameness", () => {
    expect(parseName("Kite")).toEqual({ display: "Kite", canonical: "kite" });
    expect(parseName("scout_2-b")).toEqual({ display: "scout_2-b", canonical: "scout_2-b" });
  });

  it.each([
    ["ＫＩＴＥ", "kite"], // fullwidth letters
    ["Kite", "kite"], // Kelvin sign K
    ["ﬁre", "fire"], // fi ligature
    ["KITE", "kite"],
  ])("%s is the same name as %s", (input, canonical) => {
    expect(parseName(input)?.canonical).toBe(canonical);
  });

  it.each(["kite/scout", "/kite", "a", "k", "x".repeat(25), "ki te", "_kite", "-kite", "café", "ıi", "", "ki.te"])(
    "refuses %j", (input) => {
      expect(parseName(input)).toBeUndefined();
    });

  it("accepts the length bounds", () => {
    expect(parseName("ab")?.canonical).toBe("ab");
    expect(parseName("x".repeat(24))?.canonical).toBe("x".repeat(24));
  });
});

describe("store namespace configuration", () => {
  it("has no store, and no shared default, without a namespace", () => {
    expect(firestoreFromEnv({})).toBeUndefined();
    expect(firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: "" })).toBeUndefined();
  });

  it("rejects an invalid namespace", () => {
    expect(() => firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: "a/b", GCLOUD_PROJECT: "demo-antwar" })).toThrow(/invalid store namespace/);
    expect(() => firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: "Live", GCLOUD_PROJECT: "demo-antwar" })).toThrow(/invalid store namespace/);
  });

  it("names the configured namespace", () => {
    expect(firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: "preview-abc", GCLOUD_PROJECT: "demo-antwar" })?.namespace).toBe("preview-abc");
  });
});
