import type { EventStore } from "../domain/eventStore.js";

/**
 * In-memory idempotency store.
 *
 * !! THIS IS NOT DURABLE IDEMPOTENCY. !!
 *
 * State lives in one process's heap. It is lost on restart, redeploy, or crash,
 * and it is not shared between instances. Running two replicas behind a load
 * balancer means an Intercom retry can land on the replica that has not seen the
 * event, and the alert is delivered twice.
 *
 * This is an acceptable V1 tradeoff because the failure mode is a duplicate
 * Slack message, not a lost one, and because the pipeline acknowledges Intercom
 * before doing any work - so Intercom's single retry is rarely triggered at all.
 * Swap in a Redis/KV/DynamoDB implementation of {@link EventStore} (ideally
 * overriding `claim` with an atomic `SET NX` style primitive) before running
 * more than one instance.
 */

export interface MemoryEventStoreOptions {
  /** How long an event id is remembered. Default 24h. */
  ttlMs?: number;
  /** Hard cap on retained ids, to bound memory. Default 10,000. */
  maxEntries?: number;
  /** Injection seam for tests. */
  now?: () => number;
}

export function createMemoryEventStore(options: MemoryEventStoreOptions = {}): EventStore {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;

  /** eventId -> expiry timestamp. Insertion-ordered, so the head is the oldest. */
  const seen = new Map<string, number>();

  function sweep(): void {
    const current = now();
    for (const [eventId, expiresAt] of seen) {
      if (expiresAt > current) break; // Map preserves insertion order; all TTLs are equal.
      seen.delete(eventId);
    }
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  function isLive(eventId: string): boolean {
    const expiresAt = seen.get(eventId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now()) {
      seen.delete(eventId);
      return false;
    }
    return true;
  }

  return {
    hasProcessed(eventId: string): Promise<boolean> {
      sweep();
      return Promise.resolve(isLive(eventId));
    },

    markProcessed(eventId: string): Promise<void> {
      seen.set(eventId, now() + ttlMs);
      sweep();
      return Promise.resolve();
    },

    /**
     * Atomic within a single Node process: the check and the set happen in one
     * synchronous turn, so two concurrent deliveries cannot both win.
     */
    claim(eventId: string): Promise<boolean> {
      sweep();
      if (isLive(eventId)) return Promise.resolve(false);
      seen.set(eventId, now() + ttlMs);
      return Promise.resolve(true);
    },
  };
}
