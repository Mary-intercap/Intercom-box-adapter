import { describe, expect, it } from "vitest";

import { claimEvent, type EventStore } from "../../src/domain/eventStore.js";
import { createMemoryEventStore } from "../../src/store/memoryEventStore.js";

describe("memory event store", () => {
  it("reports an unseen event as unprocessed", async () => {
    const store = createMemoryEventStore();
    await expect(store.hasProcessed("evt_1")).resolves.toBe(false);
  });

  it("remembers a marked event", async () => {
    const store = createMemoryEventStore();
    await store.markProcessed("evt_1");
    await expect(store.hasProcessed("evt_1")).resolves.toBe(true);
    await expect(store.hasProcessed("evt_2")).resolves.toBe(false);
  });

  it("grants a claim exactly once", async () => {
    const store = createMemoryEventStore();
    await expect(claimEvent(store, "evt_1")).resolves.toBe(true);
    await expect(claimEvent(store, "evt_1")).resolves.toBe(false);
    await expect(claimEvent(store, "evt_1")).resolves.toBe(false);
  });

  it("grants only one claim across concurrent callers", async () => {
    const store = createMemoryEventStore();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimEvent(store, "evt_race")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("forgets an event once its TTL expires", async () => {
    let now = 1_000_000;
    const store = createMemoryEventStore({ ttlMs: 5000, now: () => now });

    await expect(claimEvent(store, "evt_1")).resolves.toBe(true);
    now += 4999;
    await expect(store.hasProcessed("evt_1")).resolves.toBe(true);
    now += 2;
    await expect(store.hasProcessed("evt_1")).resolves.toBe(false);
    // After expiry the event can be claimed again - the honest consequence of a
    // TTL cache, and why this is not durable idempotency.
    await expect(claimEvent(store, "evt_1")).resolves.toBe(true);
  });

  it("bounds memory by evicting the oldest entries", async () => {
    const store = createMemoryEventStore({ maxEntries: 3, ttlMs: 60_000 });
    for (const id of ["a", "b", "c", "d", "e"]) await store.markProcessed(id);

    await expect(store.hasProcessed("a")).resolves.toBe(false);
    await expect(store.hasProcessed("b")).resolves.toBe(false);
    await expect(store.hasProcessed("e")).resolves.toBe(true);
  });

  it("falls back to check-then-set for stores without an atomic claim", async () => {
    const seen = new Set<string>();
    const store: EventStore = {
      hasProcessed: (id) => Promise.resolve(seen.has(id)),
      markProcessed: (id) => {
        seen.add(id);
        return Promise.resolve();
      },
    };
    await expect(claimEvent(store, "evt_1")).resolves.toBe(true);
    await expect(claimEvent(store, "evt_1")).resolves.toBe(false);
  });
});
