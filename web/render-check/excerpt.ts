/**
 * Cut a short excerpt of a public recording for the replay surface: the board at tick `from` as one full message,
 * then the recording's own messages to `to`, packed as /replays/<id> serves them. A whole Free-for-all recording
 * is tens of megabytes; the HUD needs only a moment of it.
 *
 *   node --import ./src/ts-resolve.mjs web/render-check/excerpt.ts --id <replay id> --from 6000 --to 6600
 *
 * Writes web/render-check/snapshot/bodies/<id>-<from>-<to>.bin.gz and prints its digest; fixtures.json names it.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { PUBLIC_SITE, SNAPSHOT_DIR } from "./serve.ts";

export function replayExcerpt(recording: Uint8Array, from: number, to: number): Uint8Array {
  const all = unpackMessages(recording).map(decodeMessage);
  const head = all[0]!;
  if (!head.full) throw new Error("the recording does not open with a full message");
  const board = new SpectatorState(head.full, head.tick, head.ants);
  let i = 1;
  for (; i < all.length && all[i]!.tick <= from; i++) board.apply(all[i]!);
  if (board.tick !== from) throw new Error(`the recording has no tick ${from} (it reaches ${board.tick})`);
  const rest = all.slice(i).filter(m => m.tick <= to);
  return packMessages([board.message(), ...rest].map(encodeMessage));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { id: { type: "string" }, from: { type: "string" }, to: { type: "string" } } });
  if (!values.id || values.from === undefined || values.to === undefined) throw new Error("excerpt needs --id, --from and --to");
  const res = await fetch(`${PUBLIC_SITE}/replays/${encodeURIComponent(values.id)}`);
  if (!res.ok) throw new Error(`${PUBLIC_SITE}/replays/${values.id}: ${res.status}`);
  const whole = new Uint8Array(await res.arrayBuffer());
  const cut = replayExcerpt(whole, Number(values.from), Number(values.to));
  const file = `${values.id}-${values.from}-${values.to}.bin.gz`;
  await mkdir(join(SNAPSHOT_DIR, "bodies"), { recursive: true });
  await writeFile(join(SNAPSHOT_DIR, "bodies", file), gzipSync(cut, { level: 9 }));
  const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  console.log(JSON.stringify({ source: `${PUBLIC_SITE}/replays/${values.id}`, sourceBytes: whole.length, sourceSha256: digest(whole), file, bytes: cut.length, sha256: digest(cut) }));
}
