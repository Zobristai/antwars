import { replayPath } from "./replay.ts";

/** Lobby recordings never fall back to the public media namespace, even without an invite. */
export function lobbyRecordingPath(params: URLSearchParams): string {
  const lobby = params.get("lobby");
  const id = params.get("replay");
  if (!lobby || lobby === "." || lobby === ".." || !id) throw new Error("Invalid lobby recording link.");
  // Keep the existing recording-id validation and public links unchanged.
  replayPath(params);
  return `/watch/replays/${encodeURIComponent(lobby)}/${encodeURIComponent(id)}`;
}

/** Bound to one route: no caller or redirect may transfer the invite to another resource. */
export function inviteRecordingRequest(path: string, invite: string | null, request: typeof fetch = fetch): typeof fetch {
  if (!path.startsWith("/watch/replays/") || /[\\\s]/.test(path)) throw new Error("Invalid lobby recording route.");
  return async (input, options) => {
    if (input !== path) throw new Error("Recording request changed its route.");
    const headers = new Headers({ accept: "application/octet-stream" });
    if (invite) headers.set("x-antwar-invite", invite);
    return request(path, {
      method: "GET", headers, signal: options?.signal,
      credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
    });
  };
}
