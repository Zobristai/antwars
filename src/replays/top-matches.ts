import { readFileSync } from "node:fs";
import { z } from "zod";
import { isReplayId } from "./access.js";

/**
 * The Watch page's top matches, shown when no match is live: a hand-picked list of up to 16 matches, in tile order, kept in
 * top-matches.json beside this file and shipped with the build (docs/top-matches.md): {"matches": ["<match id>", ...]}.
 * The route serves each listed match whose record exists and that the public visibility check passes; the picks are
 * chosen by hand, so no match-type rule applies.
 */
export const TOP_MATCHES = 16;

const topMatchList = z.object({ matches: z.array(z.string()).max(TOP_MATCHES) });

/** The list's ids in order: a malformed or repeated id is left off and named in `leftOff`. A file of any other shape is refused. */
export function topMatchIds(file: unknown): { ids: string[]; leftOff: string[] } {
  const { matches } = topMatchList.parse(file);
  const ids: string[] = [], leftOff: string[] = [];
  for (const id of matches) (isReplayId(id) && !ids.includes(id) ? ids : leftOff).push(id);
  return { ids, leftOff };
}

/** The shipped list, read once at start. */
export function shippedTopMatchList(): { ids: string[]; leftOff: string[] } {
  return topMatchIds(JSON.parse(readFileSync(new URL("./top-matches.json", import.meta.url), "utf8")));
}

/** One read shared by every caller: a caller waits for the running read; a failed read is not kept, so the next caller reads again. */
export function sharedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let done: Promise<T> | null = null;
  return () => {
    done ??= read().catch(error => { done = null; throw error; });
    return done;
  };
}
