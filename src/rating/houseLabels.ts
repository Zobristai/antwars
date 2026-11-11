import { HOUSE_USERNAME } from "../identity/houseOwnership.js";

/**
 * One Benchmark handle's display name and fixed level and tier.
 * A null level means the handle has no fixed value; a null tier means none.
 */
export interface HouseLabel {
  readonly displayName: string;
  readonly thinkingLevel: string | null;
  readonly serviceTier: string | null;
}

const label = (displayName: string, thinkingLevel: string | null = null, serviceTier: string | null = null): HouseLabel =>
  ({ displayName, thinkingLevel, serviceTier });

/**
 * Each antwars handle's display name and fixed level and tier, keyed by the handle without the antwars/ owner prefix.
 * A Benchmark row shows these values whatever its seats report; an unlisted handle shows UNLISTED_MODEL, with no level or tier
 * (never a slug or a name built from one; a seatable handle without a row fails
 * test/rating/seatable-handles.test.ts).
 */
export const HOUSE_LABELS: Readonly<Record<string, HouseLabel>> = Object.freeze({
  "claude-opus-5-5": label("Claude Opus 5.5", "high"),
  "claude-opus-5-5-low": label("Claude Opus 5.5", "low"),
  "claude-opus-5-5-medium": label("Claude Opus 5.5", "medium"),
  "claude-opus-5-5-xhigh": label("Claude Opus 5.5", "xhigh"),
  "claude-opus-5-5-max": label("Claude Opus 5.5", "max"),
  "claude-fable-5-1": label("Claude Fable 5.1", "max"),
  "claude-fable-5-2": label("Claude Fable 5.2", "max"),
  "claude-fable-5-2-high": label("Claude Fable 5.2", "high"),
  "claude-fable-5-2-xhigh": label("Claude Fable 5.2", "xhigh"),
  "claude-fable-5-2-medium": label("Claude Fable 5.2", "medium"),
  "claude-fable-5-2-low": label("Claude Fable 5.2", "low"),
  "claude-sonnet-5-5": label("Claude Sonnet 5.5", "max"),
  "glm-5-3": label("GLM-5.3", "max"),
  "k3-1-pro": label("K3.1 Pro", "max"),
  "muse-spark-1-3": label("Muse Spark 1.3 on muse", "max"),
  "muse-wonder-1-0": label("Muse Wonder 1.0 on muse", "max"),
  "muse-wonder-full-1-0": label("Muse Wonder Full 1.0 on muse", "max"),
  "claude-haiku-5-5": label("Claude Haiku 5.5", "max"),
  "deepseek-flash": label("DeepSeek V4.1 Flash", "max"),
  "gpt-6-luna": label("GPT-6 Luna", "max", "fast"),
  "gpt-6-astra": label("GPT-6 Astra", "max", "fast"),
  "k3-1-pro-highspeed": label("K3.1 Pro Highspeed", "high"),
  "grok-4-7": label("Grok 4.7", "xhigh"),
  "mimo-v2-6-flash": label("MiMo V2.6 Flash", "high"),
  "mimo-v2-6-pro": label("MiMo V2.6 Pro", "high"),
  "qwen3-8-max": label("Qwen3.8 Max", "xhigh"),
  "gpt-6-1-sol": label("GPT-6.1 Sol", "max", "fast"),
  "gpt-6-1-sol-high": label("GPT-6.1 Sol", "high", "standard"),
  "gpt-6-1-sol-xhigh": label("GPT-6.1 Sol", "xhigh", "standard"),
  "gpt-6-1-sol-high-fast": label("GPT-6.1 Sol", "high", "fast"),
  "gpt-6-1-sol-xhigh-fast": label("GPT-6.1 Sol", "xhigh", "fast"),
  "gpt-6-1-terra-max-fast": label("GPT-6.1 Terra", "max", "fast"),
  "gpt-6-1-terra-max": label("GPT-6.1 Terra", "max", "standard"),
  "gemini-3-8-flash": label("Gemini 3.8 Flash", "high", "standard"),
  "gemini-4-argon": label("Gemini 4 Argon", "high", "standard"),
  "gemini-4-carbon-low": label("Gemini 4 Carbon", "low"),
  "gemini-4-carbon-medium": label("Gemini 4 Carbon", "medium"),
  "gemini-4-carbon-high": label("Gemini 4 Carbon", "high"),
  "mistral-large-latest": label("Mistral Large", null, null),
  "abliterated-model-large": label("Abliterated GLM-5.2", "max", "standard"),
  "abliterated-model": label("Abliterated Model", "high", "standard"),
  "mistral-large-4": label("Mistral Large 4", "high", "standard"),
  "abliterated-large-v2": label("Abliterated GLM-5.3", "max", "standard"),
  "abliterated-large-flash": label("Abliterated DeepSeek V4.1 Flash", "max", "standard"),
  // A display name only: no fixed level or tier.
  "glm-5-3-highspeed": label("GLM-5.3 Highspeed"),
  "grok-composer-2-5-fast": label("Grok Composer 2.5 Fast"),
  "gemini-3-1-pro-preview": label("Gemini 3.1 Pro Preview"),
  // The recorded model key; a recording does not say which Terra handle played.
  "gpt-6-1-terra": label("GPT-6.1 Terra"),
});

/** The listed entry for an owner/handle display name, compared case-insensitively like canonical names. */
function listed(displayName: string): HouseLabel | undefined {
  const name = displayName.toLowerCase(), prefix = `${HOUSE_USERNAME}/`;
  const handle = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
  return handle !== undefined && Object.hasOwn(HOUSE_LABELS, handle) ? HOUSE_LABELS[handle]! : undefined;
}

/**
 * A Benchmark row's fixed level and tier from its owner/handle display name; both null for an unlisted handle
 * or one with no fixed value. Whether a row is a Benchmark row is decided by stored owner, not here.
 */
export function houseLabel(displayName: string): { readonly thinkingLevel: string | null; readonly serviceTier: string | null } {
  const fixed = listed(displayName);
  return { thinkingLevel: fixed?.thinkingLevel ?? null, serviceTier: fixed?.serviceTier ?? null };
}

/** What an unlisted house handle or model label shows: never its slug or a name built from one. It carries no level or
 * tier badges. */
export const UNLISTED_MODEL = "Unlisted model";

/** Whether an owner/handle display name has a HOUSE_LABELS row. */
export const isListedHouse = (displayName: string): boolean => listed(displayName) !== undefined;

/**
 * A Benchmark row's shown name from its owner/handle display name: the listed display name, or UNLISTED_MODEL when
 * unlisted. Whether a row is a Benchmark row is decided by stored owner, not here.
 */
export function houseDisplayName(displayName: string): string {
  return listed(displayName)?.displayName ?? UNLISTED_MODEL;
}

/** The row for a recorded "<provider>/<model id>" label: the provider dropped and "." written as "-" gives the
 * handle key, compared case-insensitively; undefined when the table does not list it. */
export function houseModelEntry(label: string): HouseLabel | undefined {
  const key = label.slice(label.indexOf("/") + 1).toLowerCase().replace(/\./g, "-");
  return Object.hasOwn(HOUSE_LABELS, key) ? HOUSE_LABELS[key]! : undefined;
}
