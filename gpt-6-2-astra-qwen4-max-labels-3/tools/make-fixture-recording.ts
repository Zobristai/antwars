// Scratch, not committed to the code. One FIXTURE recording for the HUD renders: the real stored recording of an index
// 1v1 match (claude-haiku-5-5 vs qwen3-8-max) decoded with the head's own stream code, its two seats' identity, model
// label, level and tier replaced by two of the new handles, and encoded again. Play, board and every other field are the
// real match's. Run from the head's tree: node --import ./src/ts-resolve.mjs <this> <in.raw> <out.raw>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeMessage, encodeReplayMessage, encodeMessage } from "./src/live/format.ts";
import { packMessages, unpackMessages } from "./src/live/snapshot.ts";
const [inp, outp] = process.argv.slice(2);
const raw = new Uint8Array(readFileSync(inp!));
const parts = unpackMessages(raw);
const msgs = parts.map(decodeMessage);
// Round trip first: re-encoding the unchanged messages must give the stored bytes back.
let same = 0; for (let i = 0; i < parts.length; i++) { const again = msgs[i]!.full === null ? encodeMessage(msgs[i]!) : encodeReplayMessage(msgs[i]!); if (Buffer.compare(Buffer.from(again), Buffer.from(parts[i]!)) === 0) same++; }
console.log("messages", parts.length, "round-trip identical", same);
const SEATS: Record<string, { displayName: string; modelLabel: string; thinkingLevel: string; serviceTier?: string }> = {
  "antwars/claude-haiku-5-5": { displayName: "antwars/gpt-6-2-astra-medium", modelLabel: "openai/gpt-6.2-astra", thinkingLevel: "medium", serviceTier: "fast" },
  "antwars/qwen3-8-max": { displayName: "antwars/qwen4-max-xhigh", modelLabel: "qwen-token-plan/qwen4-max", thinkingLevel: "xhigh" },
};
let changed = 0;
const swap = (a: any) => { const to = a.identity && SEATS[a.identity.displayName]; if (!to) return a; changed++;
  const { serviceTier: _t, ...rest } = a; return { ...rest, modelLabel: to.modelLabel, thinkingLevel: to.thinkingLevel, ...(to.serviceTier ? { serviceTier: to.serviceTier } : {}), identity: { ...a.identity, displayName: to.displayName } }; };
const out = msgs.map(m => {
  const full = m.full === null ? null : { ...m.full, agents: m.full.agents.map(swap) };
  const events = (m as any).events?.map((e: any) => e.kind === "join" ? swap(e) : e);
  const next = { ...m, full, ...(events ? { events } : {}) } as typeof m;
  return full === null ? encodeMessage(next) : encodeReplayMessage(next);
});
const bytes = packMessages(out);
writeFileSync(outp!, bytes);
const check = unpackMessages(bytes).map(decodeMessage);
console.log("seats changed", changed, "agents now", JSON.stringify(check.find(m => m.full)?.full?.agents.map((a: any) => [a.identity?.displayName, a.modelLabel, a.thinkingLevel, a.serviceTier])), "bytes", bytes.length, createHash("sha256").update(bytes).digest("hex"));
