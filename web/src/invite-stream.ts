import type { EventSourceLike } from "./stream.ts";

/**
 * EventSource cannot set an invite header. Its same-origin fetch equivalent
 * keeps the invite out of URLs/referrers and leaves reconnects to openLive.
 */
export function openInviteStream(path: string, invite: string, request: typeof fetch = fetch): EventSourceLike {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("Private stream must use a same-origin path");
  }
  const controller = new AbortController();
  let state = 0;
  const source: EventSourceLike = {
    onopen: null, onmessage: null, onerror: null,
    get readyState() { return state; },
    close() { state = 2; controller.abort(); },
  };
  void (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await request(path, {
        method: "GET", headers: { accept: "text/event-stream", "x-antwar-invite": invite },
        credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) { await response.body?.cancel(); return; }
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        await response.body?.cancel();
        throw new Error("Private stream unavailable");
      }
      state = 1;
      source.onopen?.(new Event("open"));
      if (controller.signal.aborted) { await response.body.cancel(); return; }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let line = "", data: string[] = [], dataLength = 0, event = "", skipLF = false;
      // Bound pending protocol text, not total stream duration or tick count.
      const maxFrame = 16 * 1024 * 1024;
      const lineEnd = () => {
        if (line === "") {
          if (data.length && (event === "" || event === "message") && !controller.signal.aborted) {
            source.onmessage?.(new MessageEvent("message", { data: data.join("\n") }));
          }
          data = []; dataLength = 0; event = "";
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") {
            data.push(value); dataLength += value.length + 1;
            if (dataLength > maxFrame) throw new Error("Private stream frame too large");
          } else if (field === "event") event = value;
        }
        line = "";
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done || controller.signal.aborted) break;
        for (const char of decoder.decode(chunk.value, { stream: true })) {
          if (char === "\n" && skipLF) { skipLF = false; continue; }
          skipLF = false;
          if (char === "\r" || char === "\n") { lineEnd(); skipLF = char === "\r"; }
          else {
            line += char;
            if (line.length > maxFrame) throw new Error("Private stream line too large");
          }
        }
      }
      // A truncated final event is never delivered. Reconnection requests a full frame.
    } catch {
      // Token/provider details are intentionally absent from browser errors.
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      state = 2;
      if (!controller.signal.aborted) source.onerror?.(new Event("error"));
    }
  })();
  return source;
}
