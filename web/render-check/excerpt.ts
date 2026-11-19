/**
 * Cut a short excerpt of a public recording for the replay surface: the board at tick `from` as one full message,
 * then the recording's own messages to `to`, packed as /replays/<id> serves them. A whole Free-for-all recording
 * is tens of megabytes; the HUD needs only a moment of it.
 *
 *   node --import ./src/ts-resolve.mjs web/render-check/excerpt.ts --id <replay id> --from 6000 --to 6110
 *
 * Writes the excerpt as readable text (replay-text.ts) in files of at most 64 KB, read in order:
 * web/render-check/snapshot/bodies/<id>-<from>-<to>/01.replay.jsonl, 02.replay.jsonl, ..., and prints them with the
 * excerpt's digest; fixtures.json names the files and that digest, which serve.ts checks on every run.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { joinReplayText, replayFromText, replayToText, splitReplayText } from "./replay-text.ts";
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

const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Write an excerpt's text files (see the file's comment); returns their paths, relative to snapshot/, in order. */
export async function writeExcerpt(id: string, from: number, to: number, cut: Uint8Array, snapshotDir = SNAPSHOT_DIR): Promise<string[]> {
  const text = replayToText(cut);
  if (digest(replayFromText(text)) !== digest(cut)) throw new Error("the excerpt's text does not turn back into its bytes");
  const parts = splitReplayText(text);
  if (digest(replayFromText(joinReplayText(parts))) !== digest(cut)) throw new Error("the excerpt's files do not turn back into its bytes");
  const dir = `bodies/${id}-${from}-${to}`;
  await rm(join(snapshotDir, dir), { recursive: true, force: true });
  await mkdir(join(snapshotDir, dir), { recursive: true });
  const files = parts.map((_, n) => `${dir}/${String(n + 1).padStart(2, "0")}.replay.jsonl`);
  for (const [n, part] of parts.entries()) await writeFile(join(snapshotDir, files[n]!), part);
  return files;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { id: { type: "string" }, from: { type: "string" }, to: { type: "string" } } });
  if (!values.id || values.from === undefined || values.to === undefined) throw new Error("excerpt needs --id, --from and --to");
  const res = await fetch(`${PUBLIC_SITE}/replays/${encodeURIComponent(values.id)}`);
  if (!res.ok) throw new Error(`${PUBLIC_SITE}/replays/${values.id}: ${res.status}`);
  const whole = new Uint8Array(await res.arrayBuffer());
  const cut = replayExcerpt(whole, Number(values.from), Number(values.to));
  const files = (await writeExcerpt(values.id, Number(values.from), Number(values.to), cut)).map(f => `snapshot/${f}`);
  console.log(JSON.stringify({ source: `${PUBLIC_SITE}/replays/${values.id}`, sourceBytes: whole.length, sourceSha256: digest(whole), files, bytes: cut.length, sha256: digest(cut) }, null, 1));
}
