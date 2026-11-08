/**
 * Cut a recorded excerpt from a server match log: the match is
 * re-simulated from its JSONL log (src/live/record.ts recordLog) up to `to`, the
 * spectator board is built up to `from` (src/live/model.ts SpectatorState), and
 * the excerpt is that board as one full snapshot followed by one message per
 * tick to `to`, packed as the client's recordings are.
 *
 * Usage: node --import ./src/ts-resolve.mjs web/capture/excerpt.ts --log FILE --out FILE --sha256 HEX --from TICK --to TICK
 * The log's sha256 must match --sha256. No recording is bundled any longer, so there are no defaults.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { recordLog } from "../../src/live/record.ts";
import { loadReplayFile } from "../../src/live/replayOptions.ts";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";

/** The excerpt's messages: a full snapshot at tick `from`, then one message per tick to `to`. */
export function excerpt(lines: readonly string[], from: number, to: number): StreamMessage[] {
  const all = recordLog(lines, to).map(decodeMessage);
  const head = all[0]!;
  const board = new SpectatorState(head.full!, head.tick, head.ants);
  let i = 1;
  for (; i < all.length && all[i]!.tick <= from; i++) board.apply(all[i]!);
  if (board.tick !== from) throw new Error(`the match has no tick ${from} (it ends at ${board.tick})`);
  return [board.message(), ...all.slice(i)];
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { log: { type: "string" }, out: { type: "string" }, from: { type: "string" }, to: { type: "string" }, sha256: { type: "string" }, holds: { type: "string" } } });
  if (!values.log || !values.out || !values.sha256 || values.from === undefined || values.to === undefined) {
    throw new Error("excerpt needs --log, --out, --sha256, --from and --to");
  }
  const { lines, sourceSha256: digest } = loadReplayFile(values.log, { holds: values.holds, expectedSha256: values.sha256 });
  const from = Number(values.from);
  const to = Number(values.to);
  const messages = excerpt(lines, from, to);
  const packed = packMessages(messages.map(encodeMessage));
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, packed);
  const first = messages[0]!;
  console.log(
    JSON.stringify({
      log: values.log,
      logSha256: digest,
      out,
      sha256: createHash("sha256").update(packed).digest("hex"),
      bytes: packed.length,
      messages: messages.length,
      firstTick: first.tick,
      lastTick: messages.at(-1)!.tick,
      agents: first.full!.agents.map((a) => a.colony),
    }),
  );
}
