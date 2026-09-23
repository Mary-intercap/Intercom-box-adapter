/**
 * Idempotency boundary.
 *
 * Intercom retries a failed delivery, and a retry must not produce a second AI
 * call or a second Slack alert. The pipeline does check-then-set through this
 * interface.
 *
 * NOTE: `hasProcessed` + `markProcessed` is NOT atomic. The in-memory
 * implementation is safe for a single-process deployment because Node runs the
 * check and the mark in the same synchronous turn, but a distributed
 * implementation should override {@link EventStore.claim} with an atomic
 * primitive (Redis `SET NX`, DynamoDB conditional put) instead.
 */
export interface EventStore {
  hasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;

  /**
   * Optional atomic variant. Returns true when this caller now owns the event.
   * Implementations that can do this atomically should; the pipeline prefers it
   * when present.
   */
  claim?(eventId: string): Promise<boolean>;
}

/** Claims an event, using the atomic path when the store offers one. */
export async function claimEvent(store: EventStore, eventId: string): Promise<boolean> {
  if (store.claim) return store.claim(eventId);
  if (await store.hasProcessed(eventId)) return false;
  await store.markProcessed(eventId);
  return true;
}
