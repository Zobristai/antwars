import type { PublicMatchCatalog } from "../../src/live/match-catalog.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

/** Reject malformed responses rather than misrepresenting them as an idle server. */
export function readPublicMatchCatalog(value: unknown): PublicMatchCatalog | null {
  if (!record(value) || !Array.isArray(value.matches) || !Array.isArray(value.lobbies)) return null;
  const matches: PublicMatchCatalog["matches"][number][] = [];
  const lobbies: PublicMatchCatalog["lobbies"][number][] = [];
  for (const entry of value.matches) {
    if (!record(entry) || !text(entry.lobbyId) || typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)
      || typeof entry.rated !== "boolean" || typeof entry.delaySeconds !== "number" || (entry.delaySeconds !== 0 && entry.delaySeconds !== (entry.rated ? 300 : 60))) return null;
    matches.push({ lobbyId: entry.lobbyId, startedAt: entry.startedAt, rated: entry.rated, delaySeconds: entry.delaySeconds });
  }
  for (const entry of value.lobbies) {
    if (!record(entry) || !text(entry.id) || typeof entry.size !== "number" || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > 4
      || (entry.state !== "open" && entry.state !== "waiting") || !Array.isArray(entry.colonies) || entry.colonies.length !== 2) return null;
    const size = entry.size;
    if (!entry.colonies.every(colony => Array.isArray(colony) && colony.length <= size && colony.every(text))) return null;
    lobbies.push({ id: entry.id, size: entry.size, state: entry.state, colonies: entry.colonies.map(colony => [...colony]) });
  }
  return { matches, lobbies };
}

/** One request at a time; catalog refresh never restarts the selected match's playback. */
export function watchMatchDirectory(
  update: (catalog: PublicMatchCatalog) => void,
  unavailable: () => void,
  request: typeof fetch = fetch,
  intervalMs = 1500,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const response = await request("/watch/catalog", {
        cache: "no-store", credentials: "same-origin", redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error("Directory unavailable");
      const catalog = readPublicMatchCatalog(await response.json());
      if (!catalog) throw new Error("Invalid directory");
      if (!controller.signal.aborted) update(catalog);
    } catch {
      if (!controller.signal.aborted) unavailable();
    }
    if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, intervalMs);
  };
  void refresh();
  return () => { controller.abort(); clearTimeout(timer); };
}
