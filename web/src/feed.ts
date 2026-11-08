/**
 * The live client's feed: the stream
 * link (web/src/stream.ts) and the bounded inbox (web/src/inbox.ts) wired
 * together, so the page and the tests run the same path.
 *
 * An overflow drops the backlog. Before the first full snapshot has been
 * delivered no frame loop is running yet, so the stream is reopened at once;
 * after it, the stream is suspended at once and the frame loop reopens it on
 * its next frame (take). Either way the new connection's first message is a
 * full snapshot at the delayed live position.
 */
import type { StreamMessage } from "../../src/live/format.ts";
import { INBOX_CAP, Inbox, type Arrival } from "./inbox.ts";
import { decodeData, openLive, type LinkState, type LiveLink, type LiveOptions } from "./stream.ts";
import type { PreparedTick } from "./buffer.ts";
import { WorkerIntake, type Intake } from "./intake.ts";

export interface LiveFeed {
  /** Resolves with the first full snapshot delivered. */
  readonly first: Promise<StreamMessage>;
  readonly link: LiveLink;
  readonly inbox: Inbox;
  /** The messages to play this frame, oldest first; reopens the stream after an overflow. Call once per frame. */
  take(): Arrival[];
}

export function openFeed(
  path: string,
  now: () => number,
  onState: (s: LinkState) => void,
  { onMessage, ...options }: Pick<LiveOptions, "source" | "decode" | "onReset" | "onArrival"> & { onMessage?: (m: StreamMessage) => void } = {},
): LiveFeed {
  let delivered: StreamMessage | null = null;
  let firstSeen!: (m: StreamMessage) => void;
  const first = new Promise<StreamMessage>((res) => (firstSeen = res));
  let link: LiveLink | null = null;
  let overflowReopen = false;
  const inbox = new Inbox(() => {
    if (delivered === null) link?.reopen();
    else link?.suspend();
  });
  link = openLive(
    path,
    (m) => {
      inbox.push(m, now());
      onMessage?.(m);
      if (delivered === null && m.full !== null) {
        delivered = m;
        firstSeen(m);
      }
    },
    (state) => {
      // connect() reports connecting synchronously. A bounded catch-up reopen
      // is not a transport error; real onerror callbacks still report normally.
      if (state !== "connecting" || !overflowReopen) onState(state);
    },
    { ...options, maxPending: INBOX_CAP, onOverflow: () => inbox.overflow() },
  );
  const live = link;
  return {
    first,
    link: live,
    inbox,
    take() {
      const out = inbox.drain();
      if (inbox.takeResync()) {
        overflowReopen = delivered !== null;
        try { live.reopen(); }
        finally { overflowReopen = false; }
      }
      return out;
    },
  };
}

export type LiveArrival =
  | { kind: "prepared"; prepared: PreparedTick; at: number; workerMs: number; deliveryMs: number }
  | { kind: "inline"; m: StreamMessage; at: number };

export interface PreparedFeed {
  readonly first: Promise<StreamMessage>;
  readonly link: LiveLink;
  readonly inbox: Inbox;
  take(): LiveArrival[];
}

/** Production live route: worker preparation normally; page-side decode only if worker startup fails. */
export function openPreparedFeed(
  path: string,
  now: () => number,
  onState: (s: LinkState) => void,
  /** onMessage sees every message as it is delivered, before any frame takes it (source.ts: whether this match's result has come). */
  options: { source?: LiveOptions["source"]; intake?: Intake; measure?: () => number; onMessage?: (m: StreamMessage) => void; onArrival?: () => void } = {},
): PreparedFeed {
  let feed: LiveFeed | null = null;
  let inline = false;
  const intake = options.intake ?? new WorkerIntake(
    () => new Worker(new URL("./intake.worker.ts", import.meta.url), { type: "module" }),
    (error, startup) => {
      if (startup) {
        inline = true; // Permanent for this feed: do not retry an unavailable worker on every reconnect.
        console.error("antwar: intake worker unavailable; using page-side decoding", error);
      } else console.error("antwar: intake worker failed; reconnecting", error);
      // Reuse the bounded stream and get a full snapshot before Playback.push adopts the fallback.
      feed?.link.reopen();
    },
    options.measure,
  );
  const prepared = new WeakMap<StreamMessage, "inline" | { prepared: PreparedTick | null; workerMs: number; deliveryMs?: number }>();
  feed = openFeed(path, now, onState, {
    source: options.source,
    onMessage: options.onMessage,
    onArrival: options.onArrival,
    onReset: () => intake.reset(),
    decode: async (data) => {
      if (inline) {
        const m = await decodeData(data);
        prepared.set(m, "inline");
        return m;
      }
      const tick = await intake.decode(data);
      prepared.set(tick.m, tick);
      return tick.m;
    },
  });
  const live = feed;
  return {
    first: live.first,
    inbox: live.inbox,
    link: {
      close() { live.link.close(); intake.close(); },
      reopen() { live.link.reopen(); },
      suspend() { live.link.suspend(); },
    },
    take() {
      return live.take().flatMap<LiveArrival>(({ m, at }) => {
        const tick = prepared.get(m);
        prepared.delete(m);
        if (tick === "inline") return [{ kind: "inline", m, at }];
        return tick?.prepared ? [{ kind: "prepared", prepared: tick.prepared, at, workerMs: tick.workerMs, deliveryMs: tick.deliveryMs ?? 0 }] : [];
      });
    },
  };
}
