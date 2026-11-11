import { describe, expect, it } from "vitest";
import type { DocPath, Fields, TransactionRead } from "../../src/store/firestore.ts";
import { HOUSE_LABELS, HOUSE_USERNAME, houseDisplayName, houseLabel, houseOwnedAmong, isHouseOwned } from "../../src/rating/house.ts";
import { UNLISTED_MODEL } from "../../src/rating/houseLabels.ts";

/**
 * Pins the House table and the House ownership check as they stood at main 3cad75d2, before the
 * ownership check and the label table moved to their own modules. It imports only from src/rating/house.ts,
 * so the same file must pass unchanged after the move.
 */
const PINNED: Readonly<Record<string, readonly [displayName: string, thinkingLevel: string | null, serviceTier: string | null]>> = {
  "claude-opus-5-5": ["Claude Opus 5.5", "high", null],
  "claude-opus-5-5-low": ["Claude Opus 5.5", "low", null],
  "claude-opus-5-5-medium": ["Claude Opus 5.5", "medium", null],
  "claude-opus-5-5-xhigh": ["Claude Opus 5.5", "xhigh", null],
  "claude-opus-5-5-max": ["Claude Opus 5.5", "max", null],
  "claude-fable-5-1": ["Claude Fable 5.1", "max", null],
  "claude-fable-5-2": ["Claude Fable 5.2", "max", null],
  "claude-fable-5-2-high": ["Claude Fable 5.2", "high", null],
  "claude-fable-5-2-xhigh": ["Claude Fable 5.2", "xhigh", null],
  "claude-fable-5-2-medium": ["Claude Fable 5.2", "medium", null],
  "claude-fable-5-2-low": ["Claude Fable 5.2", "low", null],
  "claude-sonnet-5-5": ["Claude Sonnet 5.5", "max", null],
  "glm-5-3": ["GLM-5.3", "max", null],
  "k3-1-pro": ["K3.1 Pro", "max", null],
  "muse-spark-1-3": ["Muse Spark 1.3 on muse", "max", null],
  "muse-wonder-1-0": ["Muse Wonder 1.0 on muse", "max", null],
  "muse-wonder-full-1-0": ["Muse Wonder Full 1.0 on muse", "max", null],
  "claude-haiku-5-5": ["Claude Haiku 5.5", "max", null],
  "deepseek-flash": ["DeepSeek V4.1 Flash", "max", null],
  "gpt-6-luna": ["GPT-6 Luna", "max", "fast"],
  "gpt-6-astra": ["GPT-6 Astra", "max", "fast"],
  "k3-1-pro-highspeed": ["K3.1 Pro Highspeed", "high", null],
  "grok-4-7": ["Grok 4.7", "xhigh", null],
  "mimo-v2-6-flash": ["MiMo V2.6 Flash", "high", null],
  "mimo-v2-6-pro": ["MiMo V2.6 Pro", "high", null],
  "qwen3-8-max": ["Qwen3.8 Max", "xhigh", null],
  "gpt-6-1-sol": ["GPT-6.1 Sol", "max", "fast"],
  "gpt-6-1-sol-high": ["GPT-6.1 Sol", "high", "standard"],
  "gpt-6-1-sol-xhigh": ["GPT-6.1 Sol", "xhigh", "standard"],
  "gpt-6-1-sol-high-fast": ["GPT-6.1 Sol", "high", "fast"],
  "gpt-6-1-sol-xhigh-fast": ["GPT-6.1 Sol", "xhigh", "fast"],
  "gpt-6-1-terra-max-fast": ["GPT-6.1 Terra", "max", "fast"],
  "gpt-6-1-terra-max": ["GPT-6.1 Terra", "max", "standard"],
  "gemini-3-8-flash": ["Gemini 3.8 Flash", "high", "standard"],
  "gemini-4-argon": ["Gemini 4 Argon", "high", "standard"],
  "gemini-4-carbon-low": ["Gemini 4 Carbon", "low", null],
  "gemini-4-carbon-medium": ["Gemini 4 Carbon", "medium", null],
  "gemini-4-carbon-high": ["Gemini 4 Carbon", "high", null],
  "mistral-large-latest": ["Mistral Large", null, null],
  "abliterated-model-large": ["Abliterated GLM-5.2", "max", "standard"],
  "abliterated-model": ["Abliterated Model", "high", "standard"],
  "mistral-large-4": ["Mistral Large 4", "high", "standard"],
  "abliterated-large-v2": ["Abliterated GLM-5.3", "max", "standard"],
  "abliterated-large-flash": ["Abliterated DeepSeek V4.1 Flash", "max", "standard"],
  "glm-5-3-highspeed": ["GLM-5.3 Highspeed", null, null],
  "grok-composer-2-5-fast": ["Grok Composer 2.5 Fast", null, null],
  "gemini-3-1-pro-preview": ["Gemini 3.1 Pro Preview", null, null],
  "gpt-6-1-terra": ["GPT-6.1 Terra", null, null],
};

