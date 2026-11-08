/**
 * Where the spectator client's messages come from (protocol in
 * src/live/hub.ts).
 *
 * - Live: an EventSource on /watch/live/<lobbyId>, selected explicitly or from
 *   the public catalog. Reconnections preserve that lobby identity.
 * - Recorded: a packed recording written by src/live/record.ts (uncompressed
 *   messages, the first a full snapshot), handed to the buffer one tick of
 *   client time apart, for the bench and whole-match capture.
 */
import { decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";

export type Sink = (message: StreamMessage) => void;
export type LinkState = "connecting" | "open" | "reconnecting";

/** One SSE data line to a message: base64, then raw inflate, then decode. */
export async function decodeData(data: string): Promise<StreamMessage> {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return decodeMessage(new Uint8Array(await new Response(inflated).arrayBuffer()));
}

/** Only stable lobby identities select streams; retired numeric match routes are never requested. */
export function streamPath(params: URLSearchParams): string | null {
  const lobby = params.get("lobby");
  return lobby ? `/watch/live/${encodeURIComponent(lobby)}` : null;
}

export interface LiveLink {
  close(): void;
  /** Drop the connection and open a fresh one (used to move on to the next match, and to resync after an overflow). */
  reopen(): void;
  /** Drop the connection and every message not yet delivered, until reopen. */
  suspend(): void;
}

/** What openLive needs of an EventSource; tests substitute their own. */
export interface EventSourceLike {
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent<string>) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  readonly readyState: number;
  close(): void;
}

export interface LiveOptions {
  /**
   * Most messages received but not yet decoded and delivered. One more
   * suspends the link before it is decoded, and onOverflow runs; the owner
   * reopens the link, whose first message is a full snapshot.
   */
  maxPending?: number;
  onOverflow?: () => void;
  /** Defaults to the browser's EventSource. */
  source?: (path: string) => EventSourceLike;
  /** Defaults to decodeData. */
  decode?: (data: string) => Promise<StreamMessage>;
  /** Abandon any decode-adjacent worker work when this connection is superseded. */
  onReset?: () => void;
  /** A message reached the current connection, before any decoding (source.ts: the server is sending this lobby). */
  onArrival?: () => void;
}

/** How long to wait before reopening a stream the server refused or closed for good. */
const RETRY_MS = 3000;
/** EventSource.CLOSED. */
const CLOSED = 2;

/** The match's result: its final delta (an end event) or a full snapshot of the finished match. The slot ends the
 * stream after it (src/live/hub.ts flushFinal) and has nothing more to send for this match. */
function carriesResult(m: StreamMessage): boolean {
  return (m.full !== null && m.full.result !== null) || m.events.some(e => e.kind === "end");
}

/**
 * Open the live stream. Messages are decoded one at a time and reach the sink
 * in the order they were sent. Admission is bounded before decoding: past
 * maxPending undelivered messages the link suspends. A connection that is
 * suspended, reopened or closed is abandoned: its undelivered messages are
 * neither decoded nor delivered. Once a message carrying the match's result
 * has been delivered the link is finished: its connection closes and is not
 * reconnected, while everything already delivered keeps playing.
 */
export function openLive(path: string, sink: Sink, onState: (s: LinkState) => void, options: LiveOptions = {}): LiveLink {
  const maxPending = options.maxPending ?? Number.POSITIVE_INFINITY;
  const decode = options.decode ?? decodeData;
  const open = options.source ?? ((p: string) => new EventSource(p));
  let es: EventSourceLike | null = null;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  /** The result has been delivered on the current connection; only reopen() connects again. */
  let finished = false;
  let reported: LinkState | null = null;
  const report = (s: LinkState) => { reported = s; onState(s); };
  /** The current connection; work from an earlier one is dropped. */
  let gen = 0;
  let pending = 0;
  const stop = () => {
    gen++;
    options.onReset?.();
    pending = 0;
    chain = Promise.resolve();
    es?.close();
    es = null;
  };
  /** Close the finished connection without abandoning delivered work: no new generation, no onReset. */
  const finish = () => {
    finished = true;
    es?.close();
    es = null;
    // The server's end can be seen before the result finishes decoding; the page has not lost its stream.
    if (reported !== "open") report("open");
  };
  const connect = () => {
    stop();
    finished = false;
    const my = gen;
    report("connecting");
    const source = open(path);
    es = source;
    source.onopen = () => {
      if (my === gen && !finished) report("open");
    };
    source.onmessage = (ev: MessageEvent<string>) => {
      if (my !== gen) return;
      options.onArrival?.();
      if (pending >= maxPending) {
        stop();
        options.onOverflow?.();
        return;
      }
      pending++;
      const data = ev.data;
      chain = chain.then(async () => {
        if (my !== gen) return;
        try {
          const m = await decode(data);
          if (my === gen) {
            sink(m);
            if (my === gen && !finished && carriesResult(m)) finish();
          }
        } catch (e: unknown) {
          if (my === gen) console.error("antwar: bad stream message", e);
        } finally {
          if (my === gen) pending--;
        }
      });
    };
    source.onerror = () => {
      if (my !== gen || finished) return;
      report("reconnecting");
      // The browser retries a dropped connection itself; one it gave up on (an
      // error status) is reopened here.
      if (source.readyState === CLOSED && !closed) setTimeout(() => my === gen && !closed && !finished && connect(), RETRY_MS);
    };
  };
  connect();
  return {
    close() {
      closed = true;
      stop();
    },
    reopen() {
      connect();
    },
    suspend() {
      stop();
    },
  };
}

/** A recorded match: every message, decoded, in tick order. */
export async function loadRecording(url: string): Promise<StreamMessage[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`recording ${url}: HTTP ${response.status}`);
  return unpackMessages(new Uint8Array(await response.arrayBuffer())).map(decodeMessage);
}
