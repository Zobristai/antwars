/// <reference types="node" />
import type { Store, TransactionRead } from "../store/firestore.js";

/**
 * Slot wake: match servers run only on demand, so a slot's server is
 * sent a wake-up once a lobby's assignment to that slot commits, whether or not
 * the server is running.
 *
 * settleSlots notes each slot it hands out with noteSlotTaken, against the read of
 * the transaction attempt it runs in. A waking store gives every attempt its own
 * read and, after a transaction commits, wakes each slot its committing attempt
 * noted. Every slot-assigning path (a lobby filling or started early, a release
 * handing its slot on, a queue-made lobby) runs settleSlots in a transaction on the
 * store createLobbies was given, so none needs wake code of its own.
 */

const notedByAttempt = new WeakMap<TransactionRead, Set<string>>();

/** Records a slot handed out in the attempt that owns read; a no-op for a read not from a waking store. */
export function noteSlotTaken(read: TransactionRead, slot: string): void {
  notedByAttempt.get(read)?.add(slot);
}

/**
 * The same reads and transactions as store. After a transaction commits, wake is
 * called once per slot noted in its committing attempt; nothing is woken for a
 * transaction that is rolled back (no writes), refused, fails or throws, nor for
 * an attempt that was aborted and rerun. A throw from wake never changes the
 * transaction's result.
 */
export function wakingStore(store: Store, wake: (slot: string) => void): Store {
  return {
    namespace: store.namespace,
    get: (path) => store.get(path),
    query: (collectionId, options) => store.query(collectionId, options),
    async transaction(step) {
      // Attempts run one after another; the last to run is the one whose writes committed.
      let last: { readonly noted: Set<string>; committing: boolean } | undefined;
      const result = await store.transaction(async (read) => {
        const attemptRead: TransactionRead = (paths) => read(paths);
        const attempt = { noted: new Set<string>(), committing: false };
        notedByAttempt.set(attemptRead, attempt.noted);
        last = attempt;
        const outcome = await step(attemptRead);
        attempt.committing = outcome.writes.length > 0;
        return outcome;
      });
      if (last?.committing) {
        for (const slot of last.noted) {
          try {
            wake(slot);
          } catch (error) {
            console.error(`antwar wake for slot ${slot} failed: ${(error as Error).message}`);
          }
        }
      }
      return result;
    },
  };
}

const WAKE_TIMEOUT_MS = 60_000;
/** The waits before each retry of a failed wake: three attempts in all. */
export const WAKE_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000];

/**
 * The waker for every server that assigns slots, from ANTWAR_SLOT_URL_TEMPLATE: an
 * https URL containing {slot}, such as https://antwar-{slot}-123.europe-west1.run.app.
 * Unset or empty means no waker. A malformed template throws, refusing start-up.
 * Waking sends GET <slot url>/wake and, while it fails (no answer, a timeout or a
 * non-2xx status), retries after each of retryDelaysMs in turn, logging
 * every failure and a final give-up line; it never throws. A wake lost even so is
 * recovered by the lobbies' stale-hold release (src/lobby/lobbies.ts).
 */
export function slotWakerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  request: typeof fetch = fetch,
  retryDelaysMs: readonly number[] = WAKE_RETRY_DELAYS_MS,
): ((slot: string) => void) | undefined {
  const template = env.ANTWAR_SLOT_URL_TEMPLATE;
  if (template === undefined || template === "") return undefined;
  const wakeUrl = (slot: string): string => {
    const url = new URL(template.replaceAll("{slot}", slot));
    return `${url.origin}${url.pathname.replace(/\/$/, "")}/wake`;
  };
  let sample: URL;
  try {
    sample = new URL(template.replaceAll("{slot}", "public-0"));
  } catch {
    throw new Error(`ANTWAR_SLOT_URL_TEMPLATE must be an https URL containing {slot}; got ${JSON.stringify(template)}`);
  }
  if (!template.includes("{slot}") || sample.protocol !== "https:" || sample.username !== "" || sample.password !== ""
    || sample.search !== "" || sample.hash !== "") {
    throw new Error(`ANTWAR_SLOT_URL_TEMPLATE must be an https URL containing {slot}, with no credentials, query or fragment; got ${JSON.stringify(template)}`);
  }
  /** One wake request; true when the slot's server answered 2xx. */
  const attempt = async (slot: string): Promise<boolean> => {
    try {
      const response = await request(wakeUrl(slot), { method: "GET", redirect: "error", signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) });
      await response.body?.cancel();
      if (response.ok) return true;
      console.error(`antwar wake for slot ${slot} answered HTTP ${response.status}`);
    } catch (error) {
      console.error(`antwar wake for slot ${slot} failed: ${(error as Error).message}`);
    }
    return false;
  };
  return (slot) => {
    void (async () => {
      if (await attempt(slot)) return;
      for (const delay of retryDelaysMs) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (await attempt(slot)) return;
      }
      const attempts = retryDelaysMs.length + 1;
      console.error(`antwar wake for slot ${slot} gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
    })();
  };
}
