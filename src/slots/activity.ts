/**
 * Outstanding work of this process's match server. A slot server is idle,
 * and may stop, only while no hold is open. Every slot-server part shares
 * this one interface.
 */
export interface Activity {
  /** Opens one hold; the returned release is idempotent. */
  hold(reason: string): () => void;
  /** True while no hold is open. */
  readonly idle: boolean;
  /** Resolves once no hold is open; at once when idle. */
  whenIdle(): Promise<void>;
}

export function createActivity(): Activity {
  const open = new Set<symbol>();
  let waiters: (() => void)[] = [];
  return {
    hold(reason) {
      const id = Symbol(reason);
      open.add(id);
      return () => {
        if (!open.delete(id) || open.size > 0) return;
        const resolved = waiters;
        waiters = [];
        for (const resolve of resolved) resolve();
      };
    },
    get idle() {
      return open.size === 0;
    },
    whenIdle() {
      return open.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

const bySlot = new Map<string, Activity>();

/** The one Activity of this process's server for a slot, created on first use. */
export function slotActivity(slot: string): Activity {
  let activity = bySlot.get(slot);
  if (activity === undefined) {
    activity = createActivity();
    bySlot.set(slot, activity);
  }
  return activity;
}
