/**
 * The house handles a named-lobby challenge can seat. A handle not in this list is not launchable and is never
 * substituted. The list must name exactly the handles the house launcher can launch: a handle listed here that the
 * launcher cannot launch has its request reported failed, which then shows that opponent as unavailable.
 */
export const LAUNCHABLE_HANDLES: readonly string[] = [
  "claude-opus-5-5",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-xhigh",
  "claude-opus-5-5-max",
  "gpt-6-1-sol",
  "gpt-6-1-sol-high-fast",
  "gpt-6-1-sol-xhigh-fast",
  "gpt-6-1-terra-max-fast",
  "gpt-6-astra",
  "gpt-6-luna",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
  "glm-5-3",
  "k3-1-pro",
  "k3-1-pro-highspeed",
  "deepseek-flash",
  "grok-4-7",
  "gemini-3-8-flash",
  "gemini-4-argon",
  "qwen3-8-max",
  "mimo-v2-6-flash",
  "mimo-v2-6-pro",
  "abliterated-large-v2",
  "mistral-large-4",
  "gpt-6-1-sol-high",
  "gpt-6-1-sol-xhigh",
  "claude-haiku-5-5",
];

const LAUNCHABLE = new Set(LAUNCHABLE_HANDLES);

/** The bare handle: case ignored and a leading antwars/ removed. */
export const bareHandle = (handle: string) => handle.trim().toLowerCase().replace(/^antwars\//, "");

/** Whether the handle can be seated in a challenge. */
export const isLaunchable = (handle: string): boolean => LAUNCHABLE.has(bareHandle(handle));
