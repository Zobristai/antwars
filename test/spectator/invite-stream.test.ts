import { describe, expect, it, vi } from "vitest";
import { openInviteStream } from "../../web/src/invite-stream.ts";

function response(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function collect(chunks: string[]): Promise<string[]> {
  const source = openInviteStream("/live/match/lobby", "invite", async () => response(chunks));
  const messages: string[] = [];
  source.onmessage = event => { messages.push(event.data); };
  await new Promise<void>(resolve => { source.onerror = () => resolve(); });
  expect(source.readyState).toBe(2);
  return messages;
}

describe("private invitation stream", () => {
  it("sends an invite only in a same-origin header, refusing redirects", async () => {
    const request = vi.fn(async () => response(["data: snapshot\n\n"])) as unknown as typeof fetch;
    const source = openInviteStream("/live/match/lobby", "secret-invite", request);
    const events: string[] = [];
    source.onopen = () => { expect(source.readyState).toBe(1); };
    source.onmessage = event => { events.push(event.data); };
    await new Promise<void>(resolve => { source.onerror = () => resolve(); });
    expect(events).toEqual(["snapshot"]);
    expect(request).toHaveBeenCalledWith("/live/match/lobby", expect.objectContaining({
      headers: { accept: "text/event-stream", "x-antwar-invite": "secret-invite" },
      credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
    }));
  });

  it("handles split CRLF, comments, multiline data and truncated final frames", async () => {
    expect(await collect([": heartbeat\r", "\ndata: one\r", "\ndata: two\r\n\r", "\ndata: incomplete"])).toEqual(["one\ntwo"]);
  });

  it("accepts LF and CR events without dispatching named non-message events", async () => {
    expect(await collect(["event: status\ndata: hidden\n\ndata: first\n\ndata: second\r\r"])).toEqual(["first", "second"]);
  });

  it("fails refused requests closed without emitting data", async () => {
    const source = openInviteStream("/live/match/lobby", "revoked", async () => new Response("private", { status: 403 }));
    const onmessage = vi.fn(); source.onmessage = onmessage;
    await new Promise<void>(resolve => { source.onerror = () => resolve(); });
    expect(source.readyState).toBe(2);
    expect(onmessage).not.toHaveBeenCalled();
  });

  it("aborts an attached connection without asking its caller to reconnect", async () => {
    let signal: AbortSignal | undefined;
    const source = openInviteStream("/live/match/lobby", "invite", async (_url, options) => {
      signal = options?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({}), { headers: { "content-type": "text/event-stream" } });
    });
    const error = vi.fn(); source.onerror = error;
    await new Promise<void>(resolve => { source.onopen = () => { source.close(); resolve(); }; });
    expect(signal?.aborted).toBe(true);
    expect(source.readyState).toBe(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("refuses absolute, network-path and backslash URLs before exposing an invite", () => {
    const request = vi.fn() as unknown as typeof fetch;
    for (const path of ["https://other.test/live", "//other.test/live", "/\\other.test/live", "live"]) {
      expect(() => openInviteStream(path, "secret", request)).toThrow("same-origin");
    }
    expect(request).not.toHaveBeenCalled();
  });
});