/** An in-memory transactional read over fixed documents; an absent path reads as null. */
function readOf(docs: Readonly<Record<DocPath, Fields>>): TransactionRead {
  return async (paths) => new Map(paths.map((path) => [path, docs[path] ?? null]));
}

const HOUSE_ID = "house-username";
const SEATS: Readonly<Record<DocPath, Fields>> = {
  [`usernames/${HOUSE_USERNAME}`]: { identityId: HOUSE_ID },
  "usernames/kite": { identityId: "kite-username" },
  [`identities/${HOUSE_ID}`]: { kind: "username", displayName: HOUSE_USERNAME },
  "identities/house-handle": { kind: "handle", displayName: `${HOUSE_USERNAME}/claude-opus-5-5`, ownerId: HOUSE_ID },
  "identities/kite-username": { kind: "username", displayName: "kite" },
  "identities/kite-handle": { kind: "handle", displayName: "kite/antwars", ownerId: "kite-username" },
};
const IDS = [HOUSE_ID, "house-handle", "kite-username", "kite-handle", "missing"] as const;

describe("House table pinned at main 3cad75d2", () => {
  it("exports the antwars username", () => {
    expect(HOUSE_USERNAME).toBe("antwars");
  });

  it("lists exactly 48 handles, each with its display name, level and tier", () => {
    expect(Object.keys(HOUSE_LABELS)).toHaveLength(48);
    expect(Object.keys(HOUSE_LABELS)).toEqual(Object.keys(PINNED));
    const shown = Object.fromEntries(Object.entries(HOUSE_LABELS)
      .map(([handle, label]) => [handle, [label.displayName, label.thinkingLevel, label.serviceTier]]));
    expect(shown).toEqual(PINNED);
    expect(Object.isFrozen(HOUSE_LABELS)).toBe(true);
  });

  it("looks each handle up from its owner/handle name, case-insensitively, and shows every unlisted name as Unlisted model, never its slug", () => {
    for (const [handle, [displayName, thinkingLevel, serviceTier]] of Object.entries(PINNED)) {
      expect(houseLabel(`${HOUSE_USERNAME}/${handle}`)).toEqual({ thinkingLevel, serviceTier });
      expect(houseLabel(`ANTWARS/${handle.toUpperCase()}`)).toEqual({ thinkingLevel, serviceTier });
      expect(houseDisplayName(`${HOUSE_USERNAME}/${handle}`)).toBe(displayName);
    }
    expect(houseLabel("antwars/unlisted")).toEqual({ thinkingLevel: null, serviceTier: null });
    expect(houseLabel("kite/claude-opus-5-5")).toEqual({ thinkingLevel: null, serviceTier: null });
    expect(houseLabel("claude-opus-5-5")).toEqual({ thinkingLevel: null, serviceTier: null });
    expect(houseLabel("antwars/toString")).toEqual({ thinkingLevel: null, serviceTier: null });
    expect(houseDisplayName("antwars/unlisted")).toBe("Unlisted model");
    expect(houseDisplayName("kite/claude-opus-5-5")).toBe("Unlisted model");
    expect(houseDisplayName("antwars/toString")).toBe("Unlisted model");
    expect(UNLISTED_MODEL).toBe("Unlisted model");
  });
});

describe("House ownership seat check pinned at main 3cad75d2", () => {
  it("counts the antwars username and its handles as house-owned, by stored owner", async () => {
    const owned = await houseOwnedAmong(readOf(SEATS), IDS);
    expect([...owned].sort()).toEqual([HOUSE_ID, "house-handle"].sort());
    const each = await Promise.all(IDS.map((id) => isHouseOwned(readOf(SEATS), id)));
    expect(Object.fromEntries(IDS.map((id, i) => [id, each[i]]))).toEqual({
      [HOUSE_ID]: true, "house-handle": true, "kite-username": false, "kite-handle": false, missing: false,
    });
  });

  it("owns nothing when the antwars username is unclaimed", async () => {
    const { [`usernames/${HOUSE_USERNAME}`]: _claim, ...unclaimed } = SEATS;
    expect([...await houseOwnedAmong(readOf(unclaimed), IDS)]).toEqual([]);
    expect(await isHouseOwned(readOf(unclaimed), "house-handle")).toBe(false);
  });

  it("returns an empty set for no identities", async () => {
    expect([...await houseOwnedAmong(readOf(SEATS), [])]).toEqual([]);
  });
});
