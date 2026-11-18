/**
 * Scripted seats: a seated player that recorded no model and is not a house (Model Index) seat, such as a scripted test
 * opponent. Every surface that names a seat shows one as SCRIPTED_BOT, with no model, level, tier or rating, never its
 * account's name. Decided from what the seat recorded, never from a list of names.
 */
import type { StreamAgent } from "../../src/live/format.ts";
import { HOUSE_USERNAME } from "../../src/identity/houseOwnership.ts";

/** What a scripted seat is called wherever a seat's player is shown. */
export const SCRIPTED_BOT = "Scripted bot";

/** Whether a seat held by `handle` (a stream display name, "#n" and all, or a recorded handle) that recorded `modelLabel`
 * is scripted: it has a handle, recorded no model, and the handle is not the house's. */
export function isScriptedSeat(handle: string | null | undefined, modelLabel: string | null | undefined): boolean {
  return !!handle && !modelLabel && !handle.toLowerCase().startsWith(`${HOUSE_USERNAME}/`);
}

/** Whether a stream agent, as received or as shownAgent shows it, holds a scripted seat. */
export function isScriptedAgent(a: Pick<StreamAgent, "identity" | "modelLabel"> | undefined): boolean {
  return a !== undefined && isScriptedSeat(a.identity?.displayName, a.modelLabel);
}

/** An agent as the board shows it: a scripted seat's identity is SCRIPTED_BOT with no rating, level or tier; any other
 * agent unchanged. */
export function shownAgent(a: StreamAgent): StreamAgent {
  if (!isScriptedAgent(a)) return a;
  const shown: StreamAgent = { ...a, identity: { displayName: SCRIPTED_BOT } };
  delete shown.thinkingLevel;
  delete shown.serviceTier;
  return shown;
}
