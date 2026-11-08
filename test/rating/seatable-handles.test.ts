// Every handle that can be seated has a HOUSE_LABELS row: a test fails whenever any handle that can be seated (the
// launchable list and the index draw) has no HOUSE_LABELS entry. A missing label is caught before merge, not on the page.
import { describe, expect, it } from "vitest";
import { LAUNCHABLE_HANDLES } from "../../src/lobby/houseLaunchable.ts";
import { HOUSE_USERNAME } from "../../src/identity/houseOwnership.ts";
import { HOUSE_LABELS, UNLISTED_MODEL, houseDisplayName } from "../../src/rating/houseLabels.ts";

/**
 * The Model Index draw. It is not held in this repository: each handle is derived from its catalog model id. These are
 * round 26's 28 listings (seed 3961925567). A handle newly drawn is caught here only once it is added to this list.
 */
const INDEX_DRAW: readonly string[] = [
  "claude-opus-5-5", "gpt-6-1-sol-high", "glm-5-3", "k3-1-pro-highspeed", "gpt-6-astra", "grok-4-7", "abliterated-large-v2",
  "gpt-6-1-sol-high-fast", "claude-opus-5-5-max", "k3-1-pro", "gpt-6-1-sol-xhigh-fast", "deepseek-flash", "gpt-6-luna",
  "mistral-large-4", "gemini-4-argon", "claude-opus-5-5-medium", "claude-haiku-5-5", "qwen3-8-max", "gemini-3-8-flash",
  "gpt-6-1-sol-xhigh", "gpt-6-1-sol", "claude-fable-5-1",
  // Unpaired in round 26, still in the draw.
  "gpt-6-1-terra-max-fast", "claude-opus-5-5-xhigh", "claude-sonnet-5-5", "claude-opus-5-5-low", "mimo-v2-6-flash", "mimo-v2-6-pro",
];

/** Every seatable handle: the launchable list and the index draw, each once. */
const SEATABLE: readonly string[] = [...new Set([...LAUNCHABLE_HANDLES, ...INDEX_DRAW])];

/** The handles among `handles` that HOUSE_LABELS does not list, so a page would show them as "Unlisted model". */
const unlabelled = (handles: readonly string[]): string[] =>
  handles.filter(handle => !Object.hasOwn(HOUSE_LABELS, handle.toLowerCase()) || houseDisplayName(`${HOUSE_USERNAME}/${handle}`) === UNLISTED_MODEL);

describe("every seatable handle has a HOUSE_LABELS row", () => {
  it("holds round 26's 28 index-draw listings and every launch-table handle", () => {
    expect(INDEX_DRAW).toHaveLength(28);
    expect(new Set(INDEX_DRAW).size).toBe(28);
    expect(LAUNCHABLE_HANDLES.length).toBeGreaterThan(0);
  });

  it("lists every launch-table and index-draw handle", () => {
    expect(unlabelled(SEATABLE)).toEqual([]);
  });

  it("names the two Live now handles of 2026-11-07 by their rows", () => {
    expect(houseDisplayName("antwars/abliterated-large-v2")).toBe("Abliterated GLM-5.3");
    expect(houseDisplayName("antwars/mistral-large-4")).toBe("Mistral Large 4");
  });

  it("fails for a seatable handle without a row, naming it", () => {
    expect(unlabelled([...SEATABLE, "new-model-without-a-row"])).toEqual(["new-model-without-a-row"]);
    expect(unlabelled(["toString", "constructor"])).toEqual(["toString", "constructor"]);
  });
});
